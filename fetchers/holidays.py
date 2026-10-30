"""
holidays.py
------------
Determines if today is a trading day for the Tehran Stock Exchange.
Uses jdatetime to check Persian calendar weekdays and a list of official holidays.
"""

import jdatetime

# ---- Official holidays in Persian calendar (YYYYMMDD) ----
# These are for 1405 (2026-2027). Update this list as needed.
# Source: Official holidays of Iran (approximate).
PERSIAN_HOLIDAYS = [
    "14050101",  # Nowruz (New Year) – 1st of Farvardin
    "14050102",  # Nowruz – 2nd of Farvardin
    "14050103",  # Nowruz – 3rd of Farvardin
    "14050112",  # 12th of Farvardin (Islamic Republic Day)
    "14050113",  # 13th of Farvardin (Nature Day)
    # Add more holidays as they are confirmed
]

def is_trading_day():
    """
    Returns True if today is a trading day for TSETMC.
    Trading days: not Thursday, not Friday, and not a listed holiday.
    """
    try:
        today = jdatetime.date.today()
        # jdatetime.weekday(): 0=Saturday, 1=Sunday, 2=Monday, 3=Tuesday, 4=Wednesday, 5=Thursday, 6=Friday
        weekday = today.weekday()
        # TSETMC is closed on Thursdays (5) and Fridays (6)
        if weekday in (5, 6):
            return False

        # Check if today is in the official holiday list
        today_str = today.strftime("%Y%m%d")
        if today_str in PERSIAN_HOLIDAYS:
            return False

        return True
    except ImportError:
        # If jdatetime is not installed, assume trading day (but log warning)
        print("⚠️ jdatetime not installed – cannot check holidays. Assuming trading day.")
        return True