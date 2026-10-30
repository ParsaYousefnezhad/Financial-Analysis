"""
servatmandi.py
--------------
Fetches 5-min OHLCV data from the Servatmandi API for macro Iranian assets.
Maps the Base64 decoded payloads directly to the central database.

Notes:
  • The API sometimes returns a Persian "high traffic" restriction string
    instead of data. We detect and skip it cleanly.
  • Volume can arrive as NaN / inf / empty — all are coerced to 0 before
    casting to int64 so pandas never raises.
  • Servatmandi mixes Toman and Rial prices. This script forces all data 
    into TOMAN by dynamically shifting powers of 10 to match the predefined 
    CANONICAL_SCALE.
"""

import base64
import sys
import time
from pathlib import Path

import numpy as np
import pandas as pd
import requests

# Ensure we can import from the parent directory
sys.path.append(str(Path(__file__).resolve().parent.parent))

from database import insert_trades, init_db

ASSETS = {
    "geramTalaHejdah": "2%3A5000000001102",
    "tala18Etehadiye": "2%3A5010000001102",
    "abshode":         "2%3A5000000001000",
    "Dollar":          "2%3A100000000001",
}

# Canonical reference price for each symbol IN TOMAN. 
# Every fetched bar is shifted by an integer number of decades so its log10 
# lands closest to the log10 of this reference. 
CANONICAL_SCALE = {
    "abshode":         103_536_950.0,   # ~1.04e8 (Toman)
    "Dollar":          618_500.0,       # ~6.18e5 (Toman, 6 digits)
    "tala18Etehadiye": 23_821_600.0,     # ~2.38e6 (Toman)
    "geramTalaHejdah": 24_666_500.0,     # ~2.47e6 (Toman)
}

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9,fa;q=0.8",
    "Referer": "https://servatmandi.com/",
    "Origin":  "https://servatmandi.com",
}

# Increased count to ensure we pull enough 5m candles to reach 2026-09-27
COUNT = 1500   


# ---------------------------------------------------------------- helpers
def b64_decode(s: str) -> "str | None":
    s = s.strip().replace("\n", "").replace("\r", "").replace(" ", "")
    pad = (-len(s)) % 4
    try:
        return base64.b64decode(s + "=" * pad).decode("utf-8", errors="replace")
    except Exception:
        return None


def _clean_numeric(df: pd.DataFrame, cols) -> pd.DataFrame:
    """Coerce columns to numeric."""
    out = df.copy()
    for col in cols:
        out[col] = pd.to_numeric(out[col], errors="coerce")
    return out


def normalize_scale(df: pd.DataFrame, symbol: str) -> pd.DataFrame:
    """
    Align every fetched bar to `CANONICAL_SCALE[symbol]` by shifting an
    integer number of powers of 10.

    For each row:  shift = round(log10(ref) - log10(close))
                   OHLC  *= 10 ** shift

    Rows with close <= 0 are left untouched (and later dropped by
    format_for_db).
    """
    if df.empty:
        return df

    ref = CANONICAL_SCALE.get(symbol)
    if not ref or ref <= 0:
        return df

    out = df.copy().reset_index(drop=True)
    log_ref = np.log10(ref)

    closes = pd.to_numeric(out["close"], errors="coerce")
    valid = closes > 0

    shifts = pd.Series(0, index=out.index, dtype="int64")
    if valid.any():
        log_close = np.log10(closes[valid])
        shifts.loc[valid] = np.round(log_ref - log_close).astype("int64")

    multipliers = np.power(10.0, shifts.values)

    for col in ("open", "high", "low", "close"):
        col_vals = pd.to_numeric(out[col], errors="coerce").values
        out[col] = col_vals * multipliers

    moved = int((shifts != 0).sum())
    if moved:
        shift_summary = shifts.value_counts().sort_index().to_dict()
        print(f"    [scale] {symbol}: adjusted {moved}/{len(out)} rows to TOMAN "
              f"(ref≈{ref:,.0f}, shifts={shift_summary})")

    return out


