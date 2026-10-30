import time
from threading import Lock
import pandas as pd
from fastapi import APIRouter, Request, Query
from fastapi.templating import Jinja2Templates
from fastapi.responses import JSONResponse
from config import INCODE_TO_NAME, TIMEFRAMES, BASE_DIR
from database import get_stock_data, get_all_inscodes

router = APIRouter()
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

# ============================================================
# Response cache
# ============================================================
_data_cache = {}
_data_cache_lock = Lock()
_DATA_CACHE_TTL = 20
_DATA_CACHE_MAX_ENTRIES = 256

def _cache_get(key):
    with _data_cache_lock:
        entry = _data_cache.get(key)
        if not entry:
            return None
        ts, payload = entry
        if time.time() - ts > _DATA_CACHE_TTL:
            _data_cache.pop(key, None)
            return None
        return payload

def _cache_set(key, payload):
    with _data_cache_lock:
        _data_cache[key] = (time.time(), payload)
        if len(_data_cache) > _DATA_CACHE_MAX_ENTRIES:
            oldest = min(_data_cache.items(), key=lambda kv: kv[1][0])
            _data_cache.pop(oldest[0], None)

def _cache_clear():
    with _data_cache_lock:
        _data_cache.clear()

# ============================================================
# Market data helpers
# ============================================================
def resample_ohlcv(df, timeframe):
    if df.empty:
        return df
    offset = TIMEFRAMES.get(timeframe)
    if not offset:
        raise ValueError(f"Invalid timeframe: {timeframe}")

    r = df.resample(offset).agg({
        'open': 'first', 'high': 'max', 'low': 'min',
        'close': 'last', 'volume': 'sum',
    })

    return r.dropna(subset=['open', 'high', 'low', 'close'])

def df_to_chart_data(df):
    """
    Serializes resampled OHLCV DataFrame for TradingView Lightweight Charts.
    Ensures `time` is a strictly ascending, deduplicated Unix timestamp (seconds)
    so Lightweight Charts never encounters out-of-order or duplicate time assertions.
    """
    if df.empty:
        return {"data": [], "extra": {}}
    df = df.reset_index()
    # Normalize to Unix seconds (UTCTimestamp) across all pandas datetime64 resolutions
    df['time']    = ((df['datetime'] - pd.Timestamp("1970-01-01")) // pd.Timedelta('1s')).astype('int64')
    df['timeStr'] = df['datetime'].dt.strftime('%Y-%m-%d %H:%M:%S')
    df = df.drop(columns=['datetime'])
    cols = ['time', 'timeStr', 'open', 'high', 'low', 'close', 'volume']
    df = df.dropna(subset=['time', 'open', 'high', 'low', 'close', 'volume'])
    df = df.sort_values('time').drop_duplicates(subset=['time'], keep='last')
    return {"data": df[cols].to_dict(orient='records'), "extra": {}}

# ============================================================
# Routes
# ============================================================
@router.get("/")
async def index(request: Request, asset: str = None, timeframe: str = None):
    inscodes = get_all_inscodes() or list(INCODE_TO_NAME.keys())
    assets = [{"value": c, "label": INCODE_TO_NAME.get(c, c)} for c in inscodes]
    timeframes = list(TIMEFRAMES.keys())
    selected_asset = asset or next(
        (a['value'] for a in assets if "Ayar" in a['label']), None
    ) or (assets[0]['value'] if assets else None)
    selected_timeframe = timeframe if timeframe in timeframes else (
        "1d" if "1d" in timeframes else (timeframes[0] if timeframes else '5m')
    )
    return templates.TemplateResponse("index.html", {
        "request": request, "assets": assets, "timeframes": timeframes,
        "selected_asset": selected_asset, "selected_timeframe": selected_timeframe,
    })

@router.get("/data/{asset}/{timeframe}")
async def get_data(asset: str, timeframe: str,
                   limit: int = Query(10000, ge=1, le=10000)):
    try:
        if timeframe not in TIMEFRAMES:
            return JSONResponse(status_code=400,
                                content={"error": f"Invalid timeframe: {timeframe}"})
        key = (asset, timeframe, limit)
        cached = _cache_get(key)
        if cached is not None:
            return JSONResponse(content=cached)

        df = get_stock_data(asset)
        if df.empty:
            return JSONResponse(content={"chart_data": [], "extra_data": {}})

        df = resample_ohlcv(df, timeframe)
        if df.empty:
            return JSONResponse(content={"chart_data": [], "extra_data": {}})

        df = df.sort_index()
        if limit > 0 and len(df) > limit:
            df = df.tail(limit)

        chart = df_to_chart_data(df)
        payload = {"chart_data": chart["data"], "extra_data": chart["extra"]}

        _cache_set(key, payload)
        return JSONResponse(content=payload)
    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})
