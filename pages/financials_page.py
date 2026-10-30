import asyncio
import sqlite3
import time
import traceback
from pathlib import Path
from threading import Lock
import pandas as pd

from fastapi import APIRouter, Request, BackgroundTasks
from fastapi.templating import Jinja2Templates
from fastapi.responses import JSONResponse, FileResponse
from config import INCODE_TO_NAME, BASE_DIR
from database import get_all_inscodes
from fetchers.fetch_funda import (
    scrape_symbol,
    ensure_db,
    export_symbol_to_excel,
    DEFAULT_DB,
    STATEMENT_TO_TABLE,
    SECTION_HEADER_ROWS,
    get_standard_row_list,
)

router = APIRouter()
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

STATEMENT_ORDER = [
    "Balance Sheet",
    "Income Statement",
    "Cash Flow",
    "Comprehensive Income",
]

DEFAULT_SUGGESTED_FIRMS = [
    {"symbol": "فملی", "name": "ملی صنایع مس ایران"},
    {"symbol": "شپنا", "name": "پالایش نفت اصفهان"},
    {"symbol": "فولاد", "name": "فولاد مبارکه اصفهان"},
    {"symbol": "فخوز", "name": "فولاد خوزستان"},
    {"symbol": "شبندر", "name": "پالایش نفت بندرعباس"},
    {"symbol": "شتران", "name": "پالایش نفت تهران"},
    {"symbol": "وبملت", "name": "بانک ملت"},
    {"symbol": "خودرو", "name": "ایران خودرو"},
    {"symbol": "کگل", "name": "معدنی و صنعتی گل گهر"},
    {"symbol": "کچاد", "name": "معدنی و صنعتی چادرملو"},
    {"symbol": "پارسان", "name": "نفت و گاز پارسیان"},
    {"symbol": "وغدیر", "name": "سرمایه‌گذاری غدیر"},
    {"symbol": "تاپیکو", "name": "سرمایه‌گذاری نفت و گاز و پتروشیمی تامین"},
]

# ============================================================
# On-demand Codal scrape guard
# ============================================================
_scrape_locks: dict[str, Lock] = {}
_scrape_locks_guard = Lock()
_scraped_recently: dict[str, float] = {}
SCRAPE_COOLDOWN = 60
SCRAPE_START_YEAR = 1395

def _get_scrape_lock(key: str) -> Lock:
    with _scrape_locks_guard:
        lock = _scrape_locks.get(key)
        if lock is None:
            lock = Lock()
            _scrape_locks[key] = lock
        return lock

def _scrape_symbol_sync(symbol: str, consolidated: bool = False, force: bool = False) -> dict:
    key = f"{symbol.strip()}:{1 if consolidated else 0}"
    lock = _get_scrape_lock(key)
    with lock:
        now = time.time()
        if not force and (now - _scraped_recently.get(key, 0.0) < SCRAPE_COOLDOWN):
            return {"skipped": True, "symbol": symbol}
        _scraped_recently[key] = now

        try:
            summary = scrape_symbol(
                symbol,
                db_name=DEFAULT_DB,
                start_year=SCRAPE_START_YEAR,
                consolidated=consolidated,
                sleep_s=0.25,
                export_excel=True,
            )
            print(f"[on-demand] {symbol} (consolidated={consolidated}): {summary}")
            return summary
        except Exception:
            print(f"[on-demand] {symbol} failed:")
            traceback.print_exc()
            return {"error": True, "symbol": symbol}

def _page_assets():
    try:
        inscodes = get_all_inscodes() or list(INCODE_TO_NAME.keys())
    except Exception:
        inscodes = list(INCODE_TO_NAME.keys())
    return [{"value": c, "label": INCODE_TO_NAME.get(c, c)} for c in inscodes]