# ---------------------------------------------------------------- fetch
def fetch_bars(ticker: str, to_ts: int, count: int = COUNT) -> pd.DataFrame:
    url = (
        f"https://servatmandi.com/Chart/GetIntradayBars"
        f"?ticker={ticker}"
        f"&count={count}"
        f"&to={to_ts}"
        f"&firstDataRequest=false"
        f"&resolution=5"
    )

    try:
        r = requests.get(url, headers=HEADERS, timeout=(10, 90))
        r.raise_for_status()
    except requests.exceptions.RequestException as e:
        print(f"    [WARN {ticker}] Network error connecting to Servatmandi: {e}")
        return pd.DataFrame()

    raw_text = r.text.strip()
    if not raw_text:
        print(f"    [WARN {ticker}] API returned an empty string.")
        return pd.DataFrame()

    if "ترافیک بالا" in raw_text or "محدود" in raw_text:
        print(f"    [WARN {ticker}] Servatmandi API is currently restricted "
              f"for free users (High Traffic). Skipping.")
        return pd.DataFrame()

    decoded = None
    for skip in range(0, 6):
        d = b64_decode(raw_text[skip:])
        if d and "," in d and ";" in d:
            decoded = d
            break

    if decoded is None:
        print(f"    [WARN {ticker}] Could not Base64-decode the response. "
              f"Raw snippet: {raw_text[:100]}...")
        return pd.DataFrame()

    rows = []
    for rec in decoded.split(";"):
        rec = rec.strip()
        if not rec:
            continue
        parts = rec.split(",")
        if len(parts) < 6:
            continue
        rows.append(parts[:6])

    if not rows:
        return pd.DataFrame()

    df = pd.DataFrame(
        rows,
        columns=["timestamp", "open", "high", "low", "close", "volume"],
    )

    df["timestamp"] = (
        pd.to_datetime(df["timestamp"].astype("int64"), unit="s", utc=True)
        .dt.tz_convert("Asia/Tehran")
    )

    df = _clean_numeric(df, ["open", "high", "low", "close", "volume"])

    df = df[df["timestamp"] > pd.Timestamp("2000-01-01", tz="UTC")]
    df = df.dropna(subset=["open", "high", "low", "close"]).reset_index(drop=True)
    return df


def format_for_db(df: pd.DataFrame) -> pd.DataFrame:
    """Formats DataFrame to match the `stock_data` schema."""
    out = df.copy()

    for col in ("open", "high", "low", "close", "volume"):
        out[col] = pd.to_numeric(out[col], errors="coerce")

    out = out.dropna(subset=["open", "high", "low", "close"])

    out["volume"] = (
        out["volume"]
        .replace([float("inf"), float("-inf")], 0)
        .fillna(0)
        .astype("int64")
    )

    return pd.DataFrame({
        "date":   out["timestamp"].dt.strftime("%Y-%m-%d"),
        "time":   out["timestamp"].dt.strftime("%H:%M:%S"),
        "open":   out["open"],
        "high":   out["high"],
        "low":    out["low"],
        "close":  out["close"],
        "volume": out["volume"],
    })


# ---------------------------------------------------------------- entrypoint
def update_all_servatmandi() -> int:
    to_ts = int(time.time())
    
    # Specific cutoff date requested
    cutoff = pd.Timestamp("2026-09-27 22:00:00", tz="Asia/Tehran")

    total_inserts = 0
    for db_symbol, ticker in ASSETS.items():
        try:
            df = fetch_bars(ticker, to_ts)
            if df.empty:
                continue

            df = normalize_scale(df, db_symbol)

            df = df[df["timestamp"] >= cutoff].reset_index(drop=True)
            if df.empty:
                continue

            formatted_df = format_for_db(df)
            if formatted_df.empty:
                continue

            inserted = insert_trades(db_symbol, formatted_df)
            if inserted:
                print(f"Servatmandi {db_symbol}: inserted {inserted} new rows (Normalized to Toman)")
                total_inserts += inserted

        except Exception as e:
            print(f"⚠️ Error fetching Servatmandi {db_symbol}: {e}")

    return total_inserts


if __name__ == "__main__":
    init_db()
    total = update_all_servatmandi()
    print("=========================================")
    print(f"SYNC COMPLETE — Total inserts: {total}")
    print("=========================================")
