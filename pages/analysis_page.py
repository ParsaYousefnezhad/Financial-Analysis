import pandas as pd
import numpy as np
import warnings
from scipy.stats import gaussian_kde
from statsmodels.tsa.stattools import adfuller

from fastapi import APIRouter, Request
from fastapi.templating import Jinja2Templates
from fastapi.responses import JSONResponse

from config import INCODE_TO_NAME, BASE_DIR
from database import get_all_inscodes, get_stock_data
from fetchers.rf_fetcher import (
    get_optimal_akhza_rate,
    fetch_active_akhza_bonds,
    get_optimal_usd_rate,
    fetch_us_yield_curve
)

# Reuse the helper from the index page
from pages.index_page import resample_ohlcv

router = APIRouter()
templates = Jinja2Templates(directory=str(BASE_DIR / "templates"))

def _page_assets():
    inscodes = get_all_inscodes() or list(INCODE_TO_NAME.keys())
    return [{"value": c, "label": INCODE_TO_NAME.get(c, c)} for c in inscodes]

@router.get("/analysis")
async def analysis_page(request: Request):
    return templates.TemplateResponse("analysis.html",
                                      {"request": request, "assets": _page_assets()})

@router.get("/api/analysis")
async def compute_quant_metrics(asset1: str, asset2: str, timeframe: str = "1d"):
    try:
        df1 = resample_ohlcv(get_stock_data(asset1), timeframe)['close']
        df2 = resample_ohlcv(get_stock_data(asset2), timeframe)['close']

        df = pd.concat([df1, df2], axis=1, join='inner')
        if df.empty:
            return JSONResponse(
                status_code=400,
                content={"error": "No overlapping historical data found for these assets."}
            )

        df.columns = [asset1, asset2]

        returns = df.pct_change().dropna()
        if returns.empty:
            return JSONResponse(
                status_code=400,
                content={"error": "Not enough data points to calculate returns."}
            )

        start_date = returns.index.min().strftime('%Y-%m-%d')
        end_date = returns.index.max().strftime('%Y-%m-%d')

        mean_ret = returns.mean().to_dict()
        std_dev = returns.std().to_dict()
        cov_matrix = returns.cov()

        ann_factor = 252 if timeframe == "1d" else 1

        def is_usd_asset(ticker):
            ticker_upper = ticker.upper()
            return ticker_upper.endswith("USDT") or ticker_upper.endswith("USD")

        is_usd_1 = is_usd_asset(asset1)
        is_usd_2 = is_usd_asset(asset2)

        us_bonds = fetch_us_yield_curve()
        akhza_bonds = fetch_active_akhza_bonds()
        all_bonds = us_bonds + akhza_bonds

        opt_usd = get_optimal_usd_rate(target_days=365)
        opt_irr = get_optimal_akhza_rate(target_days=365)

        rf_rate_1 = opt_usd.get('ytm', 0.0415) if is_usd_1 else opt_irr.get('ytm', 0.39)
        rf_symbol_1 = opt_usd.get('symbol', 'US T-Bill (1Y)') if is_usd_1 else opt_irr.get('symbol', 'اخزا301')

        rf_rate_2 = opt_usd.get('ytm', 0.0415) if is_usd_2 else opt_irr.get('ytm', 0.39)
        rf_symbol_2 = opt_usd.get('symbol', 'US T-Bill (1Y)') if is_usd_2 else opt_irr.get('symbol', 'اخزا301')

        sensitivity_table = []
        cov_12 = cov_matrix.iloc[0, 1]

        for w1 in np.linspace(0, 1, 11):
            w2 = 1.0 - w1
            port_ret = (w1 * mean_ret[asset1]) + (w2 * mean_ret[asset2])
            port_var = (
                (w1 ** 2) * (std_dev[asset1] ** 2)
                + (w2 ** 2) * (std_dev[asset2] ** 2)
                + (2 * w1 * w2 * cov_12)
            )
            port_vol = np.sqrt(port_var)

            ann_ret = port_ret * ann_factor
            ann_vol = port_vol * np.sqrt(ann_factor)

            port_rf = (w1 * rf_rate_1) + (w2 * rf_rate_2)
            sharpe = (ann_ret - port_rf) / ann_vol if ann_vol != 0 else 0

            sensitivity_table.append({
                "weight_1": round(w1, 2),
                "weight_2": round(w2, 2),
                "return": ann_ret,
                "volatility": ann_vol,
                "sharpe": sharpe
            })

        individual_sharpe = {}
        individual_sharpe[asset1] = (
            (mean_ret[asset1] * ann_factor - rf_rate_1)
            / (std_dev[asset1] * np.sqrt(ann_factor))
            if std_dev[asset1] != 0 else 0
        )
        individual_sharpe[asset2] = (
            (mean_ret[asset2] * ann_factor - rf_rate_2)
            / (std_dev[asset2] * np.sqrt(ann_factor))
            if std_dev[asset2] != 0 else 0
        )

        dist_data = {}
        stationarity_data = {}

        for asset in [asset1, asset2]:
            asset_ret = returns[asset]
            skewness = float(asset_ret.skew())
            kurtosis = float(asset_ret.kurtosis())

            # KDE needs >= 2 points and non-zero variance; a flat or very short
            # return series makes gaussian_kde raise LinAlgError("singular
            # matrix"), which previously 500'd the whole /api/analysis request.
            # Fall back to a flat/empty curve instead of failing.
            try:
                lo, hi = float(asset_ret.min()), float(asset_ret.max())
                if len(asset_ret) >= 2 and hi > lo and float(asset_ret.std()) > 0:
                    kde = gaussian_kde(asset_ret)
                    x_vals = np.linspace(lo, hi, 100)
                    y_vals = kde(x_vals)
                else:
                    x_vals = np.linspace(lo, hi if hi > lo else lo + 1e-9, 100)
                    y_vals = np.zeros(100)
            except Exception:
                x_vals = np.zeros(100)
                y_vals = np.zeros(100)

            try:
                with warnings.catch_warnings():
                    warnings.simplefilter("ignore", FutureWarning)
                    adf_res = adfuller(asset_ret)

                is_stationary = bool(adf_res[1] < 0.05)
                adf_stat = float(adf_res[0])
                p_value = float(adf_res[1])
            except Exception:
                is_stationary, adf_stat, p_value = False, 0.0, 1.0

            dist_data[asset] = {
                "skew": skewness,
                "kurtosis": kurtosis,
                "kde_x": (x_vals * 100).tolist(),
                "kde_y": y_vals.tolist()
            }
            stationarity_data[asset] = {
                "is_stationary": is_stationary,
                "adf_stat": adf_stat,
                "p_value": p_value
            }

        performance_data = {}
        window = 21 if timeframe == "1d" else (30 * 24 if timeframe == "1h" else 21)

        for asset, df_asset in [(asset1, df1), (asset2, df2)]:
            try:
                m_prices = df_asset.resample('ME').last().dropna()
            except ValueError:
                m_prices = df_asset.resample('M').last().dropna()

            m_ret = m_prices.pct_change().dropna()
            heatmap_data = [
                {"year": d.year, "month": d.month, "return": float(val)}
                for d, val in m_ret.items()
            ]

            try:
                y_prices = df_asset.resample('YE').last().dropna()
            except ValueError:
                y_prices = df_asset.resample('Y').last().dropna()

            y_ret = y_prices.pct_change().dropna()
            yearly_data = [
                {"year": d.year, "return": float(val)}
                for d, val in y_ret.items()
            ]

            rolling_ret = df_asset.pct_change(window).dropna()
            rolling_vol = returns[asset].rolling(window).std() * np.sqrt(ann_factor)

            rolling_df = pd.DataFrame({'ret': rolling_ret, 'vol': rolling_vol}).dropna()

            performance_data[asset] = {
                "heatmap": heatmap_data,
                "yearly": yearly_data,
                "rolling": {
                    "dates": [d.strftime('%Y-%m-%d') for d in rolling_df.index],
                    "returns": rolling_df['ret'].tolist(),
                    "volatility": rolling_df['vol'].tolist()
                }
            }

        return JSONResponse({
            "correlation": returns.corr().to_dict(),
            "covariance": cov_matrix.to_dict(),
            "annualized_volatility": {k: v * np.sqrt(ann_factor) for k, v in std_dev.items()},
            "sharpe_ratio": individual_sharpe,
            "rf_data": {
                "asset1": {"rate": rf_rate_1, "symbol": rf_symbol_1},
                "asset2": {"rate": rf_rate_2, "symbol": rf_symbol_2}
            },
            "active_bonds": all_bonds,
            "start_date": start_date,
            "end_date": end_date,
            "timeframe": timeframe,
            "sensitivity_table": sensitivity_table,
            "distribution": dist_data,
            "stationarity": stationarity_data,
            "performance": performance_data
        })

    except Exception as e:
        return JSONResponse(status_code=500, content={"error": str(e)})