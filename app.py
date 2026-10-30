"""app.py"""
import asyncio
from datetime import datetime
from contextlib import asynccontextmanager

from fastapi import FastAPI, WebSocket, WebSocketDisconnect
from fastapi.responses import JSONResponse
from fastapi.staticfiles import StaticFiles
from apscheduler.schedulers.background import BackgroundScheduler
from apscheduler.triggers.interval import IntervalTrigger

# ---- Page Routers & Cache imports ----
from pages.index_page import router as index_router, _cache_clear
from pages.analysis_page import router as analysis_router
from pages.financials_page import router as financials_router
from pages.ai_page import router as ai_router

# ---- Global fetchers & DB init ----
from fetchers.crypto_fetcher import update_all_nobitex
from fetchers.commodities_fetcher import update_all_commodities
from fetchers.fetch_to_db import update_all_stocks
from fetchers.fetch_funda import init_fundamental_db, DEFAULT_DB
from fetchers.servatmandi import update_all_servatmandi
from fetchers.fetch_indexes import update_all_indexes 
from fetchers.kala_fetcher import update_all_kala
from fetchers.aseke_fetcher import update_aseke
from database import init_db
from config import BASE_DIR

# ============================================================
# WebSocket manager
# ============================================================
class ConnectionManager:
    def __init__(self):
        self.active_connections: list[WebSocket] = []
        self.loop = None

    async def connect(self, ws: WebSocket):
        await ws.accept()
        self.active_connections.append(ws)

    def disconnect(self, ws: WebSocket):
        if ws in self.active_connections:
            self.active_connections.remove(ws)

    async def broadcast(self, msg: str):
        for c in self.active_connections:
            try:
                await c.send_text(msg)
            except Exception:
                pass

    def broadcast_sync(self, msg: str):
        if self.loop is None:
            return
        asyncio.run_coroutine_threadsafe(self.broadcast(msg), self.loop)

manager = ConnectionManager()

# ============================================================
# Lifespan & Global Background Jobs
# ============================================================
@asynccontextmanager
async def lifespan(app: FastAPI):
    manager.loop = asyncio.get_running_loop()
    init_db()
    init_fundamental_db(DEFAULT_DB)

    scheduler = BackgroundScheduler()
    scheduler.add_job(lambda: update_and_broadcast_sync(),
                      trigger=IntervalTrigger(minutes=1),
                      id="update_stocks", replace_existing=True,
                      next_run_time=datetime.now())
    scheduler.add_job(lambda: update_and_broadcast_nobitex(),
                      trigger=IntervalTrigger(minutes=1),
                      id="update_nobitex", replace_existing=True,
                      next_run_time=datetime.now())
    scheduler.add_job(lambda: update_and_broadcast_commodities(),
                      trigger=IntervalTrigger(minutes=2),
                      id="update_commodities", replace_existing=True,
                      next_run_time=datetime.now())
    scheduler.add_job(lambda: update_and_broadcast_servatmandi(),
                      trigger=IntervalTrigger(minutes=5),
                      id="update_servatmandi", replace_existing=True,
                      next_run_time=datetime.now())
                      
    # ---- New Index Scheduler (Runs every 5 minutes) ----
    scheduler.add_job(lambda: update_and_broadcast_indexes(),
                      trigger=IntervalTrigger(minutes=5),
                      id="update_indexes", replace_existing=True,
                      next_run_time=datetime.now())
    scheduler.add_job(lambda: update_and_broadcast_kala(),
                      trigger=IntervalTrigger(minutes=15),
                      id="update_kala", replace_existing=True,
                      next_run_time=datetime.now())
    scheduler.add_job(lambda: update_and_broadcast_aseke(),
                      trigger=IntervalTrigger(minutes=15),
                      id="update_aseke", replace_existing=True,
                      next_run_time=datetime.now())
                      
    scheduler.start()
    print("Scheduler started.")
    yield
    scheduler.shutdown()
    print("Scheduler stopped.")

def update_and_broadcast_sync():
    n = update_all_stocks()
    if n > 0:
        _cache_clear(); manager.broadcast_sync("refresh")
    return n

def update_and_broadcast_indexes():
    n = update_all_indexes()
    if n > 0:
        _cache_clear(); manager.broadcast_sync("refresh")
    return n

def update_and_broadcast_nobitex():
    n = update_all_nobitex()
    if n > 0:
        _cache_clear(); manager.broadcast_sync("refresh")
    return n

def update_and_broadcast_commodities():
    n = update_all_commodities()
    if n > 0:
        _cache_clear(); manager.broadcast_sync("refresh")
    return n

def update_and_broadcast_servatmandi():
    n = update_all_servatmandi()
    if n > 0:
        _cache_clear(); manager.broadcast_sync("refresh")
    return n
def update_and_broadcast_kala():
    n = update_all_kala()
    if n > 0:
        _cache_clear(); manager.broadcast_sync("refresh")
    return n
def update_and_broadcast_aseke():
    n = update_aseke()
    if n > 0:
        _cache_clear(); manager.broadcast_sync("refresh")
    return n



# ============================================================
# Main App Construction
# ============================================================
app = FastAPI(title="Stock Platform", lifespan=lifespan)
app.mount("/static", StaticFiles(directory=str(BASE_DIR / "static")), name="static")

# Include the external page routers
app.include_router(index_router)
app.include_router(analysis_router)
app.include_router(financials_router)
app.include_router(ai_router)

# ============================================================
# Global/Infrastructure Endpoints
# ============================================================
@app.post("/api/update")
async def manual_update():
    """Triggers a manual database stock & index update and alerts clients globally via WS."""
    try:
        loop = asyncio.get_running_loop()
        n = await loop.run_in_executor(None, update_all_stocks)
        idx_n = await loop.run_in_executor(None, update_all_indexes)
        
        total_inserted = n + idx_n
        if total_inserted > 0:
            _cache_clear()
            await manager.broadcast("refresh")
            
        return JSONResponse(content={"status": "success", "inserted": total_inserted})
    except Exception as e:
        return JSONResponse(status_code=500,
                            content={"status": "error", "message": str(e)})

@app.websocket("/ws")
async def websocket_endpoint(ws: WebSocket):
    """Global WebSocket feed."""
    await manager.connect(ws)
    try:
        while True:
            await ws.receive_text()
    except WebSocketDisconnect:
        manager.disconnect(ws)