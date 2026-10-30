#!/usr/bin/env python3
"""
fetch_funda.py — Standardized Multi-Year Codal Financial Statement Scraper & Database Engine
=============================================================================================
Fetches 12-month financial statements (Balance Sheet, Income Statement, Cash Flow Statement,
and Comprehensive Income) for ANY Iranian listed company from Codal (search.codal.ir /
excel.codal.ir / codal.ir), maps line items into canonical accounting schemas, and stores
them in a separate SQLite database (`fundamental.db`) with dedicated standard tables:
  - `balance_sheet`
  - `income_statement`
  - `cash_flow_statement`
  - `comprehensive_income`
as well as normalized relational tables (`companies`, `statement_metadata`, `reports`,
`line_items`, `financial_facts`) and optional Excel workbook export.

Key fixes over legacy notebook / scraper:
  1. Eliminates firm-locked URL query parameters (`IndustryGroup`, `Name`, `name`,
     `ReportingType=1000000`, `CompanyType=1`) so the search works universally across all
     TSE / FaraBourse symbols (e.g., فملی, شپنا, فولاد, وبملت, خودرو, پارسان, کگل, etc.).
  2. Properly formats boolean flags (`Audited=true`, `Mains=true`, `Consolidatable=true`,
     `NotConsolidatable=true`, `Childs=false`, `LetterType=6`, `Length=12`) required by
     `https://search.codal.ir/api/search/v2/q`.
  3. Extracts `LetterSerial` from `LetterSerial`, `Url` (`?LetterSerial=...`), or `ExcelUrl`
     (`/GetAll/{serial}/0`), and extracts the fiscal year & period-end date (`YYYY/MM/DD`)
     from both `ToDate` and `Title` (which is where Codal v2 API places them).
  4. Supports `.xls`, `.xlsx`, HTML tables (`rayanDynamicStatement`, 8-column side-by-side
     balance sheets, `tblGridHeader`), and embedded `var datasource = {...}` JSON, plus
     automatic prior-year comparative column backfill (`سال مالی قبل`).
"""
from __future__ import annotations

import io
import json
import logging
import os
import re
import sqlite3
import time
import urllib.parse
from io import BytesIO
from pathlib import Path
from typing import Optional

import numpy as np
import pandas as pd
import requests
from bs4 import BeautifulSoup

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s  %(levelname)-7s  %(message)s",
    datefmt="%H:%M:%S",
)
log = logging.getLogger("fetch_funda")

BASE_DIR = Path(__file__).resolve().parent.parent
DEFAULT_DB = str(BASE_DIR / "fundamental.db")
OUT_DIR = str(BASE_DIR / "codal_reports")

DEFAULT_TARGET_YEARS = [1395, 1396, 1397, 1398, 1399, 1400, 1401, 1402, 1403, 1404]

HTTP_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/122.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "fa-IR,fa;q=0.9,en-US;q=0.8,en;q=0.7",
    "Origin": "https://codal.ir",
    "Referer": "https://codal.ir/",
}

# ============================================================================
# 1. Standard Line Item Definitions (Balance Sheet, Income, Cash Flow, Comp.)
# ============================================================================

STANDARD_BALANCE_ROWS: list[str] = [
    "دارایی های غیرجاری",
    "حساب ها و اسناد دریافتنی بلندمدت",
    "سرمایه گذاری های بلند مدت",
    "دارایی های ثابت مشهود",
    "دارایی های ثابت نامشهود",
    "سایر دارایی ها",
    "جمع دارایی های غیرجاری",
    "دارایی های جاری",
    "موجودی نقد",
    "سرمایه گذاری های کوتاه مدت",
    "دریافتنی های تجاری و سایر دریافتنی ها",
    "حساب ها و اسناد دریافتنی تجاری",
    "سایر حساب ها و اسناد دریافتنی",
    "طلب از شرکت های گروه و شرکت های وابسته",
    "موجودی مواد و کالا",
    "سفارشات",
    "پیش پرداخت ها",
    "پیش پرداخت ها و سفارشات",
    "دارایی های غیرجاری نگهداری شده برای فروش",
    "جمع دارایی های جاری",
    "جمع دارایی ها",
    "حقوق صاحبان سهام",
    "سرمایه",
    "دریافتی بابت افزایش سرمایه",
    "سهام خزانه",
    "صرف سهام خزانه",
    "اندوخته قانونی",
    "سایر اندوخته ها",
    "سود(زیان) انباشته",
    "جمع حقوق صاحبان سهام",
    "بدهی های غیرجاری",
    "تسهیلات مالی دریافتی بلندمدت",
    "حساب ها و اسناد پرداختنی بلندمدت",
    "ذخیره مزایای پایان خدمت کارکنان",
    "جمع بدهی های غیرجاری",
    "بدهی های جاری",
    "پرداختنی تجاری و سایر پرداختنی ها",
    "حساب ها و اسناد پرداختنی تجاری",
    "بدهی به شرکت های گروه و وابسته",
    "سایر حساب ها و اسناد پرداختنی",
    "مالیات پرداختنی",
    "پیش دریافت ها",
    "ذخیره مالیات",
    "پیش دریافت های جاری",
    "سود سهام پرداختنی",
    "تسهیلات مالی دریافتی",
    "جمع بدهی های جاری",
    "جمع بدهی ها",
    "جمع بدهی ها و حقوق صاحبان سهام",
]

STANDARD_INCOME_ROWS: list[str] = [
    "درآمدهای عملیاتی",
    "بهای تمام شده درآمد های عملیاتی",
    "سود(زیان) ناخالص",
    "هزینه های فروش و اداری و عمومی",
    "سایر درآمدها",
    "سایر هزینه ها",
    "خالص سایر درآمدهای عملیاتی",
    "جمع هزینه ها",
    "سود(زیان) عملیاتی",
    "هزینه های مالی",
    "سایر درآمدها و هزینه‌های غیرعملیاتی- درآمد سرمایه‌ گذاری‌ها",
    "سایر درآمدها و هزینه‌های غیرعملیاتی- اقلام متفرقه",
    "سایر درآمدها و هزینه‌های غیرعملیاتی",
    "سود(زیان) قبل از اقلام غیر مترقبه و اثرات انباشته تغییر در اصول و روش های حسابداری",
    "سود(زیان) عملیات در حال تداوم قبل از مالیات",
    "مالیات سال جاری",
    "مالیات سال های قبل",
    "سود(زیان) خالص عملیات در حال تداوم",
    "سود(زیان) خالص",
    "سود(زیان) انباشته ابتدای دوره",
    "تعدیلات سنواتی",
    "سود(زیان) انباشته ابتدای دوره تعدیل شده",
    "سود(زیان) انباشته ابتدای دوره تخصیص نیافته",
    "سود قابل تخصیص",
    "اندوخته قانونی",
    "سایر اندوخته ها",
    "افزایش سرمایه از محل سود انباشته",
    "سود سهام پیشنهادی",
    "پاداش هیئت مدیره",
    "جمع تغییرات در سود انباشته",
    "سود(زیان) انباشته پایان دوره",
    "عملیاتی (ریال)",
    "غیرعملیاتی (ریال)",
    "سود ناشی از عملیات در حال تداوم هر سهم",
    "سود ناشی از عملیات متوقف شده هر سهم",
    "سود(زیان) پایه هر سهم",
    "سود(زیان) خالص هر سهم",
    "سرمایه",
]

STANDARD_CASHFLOW_ROWS: list[str] = [
    "جریان های نقدی حاصل از فعالیت های عملیاتی",
    "نقد دریافتی از مشتریان",
    "نقد پرداختی به تامین کنندگان و کارکنان",
    "نقد حاصل از عملیات",
    "سود تضمین شده و کارمزد پرداختی",
    "مالیات بر درآمد پرداختی",
    "سایر دریافت ها و پرداخت های عملیاتی",
    "خالص جریان نقدی ناشی از فعالیت های عملیاتی",
    "جریان های نقدی حاصل از فعالیت های سرمایه گذاری",
    "وجوه پرداختی بابت خرید دارایی های ثابت مشهود",
    "وجوه دریافتی ناشی از فروش دارایی های ثابت مشهود",
    "وجوه پرداختی بابت خرید دارایی های نامشهود",
    "وجوه پرداختی بابت تحصیل سرمایه گذاری ها",
    "وجوه دریافتی ناشی از فروش سرمایه گذاری ها",
    "سود دریافتی بابت سرمایه گذاری ها و سپرده ها",
    "سایر جریان های نقدی فعالیت های سرمایه گذاری",
    "خالص جریان نقدی ناشی از فعالیت های سرمایه گذاری",
    "جریان های نقدی حاصل از فعالیت های تامین مالی",
    "وجوه دریافتی حاصل از افزایش سرمایه",
    "وجوه دریافتی حاصل از تسهیلات مالی",
    "بازپرداخت اصل تسهیلات مالی",
    "سود تسهیلات مالی پرداختی",
    "سود سهام پرداختی به سهامداران",
    "سایر جریان های نقدی فعالیت های تامین مالی",
    "خالص جریان نقدی ناشی از فعالیت های تامین مالی",
    "خالص افزایش (کاهش) در موجودی نقد",
    "موجودی نقد در ابتدای دوره",
    "تاثیر تغییرات نرخ ارز بر موجودی نقد",
    "موجودی نقد در پایان دوره",
]

STANDARD_COMPREHENSIVE_ROWS: list[str] = [
    "سود(زیان) خالص",
    "مازاد تجدید ارزیابی دارایی های ثابت مشهود",
    "سود(زیان) تحقق نیافته ناشی از تغییر ارزش سرمایه گذاری ها",
    "تفاوت تسعیر ارز عملیات خارجی",
    "سود(زیان) اکتواریایی مزایای پایان خدمت کارکنان",
    "سایر اقلام سود و زیان جامع",
    "جمع سایر اقلام سود و زیان جامع",
    "سود(زیان) جامع سال",
]

SECTION_HEADER_ROWS = {
    "دارایی های غیرجاری",
    "دارایی های جاری",
    "حقوق صاحبان سهام",
    "بدهی های غیرجاری",
    "بدهی های جاری",
    "جریان های نقدی حاصل از فعالیت های عملیاتی",
    "جریان های نقدی حاصل از فعالیت های سرمایه گذاری",
    "جریان های نقدی حاصل از فعالیت های تامین مالی",
}

