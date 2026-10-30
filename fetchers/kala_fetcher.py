import requests
import pandas as pd
import time
from datetime import datetime
from zoneinfo import ZoneInfo
import sys
from pathlib import Path

# Ensure we can import from the parent directory
sys.path.append(str(Path(__file__).resolve().parent.parent))

from database import insert_trades, init_db
from fetchers.holidays import is_trading_day

# Configure assets with their specific IME API symbol IDs
ASSETS = [
    {"api_symbol": "41", "db_symbol": "Tala995",   "resolution": "15"},
    {"api_symbol": "43", "db_symbol": "Noghre999", "resolution": "15"},
    {"api_symbol": "42", "db_symbol": "Seke",      "resolution": "15"},
]

URL = "https://imechartapi.tadbirrlc.com/imechartdata/history"
HEADERS = {
    "Accept": "application/json",
    "User-Agent": "TraderBot/1.0.0 (KalaFetcher)"
}

# Fetch the last ~3 days of 15m candles
MAX_CANDLES = 300 

def is_kala_market_open():
    """
    Validates if current time is within active Kala trading hours.
    Sat-Wed: 12:00 - 18:00
    Thu:     12:00 - 15:00
    """
    tehran_time = datetime.now(ZoneInfo("Asia/Tehran"))
    weekday = tehran_time.weekday() # 0=Mon, 1=Tue, 2=Wed, 3=Thu, 4=Fri, 5=Sat, 6=Sun
    
    # Block Fridays (4)
    if weekday == 4:
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

def fetch_kala_candles(asset):
    """Fetch recent history for a specific IME Kala asset."""
    api_symbol = asset["api_symbol"]
    resolution = asset["resolution"]
    
    # Use Tehran time for the request
    now = datetime.now(ZoneInfo("Asia/Tehran"))
    resolution_seconds = int(resolution) * 60
    
    to_timestamp = int(now.timestamp())
    from_timestamp = to_timestamp - (MAX_CANDLES * resolution_seconds)
    
    params = {
        "symbol": api_symbol,
        "resolution": resolution,
        "from": from_timestamp,
        "to": to_timestamp
    }
    
    try:
        resp = requests.get(URL, params=params, headers=HEADERS, timeout=10)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"    [WARN {asset['db_symbol']}] Network error connecting to IME: {e}")
        return pd.DataFrame()
    
    if data.get("s") != "ok":
        print(f"⚠️ IME API returned no data or error for {api_symbol}: {data}")
        return pd.DataFrame()

    # Convert UNIX timestamps to Tehran time
    timestamps = pd.to_datetime(data["t"], unit="s", utc=True).tz_convert("Asia/Tehran")

    df = pd.DataFrame({
        "date": timestamps.strftime("%Y-%m-%d"),
        "time": timestamps.strftime("%H:%M:%S"),
        "open": data["o"],
        "high": data["h"],
        "low": data["l"],
        "close": data["c"],
        "volume": data["v"]
    })
    
    # Drop completely empty candles if they exist
    df = df.dropna(subset=['open', 'high', 'low', 'close'])
    return df

def update_all_kala():
    """Update all configured Kala symbols and route to DB."""
    if not is_kala_market_open():
        print("📅 Kala market is closed. Skipping fetch.")
        return 0
        
    if not is_trading_day():
        print("📅 Today is a holiday. Skipping Kala fetch.")
        return 0

    print(f"\n--- Starting Kala Updates [{datetime.now().strftime('%Y-%m-%d %H:%M:%S')}] ---")
    total = 0
    for asset in ASSETS:
        db_symbol = asset["db_symbol"]
        try:
            df = fetch_kala_candles(asset)
            if not df.empty:
                inserted = insert_trades(db_symbol, df)
                print(f"Kala {db_symbol}: inserted {inserted} new rows")
                total += inserted
            else:
                print(f"Kala {db_symbol}: No new data found.")
        except Exception as e:
            print(f"Error fetching Kala {db_symbol}: {e}")
    return total

if __name__ == "__main__":
    init_db()
    total = update_all_kala()
    print(f"\n=========================================")
    print(f"SYNC COMPLETE")
    print(f"Total Database Inserts: {total}")
    print(f"=========================================\n")