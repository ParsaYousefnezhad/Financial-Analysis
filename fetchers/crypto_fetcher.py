"""
crypto_fetcher.py
-----------------
Fetches OHLC data from the Nobitex API for all platform assets.
Maps Nobitex API tickers to existing database ticker formats.

Notes:
  • Nobitex's /market/udf/history endpoint does NOT serve OHLC for fiat /
    stablecoin pairs like USDTIRT — it returns {"s": "no_data"}.
    If you need the USDT/IRT rate, hit /market/stats?srcCurrency=usdt
    and store it separately.
  • `resolution` is in MINUTES. The scheduler polls every 1 minute, so
    resolution="1" gives you genuine 1-minute bars.
"""

import requests
import pandas as pd
from datetime import datetime, timezone, timedelta

from database import insert_trades, init_db

# ---------------------------------------------------------------- config
ASSETS = [
    {"api_symbol": "BTCUSDT",  "db_symbol": "BTCUSDT",  "resolution": "1"},
    {"api_symbol": "PAXGUSDT", "db_symbol": "PAXGUSDT", "resolution": "1"},
    {"api_symbol": "XAUTUSDT", "db_symbol": "XAUTUSDT", "resolution": "1"},
    {"api_symbol": "XAUTIRT",  "db_symbol": "XAUTIRT",  "resolution": "1"},
    # USDTIRT intentionally omitted — Nobitex does not expose OHLC for it.
]

MAX_CANDLES = 500
URL = "https://apiv2.nobitex.ir/market/udf/history"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "TraderBot/1.0.0",
}


# ---------------------------------------------------------------- fetch
def fetch_nobitex_candles(asset: dict) -> pd.DataFrame:
    """Return a DataFrame of new candles for one asset, or empty on no_data."""
    api_symbol = asset["api_symbol"]
    resolution = asset["resolution"]

    now = datetime.now(timezone.utc)
    resolution_seconds = int(resolution) * 60
    from_timestamp = int(
        (now - timedelta(seconds=MAX_CANDLES * resolution_seconds)).timestamp()
    )
    to_timestamp = int(now.timestamp())

    params = {
        "symbol": api_symbol,
        "resolution": resolution,
        "from": from_timestamp,
        "to": to_timestamp,
    }

    try:
        resp = requests.get(URL, params=params, headers=HEADERS, timeout=15)
        resp.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"⚠️ Nobitex HTTP error for {api_symbol}: {e}")
        return pd.DataFrame()

    try:
        data = resp.json()
    except ValueError:
        print(f"⚠️ Nobitex returned non-JSON for {api_symbol}")
        return pd.DataFrame()

    status = data.get("s")

    # Expected for pairs Nobitex doesn't serve OHLC for — silent, not an error.
    if status == "no_data":
        return pd.DataFrame()

    if status != "ok":
        print(f"⚠️ Nobitex API error for {api_symbol}: {data}")
        return pd.DataFrame()

    required_keys = ("t", "o", "h", "l", "c", "v")
    missing = [k for k in required_keys if k not in data]
    if missing:
        print(f"⚠️ Nobitex payload missing keys for {api_symbol}: {missing}")
        return pd.DataFrame()

    if not data["t"]:
        return pd.DataFrame()

    timestamps = pd.to_datetime(
        data["t"], unit="s", utc=True
    ).tz_convert("Asia/Tehran")

    df = pd.DataFrame({
        "date":   timestamps.strftime("%Y-%m-%d"),
        "time":   timestamps.strftime("%H:%M:%S"),
        "open":   data["o"],
        "high":   data["h"],
        "low":    data["l"],
        "close":  data["c"],
        "volume": data["v"],
    })

    # Sanitize numbers.
    for col in ("open", "high", "low", "close"):
        df[col] = pd.to_numeric(df[col], errors="coerce")
    df["volume"] = (
        pd.to_numeric(df["volume"], errors="coerce")
        .replace([float("inf"), float("-inf")], 0)
        .fillna(0)
        .astype("int64")
    )

    df = df.dropna(subset=["open", "high", "low", "close"]).reset_index(drop=True)
    return df


# ---------------------------------------------------------------- entrypoint
def update_all_nobitex() -> int:
    """Update every configured symbol from Nobitex and route to the DB."""
    total = 0
    for asset in ASSETS:
        api_symbol = asset["api_symbol"]
        db_symbol  = asset["db_symbol"]
        try:
            df = fetch_nobitex_candles(asset)
            if df.empty:
                continue
            inserted = insert_trades(db_symbol, df)
            if inserted:
                print(f"Nobitex {db_symbol}: inserted {inserted} new rows")
                total += inserted
        except Exception as e:
            print(f"⚠️ Error fetching Nobitex {db_symbol}: {e}")
    return total


if __name__ == "__main__":
    init_db()
    total = update_all_nobitex()
    print("=========================================")
    print(f"SYNC COMPLETE — Total inserts: {total}")
    print("=========================================")