def get_statement_variants(consolidated: bool) -> dict[str, list[str]]:
    if consolidated:
        return {
            "Balance Sheet": ["صورت وضعیت مالی تلفیقی", "ترازنامه تلفیقی"],
            "Income Statement": ["صورت سود و زیان تلفیقی"],
            "Comprehensive Income": ["صورت سود و زیان جامع تلفیقی"],
            "Cash Flow": [
                "صورت جریان های نقدی تلفیقی",
                "صورت جریان‌های نقدی تلفیقی",
                "صورت جریان وجوه نقد تلفیقی",
                "جریان وجوه نقد تلفیقی",
            ],
        }
    return {
        "Balance Sheet": ["صورت وضعیت مالی", "ترازنامه"],
        "Income Statement": ["صورت سود و زیان"],
        "Comprehensive Income": ["صورت سود و زیان جامع"],
        "Cash Flow": [
            "صورت جریان های نقدی",
            "صورت جریان‌های نقدی",
            "صورت جریان وجوه نقد",
            "جریان وجوه نقد",
        ],
    }

STATEMENT_TO_TABLE = {
    "Balance Sheet": "balance_sheet",
    "Income Statement": "income_statement",
    "Trends": "income_statement",
    "Cash Flow": "cash_flow_statement",
    "Comprehensive Income": "comprehensive_income",
}

STATEMENT_TO_FA_SHEET = {
    "Balance Sheet": "ترازنامه",
    "Income Statement": "سود و زیان",
    "Cash Flow": "جریان نقدی",
    "Comprehensive Income": "سود و زیان جامع",
}

# ============================================================================
# 2. Persian Text & Number Normalization Helpers
# ============================================================================

_AR2FA = str.maketrans({
    "ي": "ی",
    "ى": "ی",
    "ك": "ک",
    "۰": "0",
    "۱": "1",
    "۲": "2",
    "۳": "3",
    "۴": "4",
    "۵": "5",
    "۶": "6",
    "۷": "7",
    "۸": "8",
    "۹": "9",
    "٠": "0",
    "١": "1",
    "٢": "2",
    "٣": "3",
    "٤": "4",
    "٥": "5",
    "٦": "6",
    "٧": "7",
    "٨": "8",
    "٩": "9",
    "\u200c": " ",
    "\u200f": "",
    "\u200e": "",
    "\xa0": " ",
    "\u064B": "",
    "\u064C": "",
    "\u064D": "",
    "‌": " ",
    "‏": " ",
})

def norm_label(s) -> str:
    if s is None or (isinstance(s, float) and np.isnan(s)):
        return ""
    s = str(s).translate(_AR2FA)
    s = re.sub(r"[\(\（]\s*", "(", s)
    s = re.sub(r"\s*[\)\）]", ")", s)
    s = re.sub(r"\s*[-–—_]\s*", "-", s)
    s = re.sub(r"\s+", " ", s)
    return s.strip().lower()

def parse_number(v) -> Optional[float]:
    if v is None or (isinstance(v, float) and np.isnan(v)):
        return None
    if isinstance(v, (int, float, np.number)) and not isinstance(v, bool):
        fv = float(v)
        return None if np.isnan(fv) else fv
    s = str(v).translate(_AR2FA).replace(",", "").replace("٬", "").strip()
    negative = False
    if s.startswith("(") and s.endswith(")"):
        negative = True
        s = s[1:-1].strip()
    if s in ("", "-", "—", "--", "nan", "none", "null"):
        return None
    s = re.sub(r"[^\d\.\-]", "", s)
    if s in ("", ".", "-"):
        return None
    try:
        val = float(s)
    except ValueError:
        return None
    return -val if negative else val

def is_date_value(v) -> bool:
    if v is None:
        return False
    try:
        fv = float(v)
    except Exception:
        return False
    return 13000000 < abs(fv) < 15000000

# ============================================================================
# 3. Database Schema & Storage Layer (`fundamental.db`)
# ============================================================================

def _ensure_parent_dir(db_path: str) -> None:
    parent = Path(db_path).expanduser().resolve().parent
    if not parent.exists():
        parent.mkdir(parents=True, exist_ok=True)

def _create_schema(cur: sqlite3.Cursor) -> None:
    cur.execute("""
        CREATE TABLE IF NOT EXISTS companies (
            company_id INTEGER PRIMARY KEY AUTOINCREMENT,
            symbol     TEXT UNIQUE,
            name       TEXT,
            updated_at TEXT
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS statement_metadata (
            id              INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id      INTEGER,
            firm_symbol     TEXT,
            year            TEXT,
            end_date        TEXT,
            is_consolidated INTEGER DEFAULT 0,
            letter_serial   TEXT,
            tracing_no      INTEGER,
            title           TEXT,
            publish_date    TEXT,
            FOREIGN KEY(company_id) REFERENCES companies(company_id),
            UNIQUE(firm_symbol, year, is_consolidated)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS line_items (
            item_id        INTEGER PRIMARY KEY AUTOINCREMENT,
            statement_type TEXT,
            item_name      TEXT,
            row_order      INTEGER DEFAULT 999,
            UNIQUE(statement_type, item_name)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS reports (
            report_id       INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id      INTEGER,
            tracing_no      INTEGER UNIQUE,
            period_length   INTEGER,
            end_date        TEXT,
            year            INTEGER,
            is_consolidated INTEGER DEFAULT 0,
            letter_serial   TEXT,
            FOREIGN KEY(company_id) REFERENCES companies(company_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS financial_facts (
            fact_id         INTEGER PRIMARY KEY AUTOINCREMENT,
            report_id       INTEGER,
            item_id         INTEGER,
            data_period     TEXT,
            is_restated     BOOLEAN DEFAULT 0,
            is_consolidated INTEGER DEFAULT 0,
            audit_status    TEXT,
            value           REAL,
            FOREIGN KEY(report_id) REFERENCES reports(report_id),
            FOREIGN KEY(item_id)   REFERENCES line_items(item_id)
        )
    """)
    cur.execute("""
        CREATE TABLE IF NOT EXISTS report_tables (
            table_id      INTEGER PRIMARY KEY AUTOINCREMENT,
            company_id    INTEGER NOT NULL,
            report_id     INTEGER NOT NULL,
            section_title TEXT,
            table_title   TEXT,
            table_index   INTEGER NOT NULL,
            rows_json     TEXT NOT NULL,
            FOREIGN KEY(company_id) REFERENCES companies(company_id),
            FOREIGN KEY(report_id)  REFERENCES reports(report_id),
            UNIQUE(report_id, table_index)
        )
    """)

    # Dedicated Standard Statement Tables (1 table per core financial statement)
    for tbl_name in ("balance_sheet", "income_statement", "cash_flow_statement", "comprehensive_income"):
        cur.execute(f"""
            CREATE TABLE IF NOT EXISTS {tbl_name} (
                id              INTEGER PRIMARY KEY AUTOINCREMENT,
                symbol          TEXT NOT NULL,
                company_name    TEXT,
                year            INTEGER NOT NULL,
                end_date        TEXT,
                is_consolidated INTEGER NOT NULL DEFAULT 0,
                row_index       INTEGER NOT NULL,
                item_name       TEXT NOT NULL,
                value           REAL,
                letter_serial   TEXT,
                UNIQUE(symbol, year, is_consolidated, item_name)
            )
        """)
        cur.execute(f"CREATE INDEX IF NOT EXISTS idx_{tbl_name}_sym_yr ON {tbl_name}(symbol, is_consolidated, year)")

    cur.execute("CREATE INDEX IF NOT EXISTS idx_reports_company ON reports(company_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_facts_report    ON financial_facts(report_id)")
    cur.execute("CREATE INDEX IF NOT EXISTS idx_facts_item      ON financial_facts(item_id)")

    # Safe migrations if fundamental.db already existed from an older schema version
    for alter_sql in [
        "ALTER TABLE companies ADD COLUMN updated_at TEXT",
        "ALTER TABLE line_items ADD COLUMN row_order INTEGER DEFAULT 999",
        "ALTER TABLE reports ADD COLUMN year INTEGER",
        "ALTER TABLE reports ADD COLUMN is_consolidated INTEGER DEFAULT 0",
        "ALTER TABLE reports ADD COLUMN letter_serial TEXT",
        "ALTER TABLE financial_facts ADD COLUMN is_consolidated INTEGER DEFAULT 0",
        "ALTER TABLE statement_metadata ADD COLUMN end_date TEXT",
        "ALTER TABLE statement_metadata ADD COLUMN is_consolidated INTEGER DEFAULT 0",
        "ALTER TABLE statement_metadata ADD COLUMN tracing_no INTEGER",
        "ALTER TABLE statement_metadata ADD COLUMN title TEXT",
    ]:
        try:
            cur.execute(alter_sql)
        except sqlite3.OperationalError:
            pass

def init_fundamental_db(db_name: str = DEFAULT_DB) -> str:
    db_path = str(Path(db_name).expanduser().resolve())
    _ensure_parent_dir(db_path)
    conn = sqlite3.connect(db_path, timeout=30.0)
    try:
        conn.execute("PRAGMA journal_mode=WAL")
        cur = conn.cursor()
        _create_schema(cur)
        conn.commit()
    finally:
        conn.close()
    return db_path

