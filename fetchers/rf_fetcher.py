import requests
import re
from datetime import date, datetime
import jdatetime
import pandas as pd
import concurrent.futures

# ==========================================
# 1. TSETMC (AKHZA) - IRANIAN RIAL RISK-FREE
# ==========================================
TSETMC_API_URL = "https://cdn.tsetmc.com/api/ClosingPrice/GetTradeTop/FutureBedehiOTC/3/9999"

AKHZA_FALLBACKS = [
    {'symbol': 'اخزا202', 'maturity_date': '1405-09-23', 'days_to_maturity': 96, 'ytm': 0.4042, 'market': 'TSETMC Akhza (IRR)'},
    {'symbol': 'اخزا213', 'maturity_date': '1405-10-21', 'days_to_maturity': 124, 'ytm': 0.3935, 'market': 'TSETMC Akhza (IRR)'},
    {'symbol': 'اخزا210', 'maturity_date': '1405-11-12', 'days_to_maturity': 145, 'ytm': 0.3824, 'market': 'TSETMC Akhza (IRR)'},
    {'symbol': 'اخزا301', 'maturity_date': '1406-06-15', 'days_to_maturity': 362, 'ytm': 0.3989, 'market': 'TSETMC Akhza (IRR)'},
    {'symbol': 'اخزا405', 'maturity_date': '1407-04-20', 'days_to_maturity': 670, 'ytm': 0.4086, 'market': 'TSETMC Akhza (IRR)'},
]

def parse_maturity_from_lval30(lval30):
    match = re.search(r'(\d{6})$', lval30)
    if not match: return None
    digits = match.group(1)
    year, month, day = int(digits[0:2]) + 1400, int(digits[2:4]), int(digits[4:6])
    if not (1 <= month <= 12 and 1 <= day <= 31): return None
    return f"{year:04d}-{month:02d}-{day:02d}"

def calculate_ytm(price, face_value=1_000_000, days_to_maturity=1):
    if price <= 0 or days_to_maturity <= 0: return None
    return (face_value / price) ** (365.0 / days_to_maturity) - 1

def fetch_active_akhza_bonds():
    headers = {"User-Agent": "Mozilla/5.0", "Accept": "application/json"}
    try:
        data = requests.get(TSETMC_API_URL, headers=headers, timeout=8).json()
    except Exception as e:
        print(f"⚠️ Failed to fetch TSETMC API data: {e}")
        return AKHZA_FALLBACKS

    active_bonds = []
    today = date.today()

    for item in data.get("tradeTop", []):
        instrument = item.get("instrument", {})
        lval18afc = instrument.get("lVal18AFC", "")
        if not lval18afc.startswith("اخزا"): continue

        price = item.get("pClosing", 0)
        lval30 = instrument.get("lVal30", "")
        if not lval30 or price <= 0: continue

        persian_maturity = parse_maturity_from_lval30(lval30)
        if not persian_maturity: continue

        try:
            y, m, d = map(int, persian_maturity.split('-'))
            gregorian_maturity = jdatetime.date(y, m, d).togregorian()
            days_to_maturity = (gregorian_maturity - today).days

            if days_to_maturity > 0:
                ytm_val = calculate_ytm(price, face_value=1_000_000, days_to_maturity=days_to_maturity)
                if ytm_val is not None:
                    active_bonds.append({
                        'symbol': lval18afc,
                        'maturity_date': persian_maturity,
                        'days_to_maturity': days_to_maturity,
                        'ytm': ytm_val,
                        'market': 'TSETMC Akhza (IRR)'
                    })
        except Exception:
            continue

    return active_bonds if active_bonds else AKHZA_FALLBACKS

def get_optimal_akhza_rate(target_days=365):
    bonds = fetch_active_akhza_bonds()
    return min(bonds, key=lambda b: abs(b['days_to_maturity'] - target_days))

# ==========================================
# 2. US TREASURY - USD RISK-FREE (FRED)
# ==========================================
US_FALLBACK_BONDS = [
    {'symbol': 'US T-Bill (1M)', 'maturity_date': '1 Month', 'days_to_maturity': 30, 'ytm': 0.0435, 'market': 'US Treasury (USD)'},
    {'symbol': 'US T-Bill (3M)', 'maturity_date': '3 Months', 'days_to_maturity': 90, 'ytm': 0.0440, 'market': 'US Treasury (USD)'},
    {'symbol': 'US T-Bill (6M)', 'maturity_date': '6 Months', 'days_to_maturity': 180, 'ytm': 0.0430, 'market': 'US Treasury (USD)'},
    {'symbol': 'US T-Bill (1Y)', 'maturity_date': '1 Year', 'days_to_maturity': 365, 'ytm': 0.0415, 'market': 'US Treasury (USD)'},
    {'symbol': 'US T-Note (2Y)', 'maturity_date': '2 Years', 'days_to_maturity': 730, 'ytm': 0.0395, 'market': 'US Treasury (USD)'},
    {'symbol': 'US T-Note (5Y)', 'maturity_date': '5 Years', 'days_to_maturity': 1825, 'ytm': 0.0390, 'market': 'US Treasury (USD)'},
    {'symbol': 'US T-Note (10Y)', 'maturity_date': '10 Years', 'days_to_maturity': 3650, 'ytm': 0.0410, 'market': 'US Treasury (USD)'},
]

def fetch_us_yield_curve():
    series_ids = {
        "DGS1MO": {"symbol": "US T-Bill (1M)", "days": 30},
        "DGS3MO": {"symbol": "US T-Bill (3M)", "days": 90},
        "DGS6MO": {"symbol": "US T-Bill (6M)", "days": 180},
        "DGS1":   {"symbol": "US T-Bill (1Y)", "days": 365},
        "DGS2":   {"symbol": "US T-Note (2Y)", "days": 730},
        "DGS5":   {"symbol": "US T-Note (5Y)", "days": 1825},
        "DGS10":  {"symbol": "US T-Note (10Y)", "days": 3650},
    }
    
    us_bonds = []

    def fetch_fred(series_id, info):
        url = f"https://fred.stlouisfed.org/graph/fredgraph.csv?id={series_id}"
        try:
            df = pd.read_csv(url, parse_dates=True, index_col='DATE', na_values='.', timeout=4)
            df = df.dropna()
            if not df.empty:
                return {
                    'symbol': info["symbol"],
                    'maturity_date': df.index[-1].strftime('%Y-%m-%d'),
                    'days_to_maturity': info["days"],
                    'ytm': float(df.iloc[-1].iloc[0]) / 100.0,
                    'market': 'US Treasury (USD)'
                }
        except Exception:
            pass
        return None

    with concurrent.futures.ThreadPoolExecutor(max_workers=7) as executor:
        futures = [executor.submit(fetch_fred, sid, info) for sid, info in series_ids.items()]
        for future in concurrent.futures.as_completed(futures):
            res = future.result()
            if res: us_bonds.append(res)
                
    return sorted(us_bonds, key=lambda x: x['days_to_maturity']) if us_bonds else US_FALLBACK_BONDS

def get_optimal_usd_rate(target_days=365):
    bonds = fetch_us_yield_curve()
    return min(bonds, key=lambda b: abs(b['days_to_maturity'] - target_days))

# Compatibility alias
get_optimal_rf_rate = get_optimal_akhza_rate