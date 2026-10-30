"""
commodities_fetcher.py
----------------------
Fetches real-time 1-minute OHLC spot data via London Strategic Edge API.
Enforces strict global market trading hours and polls every 2 minutes.

Hardened against:
  • DNS resolution failures (Errno 11001) — pre-checked, logged once per outage
  • Transient 429/5xx — jittered exponential backoff
  • Old urllib3 versions lacking `backoff_jitter` / `respect_retry_after_header`
  • Optional proxy routing (for Iran-based hosts reaching international APIs)
"""

import inspect
import os
import socket
import time
import urllib3
from urllib.parse import urlparse
from datetime import datetime, time as dtime
from zoneinfo import ZoneInfo

import pandas as pd
import requests
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry

from database import insert_trades, init_db, get_connection

# Suppress insecure request warnings caused by verify=False
urllib3.disable_warnings(urllib3.exceptions.InsecureRequestWarning)

# ---------------------------------------------------------------- config
LSE_API_KEY = os.getenv("LSE_API_KEY", "lse_live_5344f86f70ffd5e29afc9aa022a4b6be")
LSE_HOST    = "api.londonstrategicedge.com"
LSE_BASE    = f"https://{LSE_HOST}"

# Optional: route all LSE calls through a proxy (e.g. Wireguard / VPS relay).
#   export LSE_PROXY_URL="socks5h://127.0.0.1:1080"
#   export LSE_PROXY_URL="http://10.0.0.5:3128"
PROXY_URL = os.getenv("LSE_PROXY_URL") or None

# TLS verification is off by default (matching the original behavior) but can
# be turned on for a hardened deployment:
#   export LSE_VERIFY_TLS=1
VERIFY_TLS = os.getenv("LSE_VERIFY_TLS", "0") == "1"

COMMODITIES = {
    "XAUUSD": "XAU/USD",
    "XAGUSD": "XAG/USD",
}

# ---------------------------------------------------------------- urllib3 compat
_RETRY_PARAMS = inspect.signature(Retry.__init__).parameters
_RETRY_SUPPORTS_JITTER = "backoff_jitter" in _RETRY_PARAMS
_RETRY_SUPPORTS_RETRY_AFTER = "respect_retry_after_header" in _RETRY_PARAMS


# ---------------------------------------------------------------- DNS guard
# Tracks the last known DNS state so we log a failure once per outage instead
# of on every single 2-minute poll.
_last_dns_state: "bool | None" = None


def _check_dns(host: str) -> bool:
    """Return True if `host` resolves. Logs transitions only."""
    global _last_dns_state
    try:
        socket.gethostbyname(host)
    except socket.gaierror:
        if _last_dns_state is not False:
            print(
                f"❌ DNS resolution failed for {host}. "
                f"Commodity fetches will be skipped until the resolver recovers "
                f"(check network / DNS / proxy)."
            )
        _last_dns_state = False
        return False

    if _last_dns_state is False:
        print(f"✅ DNS recovered for {host} — resuming commodity fetches.")
    _last_dns_state = True
    return True


# ---------------------------------------------------------------- market hours
def is_commodity_market_open(dt: datetime) -> bool:
    """
    Gold/silver spot hours in Tehran local time.
    Opens Monday 01:30, closes Saturday 00:30, with a daily 00:30–01:30 break
    Tuesday–Friday.
    """
    weekday = dt.weekday()   # Mon=0 ... Sun=6
    t = dt.time()

    if weekday == 6:                                    # Sunday — closed
        return False
    if weekday == 5 and t >= dtime(0, 30):              # Saturday after close
        return False
    if weekday == 0 and t < dtime(1, 30):               # Monday pre-open
        return False
    if weekday in (1, 2, 3, 4) and (dtime(0, 30) <= t < dtime(1, 30)):
        return False                                    # Tue–Fri daily break
    return True


# ---------------------------------------------------------------- db helpers
def get_latest_timestamp(symbol: str):
    """Return the newest stored datetime for `symbol`, or None."""
    conn = get_connection()
    try:
        cur = conn.execute(
            "SELECT date, time FROM stock_data "
            "WHERE inscode = ? ORDER BY date DESC, time DESC LIMIT 1",
            (symbol,),
        )
        row = cur.fetchone()
    finally:
        conn.close()

    if not row:
        return None
    try:
        return pd.to_datetime(f"{row[0]} {row[1]}", format="%Y-%m-%d %H:%M:%S")
    except Exception:
        return None


# ---------------------------------------------------------------- http session
def _build_session() -> requests.Session:
    session = requests.Session()

    retry_kwargs = dict(
        total=5,
        connect=5,
        read=5,
        backoff_factor=2,          # 2, 4, 8, 16, 32 s
        status_forcelist=[429, 500, 502, 503, 504],
        allowed_methods=["GET"],
        raise_on_status=False,
    )
    if _RETRY_SUPPORTS_JITTER:
        retry_kwargs["backoff_jitter"] = 1.0
    if _RETRY_SUPPORTS_RETRY_AFTER:
        retry_kwargs["respect_retry_after_header"] = True

    adapter = HTTPAdapter(max_retries=Retry(**retry_kwargs))
    session.mount("http://", adapter)
    session.mount("https://", adapter)

    if PROXY_URL:
        session.proxies = {"http": PROXY_URL, "https": PROXY_URL}
    return session