def ensure_db(db_name: str = DEFAULT_DB) -> sqlite3.Connection:
    path = init_fundamental_db(db_name)
    conn = sqlite3.connect(path, timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL")
    return conn

def get_or_create_company(cur: sqlite3.Cursor, symbol: str, company_name: str = "") -> int:
    symbol = symbol.strip()
    cur.execute("SELECT company_id, name FROM companies WHERE symbol = ?", (symbol,))
    r = cur.fetchone()
    now_str = time.strftime("%Y-%m-%d %H:%M:%S")
    if r:
        cid, existing_name = r
        if company_name and company_name != existing_name:
            cur.execute(
                "UPDATE companies SET name = ?, updated_at = ? WHERE company_id = ?",
                (company_name, now_str, cid),
            )
        else:
            cur.execute("UPDATE companies SET updated_at = ? WHERE company_id = ?", (now_str, cid))
        return cid
    cur.execute(
        "INSERT INTO companies (symbol, name, updated_at) VALUES (?, ?, ?)",
        (symbol, company_name or symbol, now_str),
    )
    return cur.lastrowid

def get_or_create_item(cur: sqlite3.Cursor, statement_type: str, item_name: str, row_order: int = 999) -> int:
    cur.execute(
        "SELECT item_id, row_order FROM line_items WHERE statement_type = ? AND item_name = ?",
        (statement_type, item_name),
    )
    r = cur.fetchone()
    if r:
        item_id, existing_order = r
        if row_order < (existing_order or 999):
            cur.execute("UPDATE line_items SET row_order = ? WHERE item_id = ?", (row_order, item_id))
        return item_id
    cur.execute(
        "INSERT INTO line_items (statement_type, item_name, row_order) VALUES (?, ?, ?)",
        (statement_type, item_name, row_order),
    )
    return cur.lastrowid

# ============================================================================
# 4. Universal Codal Report Discovery (No IndustryGroup / No Hardcoded Name)
# ============================================================================

def _extract_serial_from_letter(item: dict) -> str:
    """Extracts LetterSerial from a Codal v2/v1 search result object."""
    direct = item.get("LetterSerial") or item.get("letterSerial")
    if direct:
        return str(direct).strip()

    for key in ("Url", "url", " AttachmentUrl", "ExcelUrl", "excelUrl"):
        val = item.get(key)
        if not val:
            continue
        s = str(val)
        m = re.search(r"[?&]LetterSerial=([^&#\s]+)", s, flags=re.IGNORECASE)
        if m:
            return urllib.parse.unquote(m.group(1)).strip()
        m2 = re.search(r"/GetAll/([^/?#\s]+)", s, flags=re.IGNORECASE)
        if m2:
            return urllib.parse.unquote(m2.group(1)).strip()
    return ""

def _extract_year_and_end_date(item: dict) -> tuple[Optional[int], str]:
    """
    Extracts the Jalali fiscal year (e.g. 1402) and full period end date (e.g. '1402/12/29')
    from `ToDate` or `Title` in a Codal search letter item.
    """
    to_date_raw = norm_label(item.get("ToDate", ""))
    title_raw = norm_label(item.get("Title", ""))

    # 1. Check explicit ToDate first
    m_to = re.search(r"(13\d{2}|14\d{2})/(\d{2})/(\d{2})", to_date_raw)
    if m_to:
        return int(m_to.group(1)), m_to.group(0)

    # 2. Check date right after "منتهی به" inside Title
    m_end = re.search(r"منتهی به\s*(13\d{2}|14\d{2})/(\d{2})/(\d{2})", title_raw)
    if m_end:
        y = int(m_end.group(1))
        return y, f"{m_end.group(1)}/{m_end.group(2)}/{m_end.group(3)}"

    # 3. Any YYYY/MM/DD inside Title
    m_any = re.search(r"(13\d{2}|14\d{2})/(\d{2})/(\d{2})", title_raw)
    if m_any:
        return int(m_any.group(1)), m_any.group(0)

    return None, ""

def get_codal_serials_auto(
    symbol: str,
    target_years: Optional[list[int]] = None,
    max_pages: int = 12,
) -> tuple[list[dict], str]:
    """
    Searches Codal (`https://search.codal.ir/api/search/v2/q`) for 12-month financial
    statements of `symbol` across `target_years`.
    Eliminates firm-specific filters (`IndustryGroup`, `Name`, `ReportingType`, `CompanyType`)
    so it operates across all companies on Codal.
    """
    if target_years is None:
        target_years = DEFAULT_TARGET_YEARS
    target_set = set(target_years)
    norm_sym = norm_label(symbol)

    log.info("Searching Codal 12-month statements for symbol '%s'...", symbol)
    found_by_year: dict[int, dict] = {}
    company_name_found = ""

    # Strategy 1: LetterType=6 (Financial Statements N-10), Length=12, no IndustryGroup/Name
    # Strategy 2: Fallback with LetterType=-1, Length=12 if Strategy 1 yields nothing on page 1
    search_strategies = [
        {"LetterType": 6, "Length": 12},
        {"LetterType": -1, "Length": 12},
    ]

    for strat_idx, strat in enumerate(search_strategies):
        if found_by_year and strat_idx > 0:
            break

        for page in range(1, max_pages + 1):
            params = {
                "search": "true",
                "Symbol": symbol,
                "LetterType": strat["LetterType"],
                "Length": strat["Length"],
                "AuditorRef": -1,
                "PageNumber": page,
                "Audited": "true",
                "NotAudited": "true",
                "IsNotAudited": "false",
                "Childs": "false",
                "Mains": "true",
                "Publisher": "false",
                "CompanyState": -1,
                "Category": -1,
                "CompanyType": -1,
                "Consolidatable": "true",
                "NotConsolidatable": "true",
            }
            url = "https://search.codal.ir/api/search/v2/q?" + urllib.parse.urlencode(params)
            try:
                r = requests.get(url, headers=HTTP_HEADERS, timeout=20)
                if r.status_code != 200:
                    continue
                payload = r.json()
                letters = payload.get("Letters", []) if isinstance(payload, dict) else (payload if isinstance(payload, list) else [])
                if not letters:
                    break

                for item in letters:
                    item_sym = norm_label(item.get("Symbol", ""))
                    if item_sym and item_sym != norm_sym:
                        continue

                    if not company_name_found and item.get("CompanyName"):
                        company_name_found = str(item.get("CompanyName")).strip()

                    title_raw = str(item.get("Title", ""))
                    title = norm_label(title_raw)
                    serial = _extract_serial_from_letter(item)
                    if not serial:
                        continue

                    # Exclude management commentary, AGM decisions, or portfolio reports
                    if any(skip_kw in title for skip_kw in ("تفسیر", "تصمیمات", "هیئت مدیره", "پرتفوی", "آگهی دعوت")):
                        continue

                    # Verify it is an annual / 12-month financial statement
                    is_annual = (
                        "12 ماهه" in title
                        or "سال مالی" in title
                        or "دوره ۱۲ ماهه" in title
                        or "دوره 12 ماهه" in title
                        or strat["LetterType"] == 6
                    )
                    if not is_annual:
                        continue

                    year, end_date = _extract_year_and_end_date(item)
                    if year is None or year not in target_set:
                        continue

                    is_audited = "حسابرسی شده" in title and "حسابرسی نشده" not in title
                    existing = found_by_year.get(year)
                    # Keep the first (latest published) Audited report, or upgrade Unaudited -> Audited
                    if existing is None or (is_audited and not existing.get("is_audited")):
                        excel_url = item.get("ExcelUrl") or f"https://excel.codal.ir/service/Excel/GetAll/{serial}/0"
                        if excel_url.startswith("/"):
                            excel_url = "https://excel.codal.ir" + excel_url
                        html_url = item.get("Url") or f"/Reports/Decision.aspx?LetterSerial={serial}&rt=0&let=6&ct=0&ft=-1"
                        if html_url.startswith("/"):
                            html_url = "https://codal.ir" + html_url

                        found_by_year[year] = {
                            "year": year,
                            "end_date": end_date or f"{year}/12/29",
                            "serial": serial,
                            "tracing_no": item.get("TracingNo") or int(f"{year}{abs(hash(serial)) % 100000:05d}"),
                            "title": title_raw,
                            "publish_date": norm_label(item.get("PublishDateTime", "")),
                            "is_audited": is_audited,
                            "excel_url": excel_url,
                            "html_url": html_url,
                        }
                        log.info("  ✓ %s (%s): serial=%s [page %d]", year, end_date, serial, page)

                if len(found_by_year) >= len(target_set):
                    break
            except Exception as e:
                log.warning("  Warning on Codal search page %d: %s", page, e)
                break

    reports_sorted = [found_by_year[y] for y in sorted(found_by_year.keys())]
    return reports_sorted, company_name_found

def fetch_report_bytes(report_meta: dict | str) -> bytes:
    """
    Downloads the report content from `excel.codal.ir`, and if unavailable or empty,
    falls back to the HTML report page on `codal.ir/Reports/Decision.aspx`.
    """
    if isinstance(report_meta, str):
        serial = report_meta
        excel_url = f"https://excel.codal.ir/service/Excel/GetAll/{serial}/0"
        html_url = f"https://codal.ir/Reports/Decision.aspx?LetterSerial={serial}&rt=0&let=6&ct=0&ft=-1"
    else:
        serial = report_meta["serial"]
        excel_url = report_meta.get("excel_url") or f"https://excel.codal.ir/service/Excel/GetAll/{serial}/0"
        html_url = report_meta.get("html_url") or f"https://codal.ir/Reports/Decision.aspx?LetterSerial={serial}&rt=0&let=6&ct=0&ft=-1"

    try:
        r = requests.get(excel_url, headers=HTTP_HEADERS, timeout=45)
        if r.status_code == 200 and len(r.content) > 256:
            return r.content
    except Exception as e:
        log.warning("Excel endpoint failed for %s (%s), trying HTML fallback...", serial, e)

    r_html = requests.get(html_url, headers=HTTP_HEADERS, timeout=45)
    r_html.raise_for_status()
    return r_html.content

# ============================================================================
# 5. Multi-Format Statement Extraction (.xls, .xlsx, HTML, Rayan datasource)
# ============================================================================

def matches_statement(txt_n: str, variants_n: list[str], consolidated: bool = False) -> bool:
    if not consolidated and ("تلفیقی" in txt_n or "تلفيقي" in txt_n):
        return False
    if consolidated and ("تلفیقی" not in txt_n and "تلفيقي" not in txt_n):
        return False
    return any(v == txt_n or (len(txt_n) < 65 and v in txt_n) for v in variants_n)

def _extract_from_rayan_datasource(html: str, variants_n: list[str], target_year: int, consolidated: bool) -> pd.DataFrame:
    """Extracts statement rows if Codal HTML embeds `var datasource = {...};`."""
    m = re.search(r"var\s+datasource\s*=\s*(\{.*?\});\s*(?:</script>|var\s)", html, flags=re.DOTALL)
    if not m:
        return pd.DataFrame(columns=["label", "value"])
    try:
        ds = json.loads(m.group(1))
    except Exception:
        return pd.DataFrame(columns=["label", "value"])

    year_re = re.compile(rf"(?<!\d){target_year}(?!\d)")
    rows: list[tuple[str, float]] = []

    for sheet in ds.get("sheets", []):
        sh_title = norm_label(sheet.get("title", ""))
        for tbl in sheet.get("tables", []):
            tbl_title = norm_label(tbl.get("title_Fa", "") or tbl.get("title", "") or sh_title)
            if not matches_statement(tbl_title, variants_n, consolidated) and not matches_statement(sh_title, variants_n, consolidated):
                continue

            cells = tbl.get("cells", [])
            if not cells:
                continue

            grid: dict[int, dict[int, str]] = {}
            max_r = max_c = 0
            for c in cells:
                r_idx = int(c.get("rowSequence", c.get("row", 0)))
                c_idx = int(c.get("columnSequence", c.get("col", 0)))
                val_str = str(c.get("value", "") or "")
                grid.setdefault(r_idx, {})[c_idx] = val_str
                if r_idx > max_r:
                    max_r = r_idx
                if c_idx > max_c:
                    max_c = c_idx

            year_col = None
            for r_idx in range(0, min(6, max_r + 1)):
                for c_idx in range(0, max_c + 1):
                    cell_txt = norm_label(grid.get(r_idx, {}).get(c_idx, ""))
                    if year_re.search(cell_txt):
                        if "تجدید" not in cell_txt:
                            year_col = c_idx
                            break
                        elif year_col is None:
                            year_col = c_idx
                if year_col is not None:
                    break

            if year_col is None:
                continue

            for r_idx in sorted(grid.keys()):
                row_dict = grid[r_idx]
                lbl = ""
                for c_idx in range(0, year_col):
                    cand = row_dict.get(c_idx, "").strip()
                    if cand and norm_label(cand) not in ("", "شرح"):
                        lbl = cand
                        break
                if not lbl:
                    continue
                val = parse_number(row_dict.get(year_col))
                if val is not None and not is_date_value(val):
                    rows.append((lbl, val))

            if rows:
                return pd.DataFrame(rows, columns=["label", "value"])

    return pd.DataFrame(columns=["label", "value"])

def extract_from_html(html: str, variants: list[str], target_year: int, consolidated: bool = False) -> pd.DataFrame:
    variants_n = [norm_label(v) for v in variants]
    year_re = re.compile(rf"(?<!\d){target_year}(?!\d)")

    # Try embedded Rayan JSON datasource first if present
    ds_df = _extract_from_rayan_datasource(html, variants_n, target_year, consolidated)
    if not ds_df.empty:
        return ds_df

    try:
        soup = BeautifulSoup(html, "lxml")
    except Exception:
        soup = BeautifulSoup(html, "html.parser")

    target_h3 = None
    for h3 in soup.find_all(["h3", "h2", "h4", "caption", "div"]):
        if h3.name == "div" and "header" not in " ".join(h3.get("class", [])).lower():
            continue
        txt_n = norm_label(h3.get_text())
        if matches_statement(txt_n, variants_n, consolidated):
            target_h3 = h3
            break

    sibling_tables = []
    if target_h3 is not None:
        curr = target_h3.find_next_sibling()
        while curr:
            if curr.name in ("h3", "h2"):
                break
            if curr.name == "table":
                sibling_tables.append(curr)
            else:
                sibling_tables.extend(curr.find_all("table"))
            curr = curr.find_next_sibling()

        if not sibling_tables:
            for tbl in soup.find_all("table"):
                if tbl.find_previous(["h3", "h2"]) is target_h3:
                    sibling_tables.append(tbl)
    else:
        sibling_tables = soup.find_all("table")

    rows: list[tuple[str, float]] = []

    rayan_tables = [t for t in sibling_tables if "rayanDynamicStatement" in (t.get("class") or [])]
    if rayan_tables:
        for tbl in rayan_tables:
            thead = tbl.find("thead")
            if thead is None:
                continue
            header_trs = thead.find_all("tr", recursive=False)
            if not header_trs:
                continue
            col_headers = [c.get_text(" ", strip=True) for c in header_trs[-1].find_all(["th", "td"], recursive=False)]

            year_col_idx = None
            for i, h_text in enumerate(col_headers):
                h_norm = norm_label(h_text)
                if year_re.search(h_norm):
                    if "تجدید" not in h_norm and "تجديد" not in h_norm:
                        year_col_idx = i
                        break
                    elif year_col_idx is None:
                        year_col_idx = i

            if year_col_idx is None:
                continue

            tbody = tbl.find("tbody")
            tr_list = tbody.find_all("tr", recursive=False) if tbody else tbl.find_all("tr", recursive=False)
            for tr in tr_list:
                cells = tr.find_all(["td", "th"], recursive=False)
                if len(cells) <= year_col_idx:
                    continue
                row_label = cells[0].get_text(" ", strip=True)
                if not row_label or norm_label(row_label) == "شرح":
                    continue
                val = parse_number(cells[year_col_idx].get_text(strip=True))
                if val is not None and not is_date_value(val):
                    rows.append((row_label, val))
        if rows:
            return pd.DataFrame(rows, columns=["label", "value"])

    for tbl_idx, tbl in enumerate(sibling_tables):
        first_tr = tbl.find("tr")
        if first_tr:
            cells = first_tr.find_all(["th", "td"])
            if len(cells) >= 8:
                year_col_left = 1
                year_col_right = 5
                for idx, c in enumerate(cells[:4]):
                    if year_re.search(norm_label(c.get_text())):
                        year_col_left = idx
                        break
                for idx, c in enumerate(cells[4:8]):
                    if year_re.search(norm_label(c.get_text())):
                        year_col_right = 4 + idx
                        break

                for tr in tbl.find_all("tr")[1:]:
                    tds = tr.find_all(["td", "th"], recursive=False)
                    if len(tds) < 8:
                        continue
                    lbl_left = tds[0].get_text(" ", strip=True)
                    if lbl_left and norm_label(lbl_left) not in ("", "شرح"):
                        v_left = parse_number(tds[year_col_left].get_text(strip=True))
                        if v_left is not None and not is_date_value(v_left):
                            rows.append((lbl_left, v_left))

                    lbl_right = tds[4].get_text(" ", strip=True)
                    if lbl_right and norm_label(lbl_right) not in ("", "شرح"):
                        v_right = parse_number(tds[year_col_right].get_text(strip=True))
                        if v_right is not None and not is_date_value(v_right):
                            rows.append((lbl_right, v_right))
                if rows:
                    return pd.DataFrame(rows, columns=["label", "value"])

        tbl_id = tbl.get("id", "") or ""
        if "tblGridHeader" in tbl_id or "header" in norm_label(tbl_id):
            ths = tbl.find_all(["th", "td"])
            year_col_idx = 1
            for idx, th in enumerate(ths):
                if year_re.search(norm_label(th.get_text())):
                    year_col_idx = idx
                    break

            if tbl_idx + 1 < len(sibling_tables):
                data_tbl = sibling_tables[tbl_idx + 1]
                for tr in data_tbl.find_all("tr"):
                    tds = tr.find_all(["td", "th"], recursive=False)
                    if len(tds) <= year_col_idx:
                        continue
                    label = tds[0].get_text(" ", strip=True)
                    if not label or norm_label(label) in ("", "شرح"):
                        continue
                    val = parse_number(tds[year_col_idx].get_text(strip=True))
                    if val is not None and not is_date_value(val):
                        rows.append((label, val))
                if rows:
                    return pd.DataFrame(rows, columns=["label", "value"])

        all_trs = tbl.find_all("tr")
        if len(all_trs) > 2:
            th_cells = all_trs[0].find_all(["th", "td"])
            if len(th_cells) in (3, 4, 5, 6):
                year_col = 1
                for idx, c in enumerate(th_cells):
                    if year_re.search(norm_label(c.get_text())):
                        year_col = idx
                        break
                for tr in all_trs[1:]:
                    tds = tr.find_all(["td", "th"], recursive=False)
                    if len(tds) <= year_col:
                        continue
                    label = tds[0].get_text(" ", strip=True)
                    if not label or norm_label(label) in ("", "شرح"):
                        continue
                    val = parse_number(tds[year_col].get_text(strip=True))
                    if val is not None and not is_date_value(val):
                        rows.append((label, val))
                if rows:
                    return pd.DataFrame(rows, columns=["label", "value"])

    return pd.DataFrame(rows, columns=["label", "value"])

def extract_from_xls(content: bytes, variants: list[str], target_year: int, consolidated: bool = False) -> pd.DataFrame:
    sheets = None
    for eng in ("xlrd", "openpyxl"):
        try:
            sheets = pd.read_excel(BytesIO(content), sheet_name=None, header=None, engine=eng, dtype=object)
            break
        except Exception:
            continue

    if not sheets:
        return pd.DataFrame(columns=["label", "value"])

    variants_n = [norm_label(v) for v in variants]
    all_stmts = get_statement_variants(consolidated)
    all_headings = {norm_label(v) for sv in all_stmts.values() for v in sv}
    year_re = re.compile(rf"(?<!\d){target_year}(?!\d)")

    for sh_name, df in sheets.items():
        sh_name_n = norm_label(sh_name)
        if not consolidated and ("تلفیقی" in sh_name_n or "تلفيقي" in sh_name_n):
            continue
        if consolidated and ("تلفیقی" not in sh_name_n and "تلفيقي" not in sh_name_n):
            continue

        n_rows, n_cols = df.shape
        if n_rows < 3 or n_cols < 2:
            continue

        heading_row = None
        if any(v in sh_name_n for v in variants_n):
            heading_row = 0
        else:
            for r in range(min(15, n_rows)):
                for c in range(n_cols):
                    if pd.isna(df.iloc[r, c]):
                        continue
                    cell_n = norm_label(df.iloc[r, c])
                    if matches_statement(cell_n, variants_n, consolidated):
                        heading_row = r
                        break
                if heading_row is not None:
                    break

        if heading_row is None:
            continue

        end_row = n_rows
        for r in range(heading_row + 1, n_rows):
            hit = False
            for c in range(n_cols):
                cell = df.iloc[r, c]
                if pd.isna(cell):
                    continue
                cell_n = norm_label(cell)
                if cell_n and cell_n in all_headings and not matches_statement(cell_n, variants_n, consolidated):
                    end_row = r
                    hit = True
                    break
            if hit:
                break

        year_col = None
        for r in range(heading_row, min(heading_row + 7, end_row)):
            for c in range(n_cols):
                cell = df.iloc[r, c]
                if pd.isna(cell):
                    continue
                cell_norm = norm_label(cell)
                if year_re.search(cell_norm) and len(cell_norm) < 85:
                    if "تجدید" not in cell_norm and "تجديد" not in cell_norm:
                        year_col = c
                        break
                    elif year_col is None:
                        year_col = c
            if year_col is not None:
                break

        if year_col is None:
            for test_c in (1, 2):
                if test_c < n_cols:
                    nums = sum(
                        1
                        for r_idx in range(heading_row + 2, min(heading_row + 15, end_row))
                        if parse_number(df.iloc[r_idx, test_c]) is not None
                    )
                    if nums > 4:
                        year_col = test_c
                        break

        if year_col is None:
            continue

        rows: list[tuple[str, float]] = []
        for r in range(heading_row + 1, end_row):
            row_label = None
            for c in range(year_col):
                cell = df.iloc[r, c]
                if pd.isna(cell):
                    continue
                s = str(cell).strip()
                if not s:
                    continue
                s_n = norm_label(s)
                if s_n in ("شرح", "") or re.fullmatch(r"[\d\.\-,()]+", s_n) or len(s_n) < 2:
                    continue
                row_label = s
                break

            if row_label is None:
                continue
            v = parse_number(df.iloc[r, year_col])
            if v is not None and not is_date_value(v):
                rows.append((row_label, v))

        if rows:
            return pd.DataFrame(rows, columns=["label", "value"])

    return pd.DataFrame(columns=["label", "value"])

def extract_statement(content: bytes, variants: list[str], target_year: int, consolidated: bool = False) -> pd.DataFrame:
    if content[:4] == b"\xd0\xcf\x11\xe0" or content[:2] == b"PK":
        df = extract_from_xls(content, variants, target_year, consolidated)
        if not df.empty:
            return df
    return extract_from_html(content.decode("utf-8", errors="replace"), variants, target_year, consolidated)

def clean_df(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    df = df.copy()
    df = df.dropna(subset=["value"])
    df = df[~df["value"].apply(is_date_value)]
    df = df[~df["label"].apply(lambda s: norm_label(s) in ("", "شرح"))]
    df = df[df["label"].astype(str).str.len() >= 2]
    df["_key"] = df["label"].apply(norm_label)
    df = df.drop_duplicates(subset=["_key"], keep="first").drop(columns=["_key"])
    return df.reset_index(drop=True)

# ============================================================================
# 6. Standard Statement Mappers (Balance Sheet, Income, Cash Flow, Comp.)
# ============================================================================

def map_to_standard_balance(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    raw_map = {norm_label(r["label"]): r["value"] for _, r in df.iterrows()}
    std_data: dict[str, float] = {}

    def get_val(*labels) -> float:
        for lbl in labels:
            n = norm_label(lbl)
            if n in raw_map:
                return raw_map[n]
        return np.nan

    def sum_vals(*labels) -> float:
        keys = {norm_label(lbl) for lbl in labels}
        vals = [raw_map[k] for k in keys if k in raw_map and pd.notna(raw_map[k])]
        return sum(vals) if vals else np.nan

    std_data["دارایی های غیرجاری"] = np.nan
    std_data["حساب ها و اسناد دریافتنی بلندمدت"] = get_val(
        "دریافتنی های بلندمدت", "دريافتني هاي بلندمدت", "حساب ها و اسناد دریافتنی بلندمدت", "دریافتنی های تجاری و سایر دریافتنی های بلندمدت"
    )
    std_data["سرمایه گذاری های بلند مدت"] = sum_vals(
        "سرمایه گذاری های بلندمدت", "سرمایه گذاری های بلند مدت", "سرمایه گذاری در املاک"
    )
    std_data["دارایی های ثابت مشهود"] = get_val("دارایی های ثابت مشهود", "دارايي هاي ثابت مشهود")
    std_data["دارایی های ثابت نامشهود"] = get_val(
        "دارایی های نامشهود", "دارايي هاي نامشهود", "دارایی های ثابت نامشهود"
    )
    std_data["سایر دارایی ها"] = sum_vals(
        "سایر دارایی ها", "ساير دارايي ها", "دارایی مالیات انتقالی", "دارايي ماليات انتقالي", "سایر دارایی های غیرجاری"
    )
    std_data["جمع دارایی های غیرجاری"] = get_val("جمع دارایی های غیرجاری", "جمع دارايي هاي غيرجاري")

    std_data["دارایی های جاری"] = np.nan
    std_data["موجودی نقد"] = get_val("موجودی نقد", "موجودي نقد", "موجودی نقد و بانک", "وجه نقد و معادل های نقد")
    std_data["سرمایه گذاری های کوتاه مدت"] = get_val("سرمایه گذاری های کوتاه مدت", "سرمایه گذاری های کوتاه مدت")

    trade_rec = get_val("دریافتنی های تجاری", "حساب ها و اسناد دریافتنی تجاری", "دریافتنی های عملیاتی")
    other_rec = get_val("دریافتنی های غیرتجاری", "سایر حساب ها و اسناد دریافتنی", "سایر دریافتنی ها")
    total_rec = get_val("دریافتنی های تجاری و سایر دریافتنی ها")
    if pd.isna(total_rec) and (pd.notna(trade_rec) or pd.notna(other_rec)):
        total_rec = (0.0 if pd.isna(trade_rec) else trade_rec) + (0.0 if pd.isna(other_rec) else other_rec)

    std_data["دریافتنی های تجاری و سایر دریافتنی ها"] = total_rec
    std_data["حساب ها و اسناد دریافتنی تجاری"] = trade_rec
    std_data["سایر حساب ها و اسناد دریافتنی"] = other_rec
    std_data["طلب از شرکت های گروه و شرکت های وابسته"] = get_val("طلب از شرکت های گروه و شرکت های وابسته")
    std_data["موجودی مواد و کالا"] = get_val("موجودی مواد و کالا", "موجودي مواد و کالا")
    std_data["سفارشات"] = get_val("سفارشات")
    std_data["پیش پرداخت ها"] = get_val("پیش پرداخت ها")

    orders_prep = get_val("پیش پرداخت ها و سفارشات", "سفارشات و پیش پرداخت ها")
    if pd.isna(orders_prep) and (pd.notna(std_data["سفارشات"]) or pd.notna(std_data["پیش پرداخت ها"])):
        orders_prep = (0.0 if pd.isna(std_data["سفارشات"]) else std_data["سفارشات"]) + (
            0.0 if pd.isna(std_data["پیش پرداخت ها"]) else std_data["پیش پرداخت ها"]
        )
    std_data["پیش پرداخت ها و سفارشات"] = orders_prep

    std_data["دارایی های غیرجاری نگهداری شده برای فروش"] = get_val(
        "دارایی های نگهداری شده برای فروش", "دارايي هاي نگهداري شده براي فروش", "دارایی های غیرجاری نگهداری شده برای فروش"
    )
    std_data["جمع دارایی های جاری"] = get_val("جمع دارایی های جاری", "جمع دارايي هاي جاري")
    std_data["جمع دارایی ها"] = get_val("جمع دارایی ها", "جمع دارايي ها")

    std_data["حقوق صاحبان سهام"] = np.nan
    std_data["سرمایه"] = get_val("سرمایه", "سرمايه")
    std_data["دریافتی بابت افزایش سرمایه"] = get_val("افزایش (کاهش) سرمایه در جریان", "افزایش سرمایه در جریان", "دریافتی بابت افزایش سرمایه")
    std_data["سهام خزانه"] = get_val("سهام خزانه")
    std_data["صرف سهام خزانه"] = sum_vals("صرف سهام خزانه", "صرف سهام", "صرف (کسر) سهام")
    std_data["اندوخته قانونی"] = get_val("اندوخته قانونی", "اندوخته قانوني")
    std_data["سایر اندوخته ها"] = sum_vals(
        "سایر اندوخته ها", "ساير اندوخته ها", "مازاد تجدید ارزیابی دارایی ها", "تفاوت تسعیر ارز عملیات خارجی"
    )
    std_data["سود(زیان) انباشته"] = get_val("سود (زیان) انباشته", "سود(زيان) انباشته", "سود انباشته", "سود(زیان) انباشته")
    std_data["جمع حقوق صاحبان سهام"] = get_val("جمع حقوق صاحبان سهام", "جمع حقوق مالکانه")

    std_data["بدهی های غیرجاری"] = np.nan
    std_data["تسهیلات مالی دریافتی بلندمدت"] = get_val("تسهیلات مالی بلندمدت", "تسهيلات مالي بلندمدت", "تسهیلات مالی دریافتی بلندمدت")
    std_data["حساب ها و اسناد پرداختنی بلندمدت"] = get_val("پرداختنی های بلندمدت", "پرداختني هاي بلندمدت", "حساب ها و اسناد پرداختنی بلندمدت")
    std_data["ذخیره مزایای پایان خدمت کارکنان"] = get_val(
        "ذخیره مزایای پایان خدمت کارکنان", "ذخيره مزاياي پايان خدمت کارکنان"
    )
    std_data["جمع بدهی های غیرجاری"] = get_val("جمع بدهی های غیرجاری", "جمع بدهي هاي غيرجاري")

    std_data["بدهی های جاری"] = np.nan
    trade_pay = get_val("پرداختنی های تجاری", "پرداختني هاي تجاري", "حساب ها و اسناد پرداختنی تجاری")
    other_pay = get_val("پرداختنی های غیرتجاری", "پرداختني هاي غيرتجاري", "سایر حساب ها و اسناد پرداختنی")
    total_pay = get_val("پرداختنی های تجاری و سایر پرداختنی ها", "پرداختنی تجاری و سایر پرداختنی ها")
    if pd.isna(total_pay) and (pd.notna(trade_pay) or pd.notna(other_pay)):
        total_pay = (0.0 if pd.isna(trade_pay) else trade_pay) + (0.0 if pd.isna(other_pay) else other_pay)

    std_data["پرداختنی تجاری و سایر پرداختنی ها"] = total_pay
    std_data["حساب ها و اسناد پرداختنی تجاری"] = trade_pay
    std_data["بدهی به شرکت های گروه و وابسته"] = get_val("بدهی به شرکت های گروه و وابسته")
    std_data["سایر حساب ها و اسناد پرداختنی"] = other_pay
    std_data["مالیات پرداختنی"] = get_val("مالیات پرداختنی", "ماليات پرداختني")
    std_data["پیش دریافت ها"] = get_val("پیش دریافت ها")
    std_data["ذخیره مالیات"] = get_val("ذخیره مالیات", "ذخایر")
    std_data["پیش دریافت های جاری"] = get_val("پیش دریافت های جاری", "پیش دریافت ها")
    std_data["سود سهام پرداختنی"] = get_val("سود سهام پرداختنی", "سود سهام پرداختني")
    std_data["تسهیلات مالی دریافتی"] = get_val("تسهیلات مالی", "تسهيلات مالي", "تسهیلات مالی دریافتی", "تسهیلات مالی کوتاه مدت")
    std_data["جمع بدهی های جاری"] = get_val("جمع بدهی های جاری", "جمع بدهي هاي جاري")
    std_data["جمع بدهی ها"] = get_val("جمع بدهی ها", "جمع بدهي ها")
    std_data["جمع بدهی ها و حقوق صاحبان سهام"] = get_val(
        "جمع بدهی ها و حقوق صاحبان سهام", "جمع حقوق مالکانه و بدهی ها", "جمع بدهی ها و حقوق مالکانه"
    )

    result_rows = [(row, std_data.get(row, np.nan)) for row in STANDARD_BALANCE_ROWS]
    return pd.DataFrame(result_rows, columns=["label", "value"])

def map_to_standard_income(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    raw_map = {norm_label(r["label"]): r["value"] for _, r in df.iterrows()}
    std_data: dict[str, float] = {}

    def get_val(*labels) -> float:
        for lbl in labels:
            n = norm_label(lbl)
            if n in raw_map:
                return raw_map[n]
        return np.nan

    std_data["درآمدهای عملیاتی"] = get_val(
        "درآمدهای عملیاتی", "فروش خالص", "درآمد حاصل از فروش", "درآمدهای عملیاتی (فروش خالص)"
    )
    std_data["بهای تمام شده درآمد های عملیاتی"] = get_val(
        "بهای تمام شده درآمدهای عملیاتی",
        "بهای تمام شده درآمد های عملیاتی",
        "بهای تمام شده کالای فروش رفته",
        "بهای تمام شده کالای فروشرفته",
        "بهای تمام ‌شده درآمدهای عملیاتی",
    )
    std_data["سود(زیان) ناخالص"] = get_val("سود (زیان) ناخالص", "سود(زيان) ناخالص", "سود(زیان) ناخالص")
    std_data["هزینه های فروش و اداری و عمومی"] = get_val(
        "هزینه های فروش، اداری و عمومی",
        "هزینه های فروش و اداری و عمومی",
        "هزینه های توزیع و فروش",
        "هزینه های عمومی و اداری",
        "هزینه های فروش، اداری و عمومی",
    )

    other_rev = get_val("سایر درآمدها", "سایر درآمدهای عملیاتی")
    std_data["سایر درآمدها"] = other_rev
    other_exp = get_val("سایر هزینه ها", "سایر هزینه های عملیاتی")
    std_data["سایر هزینه ها"] = other_exp

    if pd.notna(other_rev) or pd.notna(other_exp):
        std_data["خالص سایر درآمدهای عملیاتی"] = (0.0 if pd.isna(other_rev) else other_rev) + (
            0.0 if pd.isna(other_exp) else other_exp
        )
    else:
        std_data["خالص سایر درآمدهای عملیاتی"] = get_val("خالص سایر درآمدهای عملیاتی", "سایر درآمدها و هزینه های عملیاتی")

    selling_exp = std_data["هزینه های فروش و اداری و عمومی"]
    if pd.notna(selling_exp) or pd.notna(other_exp):
        std_data["جمع هزینه ها"] = (0.0 if pd.isna(selling_exp) else selling_exp) + (
            0.0 if pd.isna(other_exp) else other_exp
        )
    else:
        std_data["جمع هزینه ها"] = np.nan

    std_data["سود(زیان) عملیاتی"] = get_val("سود (زیان) عملیاتی", "سود(زيان) عملياتى", "سود(زیان) عملیاتی")
    std_data["هزینه های مالی"] = get_val("هزینه های مالی", "هزينه‏ هاى مالى")

    non_op_inv = get_val(
        "سایر درآمدها و هزینه های غیرعملیاتی- درآمد سرمایه گذاری ها",
        "سایر درآمدها و هزینه های غیرعملیاتی- درآمد سرمایه گذاریها",
        "سایر درآمدها و هزینه های غیرعملیاتی - درآمد سرمایه گذاری ها",
        "درآمد سرمایه گذاری ها",
    )
    non_op_misc = get_val(
        "سایر درآمدها و هزینه های غیرعملیاتی- اقلام متفرقه",
        "سایر درآمدها و هزینه های غیرعملیاتی - اقلام متفرقه",
        "خالص سایر درآمدها و هزینه های غیرعملیاتی",
    )
    non_op_tot = get_val("سایر درآمدها و هزینه های غیرعملیاتی", "ساير درآمدها و هزينه ‏هاى غيرعملياتى")
    if pd.isna(non_op_tot) and (pd.notna(non_op_inv) or pd.notna(non_op_misc)):
        non_op_tot = (0.0 if pd.isna(non_op_inv) else non_op_inv) + (0.0 if pd.isna(non_op_misc) else non_op_misc)

    std_data["سایر درآمدها و هزینه‌های غیرعملیاتی- درآمد سرمایه‌ گذاری‌ها"] = non_op_inv
    std_data["سایر درآمدها و هزینه‌های غیرعملیاتی- اقلام متفرقه"] = non_op_misc
    std_data["سایر درآمدها و هزینه‌های غیرعملیاتی"] = non_op_tot

    ebt = get_val(
        "سود (زیان) عملیات در حال تداوم قبل از مالیات",
        "سود(زيان) عمليات در حال تداوم قبل از ماليات",
        "سود (زیان) قبل از مالیات",
        "سود(زیان) قبل از مالیات",
    )
    std_data["سود(زیان) قبل از اقلام غیر مترقبه و اثرات انباشته تغییر در اصول و روش های حسابداری"] = ebt
    std_data["سود(زیان) عملیات در حال تداوم قبل از مالیات"] = ebt

    std_data["مالیات سال جاری"] = get_val("سال جاری", "مالیات بر درآمد", "مالیات عملکرد")
    std_data["مالیات سال های قبل"] = get_val("سال های قبل")
    std_data["سود(زیان) خالص عملیات در حال تداوم"] = get_val(
        "سود (زیان) خالص عملیات در حال تداوم", "سود(زیان) خالص عملیات در حال تداوم"
    )
    std_data["سود(زیان) خالص"] = get_val("سود (زیان) خالص", "سود(زیان) خالص", "سود (زیان) خالص دوره")

    std_data["سود(زیان) انباشته ابتدای دوره"] = get_val("سود (زیان) انباشته ابتدای دوره", "سود(زیان) انباشته ابتدای دوره")
    std_data["تعدیلات سنواتی"] = get_val("تعدیلات سنواتی")
    std_data["سود(زیان) انباشته ابتدای دوره تعدیل شده"] = get_val("سود (زیان) انباشته ابتدای دوره تعدیل شده")
    std_data["سود(زیان) انباشته ابتدای دوره تخصیص نیافته"] = get_val("سود (زیان) انباشته ابتدای دوره تخصیص نیافته")
    std_data["سود قابل تخصیص"] = get_val("سود قابل تخصیص")
    std_data["اندوخته قانونی"] = get_val("انتقال به اندوخته قانونی", "اندوخته قانونی")
    std_data["سایر اندوخته ها"] = get_val("انتقال به سایر اندوخته ها", "سایر اندوخته ها")
    std_data["افزایش سرمایه از محل سود انباشته"] = get_val(
        "تغییرات سرمایه از محل سود (زیان) انباشته", "افزایش سرمایه از محل سود انباشته"
    )
    std_data["سود سهام پیشنهادی"] = get_val("سود سهام مصوب", "سود سهام پیشنهادی")
    std_data["پاداش هیئت مدیره"] = get_val("پاداش هیئت مدیره")

    alloc = [
        std_data["اندوخته قانونی"],
        std_data["سایر اندوخته ها"],
        std_data["افزایش سرمایه از محل سود انباشته"],
        std_data["سود سهام پیشنهادی"],
        std_data["پاداش هیئت مدیره"],
    ]
    valid_alloc = [v for v in alloc if pd.notna(v)]
    std_data["جمع تغییرات در سود انباشته"] = sum(valid_alloc) if valid_alloc else np.nan
    std_data["سود(زیان) انباشته پایان دوره"] = get_val(
        "سود (زیان) انباشته پایان دوره", "سود(زیان) انباشته پایان دوره"
    )

    std_data["عملیاتی (ریال)"] = get_val(
        "عملیاتی (ریال)", "سود (زیان) پایه هر سهم ناشی از عملیات در حال تداوم- عملیاتی"
    )
    std_data["غیرعملیاتی (ریال)"] = get_val(
        "غیرعملیاتی (ریال)", "سود (زیان) پایه هر سهم ناشی از عملیات در حال تداوم- غیرعملیاتی"
    )
    std_data["سود ناشی از عملیات در حال تداوم هر سهم"] = get_val("ناشی از عملیات در حال تداوم")
    std_data["سود ناشی از عملیات متوقف شده هر سهم"] = get_val(
        "ناشی از عملیات متوقف شده", "سود (زیان) پایه هر سهم ناشی از عملیات متوقف‌ شده"
    )
    std_data["سود(زیان) پایه هر سهم"] = get_val("سود(زیان) پایه هر سهم", "سود (زیان) پایه هر سهم")
    std_data["سود(زیان) خالص هر سهم"] = get_val(
        "سود (زیان) خالص هر سهم – ریال", "سود (زیان) خالص هر سهم - ریال", "سود(زیان) خالص هر سهم"
    )
    std_data["سرمایه"] = get_val("سرمایه")

    result_rows = [(row, std_data.get(row, np.nan)) for row in STANDARD_INCOME_ROWS]
    return pd.DataFrame(result_rows, columns=["label", "value"])

def map_to_standard_cashflow(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    raw_map = {norm_label(r["label"]): r["value"] for _, r in df.iterrows()}
    std_data: dict[str, float] = {}
    matched_keys: set[str] = set()

    def get_val(*labels) -> float:
        for lbl in labels:
            n = norm_label(lbl)
            if n in raw_map:
                matched_keys.add(n)
                return raw_map[n]
        # Partial substring fallback for verbose Codal cash flow descriptions
        for lbl in labels:
            n = norm_label(lbl)
            if len(n) >= 10:
                for k, val in raw_map.items():
                    if n in k:
                        matched_keys.add(k)
                        return val
        return np.nan

    std_data["جریان های نقدی حاصل از فعالیت های عملیاتی"] = np.nan
    std_data["نقد دریافتی از مشتریان"] = get_val(
        "وجوه دریافتی از مشتریان", "نقد دریافتی از مشتریان", "وجوه نقد دریافتی از مشتریان"
    )
    std_data["نقد پرداختی به تامین کنندگان و کارکنان"] = get_val(
        "وجوه پرداختی به تامین کنندگان و کارکنان",
        "نقد پرداختی به تامین کنندگان و کارکنان",
        "وجوه پرداختی بابت خرید کالا و خدمات و کارکنان",
    )
    std_data["نقد حاصل از عملیات"] = get_val(
        "نقد حاصل از عملیات",
        "وجه نقد حاصل از عملیات",
        "جریان نقدی حاصل از عملیات",
        "خالص وجه نقد حاصل از عملیات",
    )
    std_data["سود تضمین شده و کارمزد پرداختی"] = get_val(
        "سود تضمین شده و کارمزد پرداختی", "بهره و کارمزد پرداختی", "سود و کارمزد پرداختی"
    )
    std_data["مالیات بر درآمد پرداختی"] = get_val(
        "مالیات بر درآمد پرداختی", "مالیات بر درآمد", "وجوه پرداختی بابت مالیات بر درآمد"
    )
    std_data["سایر دریافت ها و پرداخت های عملیاتی"] = get_val("سایر دریافت ها و پرداخت های عملیاتی")
    std_data["خالص جریان نقدی ناشی از فعالیت های عملیاتی"] = get_val(
        "خالص جریان نقدی ناشی از فعالیت های عملیاتی",
        "جریان خالص ورود (خروج) نقد حاصل از فعالیت های عملیاتی",
        "خالص وجه نقد ناشی از فعالیت های عملیاتی",
        "جمع جریان های نقدی حاصل از فعالیت های عملیاتی",
        "فعالیت های عملیاتی",
    )

    std_data["جریان های نقدی حاصل از فعالیت های سرمایه گذاری"] = np.nan
    std_data["وجوه پرداختی بابت خرید دارایی های ثابت مشهود"] = get_val(
        "وجوه پرداختی بابت خرید دارایی های ثابت مشهود",
        "پرداخت های نقدی برای تحصیل دارایی های ثابت مشهود",
        "خرید دارایی های ثابت مشهود",
    )
    std_data["وجوه دریافتی ناشی از فروش دارایی های ثابت مشهود"] = get_val(
        "وجوه دریافتی ناشی از فروش دارایی های ثابت مشهود",
        "دریافت های نقدی حاصل از فروش دارایی های ثابت مشهود",
        "فروش دارایی های ثابت مشهود",
    )
    std_data["وجوه پرداختی بابت خرید دارایی های نامشهود"] = get_val(
        "وجوه پرداختی بابت خرید دارایی های نامشهود",
        "پرداخت های نقدی برای تحصیل دارایی های نامشهود",
        "خرید دارایی های نامشهود",
    )
    std_data["وجوه پرداختی بابت تحصیل سرمایه گذاری ها"] = get_val(
        "وجوه پرداختی بابت تحصیل سرمایه گذاری ها",
        "وجوه پرداختی بابت خرید سرمایه گذاری های بلندمدت",
        "وجوه پرداختی بابت خرید سرمایه گذاری های کوتاه مدت",
        "تحصیل سرمایه گذاری ها",
    )
    std_data["وجوه دریافتی ناشی از فروش سرمایه گذاری ها"] = get_val(
        "وجوه دریافتی ناشی از فروش سرمایه گذاری ها",
        "وجوه دریافتی بابت فروش سرمایه گذاری ها",
        "فروش سرمایه گذاری ها",
    )
    std_data["سود دریافتی بابت سرمایه گذاری ها و سپرده ها"] = get_val(
        "سود سهام دریافتی",
        "سود دریافتی بابت سرمایه گذاری ها",
        "سود دریافتی از سپرده های بانکی",
        "بازده سرمایه گذاری ها و سود پرداختی بابت تامین مالی",
    )
    std_data["سایر جریان های نقدی فعالیت های سرمایه گذاری"] = get_val("سایر جریان های نقدی فعالیت های سرمایه گذاری")
    std_data["خالص جریان نقدی ناشی از فعالیت های سرمایه گذاری"] = get_val(
        "خالص جریان نقدی ناشی از فعالیت های سرمایه گذاری",
        "جریان خالص ورود (خروج) نقد حاصل از فعالیت های سرمایه گذاری",
        "خالص وجه نقد ناشی از فعالیت های سرمایه گذاری",
        "جمع جریان های نقدی حاصل از فعالیت های سرمایه گذاری",
        "فعالیت های سرمایه گذاری",
    )

    std_data["جریان های نقدی حاصل از فعالیت های تامین مالی"] = np.nan
    std_data["وجوه دریافتی حاصل از افزایش سرمایه"] = get_val(
        "وجوه دریافتی حاصل از افزایش سرمایه", "دریافت های نقدی ناشی از افزایش سرمایه"
    )
    std_data["وجوه دریافتی حاصل از تسهیلات مالی"] = get_val(
        "وجوه دریافتی حاصل از تسهیلات مالی",
        "دریافت های نقدی ناشی از تسهیلات مالی",
        "تسهیلات مالی دریافتی",
    )
    std_data["بازپرداخت اصل تسهیلات مالی"] = get_val(
        "بازپرداخت اصل تسهیلات مالی",
        "وجوه پرداختی بابت اصل تسهیلات مالی",
        "پرداخت های نقدی بابت بازپرداخت تسهیلات مالی",
    )
    std_data["سود تسهیلات مالی پرداختی"] = get_val(
        "سود تسهیلات مالی پرداختی", "وجوه پرداختی بابت سود تسهیلات مالی"
    )
    std_data["سود سهام پرداختی به سهامداران"] = get_val(
        "سود سهام پرداختی", "سود سهام پرداختی به سهامداران", "وجوه پرداختی بابت سود سهام"
    )
    std_data["سایر جریان های نقدی فعالیت های تامین مالی"] = get_val("سایر جریان های نقدی فعالیت های تامین مالی")
    std_data["خالص جریان نقدی ناشی از فعالیت های تامین مالی"] = get_val(
        "خالص جریان نقدی ناشی از فعالیت های تامین مالی",
        "جریان خالص ورود (خروج) نقد حاصل از فعالیت های تامین مالی",
        "خالص وجه نقد ناشی از فعالیت های تامین مالی",
        "جمع جریان های نقدی حاصل از فعالیت های تامین مالی",
        "فعالیت های تامین مالی",
    )

    std_data["خالص افزایش (کاهش) در موجودی نقد"] = get_val(
        "خالص افزایش (کاهش) در موجودی نقد",
        "خالص افزایش (کاهش) در وجه نقد",
        "افزایش (کاهش) خالص در موجودی نقد",
    )
    std_data["موجودی نقد در ابتدای دوره"] = get_val(
        "موجودی نقد در ابتدای دوره", "موجودی نقد در ابتدای سال", "موجودی نقد و بانک در ابتدای سال"
    )
    std_data["تاثیر تغییرات نرخ ارز بر موجودی نقد"] = get_val(
        "تاثیر تغییرات نرخ ارز بر موجودی نقد", "اثر تغییرات نرخ ارز بر موجودی نقد", "تفاوت تسعیر ارز موجودی نقد"
    )
    std_data["موجودی نقد در پایان دوره"] = get_val(
        "موجودی نقد در پایان دوره", "موجودی نقد در پایان سال", "موجودی نقد و بانک در پایان سال"
    )

    result_rows = [(row, std_data.get(row, np.nan)) for row in STANDARD_CASHFLOW_ROWS]
    # Append any unmatched non-empty rows from raw_df so indirect-method / custom items are also preserved
    for _, r in df.iterrows():
        lbl = str(r["label"]).strip()
        k = norm_label(lbl)
        if k and k not in matched_keys and pd.notna(r["value"]):
            result_rows.append((lbl, r["value"]))
    return pd.DataFrame(result_rows, columns=["label", "value"])

def map_to_standard_comprehensive(df: pd.DataFrame) -> pd.DataFrame:
    if df.empty:
        return df
    raw_map = {norm_label(r["label"]): r["value"] for _, r in df.iterrows()}
    std_data: dict[str, float] = {}
    matched_keys: set[str] = set()

    def get_val(*labels) -> float:
        for lbl in labels:
            n = norm_label(lbl)
            if n in raw_map:
                matched_keys.add(n)
                return raw_map[n]
        return np.nan

    std_data["سود(زیان) خالص"] = get_val("سود (زیان) خالص", "سود(زیان) خالص", "سود (زیان) خالص سال")
    std_data["مازاد تجدید ارزیابی دارایی های ثابت مشهود"] = get_val(
        "مازاد تجدید ارزیابی دارایی های ثابت مشهود", "مازاد تجدید ارزیابی دارایی ها"
    )
    std_data["سود(زیان) تحقق نیافته ناشی از تغییر ارزش سرمایه گذاری ها"] = get_val(
        "سود(زیان) تحقق نیافته ناشی از تغییر ارزش سرمایه گذاری ها"
    )
    std_data["تفاوت تسعیر ارز عملیات خارجی"] = get_val("تفاوت تسعیر ارز عملیات خارجی")
    std_data["سود(زیان) اکتواریایی مزایای پایان خدمت کارکنان"] = get_val(
        "سود(زیان) اکتواریایی مزایای پایان خدمت کارکنان", "سود (زیان) اکتواریایی"
    )
    std_data["سایر اقلام سود و زیان جامع"] = get_val("سایر اقلام سود و زیان جامع")
    std_data["جمع سایر اقلام سود و زیان جامع"] = get_val("جمع سایر اقلام سود و زیان جامع")
    std_data["سود(زیان) جامع سال"] = get_val(
        "سود(زیان) جامع سال", "سود (زیان) جامع سال", "جمع سود (زیان) جامع سال", "سود (زیان) جامع دوره"
    )

    result_rows = [(row, std_data.get(row, np.nan)) for row in STANDARD_COMPREHENSIVE_ROWS]
    for _, r in df.iterrows():
        lbl = str(r["label"]).strip()
        k = norm_label(lbl)
        if k and k not in matched_keys and pd.notna(r["value"]):
            result_rows.append((lbl, r["value"]))
    return pd.DataFrame(result_rows, columns=["label", "value"])

def map_statement_df(stmt_type: str, raw_df: pd.DataFrame) -> pd.DataFrame:
    if stmt_type == "Balance Sheet":
        return map_to_standard_balance(raw_df)
    if stmt_type == "Income Statement":
        return map_to_standard_income(raw_df)
    if stmt_type == "Cash Flow":
        return map_to_standard_cashflow(raw_df)
    if stmt_type == "Comprehensive Income":
        return map_to_standard_comprehensive(raw_df)
    return raw_df

def get_standard_row_list(stmt_type: str) -> Optional[list[str]]:
    if stmt_type == "Balance Sheet":
        return STANDARD_BALANCE_ROWS
    if stmt_type == "Income Statement":
        return STANDARD_INCOME_ROWS
    if stmt_type == "Cash Flow":
        return STANDARD_CASHFLOW_ROWS
    if stmt_type == "Comprehensive Income":
        return STANDARD_COMPREHENSIVE_ROWS
    return None

# ============================================================================
# 7. Store Standardized Statements in `fundamental.db` & Export to Excel
# ============================================================================

def save_standardized_statement_to_db(
    cur: sqlite3.Cursor,
    company_id: int,
    symbol: str,
    company_name: str,
    year: int,
    end_date: str,
    is_consolidated: bool,
    stmt_type: str,
    mapped_df: pd.DataFrame,
    letter_serial: str,
    tracing_no: int,
) -> int:
    """
    Persists a single year's standardized statement into BOTH:
      1. Its dedicated standard table (`balance_sheet`, `income_statement`, `cash_flow_statement`, `comprehensive_income`)
      2. The unified relational schema (`reports`, `line_items`, `financial_facts`)
    """
    if mapped_df is None or mapped_df.empty:
        return 0

    cons_int = 1 if consolidated_flag(is_consolidated) else 0
    tbl_name = STATEMENT_TO_TABLE.get(stmt_type)

    # Ensure report row exists for (company_id, end_date, is_consolidated)
    cur.execute(
        "SELECT report_id FROM reports WHERE company_id = ? AND end_date = ? AND is_consolidated = ?",
        (company_id, end_date, cons_int),
    )
    rep_row = cur.fetchone()
    if rep_row:
        report_id = rep_row[0]
    else:
        unique_tracing = int(tracing_no) * 10 + cons_int
        cur.execute(
            """
            INSERT OR IGNORE INTO reports
                (company_id, tracing_no, period_length, end_date, year, is_consolidated, letter_serial)
            VALUES (?, ?, 12, ?, ?, ?, ?)
            """,
            (company_id, unique_tracing, end_date, year, cons_int, letter_serial),
        )
        cur.execute(
            "SELECT report_id FROM reports WHERE company_id = ? AND end_date = ? AND is_consolidated = ?",
            (company_id, end_date, cons_int),
        )
        r2 = cur.fetchone()
        report_id = r2[0] if r2 else cur.lastrowid

    inserted = 0
    for row_idx, (_, r) in enumerate(mapped_df.iterrows()):
        item_name = str(r["label"]).strip()
        val = r["value"]
        val_native = None if (val is None or pd.isna(val)) else float(val)

        # Skip pure section headers that have no numeric value unless they are in dedicated table
        if tbl_name:
            cur.execute(
                f"""
                INSERT INTO {tbl_name}
                    (symbol, company_name, year, end_date, is_consolidated, row_index, item_name, value, letter_serial)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(symbol, year, is_consolidated, item_name)
                DO UPDATE SET
                    value = COALESCE(excluded.value, {tbl_name}.value),
                    end_date = excluded.end_date,
                    row_index = excluded.row_index,
                    letter_serial = excluded.letter_serial
                """,
                (symbol, company_name, year, end_date, cons_int, row_idx, item_name, val_native, letter_serial),
            )

        if val_native is not None:
            item_id = get_or_create_item(cur, stmt_type, item_name, row_order=row_idx)
            cur.execute(
                "DELETE FROM financial_facts WHERE report_id = ? AND item_id = ? AND is_consolidated = ?",
                (report_id, item_id, cons_int),
            )
            cur.execute(
                """
                INSERT INTO financial_facts
                    (report_id, item_id, data_period, is_restated, is_consolidated, audit_status, value)
                VALUES (?, ?, ?, 0, ?, 'Audited', ?)
                """,
                (report_id, item_id, str(year), cons_int, val_native),
            )
            inserted += 1

    return inserted

def consolidated_flag(v: bool | int) -> bool:
    return bool(v)

def scrape_symbol(
    symbol: str,
    db_name: str = DEFAULT_DB,
    start_year: int = 1395,
    consolidated: bool = False,
    sleep_s: float = 0.25,
    export_excel: bool = False,
) -> dict:
    """
    Main entrypoint:
      1. Queries Codal for all 12-month financial statements of `symbol` from `start_year`..1404
      2. Downloads each report (Excel or HTML)
      3. Backfills missing years using comparative prior-year columns in subsequent reports
      4. Extracts & standardizes Balance Sheet, Income Statement, Cash Flow, and Comprehensive Income
      5. Saves standardized records into `fundamental.db`
    """
    symbol = (symbol or "").strip()
    if not symbol:
        return {"symbol": symbol, "reports_fetched": 0, "facts_inserted": 0}

    target_years = [y for y in DEFAULT_TARGET_YEARS if y >= start_year]
    conn = ensure_db(db_name)
    cur = conn.cursor()

    reports, company_name = get_codal_serials_auto(symbol, target_years=target_years)
    company_id = get_or_create_company(cur, symbol, company_name or symbol)
    conn.commit()

    if not reports:
        conn.close()
        return {
            "symbol": symbol,
            "company_name": company_name or symbol,
            "reports_fetched": 0,
            "facts_inserted": 0,
            "years": [],
        }

    contents: dict[int, bytes] = {}
    meta_by_year: dict[int, dict] = {}

    for rep in reports:
        yr = rep["year"]
        meta_by_year[yr] = rep
        try:
            content = fetch_report_bytes(rep)
            contents[yr] = content
            cur.execute(
                """
                INSERT OR REPLACE INTO statement_metadata
                    (company_id, firm_symbol, year, end_date, is_consolidated, letter_serial, tracing_no, title, publish_date)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    company_id,
                    symbol,
                    str(yr),
                    rep["end_date"],
                    1 if consolidated else 0,
                    rep["serial"],
                    rep["tracing_no"],
                    rep["title"],
                    rep["publish_date"],
                ),
            )
            conn.commit()
            if sleep_s > 0:
                time.sleep(sleep_s)
        except Exception as e:
            log.warning("Failed to download report for %s year %s: %s", symbol, yr, e)

    # Comparative prior-year backfill: every year Y report on Codal also contains year Y-1 column
    for yr in sorted(list(contents.keys()), reverse=True):
        prev_yr = yr - 1
        if prev_yr >= start_year and prev_yr not in contents:
            contents[prev_yr] = contents[yr]
            meta_by_year[prev_yr] = {
                **meta_by_year[yr],
                "year": prev_yr,
                "end_date": f"{prev_yr}/12/29",
                "tracing_no": int(meta_by_year[yr]["tracing_no"]) - 1,
            }

    stmt_variants = get_statement_variants(consolidated)
    facts_total = 0
    yearly_by_stmt: dict[str, dict[int, pd.DataFrame]] = {k: {} for k in stmt_variants}

    for stmt_type, variants in stmt_variants.items():
        for yr in sorted(contents.keys()):
            raw_df = clean_df(extract_statement(contents[yr], variants, yr, consolidated=consolidated))
            # If current year's report didn't yield rows for yr, try yr+1's report (comparative column)
            if raw_df.empty and (yr + 1) in contents:
                raw_df = clean_df(extract_statement(contents[yr + 1], variants, yr, consolidated=consolidated))

            if raw_df.empty:
                continue

            mapped_df = map_statement_df(stmt_type, raw_df)
            yearly_by_stmt[stmt_type][yr] = mapped_df
            rep_meta = meta_by_year.get(yr, {})
            n_ins = save_standardized_statement_to_db(
                cur=cur,
                company_id=company_id,
                symbol=symbol,
                company_name=company_name or symbol,
                year=yr,
                end_date=rep_meta.get("end_date", f"{yr}/12/29"),
                is_consolidated=consolidated,
                stmt_type=stmt_type,
                mapped_df=mapped_df,
                letter_serial=rep_meta.get("serial", ""),
                tracing_no=rep_meta.get("tracing_no", yr * 100000),
            )
            facts_total += n_ins

    conn.commit()
    conn.close()

    if export_excel:
        try:
            export_symbol_to_excel(symbol, db_name=db_name, consolidated=consolidated)
        except Exception as e:
            log.warning("Excel export warning for %s: %s", symbol, e)

    return {
        "symbol": symbol,
        "company_name": company_name or symbol,
        "reports_fetched": len(reports),
        "years": sorted(contents.keys()),
        "facts_inserted": facts_total,
    }

def build_comparative_from_db(
    symbol: str,
    stmt_type: str = "Balance Sheet",
    consolidated: bool = False,
    db_name: str = DEFAULT_DB,
) -> pd.DataFrame:
    """
    Reads standardized statement rows for `symbol` from its dedicated table in `fundamental.db`
    and pivots them into a comparative multi-year DataFrame (rows = standard items in exact order,
    columns = years).
    """
    tbl_name = STATEMENT_TO_TABLE.get(stmt_type)
    if not tbl_name:
        return pd.DataFrame()

    conn = ensure_db(db_name)
    try:
        df = pd.read_sql_query(
            f"""
            SELECT year, row_index, item_name, value
            FROM {tbl_name}
            WHERE TRIM(symbol) = ? AND is_consolidated = ?
            ORDER BY row_index ASC, year ASC
            """,
            conn,
            params=(symbol.strip(), 1 if consolidated else 0),
        )
    finally:
        conn.close()

    if df.empty:
        return pd.DataFrame()

    std_rows = get_standard_row_list(stmt_type) or []
    extra_rows = [
        r for r in df.sort_values("row_index")["item_name"].unique().tolist() if r not in std_rows
    ]
    all_rows = std_rows + extra_rows

    years = sorted(df["year"].unique().tolist())
    out = pd.DataFrame(index=all_rows)
    for y in years:
        sub = df[df["year"] == y]
        val_map = dict(zip(sub["item_name"], sub["value"]))
        out[str(y)] = out.index.map(lambda item: val_map.get(item, np.nan))

    out.index.name = "شرح"
    return out.dropna(how="all")

def export_symbol_to_excel(
    symbol: str,
    db_name: str = DEFAULT_DB,
    consolidated: bool = False,
    out_dir: str = OUT_DIR,
) -> str:
    os.makedirs(out_dir, exist_ok=True)
    suffix = "_consolidated" if consolidated else "_standalone"
    out_path = os.path.join(out_dir, f"{symbol}{suffix}.xlsx")

    written = False
    with pd.ExcelWriter(out_path, engine="openpyxl") as xl:
        for stmt_type, fa_sheet in STATEMENT_TO_FA_SHEET.items():
            wide = build_comparative_from_db(symbol, stmt_type, consolidated=consolidated, db_name=db_name)
            if wide.empty:
                continue
            sheet = fa_sheet[:31]
            wide.to_excel(xl, sheet_name=sheet)
            ws = xl.sheets[sheet]
            ws.sheet_view.rightToLeft = True
            written = True
            for c in ws[1]:
                c.font = c.font.copy(bold=True)
            for col in ws.columns:
                w = max((len(str(c.value)) for c in col if c.value is not None), default=10)
                ws.column_dimensions[col[0].column_letter].width = min(w + 2, 45)

        if not written:
            pd.DataFrame(["هیچ داده ای یافت نشد"]).to_excel(xl, sheet_name="Empty")

    return out_path

if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(description="Fetch & standardize Codal financial statements into fundamental.db")
    parser.add_argument("--symbol", "-s", default="فملی", help="Stock ticker symbol in Persian (e.g. فملی, شپنا, فولاد)")
    parser.add_argument("--consolidated", "-c", action="store_true", help="Fetch consolidated (تلفیقی) statements")
    parser.add_argument("--start-year", "-y", type=int, default=1395, help="Start Jalali year (default: 1395)")
    parser.add_argument("--excel", "-x", action="store_true", help="Also export standardized .xlsx workbook")
    args = parser.parse_args()

    res = scrape_symbol(
        args.symbol,
        start_year=args.start_year,
        consolidated=args.consolidated,
        export_excel=args.excel,
    )
    print(json.dumps(res, ensure_ascii=False, indent=2))
