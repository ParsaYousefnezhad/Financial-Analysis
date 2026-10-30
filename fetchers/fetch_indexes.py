"""
fetch_indexes.py
----------------
Fetch 5-minute index data from TSETMC API and store it in the database.
Filters out pre-market data (before 09:00:00) and prevents duplicate inserts.
"""

import requests
import pandas as pd
import time
from datetime import datetime
from requests.adapters import HTTPAdapter
from urllib3.util.retry import Retry
from database import get_stock_data, insert_trades, init_db

INDEX_INSCODES = {
    "32097828799138957": "ShaxesKol",
    "67130298613737946": "shaxeshamvazn"
}

class TSETMCIndexFetcher:
    def __init__(self, ins_code: str):
        self.url = f"https://cdn.tsetmc.com/api/Index/GetIndexB1LastDay/{ins_code}"
        self.session = requests.Session()
        
        retry = Retry(
            total=2,
            backoff_factor=0.5,
            status_forcelist=[500, 502, 503, 504],
            allowed_methods=["GET"]
        )
        adapter = HTTPAdapter(max_retries=retry)
        self.session.mount('http://', adapter)
        self.session.mount('https://', adapter)

    def fetch_data(self):
        headers = {
            "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
            "Accept": "application/json"
        }
        resp = self.session.get(self.url, headers=headers, timeout=5)
        resp.raise_for_status()
        data = resp.json()
        
        return data.get("indexB1", data) if isinstance(data, dict) else data

def process_index_data(raw_data, inscode):
    """
    Parses the raw JSON into an OHLCV DataFrame using the correct index API keys.
    """
    if not raw_data:
        return pd.DataFrame()

    rows = []
    for item in raw_data:
        h_even = item.get('hEven', 0)
        
        # Ignore pre-market data (before 09:00:00)
        if h_even < 90000:
            continue
            
        try:
            d_str = str(item.get('dEven', datetime.today().strftime("%Y%m%d")))
            year, month, day = int(d_str[:4]), int(d_str[4:6]), int(d_str[6:8])
            # Handle Jalali dates
            if year < 1500:
                import jdatetime
                greg = jdatetime.date(year, month, day).togregorian()
                date_str = greg.strftime("%Y-%m-%d")
            else:
                date_str = f"{year:04d}-{month:02d}-{day:02d}"
        except Exception:
            date_str = datetime.today().strftime("%Y-%m-%d")

        h = h_even // 10000
        m = (h_even % 10000) // 100
        s = h_even % 100
        
        dt = pd.Timestamp(f"{date_str} {h:02d}:{m:02d}:{s:02d}")
        
        # The key for the index value in this specific endpoint
        val = item.get('xDrNivJIdx004') or item.get('xNivInuClMnt') or 0
        
        if float(val) > 0:
            rows.append({
                "datetime": dt,
                "price": float(val),
                "volume": 0  # Index endpoints usually don't carry bar-volume here
            })

    df = pd.DataFrame(rows)
    if df.empty:
        return df

    df = df.set_index('datetime')
    
    # 1. Resample price into standard OHLC
    ohlc = df['price'].resample('5min').ohlc()
    
    # 2. Add empty volume column (since indices don't have direct volume in this JSON)
    ohlc['volume'] = 0
    
    # Drop rows that had no price data in that 5-min window
    ohlc = ohlc.dropna(subset=['open', 'high', 'low', 'close'])
    
    ohlc = ohlc.reset_index()
    ohlc["date"] = ohlc["datetime"].dt.strftime("%Y-%m-%d")
    ohlc["time"] = ohlc["datetime"].dt.strftime("%H:%M:%S")
    
    return ohlc[["date", "time", "open", "high", "low", "close", "volume"]]

def fetch_and_store_index(inscode, name):
    print(f"\n📊 Processing Index: {name} ({inscode})")
    
    existing_df = get_stock_data(inscode)
    last_timestamp = None
    if not existing_df.empty:
        last_timestamp = existing_df.index.max()
        print(f"  📅 Last recorded data: {last_timestamp}")

    fetcher = TSETMCIndexFetcher(inscode)
    try:
        raw_data = fetcher.fetch_data()
        if not raw_data:
            print("  ⚠️ No data returned from API")
            return 0
            
        df_candles = process_index_data(raw_data, inscode)
        if df_candles.empty:
            print("  ⚠️ No valid data after processing")
            return 0

        # Filter out duplicates
        if last_timestamp:
            df_candles['datetime'] = pd.to_datetime(df_candles['date'] + ' ' + df_candles['time'])
            df_candles = df_candles[df_candles['datetime'] > last_timestamp]
            df_candles = df_candles.drop(columns=['datetime'])

        if df_candles.empty:
            print("  ✅ Data is already up to date. No new rows to insert.")
            return 0

        inserted = insert_trades(inscode, df_candles)
        print(f"  ✅ Inserted {inserted} new 5-minute candles")
        return inserted

    except requests.exceptions.RequestException as e:
        print(f"  ❌ Network error: {e}")
        return 0
    except Exception as e:
        print(f"  ❌ Error processing {name}: {e}")
        return 0

def update_all_indexes():
    total_inserted = 0
    for inscode, name in INDEX_INSCODES.items():
        total_inserted += fetch_and_store_index(inscode, name)
        time.sleep(1) 
    return total_inserted

if __name__ == "__main__":
    init_db()
    total = update_all_indexes()
    print(f"\n✅ Index update complete. Total new rows inserted: {total}")