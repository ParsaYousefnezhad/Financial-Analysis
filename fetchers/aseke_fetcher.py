"""
aseke_fetcher.py
----------------
Fetch ticks from TSETMC API specifically for ASeke (18650546575861744).
Converts the raw ticks to 15-minute OHLCV candles and stores them in the database.
"""

import requests
import pandas as pd
from fetchers.holidays import is_trading_day
import time
from datetime import datetime, timedelta
from zoneinfo import ZoneInfo
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
import sys
from pathlib import Path

# Ensure we can import from the parent directory
sys.path.append(str(Path(__file__).resolve().parent.parent))

from database import insert_trades, init_db
from config import INCODE_TO_NAME

ASEKE_INSCODE = "18650546575861744"

# ------------------------------------------------------------
# 0. Market Hours Validator
# ------------------------------------------------------------
def is_iran_market_open():
    """
    Validates if the current time is within active TSETMC trading hours.
    Allows fetching from 08:30 AM until 23:45 PM Tehran Time.
    """
    tehran_time = datetime.now(ZoneInfo("Asia/Tehran"))
    
    if tehran_time.weekday() in [3, 4]: # Thu, Fri
        return False
        
    if not (8 <= tehran_time.hour <= 23):
        return False
        
    if tehran_time.hour == 8 and tehran_time.minute < 30:
        return False
        
    if tehran_time.hour == 23 and tehran_time.minute > 45:
        return False
        
    return True

# ------------------------------------------------------------
# 1. TSETMC Fetcher
# ------------------------------------------------------------
class TSETMCFetcher:
    def __init__(self, ins_code: str):
        self.url = f"https://cdn.tsetmc.com/api/Trade/GetTrade/{ins_code}"
        self.session = requests.Session()
        
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
        resp = self.session.get(self.url, headers=headers, timeout=5)
        resp.raise_for_status()
        data = resp.json()
        return data.get("trade", [])

# ------------------------------------------------------------
# 2. Normalizer (ticks → OHLC)
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

def ticks_to_ohlc(df, interval_minutes=15):
    """Resamples the tick DataFrame into X-minute OHLC bars."""
    if df.empty:
        return pd.DataFrame(columns=['open', 'high', 'low', 'close', 'volume'])

    df['datetime'] = pd.to_datetime(df['datetime'])
    df = df.set_index('datetime')
    
    ohlc = df['price'].resample(f'{interval_minutes}min').ohlc()
    ohlc['volume'] = df['volume'].resample(f'{interval_minutes}min').sum()
    
    # Drop periods where no trades happened (NaN)
    ohlc = ohlc.dropna()
    return ohlc

# ------------------------------------------------------------
# 3. Core Logic for ASeke
# ------------------------------------------------------------
def fetch_and_store_aseke():
    inscode = ASEKE_INSCODE
    name_label = INCODE_TO_NAME.get(inscode, 'ASeke')
    print(f"\n📊 Processing {inscode} ({name_label}) - 15m timeframe")
    
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

        # Change interval to 15 minutes!
        ohlc = ticks_to_ohlc(df_ticks, interval_minutes=15)
        if ohlc.empty:
            print("  ⚠️ No 15m OHLC bars generated")
            return 0

        ohlc = ohlc.reset_index()
        ohlc["date"] = ohlc["datetime"].dt.strftime("%Y-%m-%d")
        ohlc["time"] = ohlc["datetime"].dt.strftime("%H:%M:%S")
        ohlc = ohlc[["date", "time", "open", "high", "low", "close", "volume"]]

        # Keep only today's data
        today_tehran = datetime.now(ZoneInfo("Asia/Tehran")).strftime("%Y-%m-%d")
        ohlc = ohlc[ohlc["date"] == today_tehran]
        
        if ohlc.empty:
            print(f"  ⚠️ Stale data dropped. No ticks matching today's date ({today_tehran}).")
            return 0

        inserted = insert_trades(inscode, ohlc)
        print(f"  ✅ Inserted {inserted} new 15-minute rows for {name_label}")
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

def update_aseke():
    """Main function called by the scheduler"""
    if not is_iran_market_open():
        print("📅 TSETMC market is closed. Skipping ASeke fetch.")
        return 0
        
    if not is_trading_day():
        print("📅 Today is a holiday – skipping ASeke fetch.")
        return 0

    return fetch_and_store_aseke()

# ------------------------------------------------------------
# 4. Standalone execution
# ------------------------------------------------------------
if __name__ == "__main__":
    init_db()
    total = update_aseke()
    print(f"\n✅ ASeke Sync Done. Total new rows inserted: {total}")