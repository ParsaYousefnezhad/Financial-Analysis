"""
database.py
------------
Database access layer – supports both reading (for app) and writing (for fetcher).
"""

import sqlite3
import threading
import pandas as pd
from config import DB_PATH

# The APScheduler jobs in app.py run several fetchers in parallel threads and
# each of them ends up calling `insert_trades`. SQLite only ever allows a
# single writer, so every write is serialised behind one process-wide lock.
# This also guarantees the staging-table race (see `insert_trades`) cannot
# happen any more.
_WRITE_LOCK = threading.Lock()

# -------------------- Connection & Init --------------------
def get_connection():
    # `timeout` + `busy_timeout` make a second writer wait for the lock
    # instead of immediately raising "database is locked".
    conn = sqlite3.connect(str(DB_PATH), timeout=30.0)
    conn.execute("PRAGMA journal_mode=WAL")
    conn.execute("PRAGMA synchronous=NORMAL")
    conn.execute("PRAGMA busy_timeout=30000")
    return conn

def init_db():
    """Create stock_data table if it doesn't exist."""
    conn = get_connection()
    conn.execute("""
        CREATE TABLE IF NOT EXISTS stock_data (
            inscode  TEXT,
            date     TEXT,
            time     TEXT,
            open     REAL,
            high     REAL,
            low      REAL,
            close    REAL,
            volume   INTEGER,
            PRIMARY KEY (inscode, date, time)
        ) WITHOUT ROWID;
    """)
    conn.commit()
    conn.close()

# -------------------- Write (for fetcher) --------------------
def _to_native(value):
    """Convert numpy/pandas scalars to plain Python types for sqlite3.

    sqlite3 only binds native ``int``/``float``/``str``/``bytes``/``None``;
    ``numpy.int64`` in particular is *not* a subclass of ``int`` and would
    raise "Error binding parameter" if passed straight through.
    """
    if value is None or isinstance(value, (bytes, str)):
        return value
    if isinstance(value, bool):
        return int(value)
    if isinstance(value, (int, float)):
        return value
    item = getattr(value, "item", None)   # numpy scalars / pandas scalars
    if callable(item):
        try:
            return item()
        except Exception:
            pass
    return value


def insert_trades(inscode, df):
    if df.empty:
        return 0
    df = df.copy()
    
    # Ensure no bytes objects are sneaking into the insert
    for col in df.columns:
        if df[col].dtype == object:
            df[col] = df[col].apply(lambda x: x.decode('utf-8', errors='ignore') if isinstance(x, bytes) else x)

    df["date"] = pd.to_datetime(df["date"]).dt.strftime("%Y-%m-%d")
    df["time"] = pd.to_datetime(df["time"], format="%H:%M:%S", errors="coerce").dt.strftime("%H:%M:%S")
    df = df.dropna(subset=["time"])
    df = df.dropna(subset=["open", "high", "low", "close", "volume"])
    if df.empty:
        return 0
    df["inscode"] = inscode

    columns = ["inscode", "date", "time", "open", "high", "low", "close", "volume"]
    records = [
        tuple(_to_native(v) for v in row)
        for row in df[columns].itertuples(index=False, name=None)
    ]

    # One writer at a time (SQLite allows a single writer even in WAL mode and
    # the scheduler polls several sources from parallel threads). Writing
    # straight into `stock_data` with INSERT OR IGNORE removes the old
    # `temp_import` staging table, which was a normal (non-TEMP) table shared
    # by every connection and therefore silently corrupted / raced between
    # concurrent fetchers.
    with _WRITE_LOCK:
        conn = get_connection()
        try:
            before = conn.total_changes
            conn.executemany(
                """
                INSERT OR IGNORE INTO stock_data
                    (inscode, date, time, open, high, low, close, volume)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?);
                """,
                records,
            )
            inserted = conn.total_changes - before
            conn.commit()
        finally:
            conn.close()

    return inserted

# -------------------- Read (for app.py) --------------------
def get_stock_data(inscode):
    conn = get_connection()
    query = """
        SELECT date, time, open, high, low, close, volume
        FROM stock_data
        WHERE inscode = ?
        ORDER BY date, time
    """
    df = pd.read_sql_query(query, conn, params=(inscode,))
    conn.close()
    
    if df.empty:
        return df

    # ---- NEW FIX: Intercept and decode SQLite BLOBs/bytes ----
    for col in df.columns:
        if df[col].dtype == object:
            df[col] = df[col].apply(lambda x: x.decode('utf-8', errors='ignore') if isinstance(x, bytes) else x)

    df['datetime'] = pd.to_datetime(df['date'].astype(str) + ' ' + df['time'].astype(str), errors='coerce')
    df = df.dropna(subset=['datetime'])
    df = df.set_index('datetime')
    
    # ---- NEW FIX: Strictly cast to numeric to prevent JSON serialization errors ----
    for col in ['open', 'high', 'low', 'close']:
        df[col] = pd.to_numeric(df[col], errors='coerce')
    
    df['volume'] = pd.to_numeric(df['volume'], errors='coerce').fillna(0)
    
    df = df[['open', 'high', 'low', 'close', 'volume']]
    return df

def get_all_inscodes():
    conn = get_connection()
    cur = conn.execute("SELECT DISTINCT inscode FROM stock_data ORDER BY inscode;")
    codes = [row[0] for row in cur.fetchall()]
    conn.close()
    return codes