def _query_standard_statement(symbol: str, statement: str, consolidated: bool = False) -> tuple[list[str], list[dict], str]:
    """
    Reads standardized statement rows from the dedicated table (`balance_sheet`,
    `income_statement`, `cash_flow_statement`, `comprehensive_income`) in `fundamental.db`.
    Returns `(columns, rows, company_name)`.
    """
    tbl_name = STATEMENT_TO_TABLE.get(statement, "balance_sheet")
    cons_int = 1 if consolidated else 0
    conn = ensure_db(DEFAULT_DB)
    try:
        cur = conn.cursor()
        cur.execute("SELECT name FROM companies WHERE TRIM(symbol) = ? LIMIT 1", (symbol,))
        c_row = cur.fetchone()
        company_name = c_row[0] if c_row and c_row[0] else symbol

        df = pd.read_sql_query(
            f"""
            SELECT year, end_date, row_index, item_name, value
            FROM {tbl_name}
            WHERE TRIM(symbol) = ? AND is_consolidated = ?
            ORDER BY row_index ASC, year DESC
            """,
            conn,
            params=(symbol, cons_int),
        )
    finally:
        conn.close()

    if df.empty:
        return [], [], company_name

    years_desc = sorted([int(y) for y in df["year"].dropna().unique().tolist()], reverse=True)
    col_keys = [str(y) for y in years_desc]

    std_rows = get_standard_row_list(statement) or []
    db_ordered_items = (
        df[["item_name", "row_index"]]
        .drop_duplicates(subset=["item_name"])
        .sort_values("row_index")["item_name"]
        .tolist()
    )
    ordered_items = list(std_rows) + [it for it in db_ordered_items if it not in std_rows]

    pivot = df.pivot_table(index="item_name", columns="year", values="value", aggfunc="first")

    rows_out: list[dict] = []
    for item_name in ordered_items:
        is_section = item_name in SECTION_HEADER_ROWS
        is_total = item_name.startswith("جمع ") or item_name in (
            "سود(زیان) ناخالص",
            "سود(زیان) عملیاتی",
            "سود(زیان) خالص",
            "سود(زیان) جامع سال",
            "خالص جریان نقدی ناشی از فعالیت های عملیاتی",
            "خالص جریان نقدی ناشی از فعالیت های سرمایه گذاری",
            "خالص جریان نقدی ناشی از فعالیت های تامین مالی",
            "خالص افزایش (کاهش) در موجودی نقد",
            "موجودی نقد در پایان دوره",
        )
        rec: dict = {
            "Item": item_name,
            "isSection": is_section,
            "isTotal": is_total,
        }
        has_any_val = False
        for y in years_desc:
            col_str = str(y)
            val = None
            if item_name in pivot.index and y in pivot.columns:
                raw_v = pivot.loc[item_name, y]
                if pd.notna(raw_v):
                    val = float(raw_v) if hasattr(raw_v, "item") else raw_v
                    has_any_val = True
            rec[col_str] = val

        # Always keep section headers and standard items that have values (or all standard items)
        if is_section or has_any_val or item_name in std_rows:
            rows_out.append(rec)

    return col_keys, rows_out, company_name

def _get_available_statements(symbol: str, consolidated: bool = False) -> list[str]:
    cons_int = 1 if consolidated else 0
    conn = ensure_db(DEFAULT_DB)
    available: list[str] = []
    try:
        cur = conn.cursor()
        for stmt_name, tbl_name in STATEMENT_TO_TABLE.items():
            cur.execute(
                f"SELECT 1 FROM {tbl_name} WHERE TRIM(symbol) = ? AND is_consolidated = ? AND value IS NOT NULL LIMIT 1",
                (symbol, cons_int),
            )
            if cur.fetchone():
                available.append(stmt_name)
    finally:
        conn.close()
    return available or STATEMENT_ORDER

# ============================================================
# Routes
# ============================================================
@router.get("/financials")
async def financials_page(request: Request):
    return templates.TemplateResponse(
        "fund.html",
        {"request": request, "assets": _page_assets()},
    )

@router.post("/api/financials/update")
async def trigger_fundamental_update(request: Request, background_tasks: BackgroundTasks):
    body = await request.json()
    symbol = (body.get("symbol") or "").strip()
    consolidated = bool(body.get("consolidated", False))
    run_sync = bool(body.get("sync", True))

    if not symbol:
        return JSONResponse(status_code=400, content={"error": "symbol required"})

    if run_sync:
        loop = asyncio.get_running_loop()
        summary = await loop.run_in_executor(
            None, _scrape_symbol_sync, symbol, consolidated, True
        )
        return JSONResponse(content={"status": "completed", "summary": summary})

    background_tasks.add_task(_scrape_symbol_sync, symbol, consolidated, True)
    return JSONResponse(content={"status": "Update initiated for " + symbol})

