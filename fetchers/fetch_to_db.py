"""
fetcher.py
----------
Fetch ticks from TSETMC API, convert to 1‑minute OHLC, and store.
Includes retries, better headers, longer timeout, strict trading hours validation, and strict same-day data filtering.
"""

import requests
import pandas as pd
from fetchers.holidays import is_trading_day
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from database import insert_trades, init_db
from config import TSETMC_INSCODES, INCODE_TO_NAME


# ------------------------------------------------------------
# 0. Market Hours Validator
# ------------------------------------------------------------
def is_iran_market_open():
    """
    Validates if the current time is within active TSETMC trading hours.
    Allows fetching from 08:30 AM until 23:45 PM Tehran Time.
    """
    tehran_time = datetime.now(ZoneInfo("Asia/Tehran"))
    
    # Python weekday(): 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun
    # Iranian weekends are Thursday (3) and Friday (4)
    if tehran_time.weekday() in [3, 4]:
        return False
        
    # Allow fetching only between 08:30 and 23:45 Tehran Time
    if not (8 <= tehran_time.hour <= 23):
        return False
        
    # Block before 08:30
    if tehran_time.hour == 8 and tehran_time.minute < 30:
        return False
        
    # Block after 23:45
    if tehran_time.hour == 23 and tehran_time.minute > 45:
        return False
        
    return True

# ------------------------------------------------------------
# 1. TSETMC Fetcher with retries and browser headers
# ------------------------------------------------------------
class TSETMCFetcher:
    def __init__(self, ins_code: str):
        self.url = f"https://cdn.tsetmc.com/api/Trade/GetTrade/{ins_code}"
        self.session = requests.Session()
        
        # Lower retries to prevent the scheduler from freezing on proxy drops
        retry = Retry(
            total=1,
            backoff_factor=0.5,
            status_forcelist=[500, 502, 503, 504],
            allowed_methods=["GET"]
        )
        adapter = HTTPAdapter(max_retries=retry)
        self.session.mount('http://', adapter)
        self.session.mount('https://', adapter)

    def fetch_ticks(self):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json"
        }
        # Reduce timeout from 30s to 5s to fail fast and free the scheduler loop
        resp = self.session.get(self.url, headers=headers, timeout=5)
        resp.raise_for_status()
        data = resp.json()
        return data.get("trade", [])
# ------------------------------------------------------------
# 2. Normalizer (ticks → OHLC)
# ------------------------------------------------------------
def ticks_to_ohlc(ticks, interval_minutes=1, trading_date=None):
    if ticks is None:
        return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])

    trading_date = trading_date or datetime.today().date()
    rows = []

    if isinstance(ticks, list):
        for t in ticks:
            h = t['hEven'] // 10000
            m = (t['hEven'] % 10000) // 100
            s = t['hEven'] % 100
            dt = datetime.combine(trading_date, datetime.min.time()) + timedelta(hours=h, minutes=m, seconds=s)
            rows.append({"datetime": dt, "price": t["pTran"], "volume": t["qTitTran"]})
        df = pd.DataFrame(rows)
    elif isinstance(ticks, pd.DataFrame):
        df = ticks.copy()
        if 'datetime' not in df.columns:
            if 'hEven' not in df.columns:
                raise ValueError("DataFrame ticks must have 'hEven' column")
            for idx, t in df.iterrows():
                h = t['hEven'] // 10000
                m = (t['hEven'] % 10000) // 100
                s = t['hEven'] % 100
                df.at[idx, 'datetime'] = datetime.combine(trading_date, datetime.min.time()) + timedelta(hours=h, minutes=m, seconds=s)
        if 'price' not in df.columns:
            df['price'] = df['pTran']
        if 'volume' not in df.columns:
            df['volume'] = df['qTitTran']
    else:
        raise TypeError("ticks must be a list or DataFrame")

    if df.empty:
        return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])

    df['datetime'] = pd.to_datetime(df['datetime'])
    df = df.set_index('datetime')
    ohlc = df['price'].resample(f'{interval_minutes}min').ohlc()
    ohlc['volume'] = df['volume'].resample(f'{interval_minutes}min').sum()
    return ohlc

