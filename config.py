"""
config.py
----------
Central configuration for the stock platform.
"""

from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
DB_PATH = BASE_DIR / "stocks.db"

# ---- TSETMC symbols (for the TSETMC fetcher) ----
TSETMC_INSCODES = [
    "17914401175772326",   # Ahrom
    "34144395039913458",   # Ayar
    "26581180478947817",   # Plata
    "8620139816622134",    # Noghrabi
    "12913156843322499",   # Nahal
    "15001802434062073",   # Sinerji
    "53633583359422860",   # Miras
    "67141987086032267",   # Moj
    "7745894403636165"     # Shepna
]

# ---- Full mapping for UI dropdown (all stocks and indexes) ----
INCODE_TO_NAME = {
    # ---- Newly Added Indexes ----
    "32097828799138957": "ShaxesKol",
    "67130298613737946": "shaxeshamvazn",
    
    # ---- TSETMC Stocks ----
    "17914401175772326": "Ahrom",
    "7745894403636165": "Shepna",
    "34144395039913458": "Ayar",
    "53633583359422860": "Miras",
    "26581180478947817": "Plata",
    "8620139816622134":  "Noghrabi",
    "12913156843322499": "Nahal",
    "15001802434062073": "Sinerji",
    "67141987086032267": "Moj",
    "18650546575861744": "ASeke",
    
    # ---- Crypto & Forex ----
    "USDTIRT": "USDTIRT",
    "BTCUSDT": "BTCUSDT",
    "PAXGUSDT": "PAXG/USDT",
    "XAUTUSDT": "XAUT/USDT",
    "XAUTIRT": "XAUT/IRT",
    "XAUUSD": "Gold (XAU/USD)",
    "XAGUSD": "Silver (XAG/USD)",
    
    # ---- Servatmandi Assets ----
    "geramTalaHejdah": "Geram Tala 18",
    "tala18Etehadiye": "Tala 18 etehadiye",
    "abshode": "abshode",
    "Dollar": "Dollar",

    # ---- Kala Assets ----
    "Tala995": "Shemsh Tala 995",
    "Noghre999": "Shemsh Noghre 999",
    "Seke": "Seke Markazi"

}

API_BASE = "https://cdn.tsetmc.com/api/Trade/GetTrade/{}"

TIMEFRAMES = {
    "1m": "1min",
    "5m":  "5min",
    "10m": "10min",
    "15m": "15min",
    "30m": "30min",
    "1h":  "1h",
    "4h":  "4h",
    "1d":  "1D"
}