@router.get("/api/financials/symbols")
async def get_financial_symbols():
    try:
        conn = ensure_db(DEFAULT_DB)
        cur = conn.cursor()
        cur.execute("""
            SELECT c.symbol, COALESCE(NULLIF(c.name, ''), c.symbol)
            FROM companies c
            ORDER BY c.symbol
        """)
        db_rows = cur.fetchall()

        out: list[dict] = []
        seen_symbols: set[str] = set()

        for sym, name in db_rows:
            sym_clean = (sym or "").strip()
            if not sym_clean:
                continue
            seen_symbols.add(sym_clean)

            cur.execute(
                "SELECT COUNT(DISTINCT year), MAX(year), MIN(year) FROM balance_sheet WHERE TRIM(symbol) = ?",
                (sym_clean,),
            )
            cnt_row = cur.fetchone()
            rc = int(cnt_row[0] or 0) if cnt_row else 0
            latest = str(cnt_row[1] or "") if cnt_row and cnt_row[1] else None
            earliest = str(cnt_row[2] or "") if cnt_row and cnt_row[2] else None

            out.append({
                "symbol": sym_clean,
                "name": name or sym_clean,
                "statements": STATEMENT_ORDER,
                "report_count": rc,
                "latest": latest,
                "earliest": earliest,
                "in_db": rc > 0,
            })

        conn.close()

        for item in DEFAULT_SUGGESTED_FIRMS:
            if item["symbol"] not in seen_symbols:
                out.append({
                    "symbol": item["symbol"],
                    "name": item["name"],
                    "statements": STATEMENT_ORDER,
                    "report_count": 0,
                    "latest": None,
                    "earliest": None,
                    "in_db": False,
                })

        return JSONResponse(content={"companies": out})
    except Exception:
        print(f"ERROR in /api/financials/symbols: {traceback.format_exc()}")
        return JSONResponse(status_code=500, content={"error": "internal error"})

@router.get("/api/financials")
async def get_financials(
    symbol: str,
    statement: str = "Balance Sheet",
    consolidated: int = 0,
):
    cs = (symbol or "").strip()
    if not cs:
        return JSONResponse(status_code=400, content={"error": "symbol required"})

    is_cons = bool(consolidated)
    cols, rows, company_name = _query_standard_statement(cs, statement, consolidated=is_cons)

    # If not yet in fundamental.db, scrape Codal on demand and re-query
    if not cols:
        print(f"[on-demand] '{cs}' (consolidated={is_cons}) missing in fundamental.db — scraping Codal…")
        loop = asyncio.get_running_loop()
        try:
            await loop.run_in_executor(None, _scrape_symbol_sync, cs, is_cons, False)
        except Exception:
            traceback.print_exc()

        cols, rows, company_name = _query_standard_statement(cs, statement, consolidated=is_cons)

    available = _get_available_statements(cs, consolidated=is_cons)

    if not cols:
        return JSONResponse(
            status_code=404,
            content={
                "error": f"No standardized statement found for '{cs}' ({statement})",
                "symbol": cs,
                "company_name": company_name,
                "statement": statement,
                "consolidated": is_cons,
                "available_statements": available,
                "columns": [],
                "rows": [],
            },
        )

    return JSONResponse(
        content={
            "symbol": cs,
            "company_name": company_name,
            "statement": statement,
            "consolidated": is_cons,
            "columns": cols,
            "rows": rows,
            "available_statements": available,
            "database": "fundamental.db",
            "table": STATEMENT_TO_TABLE.get(statement, "balance_sheet"),
        }
    )

@router.get("/api/financials/export")
async def export_financials_excel(symbol: str, consolidated: int = 0):
    cs = (symbol or "").strip()
    if not cs:
        return JSONResponse(status_code=400, content={"error": "symbol required"})

    is_cons = bool(consolidated)
    loop = asyncio.get_running_loop()
    out_path = await loop.run_in_executor(
        None, export_symbol_to_excel, cs, DEFAULT_DB, is_cons
    )
    filename = Path(out_path).name
    return FileResponse(
        path=out_path,
        filename=filename,
        media_type="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    )