# ------------------------------------------------------------
# 3. Helper: enrich ticks with datetime (Jalali → Gregorian)
# ------------------------------------------------------------
def prepare_ticks_for_ohlc(ticks):
    if not ticks:
        return pd.DataFrame()

    rows = []
    for t in ticks:
        try:
            import jdatetime
            d_str = str(t['dEven'])
            year = int(d_str[:4])
            month = int(d_str[4:6])
            day = int(d_str[6:8])
            greg = jdatetime.date(year, month, day).togregorian()
            date_str = greg.strftime("%Y-%m-%d")
        except:
            date_str = datetime.today().strftime("%Y-%m-%d")

        h = t['hEven'] // 10000
        m = (t['hEven'] % 10000) // 100
        s = t['hEven'] % 100
        dt = pd.Timestamp(f"{date_str} {h:02d}:{m:02d}:{s:02d}")
        rows.append({"datetime": dt, "price": t["pTran"], "volume": t["qTitTran"]})
    return pd.DataFrame(rows)

# ------------------------------------------------------------
# 4. Fetch and store for a single stock (with date filtering)
# ------------------------------------------------------------
def fetch_and_store_1min(inscode):
    print(f"\n📊 Processing {inscode} ({INCODE_TO_NAME.get(inscode, 'Unknown')})")
    fetcher = TSETMCFetcher(inscode)
    try:
        ticks = fetcher.fetch_ticks()
        if not ticks:
            print("  ⚠️ No ticks returned")
            return 0
        print(f"  ✓ Fetched {len(ticks)} ticks")

        df_ticks = prepare_ticks_for_ohlc(ticks)
        if df_ticks.empty:
            print("  ⚠️ No valid ticks after conversion")
            return 0

        ohlc = ticks_to_ohlc(df_ticks, interval_minutes=1)
        if ohlc.empty:
            print("  ⚠️ No OHLC bars generated")
            return 0

        ohlc = ohlc.reset_index()
        ohlc["date"] = ohlc["datetime"].dt.strftime("%Y-%m-%d")
        ohlc["time"] = ohlc["datetime"].dt.strftime("%H:%M:%S")
        ohlc = ohlc[["date", "time", "open", "high", "low", "close", "volume"]]

        # --- THE GATEKEEPER: ONLY KEEP TODAY'S DATA ---
        today_tehran = datetime.now(ZoneInfo("Asia/Tehran")).strftime("%Y-%m-%d")
        ohlc = ohlc[ohlc["date"] == today_tehran]
        
        if ohlc.empty:
            print(f"  ⚠️ Stale data dropped. No ticks matching today's date ({today_tehran}).")
            return 0
        # ----------------------------------------------

        inserted = insert_trades(inscode, ohlc)
        print(f"  ✅ Inserted {inserted} new 1-minute rows")
        return inserted

    except requests.exceptions.Timeout:
        print("  ⏱️ Timeout – skipping for now")
        return 0
    except requests.exceptions.HTTPError as e:
        if e.response.status_code == 500:
            print("  ⚠️ Server error (500) – skipping for now")
            return 0
        print(f"  ❌ HTTP error: {e}")
        return 0
    except Exception as e:
        print(f"  ❌ Error: {e}")
        return 0

# ------------------------------------------------------------
# 5. Update all stocks (with delay to avoid rate‑limiting)
# ------------------------------------------------------------
def update_all_stocks():
    """Fetch and store new data for all TSETMC stocks with a 1s delay between requests."""
    if not is_iran_market_open():
        print("📅 TSETMC market is closed. Skipping fetch to prevent date mislabeling.")
        return 0
        
    # ---- Holiday check ----
    if not is_trading_day():
        print("📅 Today is a holiday – skipping TSETMC fetch.")
        return 0

    total = 0
    for i, inscode in enumerate(TSETMC_INSCODES):
        if i > 0:
            time.sleep(1)
        total += fetch_and_store_1min(inscode)
    return total

# ------------------------------------------------------------
# 6. Standalone execution
# ------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    total = update_all_stocks()
    print(f"\n✅ Done. Total new rows inserted: {total}")