# ---------------------------------------------------------------- fetch
def fetch_and_store(symbol: str, ticker: str) -> int:
    last_dt = get_latest_timestamp(symbol)

    if last_dt is not None:
        now_tehran = datetime.now(ZoneInfo("Asia/Tehran")).replace(tzinfo=None)
        minutes_diff = max(0, int((now_tehran - last_dt).total_seconds() / 60))
        safe_limit = min(max(minutes_diff + 60, 100), 5000)
    else:
        safe_limit = 5000

    url = (
        f"{LSE_BASE}/vault/candles"
        f"?symbol={ticker}&timeframe=1m&limit={safe_limit}&order=desc"
    )

    # Fail fast on DNS — no point retrying a host that won't resolve.
    host = urlparse(url).hostname
    if not host or not _check_dns(host):
        return 0

    headers = {
        "x-api-key": LSE_API_KEY,
        "User-Agent": (
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        ),
        "Accept": "application/json",
    }

    session = _build_session()
    try:
        response = session.get(
            url,
            headers=headers,
            timeout=(10, 30),
            proxies=session.proxies or None,
            verify=VERIFY_TLS,
        )
    except requests.exceptions.RequestException as e:
        print(f"⚠️ Network failure for {symbol}: {e}")
        return 0
    finally:
        session.close()

    if response.status_code != 200:
        print(f"⚠️ API Error ({response.status_code}) for {symbol}: "
              f"{response.text[:200]}")
        return 0

    try:
        data = response.json()
    except ValueError:
        print(f"⚠️ Non-JSON response for {symbol}")
        return 0

    if isinstance(data, dict):
        data = data.get("candles") or data.get("data") or data.get("values") or []

    if not data:
        return 0

    df = pd.DataFrame(data)
    col_map = {
        "ts": "datetime", "t": "datetime", "timestamp": "datetime",
        "time": "datetime", "date": "datetime",
        "o": "open", "h": "high", "l": "low", "c": "close", "v": "volume",
    }
    df.rename(columns=lambda c: col_map.get(str(c).lower(), str(c).lower()),
              inplace=True)

    required = {"datetime", "open", "high", "low", "close"}
    missing = required - set(df.columns)
    if missing:
        print(f"⚠️ Missing columns from API for {symbol}: {missing}. "
              f"Got: {df.columns.tolist()}")
        return 0

    # order=desc → newest first, so reverse for chronological insertion.
    df = df.iloc[::-1].reset_index(drop=True)
    df["datetime"] = pd.to_datetime(df["datetime"], utc=True)

    for col in ("open", "high", "low", "close"):
        df[col] = pd.to_numeric(df[col], errors="coerce")

    if "volume" in df.columns:
        df["volume"] = (
            pd.to_numeric(df["volume"], errors="coerce")
            .replace([float("inf"), float("-inf")], 0)
            .fillna(0)
            .astype("int64")
        )
    else:
        df["volume"] = 0

    rows_to_insert = []
    for _, row in df.iterrows():
        if any(pd.isna(row[c]) for c in ("open", "high", "low", "close")):
            continue

        dt_tehran = row["datetime"].tz_convert("Asia/Tehran").tz_localize(None)

        if last_dt is not None and dt_tehran <= last_dt:
            continue
        if not is_commodity_market_open(dt_tehran):
            continue

        rows_to_insert.append({
            "date":   dt_tehran.strftime("%Y-%m-%d"),
            "time":   dt_tehran.strftime("%H:%M:%S"),
            "open":   float(row["open"]),
            "high":   float(row["high"]),
            "low":    float(row["low"]),
            "close":  float(row["close"]),
            "volume": int(row["volume"]),
        })

    if not rows_to_insert:
        return 0

    return insert_trades(symbol, pd.DataFrame(rows_to_insert))


# ---------------------------------------------------------------- entrypoint
def update_all_commodities() -> int:
    now_tehran = datetime.now(ZoneInfo("Asia/Tehran"))
    if not is_commodity_market_open(now_tehran):
        # Silent during closed hours — the scheduler calls this every 2 minutes.
        return 0

    total = 0
    for symbol, ticker in COMMODITIES.items():
        try:
            inserted = fetch_and_store(symbol, ticker)
        except Exception as e:
            print(f"⚠️ Unexpected error for {symbol}: {e}")
            inserted = 0
        if inserted:
            print(f"Commodities {symbol}: inserted {inserted} new rows")
        total += inserted
    return total


if __name__ == "__main__":
    init_db()
    print("Starting continuous 2-minute polling loop for LSE Vault API...")
    while True:
        try:
            update_all_commodities()
        except Exception as e:
            print(f"⚠️ Polling loop error: {e}")
        # Align to the next 2-minute wall boundary.
        time.sleep(120 - (time.time() % 120))