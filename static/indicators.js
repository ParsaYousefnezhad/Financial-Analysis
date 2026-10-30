/* ============================================================================
 * indicators.js — TradingView Lightweight Charts Indicator & Sub-Pane Engine
 * ============================================================================
 * Implements 16 technical & quantitative indicators on Lightweight Charts:
 *   Main Chart Overlays: MA, EMA, BOLL, SAR, SUPERTREND, SMC (Order Blocks & BOS/CHoCH)
 *   Synced Sub-Panes:    VOL, MACD, RSI, KDJ, BIAS, CCI, WR, OBV, OSAVERAGE, VPSR
 *
 * Features:
 *   - Dedicated LightweightCharts sub-pane instances synced in real time
 *   - Interactive DOM legends per pane (Visibility Eye, Settings Modal, Delete)
 *   - Real-time 60fps crosshair value readouts
 *   - Full workspace serialization for Save/Load layouts
 * ==========================================================================*/
(function () {
    'use strict';

    window._klinePaneBounds = window._klinePaneBounds || {};

    function hexToRgba(hex, alpha) {
        let h = String(hex || '').replace('#', '');
        if (h.length === 3) h = h.split('').map(function (c) { return c + c; }).join('');
        if (h.length !== 6) return 'rgba(0,0,0,' + alpha + ')';
        const r = parseInt(h.substring(0, 2), 16);
        const g = parseInt(h.substring(2, 4), 16);
        const b = parseInt(h.substring(4, 6), 16);
        return 'rgba(' + r + ',' + g + ',' + b + ',' + alpha + ')';
    }

    /* ============================================================
     * 1. Indicator Catalog & Configurations
     * ============================================================ */
    const DEFAULT_PALETTE = ['#2962FF', '#FF6D00', '#00C853', '#FF1744', '#9C27B0'];

    const INDICATOR_CONFIG = {
        MA: {
            pane: 'candle_pane',
            params: [5, 10, 30, 60],
            lines: ['MA 1', 'MA 2', 'MA 3', 'MA 4'],
            keys: ['ma1', 'ma2', 'ma3', 'ma4'],
            activeColors: ['#2962FF', '#FF6D00', '#00C853', '#9C27B0'],
            lineSize: 1.5
        },
        EMA: {
            pane: 'candle_pane',
            params: [5, 10, 30, 60],
            lines: ['EMA 1', 'EMA 2', 'EMA 3', 'EMA 4'],
            keys: ['ema1', 'ema2', 'ema3', 'ema4'],
            activeColors: ['#2962FF', '#FF6D00', '#00C853', '#9C27B0'],
            lineSize: 1.5
        },
        BOLL: {
            pane: 'candle_pane',
            params: [20, 2],
            lines: ['UP', 'MID', 'DN'],
            keys: ['up', 'mid', 'dn'],
            activeColors: ['#2962FF', '#FF6D00', '#2962FF'],
            lineSize: 1.5
        },
        SAR: {
            pane: 'candle_pane',
            params: [2, 2, 20],
            lines: ['SAR'],
            keys: ['sar'],
            activeColors: ['#FF6D00'],
            lineSize: 1.5
        },
        SUPERTREND: {
            pane: 'candle_pane',
            params: [10, 3.0],
            lines: ['Up', 'Down'],
            keys: ['up', 'dn'],
            activeColors: ['#089981', '#f23645'],
            activeStyles: ['solid', 'solid'],
            lineSize: 2
        },
        VOL: {
            pane: 'pane_vol',
            height: 125,
            params: [5, 10, 20],
            lines: ['VOL', 'MA 1', 'MA 2', 'MA 3'],
            keys: ['volume', 'ma1', 'ma2', 'ma3'],
            types: ['bar', 'line', 'line', 'line'],
            activeColors: ['#26a69a', '#2962FF', '#FF6D00', '#9C27B0']
        },
        MACD: {
            pane: 'pane_macd',
            height: 145,
            params: [12, 26, 9],
            lines: ['DIF', 'DEA', 'MACD'],
            keys: ['dif', 'dea', 'macd'],
            types: ['line', 'line', 'bar'],
            activeColors: ['#2962FF', '#FF6D00', '#26a69a']
        },
        RSI: {
            pane: 'pane_rsi',
            height: 165,
            params: [60, 14],
            lines: ['RSI', 'EMA'],
            keys: ['rsi', 'ema'],
            activeColors: ['#7e57c2', '#131722'],
            activeStyles: ['solid', 'solid'],
            lineSize: 1.5,
            priceLines: [
                { price: 70, color: '#787B86', dashed: true },
                { price: 65, color: '#f23645', dashed: false },
                { price: 60, color: '#363a45', dashed: false },
                { price: 40, color: '#363a45', dashed: false },
                { price: 35, color: '#089981', dashed: false },
                { price: 30, color: '#787B86', dashed: true }
            ]
        },
        KDJ: {
            pane: 'pane_kdj',
            height: 135,
            params: [9, 3, 3],
            lines: ['K', 'D', 'J'],
            keys: ['k', 'd', 'j'],
            activeColors: ['#2962FF', '#FF6D00', '#9C27B0'],
            priceLines: [
                { price: 80, color: '#787B86', dashed: true },
                { price: 20, color: '#787B86', dashed: true }
            ]
        },
        BIAS: {
            pane: 'pane_bias',
            height: 120,
            params: [6, 12, 24],
            lines: ['BIAS 1', 'BIAS 2', 'BIAS 3'],
            keys: ['bias1', 'bias2', 'bias3'],
            activeColors: ['#2962FF', '#FF6D00', '#00C853'],
            priceLines: [
                { price: 0, color: '#9598a1', dashed: true }
            ]
        },
        CCI: {
            pane: 'pane_cci',
            height: 120,
            params: [14],
            lines: ['CCI'],
            keys: ['cci'],
            activeColors: ['#2962FF'],
            priceLines: [
                { price: 100, color: '#787B86', dashed: true },
                { price: 0, color: '#b2b5be', dashed: true },
                { price: -100, color: '#787B86', dashed: true }
            ]
        },
        WR: {
            pane: 'pane_wr',
            height: 120,
            params: [14],
            lines: ['WR'],
            keys: ['wr'],
            activeColors: ['#2962FF'],
            priceLines: [
                { price: -20, color: '#787B86', dashed: true },
                { price: -80, color: '#787B86', dashed: true }
            ]
        },
        OBV: {
            pane: 'pane_obv',
            height: 125,
            params: [30],
            lines: ['OBV', 'MAOBV'],
            keys: ['obv', 'maobv'],
            activeColors: ['#2962FF', '#FF6D00']
        },
        SMC: {
            pane: 'candle_pane',
            params: [],
            lines: [],
            keys: []
        },
        OSAVERAGE: {
            pane: 'pane_osaverage',
            height: 130,
            params: [5, 20, 15],
            lines: ['Xtrender'],
            keys: ['xtrender'],
            types: ['bar'],
            activeColors: ['#00c853'],
            priceLines: [
                { price: 0, color: '#9598a1', dashed: true }
            ]
        },
        VPSR: {
            pane: 'pane_vpsr',
            height: 130,
            params: [50, 5, 50],
            lines: ['Osc', 'Fast', 'Mid'],
            keys: ['oscillator', 'fastSignal', 'midline'],
            activeColors: ['#2962FF', '#f23645', '#131722'],
            priceLines: [
                { price: 70, color: '#787B86', dashed: true },
                { price: 50, color: '#b2b5be', dashed: true },
                { price: 30, color: '#787B86', dashed: true }
            ]
        }
    };

    /* ============================================================
     * 2. Calculation Registry & External Custom Indicator Bridge
     * ============================================================ */
    const CALC_REGISTRY = {};

    function registerIndicatorDef(def) {
        if (!def || !def.name) return;
        CALC_REGISTRY[def.name] = def;
        if (INDICATOR_CONFIG[def.name] && Array.isArray(def.calcParams) && def.calcParams.length > 0) {
            if (!INDICATOR_CONFIG[def.name].params || INDICATOR_CONFIG[def.name].params.length === 0) {
                INDICATOR_CONFIG[def.name].params = def.calcParams.slice();
            }
        }
        if (typeof window.__onCustomIndicatorRegistered === 'function') {
            window.__onCustomIndicatorRegistered(def.name);
        }
    }

    window.TVIndicators = {
        register: registerIndicatorDef,
        registerIndicator: registerIndicatorDef,
        getConfig: function (name) { return INDICATOR_CONFIG[name]; }
    };

    // Provide compatibility shim so custom indicator scripts (osaverage.js, vpsr.js)
    // that call klinecharts.registerIndicator(...) automatically register here too
    window.klinecharts = window.klinecharts || {};
    if (typeof window.klinecharts.registerIndicator !== 'function') {
        window.klinecharts.registerIndicator = registerIndicatorDef;
    }
    if (typeof window.klinecharts.registerOverlay !== 'function') {
        window.klinecharts.registerOverlay = function () {};
    }

    /* ============================================================
     * 3. Standard Indicator Mathematical Implementations
     * ============================================================ */
    registerIndicatorDef({
        name: 'MA',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [5, 10, 30, 60];
            const sums = [0, 0, 0, 0];
            return dataList.map(function (k, i) {
                const res = {};
                params.forEach(function (p, idx) {
                    if (!p || p <= 0) return;
                    sums[idx] += k.close;
                    if (i >= p) sums[idx] -= dataList[i - p].close;
                    if (i >= p - 1) {
                        res['ma' + (idx + 1)] = sums[idx] / p;
                    }
                });
                return res;
            });
        }
    });

    registerIndicatorDef({
        name: 'EMA',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [5, 10, 30, 60];
            const emas = [null, null, null, null];
            const mults = params.map(function (p) { return 2 / ((p || 1) + 1); });
            return dataList.map(function (k) {
                const res = {};
                params.forEach(function (p, i) {
                    if (!p || p <= 0) return;
                    if (emas[i] === null) emas[i] = k.close;
                    else emas[i] = (k.close - emas[i]) * mults[i] + emas[i];
                    res['ema' + (i + 1)] = emas[i];
                });
                return res;
            });
        }
    });

    registerIndicatorDef({
        name: 'BOLL',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [20, 2];
            const length = Math.max(1, Math.round(params[0] || 20));
            const stdDev = params[1] != null ? params[1] : 2;
            const result = [];
            let sum = 0;
            for (let i = 0; i < dataList.length; i++) {
                sum += dataList[i].close;
                if (i >= length) sum -= dataList[i - length].close;
                if (i < length - 1) {
                    result.push({});
                    continue;
                }
                const mid = sum / length;
                let varianceSum = 0;
                for (let j = i - length + 1; j <= i; j++) {
                    const diff = dataList[j].close - mid;
                    varianceSum += diff * diff;
                }
                const sd = Math.sqrt(varianceSum / length);
                result.push({
                    up: mid + stdDev * sd,
                    mid: mid,
                    dn: mid - stdDev * sd
                });
            }
            return result;
        }
    });

    registerIndicatorDef({
        name: 'SAR',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [2, 2, 20];
            const stepAf = (params[0] || 2) / 100;
            const maxAf  = (params[2] || 20) / 100;
            const result = [];
            if (!dataList.length) return result;
            let sar = dataList[0].low;
            let ep  = dataList[0].high;
            let af  = stepAf;
            let isUp = true;
            for (let i = 0; i < dataList.length; i++) {
                const k = dataList[i];
                if (i === 0) {
                    result.push({ sar: sar });
                    continue;
                }
                sar = sar + af * (ep - sar);
                if (isUp) {
                    if (k.low < sar) {
                        isUp = false;
                        sar = ep;
                        ep = k.low;
                        af = stepAf;
                    } else if (k.high > ep) {
                        ep = k.high;
                        af = Math.min(af + stepAf, maxAf);
                    }
                } else {
                    if (k.high > sar) {
                        isUp = true;
                        sar = ep;
                        ep = k.high;
                        af = stepAf;
                    } else if (k.low < ep) {
                        ep = k.low;
                        af = Math.min(af + stepAf, maxAf);
                    }
                }
                result.push({ sar: sar });
            }
            return result;
        }
    });

    registerIndicatorDef({
        name: 'SUPERTREND',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [10, 3.0];
            const period     = Math.max(1, Math.round(params[0] || 10));
            const multiplier = params[1] || 3.0;
            const n = dataList.length;

            const tr = new Array(n);
            for (let i = 0; i < n; i++) {
                const h  = dataList[i].high;
                const l  = dataList[i].low;
                const pc = i > 0 ? dataList[i - 1].close : h;
                tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
            }

            const atr = new Array(n).fill(undefined);
            if (n >= period) {
                let sum = 0;
                for (let i = 0; i < period; i++) sum += tr[i];
                atr[period - 1] = sum / period;
                for (let i = period; i < n; i++) {
                    atr[i] = (atr[i - 1] * (period - 1) + tr[i]) / period;
                }
            }

            const upBand   = new Array(n).fill(undefined);
            const dnBand   = new Array(n).fill(undefined);
            const trendArr = new Array(n).fill(undefined);

            for (let i = 0; i < n; i++) {
                if (atr[i] === undefined) continue;
                const bar = dataList[i];
                const src = (bar.high + bar.low) / 2;

                let up = src - multiplier * atr[i];
                let dn = src + multiplier * atr[i];

                const prevUp = (i > 0 && upBand[i - 1] !== undefined) ? upBand[i - 1] : up;
                const prevDn = (i > 0 && dnBand[i - 1] !== undefined) ? dnBand[i - 1] : dn;

                if (i > 0 && dataList[i - 1].close > prevUp) up = Math.max(up, prevUp);
                if (i > 0 && dataList[i - 1].close < prevDn) dn = Math.min(dn, prevDn);

                upBand[i] = up;
                dnBand[i] = dn;

                const prevTrend = (i > 0 && trendArr[i - 1] !== undefined) ? trendArr[i - 1] : 1;
                let t = prevTrend;
                if (prevTrend === -1 && bar.close > prevDn) t = 1;
                else if (prevTrend === 1 && bar.close < prevUp) t = -1;
                trendArr[i] = t;
            }

            return dataList.map(function (_, i) {
                const out = {};
                if (trendArr[i] === 1) {
                    out.up = upBand[i];
                    out.trend = 1;
                } else if (trendArr[i] === -1) {
                    out.dn = dnBand[i];
                    out.trend = -1;
                }
                if (i > 0 && trendArr[i - 1] !== undefined && trendArr[i] !== undefined && trendArr[i] !== trendArr[i - 1]) {
                    out.flipped = true;
                }
                return out;
            });
        }
    });

    registerIndicatorDef({
        name: 'VOL',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [5, 10, 20];
            const sums = [0, 0, 0];
            return dataList.map(function (k, i) {
                const isUp = k.close >= k.open;
                const res = {
                    volume: k.volume,
                    _barColor: isUp ? 'rgba(38, 166, 154, 0.65)' : 'rgba(239, 83, 80, 0.65)'
                };
                params.forEach(function (p, idx) {
                    if (!p || p <= 0) return;
                    sums[idx] += k.volume;
                    if (i >= p) sums[idx] -= dataList[i - p].volume;
                    if (i >= p - 1) {
                        res['ma' + (idx + 1)] = sums[idx] / p;
                    }
                });
                return res;
            });
        }
    });

    registerIndicatorDef({
        name: 'MACD',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [12, 26, 9];
            const fast = params[0] || 12;
            const slow = params[1] || 26;
            const signal = params[2] || 9;
            let prevFast = null, prevSlow = null, prevDea = null;
            return dataList.map(function (k) {
                prevFast = prevFast === null ? k.close : (k.close - prevFast) * (2 / (fast + 1)) + prevFast;
                prevSlow = prevSlow === null ? k.close : (k.close - prevSlow) * (2 / (slow + 1)) + prevSlow;
                const dif = prevFast - prevSlow;
                prevDea = prevDea === null ? dif : (dif - prevDea) * (2 / (signal + 1)) + prevDea;
                const macdVal = (dif - prevDea) * 2;
                return {
                    dif: dif,
                    dea: prevDea,
                    macd: macdVal,
                    _barColor: macdVal >= 0 ? '#26a69a' : '#ef5350'
                };
            });
        }
    });

    registerIndicatorDef({
        name: 'RSI',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [60, 14];
            const rp = Math.max(1, Math.round(params[0] || 60));
            const ep = Math.max(1, Math.round(params[1] || 14));
            let avgGain = 0, avgLoss = 0, prevEma = null;
            return dataList.map(function (k, i) {
                const out = {};
                if (i === 0) return out;
                const change = k.close - dataList[i - 1].close;
                const gain = change > 0 ? change : 0;
                const loss = change < 0 ? -change : 0;
                if (i < rp) {
                    avgGain += gain;
                    avgLoss += loss;
                    return out;
                }
                if (i === rp) {
                    avgGain = (avgGain + gain) / rp;
                    avgLoss = (avgLoss + loss) / rp;
                } else {
                    avgGain = (avgGain * (rp - 1) + gain) / rp;
                    avgLoss = (avgLoss * (rp - 1) + loss) / rp;
                }
                const rs = avgLoss === 0 ? 0 : avgGain / avgLoss;
                const rsi = avgLoss === 0 ? 100 : 100 - 100 / (1 + rs);
                out.rsi = rsi;
                if (prevEma === null) {
                    prevEma = rsi;
                    out.ema = rsi;
                } else {
                    prevEma = (rsi - prevEma) * (2 / (ep + 1)) + prevEma;
                    out.ema = prevEma;
                }
                return out;
            });
        }
    });

    registerIndicatorDef({
        name: 'KDJ',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [9, 3, 3];
            const n = Math.max(1, Math.round(params[0] || 9));
            let prevK = 50, prevD = 50;
            return dataList.map(function (k, i) {
                if (i < n - 1) return {};
                let high = -Infinity, low = Infinity;
                for (let j = i - n + 1; j <= i; j++) {
                    if (dataList[j].high > high) high = dataList[j].high;
                    if (dataList[j].low  < low)  low  = dataList[j].low;
                }
                const rsv  = high === low ? 50 : ((k.close - low) / (high - low)) * 100;
                const kVal = (2 / 3) * prevK + (1 / 3) * rsv;
                const dVal = (2 / 3) * prevD + (1 / 3) * kVal;
                const jVal = 3 * kVal - 2 * dVal;
                prevK = kVal;
                prevD = dVal;
                return { k: kVal, d: dVal, j: jVal };
            });
        }
    });

    registerIndicatorDef({
        name: 'BIAS',
        calc: function (dataList, indicator) {
            const params = indicator.calcParams || [6, 12, 24];
            const sums = [0, 0, 0];
            return dataList.map(function (k, i) {
                const res = {};
                params.forEach(function (p, idx) {
                    if (!p || p <= 0) return;
                    sums[idx] += k.close;
                    if (i >= p) sums[idx] -= dataList[i - p].close;
                    if (i >= p - 1) {
                        const ma = sums[idx] / p;
                        res['bias' + (idx + 1)] = ma !== 0 ? ((k.close - ma) / ma) * 100 : 0;
                    }
                });
                return res;
            });
        }
    });

    registerIndicatorDef({
        name: 'CCI',
        calc: function (dataList, indicator) {
            const p = Math.max(1, Math.round((indicator.calcParams && indicator.calcParams[0]) || 14));
            return dataList.map(function (k, i) {
                if (i < p - 1) return {};
                const tp = [];
                let sum = 0;
                for (let j = i - p + 1; j <= i; j++) {
                    const v = (dataList[j].high + dataList[j].low + dataList[j].close) / 3;
                    tp.push(v);
                    sum += v;
                }
                const ma = sum / p;
                let mdSum = 0;
                for (let m = 0; m < tp.length; m++) mdSum += Math.abs(tp[m] - ma);
                const md = mdSum / p;
                const cci = md === 0 ? 0 : (tp[tp.length - 1] - ma) / (0.015 * md);
                return { cci: cci };
            });
        }
    });

    registerIndicatorDef({
        name: 'WR',
        calc: function (dataList, indicator) {
            const p = Math.max(1, Math.round((indicator.calcParams && indicator.calcParams[0]) || 14));
            return dataList.map(function (k, i) {
                if (i < p - 1) return {};
                let high = -Infinity, low = Infinity;
                for (let j = i - p + 1; j <= i; j++) {
                    if (dataList[j].high > high) high = dataList[j].high;
                    if (dataList[j].low  < low)  low  = dataList[j].low;
                }
                const wr = high === low ? 0 : ((high - k.close) / (high - low)) * -100;
                return { wr: wr };
            });
        }
    });

    registerIndicatorDef({
        name: 'OBV',
        calc: function (dataList, indicator) {
            const p = Math.max(1, Math.round((indicator.calcParams && indicator.calcParams[0]) || 30));
            let obv = 0;
            const obvList = dataList.map(function (k, i) {
                if (i === 0) {
                    obv = k.volume;
                    return obv;
                }
                if (k.close > dataList[i - 1].close) obv += k.volume;
                else if (k.close < dataList[i - 1].close) obv -= k.volume;
                return obv;
            });
            let sum = 0;
            return dataList.map(function (_, i) {
                const res = { obv: obvList[i] };
                sum += obvList[i];
                if (i >= p) sum -= obvList[i - p];
                if (i >= p - 1) res.maobv = sum / p;
                return res;
            });
        }
    });

    /* ============================================================
     * 4. Boot & Main Indicator Controller
     * ============================================================ */
    if (window.ChartState && window.ChartState.mainChart) {
        initIndicators();
    } else {
        window.addEventListener('chartStateReady', function () {
            initIndicators();
        }, { once: true });
    }

    function initIndicators() {
        const activeIndicators    = new Set();
        const indicatorVisibility = {};
        const indicatorPaneMap    = {};
        const indicatorResults    = {};
        const indicatorSeriesMap  = {};
        let smcComputedData       = null;
        let currentEditingIndicator = null;
        const SMC_EXTEND_BARS = 20;

        const SMC_SETTINGS = {
            swings_length:     50,
            internal_length:   5,
            swing_ob_size:     5,
            internal_ob_size:  5,
            internalBullColor: '#3179f5',
            internalBearColor: '#f77c80',
            swingBullColor:    '#1848cc',
            swingBearColor:    '#b22833',
            internalBullOpacity: 18,
            internalBearOpacity: 18,
            swingBullOpacity:    18,
            swingBearOpacity:    18,
            lineWidths:          [1, 1, 1, 1],
            lineStyles:          ['solid', 'solid', 'solid', 'solid'],
            lineVisible:         [true, true, true, true]
        };
        const DEFAULT_SMC_SNAPSHOT = JSON.parse(JSON.stringify(SMC_SETTINGS));

        const IND_DEFAULTS_STORAGE_KEY = 'tv_ind_default_settings_v1';
        let savedIndicatorDefaults = {};
        try {
            const raw = window.localStorage && window.localStorage.getItem(IND_DEFAULTS_STORAGE_KEY);
            if (raw) {
                const parsed = JSON.parse(raw);
                if (parsed && typeof parsed === 'object') savedIndicatorDefaults = parsed;
            }
        } catch (e) {}

        function persistSavedIndicatorDefaults() {
            try {
                if (window.localStorage) {
                    window.localStorage.setItem(IND_DEFAULTS_STORAGE_KEY, JSON.stringify(savedIndicatorDefaults));
                }
            } catch (e) {}
        }

        if (savedIndicatorDefaults.SMC && typeof savedIndicatorDefaults.SMC === 'object') {
            Object.keys(savedIndicatorDefaults.SMC).forEach(function (k) {
                if (SMC_SETTINGS[k] !== undefined) {
                    SMC_SETTINGS[k] = JSON.parse(JSON.stringify(savedIndicatorDefaults.SMC[k]));
                }
            });
            if (!Array.isArray(SMC_SETTINGS.lineWidths) || SMC_SETTINGS.lineWidths.length < 4) {
                const w = typeof savedIndicatorDefaults.SMC.lineWidth === 'number' ? savedIndicatorDefaults.SMC.lineWidth : 1;
                SMC_SETTINGS.lineWidths = [w, w, w, w];
            }
            if (!Array.isArray(SMC_SETTINGS.lineStyles) || SMC_SETTINGS.lineStyles.length < 4) {
                const s = typeof savedIndicatorDefaults.SMC.lineStyle === 'string' ? savedIndicatorDefaults.SMC.lineStyle : 'solid';
                SMC_SETTINGS.lineStyles = [s, s, s, s];
            }
            if (!Array.isArray(SMC_SETTINGS.lineVisible) || SMC_SETTINGS.lineVisible.length < 4) {
                SMC_SETTINGS.lineVisible = [true, true, true, true];
            }
        }

        // Ensure every indicator in INDICATOR_CONFIG has per-line style arrays & factory snapshot
        const DEFAULT_INDICATOR_SNAPSHOTS = {};
        function ensureIndicatorStyleArrays(name) {
            const cfg = INDICATOR_CONFIG[name];
            if (!cfg) return;
            const count = (cfg.lines && cfg.lines.length) || (cfg.keys && cfg.keys.length) || 0;
            const defColors = cfg.activeColors || DEFAULT_PALETTE;
            const defW = Math.max(1, Math.min(4, Math.round(cfg.lineSize || 2)));
            if (!Array.isArray(cfg.activeColors)) cfg.activeColors = [];
            if (!Array.isArray(cfg.lineWidths))   cfg.lineWidths = [];
            if (!Array.isArray(cfg.lineStyles))   cfg.lineStyles = [];
            if (!Array.isArray(cfg.lineOpacities)) cfg.lineOpacities = [];
            if (!Array.isArray(cfg.lineVisible))  cfg.lineVisible = [];
            for (let i = 0; i < count; i++) {
                if (!cfg.activeColors[i]) cfg.activeColors[i] = defColors[i % defColors.length];
                if (typeof cfg.lineWidths[i] !== 'number') cfg.lineWidths[i] = defW;
                if (!cfg.lineStyles[i]) cfg.lineStyles[i] = (cfg.activeStyles && cfg.activeStyles[i]) || 'solid';
                if (typeof cfg.lineOpacities[i] !== 'number') cfg.lineOpacities[i] = 100;
                if (typeof cfg.lineVisible[i] !== 'boolean') cfg.lineVisible[i] = true;
            }
            if (!DEFAULT_INDICATOR_SNAPSHOTS[name]) {
                DEFAULT_INDICATOR_SNAPSHOTS[name] = {
                    params:        Array.isArray(cfg.params) ? cfg.params.slice() : [],
                    activeColors:  cfg.activeColors.slice(),
                    lineWidths:    cfg.lineWidths.slice(),
                    lineStyles:    cfg.lineStyles.slice(),
                    lineOpacities: cfg.lineOpacities.slice(),
                    lineVisible:   cfg.lineVisible.slice()
                };
                const saved = savedIndicatorDefaults[name];
                if (saved && typeof saved === 'object') {
                    if (Array.isArray(saved.params))        cfg.params        = saved.params.slice();
                    if (Array.isArray(saved.activeColors))  cfg.activeColors  = saved.activeColors.slice();
                    if (Array.isArray(saved.lineWidths))    cfg.lineWidths    = saved.lineWidths.slice();
                    if (Array.isArray(saved.lineStyles))    cfg.lineStyles    = saved.lineStyles.slice();
                    if (Array.isArray(saved.lineOpacities)) cfg.lineOpacities = saved.lineOpacities.slice();
                    if (Array.isArray(saved.lineVisible))   cfg.lineVisible   = saved.lineVisible.slice();
                }
            }
        }
        Object.keys(INDICATOR_CONFIG).forEach(ensureIndicatorStyleArrays);

        let latestCrosshairIndex = null;

        // If a custom indicator script (osaverage.js, vpsr.js) finishes loading after initIndicators,
        // recompute if that indicator is already active.
        window.__onCustomIndicatorRegistered = function (name) {
            ensureIndicatorStyleArrays(name);
            if (activeIndicators.has(name)) {
                rebuildIndicatorSeries(name);
                renderAllLegends();
            }
        };

        /* --------------------------------------------------------
         * Canvas Overlay Drawing for RSI 30-70 Band, SMC & Bollinger Band Fill
         * -------------------------------------------------------- */
        function drawIndicatorsOnMainCanvas(ctx, helpers) {
            if (helpers && helpers.paneId === 'pane_rsi') {
                if (activeIndicators.has('RSI') && indicatorVisibility['RSI'] !== false) {
                    const y70 = helpers.priceToY(70);
                    const y30 = helpers.priceToY(30);
                    if (y70 !== null && y30 !== null && isFinite(y70) && isFinite(y30)) {
                        const top = Math.min(y70, y30);
                        const bottom = Math.max(y70, y30);
                        const bandHeight = bottom - top;
                        if (bandHeight > 0) {
                            ctx.save();
                            ctx.fillStyle = hexToRgba('#7e57c2', 0.10);
                            ctx.fillRect(0, top, helpers.plotWidth, bandHeight);
                            ctx.restore();
                        }
                    }
                }
                return;
            }

            if (helpers && helpers.paneId && helpers.paneId !== 'candle_pane') return;
            const bars = window.ChartState.currentBars || [];
            if (bars.length === 0) return;

            // 1. Subtle Bollinger Bands Channel Fill if BOLL is active & visible
            if (activeIndicators.has('BOLL') && indicatorVisibility['BOLL'] !== false) {
                const bollRes = indicatorResults['BOLL'] || [];
                if (bollRes.length === bars.length) {
                    const bollColors = INDICATOR_CONFIG.BOLL.activeColors || ['#2962FF'];
                    ctx.save();
                    ctx.fillStyle = hexToRgba(bollColors[0] || '#2962FF', 0.06);
                    ctx.beginPath();
                    let started = false;
                    const lowerPts = [];
                    for (let i = 0; i < bars.length; i++) {
                        const r = bollRes[i];
                        if (!r || typeof r.up !== 'number' || typeof r.dn !== 'number') continue;
                        const x = helpers.timeToX(bars[i].timestamp);
                        if (x === null || x < -40 || x > helpers.plotWidth + 40) continue;
                        const yUp = helpers.priceToY(r.up);
                        const yDn = helpers.priceToY(r.dn);
                        if (yUp === null || yDn === null) continue;
                        if (!started) {
                            ctx.moveTo(x, yUp);
                            started = true;
                        } else {
                            ctx.lineTo(x, yUp);
                        }
                        lowerPts.push({ x: x, y: yDn });
                    }
                    if (started && lowerPts.length > 1) {
                        for (let j = lowerPts.length - 1; j >= 0; j--) {
                            ctx.lineTo(lowerPts[j].x, lowerPts[j].y);
                        }
                        ctx.closePath();
                        ctx.fill();
                    }
                    ctx.restore();
                }
            }

            // 1b. Supertrend Shaded Trend Ribbon & Reversal Markers (matches TradingView Supertrend)
            if (activeIndicators.has('SUPERTREND') && indicatorVisibility['SUPERTREND'] !== false) {
                const stRes = indicatorResults['SUPERTREND'] || [];
                if (stRes.length === bars.length) {
                    const stColors = INDICATOR_CONFIG.SUPERTREND.activeColors || ['#089981', '#f23645'];
                    const upHex = stColors[0] || '#089981';
                    const dnHex = stColors[1] || '#f23645';

                    let segTrend = 0;
                    let segTopPts = [];
                    let segBotPts = [];

                    function flushStSegment() {
                        if (segTopPts.length >= 2 && segBotPts.length >= 2) {
                            ctx.save();
                            ctx.fillStyle = hexToRgba(segTrend === 1 ? upHex : dnHex, 0.11);
                            ctx.beginPath();
                            ctx.moveTo(segTopPts[0].x, segTopPts[0].y);
                            for (let k = 1; k < segTopPts.length; k++) {
                                ctx.lineTo(segTopPts[k].x, segTopPts[k].y);
                            }
                            for (let k = segBotPts.length - 1; k >= 0; k--) {
                                ctx.lineTo(segBotPts[k].x, segBotPts[k].y);
                            }
                            ctx.closePath();
                            ctx.fill();
                            ctx.restore();
                        }
                        segTopPts = [];
                        segBotPts = [];
                        segTrend = 0;
                    }

                    for (let i = 0; i < bars.length; i++) {
                        const r = stRes[i];
                        if (!r || (r.trend !== 1 && r.trend !== -1)) {
                            flushStSegment();
                            continue;
                        }
                        const stVal = r.trend === 1 ? r.up : r.dn;
                        if (typeof stVal !== 'number' || !isFinite(stVal)) {
                            flushStSegment();
                            continue;
                        }
                        const x = helpers.timeToX(bars[i].timestamp);
                        if (x === null) continue;
                        const ySt = helpers.priceToY(stVal);
                        const midPrice = (bars[i].open + bars[i].close) / 2;
                        const yMid = helpers.priceToY(midPrice);
                        if (ySt === null || yMid === null) continue;

                        if (r.trend !== segTrend) {
                            flushStSegment();
                            segTrend = r.trend;
                        }

                        segTopPts.push({ x: x, y: yMid });
                        segBotPts.push({ x: x, y: ySt });
                    }
                    flushStSegment();
                }
            }

            // 2. Smart Money Concepts (SMC) Order Blocks, BOS/CHoCH & Strong/Weak Highs/Lows
            if (activeIndicators.has('SMC') && indicatorVisibility['SMC'] !== false && smcComputedData) {
                const intervalMs = Math.max(1000, window.ChartState.avgBarIntervalMs || 60000);
                const lastTs = bars[bars.length - 1].timestamp;
                const endTs = lastTs + SMC_EXTEND_BARS * intervalMs;
                const xEnd = helpers.timeToX(endTs);

                function renderOBList(list, isSwing) {
                    (list || []).forEach(function (ob) {
                        if (!ob || !ob.time) return;
                        const visIdx = isSwing ? (ob.bias === 1 ? 2 : 3) : (ob.bias === 1 ? 0 : 1);
                        if (SMC_SETTINGS.lineVisible && SMC_SETTINGS.lineVisible[visIdx] === false) return;

                        const startMs = ob.time * 1000;
                        const x1 = helpers.timeToX(startMs);
                        const x2 = xEnd !== null ? xEnd : helpers.plotWidth;
                        const y1 = helpers.priceToY(ob.high);
                        const y2 = helpers.priceToY(ob.low);
                        if (x1 === null || y1 === null || y2 === null) return;

                        const baseHex = isSwing
                            ? (ob.bias === 1 ? SMC_SETTINGS.swingBullColor : SMC_SETTINGS.swingBearColor)
                            : (ob.bias === 1 ? SMC_SETTINGS.internalBullColor : SMC_SETTINGS.internalBearColor);

                        const rawOpacity = isSwing
                            ? (ob.bias === 1 ? SMC_SETTINGS.swingBullOpacity : SMC_SETTINGS.swingBearOpacity)
                            : (ob.bias === 1 ? SMC_SETTINGS.internalBullOpacity : SMC_SETTINGS.internalBearOpacity);
                        const fillAlpha = Math.max(0.02, Math.min(1, (typeof rawOpacity === 'number' ? rawOpacity : 18) / 100));
                        const strokeAlpha = Math.max(0.15, Math.min(1, fillAlpha + 0.65));

                        const itemWidth = (Array.isArray(SMC_SETTINGS.lineWidths) && typeof SMC_SETTINGS.lineWidths[visIdx] === 'number')
                            ? SMC_SETTINGS.lineWidths[visIdx]
                            : 1;
                        const itemStyle = (Array.isArray(SMC_SETTINGS.lineStyles) && SMC_SETTINGS.lineStyles[visIdx])
                            ? SMC_SETTINGS.lineStyles[visIdx]
                            : 'solid';

                        const left = Math.min(x1, x2);
                        const top  = Math.min(y1, y2);
                        const w    = Math.max(2, Math.abs(x2 - x1));
                        const h    = Math.max(2, Math.abs(y2 - y1));

                        ctx.save();
                        ctx.fillStyle = hexToRgba(baseHex, fillAlpha);
                        ctx.strokeStyle = hexToRgba(baseHex, strokeAlpha);
                        ctx.lineWidth = itemWidth;
                        if (itemStyle === 'dashed') {
                            ctx.setLineDash([6, 4]);
                        } else if (itemStyle === 'dotted') {
                            ctx.setLineDash([2, 3]);
                        } else {
                            ctx.setLineDash([]);
                        }
                        ctx.fillRect(left, top, w, h);
                        ctx.strokeRect(left, top, w, h);
                        ctx.restore();
                    });
                }

                renderOBList(smcComputedData.swing, true);
                renderOBList(smcComputedData.internal, false);

                function renderStructureLines(list, isInternal) {
                    (list || []).forEach(function (s) {
                        if (!s.startTime || !s.endTime) return;
                        const x1 = helpers.timeToX(s.startTime);
                        const x2 = helpers.timeToX(s.endTime);
                        const y  = helpers.priceToY(s.level);
                        if (x1 === null || x2 === null || y === null) return;

                        const color = s.bias === 1 ? '#089981' : '#f23645';
                        ctx.save();
                        ctx.strokeStyle = color;
                        ctx.lineWidth = isInternal ? 1 : 1.25;
                        ctx.setLineDash(isInternal ? [4, 4] : []);
                        ctx.beginPath();
                        ctx.moveTo(x1, y);
                        ctx.lineTo(x2, y);
                        ctx.stroke();

                        if (s.tag) {
                            ctx.font = "600 9.5px Arial, sans-serif";
                            ctx.fillStyle = color;
                            ctx.textAlign = 'center';
                            ctx.textBaseline = 'bottom';
                            ctx.fillText(s.tag, (x1 + x2) / 2, y - 4);
                        }
                        ctx.restore();
                    });
                }

                if (smcComputedData.structure) {
                    renderStructureLines(smcComputedData.structure.swing, false);
                    renderStructureLines(smcComputedData.structure.internal, true);
                }

                if (smcComputedData.trailing) {
                    const tr = smcComputedData.trailing;
                    const isBull = tr.swingTrend === 1;
                    const xRight = xEnd !== null ? xEnd : helpers.plotWidth - 10;

                    if (isFinite(tr.top) && tr.lastTopTime) {
                        const x1 = helpers.timeToX(tr.lastTopTime);
                        const y  = helpers.priceToY(tr.top);
                        if (x1 !== null && y !== null) {
                            ctx.save();
                            ctx.strokeStyle = '#f23645';
                            ctx.lineWidth = 1.25;
                            ctx.beginPath();
                            ctx.moveTo(x1, y);
                            ctx.lineTo(xRight, y);
                            ctx.stroke();
                            ctx.font = "600 10px Arial, sans-serif";
                            ctx.fillStyle = '#f23645';
                            ctx.textAlign = 'right';
                            ctx.textBaseline = 'bottom';
                            ctx.fillText(isBull ? 'Weak High' : 'Strong High', xRight, y - 4);
                            ctx.restore();
                        }
                    }

                    if (isFinite(tr.bottom) && tr.lastBottomTime) {
                        const x1 = helpers.timeToX(tr.lastBottomTime);
                        const y  = helpers.priceToY(tr.bottom);
                        if (x1 !== null && y !== null) {
                            ctx.save();
                            ctx.strokeStyle = '#089981';
                            ctx.lineWidth = 1.25;
                            ctx.beginPath();
                            ctx.moveTo(x1, y);
                            ctx.lineTo(xRight, y);
                            ctx.stroke();
                            ctx.font = "600 10px Arial, sans-serif";
                            ctx.fillStyle = '#089981';
                            ctx.textAlign = 'right';
                            ctx.textBaseline = 'top';
                            ctx.fillText(isBull ? 'Strong Low' : 'Weak Low', xRight, y + 4);
                            ctx.restore();
                        }
                    }
                }
            }
        }

        window.ChartState.overlayDrawHandlers.push(drawIndicatorsOnMainCanvas);

        /* --------------------------------------------------------
         * Indicator Series Creation & Data Calculation
         * -------------------------------------------------------- */
        function computeSmcNow() {
            const bars = window.ChartState.currentBars || [];
            if (bars.length < 2 || !window.SMCEngine || typeof window.SMCEngine.compute !== 'function') {
                smcComputedData = null;
                return;
            }
            smcComputedData = window.SMCEngine.compute(bars, {
                swings_length:    SMC_SETTINGS.swings_length,
                internal_length:  SMC_SETTINGS.internal_length,
                swing_ob_size:    SMC_SETTINGS.swing_ob_size,
                internal_ob_size: SMC_SETTINGS.internal_ob_size,
                showInternalStructure: true,
                showSwingStructure:    true,
                showStrongWeak:        true
            });
            window.ChartState.requestOverlayRedraw();
        }

        function disposeIndicatorSeries(name) {
            const entry = indicatorSeriesMap[name];
            if (!entry) return;
            delete indicatorSeriesMap[name];

            if (entry.isOverlay) {
                const mainChart = window.ChartState.mainChart;
                (entry.seriesList || []).forEach(function (s) {
                    window.ChartState.removeSeriesSafe(mainChart, s.series);
                });
            } else if (entry.paneId) {
                window.ChartState.unregisterSubPane(entry.paneId);
            }
        }

        function lineStyleToLwCode(styleStr) {
            if (styleStr === 'dashed') return 2;
            if (styleStr === 'dotted') return 3;
            return 0;
        }

        function rebuildIndicatorSeries(name) {
            const cfg = INDICATOR_CONFIG[name];
            if (!cfg) return;
            ensureIndicatorStyleArrays(name);

            const bars = window.ChartState.currentBars || [];
            if (name === 'SMC') {
                computeSmcNow();
                return;
            }

            const def = CALC_REGISTRY[name];
            if (!def || typeof def.calc !== 'function') return;

            // Compute indicator values over currentBars
            let computed = [];
            try {
                computed = def.calc(bars, {
                    name: name,
                    calcParams: (cfg.params || []).slice()
                }) || [];
            } catch (err) {
                console.error('[indicators.js] Calculation failed for ' + name + ':', err);
                computed = [];
            }
            indicatorResults[name] = computed;

            const isOverlay = cfg.pane === 'candle_pane';
            const isVisible = indicatorVisibility[name] !== false;
            const activeColors = cfg.activeColors || DEFAULT_PALETTE;
            const defaultLineWidth = typeof cfg.lineSize === 'number' ? cfg.lineSize : 2;

            let targetChart = window.ChartState.mainChart;
            let entry = indicatorSeriesMap[name];

            if (isOverlay) {
                if (!entry) {
                    entry = { isOverlay: true, paneId: 'candle_pane', seriesList: [] };
                    indicatorSeriesMap[name] = entry;
                } else {
                    (entry.seriesList || []).forEach(function (s) {
                        window.ChartState.removeSeriesSafe(targetChart, s.series);
                    });
                    entry.seriesList = [];
                }
            } else {
                const paneId = cfg.pane;
                indicatorPaneMap[name] = paneId;
                const valueGetter = function (idx) {
                    const list = indicatorResults[name] || [];
                    if (!cfg.keys || !cfg.keys.length || list.length === 0) return 0;
                    const primaryKey = cfg.keys[0];
                    const r = list[idx];
                    if (r && typeof r[primaryKey] === 'number' && isFinite(r[primaryKey])) {
                        return r[primaryKey];
                    }
                    // If idx is in warmup (whitespace), find nearest valid value so crosshair position stays in scale
                    for (let step = 1; step < list.length; step++) {
                        if (idx + step < list.length && list[idx + step] && typeof list[idx + step][primaryKey] === 'number' && isFinite(list[idx + step][primaryKey])) {
                            return list[idx + step][primaryKey];
                        }
                        if (idx - step >= 0 && list[idx - step] && typeof list[idx - step][primaryKey] === 'number' && isFinite(list[idx - step][primaryKey])) {
                            return list[idx - step][primaryKey];
                        }
                    }
                    return 0;
                };
                let sub = window.ChartState.subPanes.get(paneId);
                if (!sub) {
                    sub = window.ChartState.registerSubPane(paneId, {
                        height: cfg.height || 135,
                        getValueAtIndex: valueGetter
                    });
                } else {
                    sub.getValueAtIndex = valueGetter;
                    if (entry && entry.seriesList) {
                        entry.seriesList.forEach(function (s) {
                            window.ChartState.removeSeriesSafe(sub.chart, s.series);
                        });
                    }
                }
                targetChart = sub.chart;
                entry = { isOverlay: false, paneId: paneId, seriesList: [], subPane: sub };
                indicatorSeriesMap[name] = entry;
            }

            if (!targetChart) return;

            (cfg.keys || []).forEach(function (key, i) {
                const seriesType = (cfg.types && cfg.types[i]) === 'bar' ? 'Histogram' : 'Line';
                const rawHex = activeColors[i % activeColors.length] || '#2962FF';
                const lineOpacity = (cfg.lineOpacities && typeof cfg.lineOpacities[i] === 'number') ? cfg.lineOpacities[i] : 100;
                const alpha = Math.max(0.05, Math.min(1, lineOpacity / 100));
                const strokeColor = hexToRgba(rawHex, alpha);
                const lineWidth = (cfg.lineWidths && typeof cfg.lineWidths[i] === 'number') ? cfg.lineWidths[i] : defaultLineWidth;
                const lineStyleStr = (cfg.lineStyles && cfg.lineStyles[i]) || 'solid';
                const lineVis = (cfg.lineVisible && typeof cfg.lineVisible[i] === 'boolean') ? cfg.lineVisible[i] : true;
                const effectiveVisible = isVisible && lineVis;

                let series;
                if (seriesType === 'Histogram') {
                    series = window.ChartState.createSeries(targetChart, 'Histogram', {
                        color: strokeColor,
                        base: 0,
                        visible: effectiveVisible,
                        priceLineVisible: false,
                        lastValueVisible: false,
                        priceFormat: name === 'VOL' ? { type: 'volume' } : { type: 'price', precision: 2, minMove: 0.01 }
                    });
                } else {
                    const lineOpts = {
                        color: strokeColor,
                        lineWidth: lineWidth,
                        lineStyle: lineStyleToLwCode(lineStyleStr),
                        visible: effectiveVisible,
                        priceLineVisible: false,
                        lastValueVisible: false,
                        crosshairMarkerVisible: false,
                        pointMarkersVisible: false
                    };
                    if (name === 'RSI' && i === 0) {
                        lineOpts.autoscaleInfoProvider = function (original) {
                            const res = typeof original === 'function' ? original() : null;
                            if (res && res.priceRange) {
                                return {
                                    priceRange: {
                                        minValue: Math.min(res.priceRange.minValue, 26),
                                        maxValue: Math.max(res.priceRange.maxValue, 74)
                                    }
                                };
                            }
                            return { priceRange: { minValue: 26, maxValue: 74 } };
                        };
                    }
                    series = window.ChartState.createSeries(targetChart, 'Line', lineOpts);
                }

                if (!series) return;

                const seriesData = [];
                for (let bIdx = 0; bIdx < bars.length; bIdx++) {
                    const row = computed[bIdx];
                    const val = row ? row[key] : undefined;
                    if (typeof val === 'number' && isFinite(val)) {
                        const pt = { time: bars[bIdx].time, value: val };
                        if (seriesType === 'Histogram') {
                            if (name === 'OSAVERAGE') {
                                pt.color = hexToRgba(val >= 0 ? rawHex : '#f23645', alpha);
                            } else if (row && row._barColor) {
                                pt.color = row._barColor;
                            }
                        } else if (name === 'SUPERTREND') {
                            // Discontinuous segment handling for Supertrend Up/Down bands
                            const hasNextBar = (bIdx + 1) < bars.length;
                            const nextRow = hasNextBar ? computed[bIdx + 1] : null;
                            const nextVal = nextRow ? nextRow[key] : undefined;
                            const nextIsValid = typeof nextVal === 'number' && isFinite(nextVal);
                            pt.color = (!hasNextBar || nextIsValid) ? strokeColor : 'rgba(0, 0, 0, 0)';
                        }
                        seriesData.push(pt);
                    } else {
                        seriesData.push({ time: bars[bIdx].time });
                    }
                }

                // Append 1-month forward-fed future whitespace timestamps so sub-panes stay 1:1 aligned
                const future = (window.ChartState && window.ChartState.futureWhitespace) || [];
                for (let fIdx = 0; fIdx < future.length; fIdx++) {
                    seriesData.push(future[fIdx]);
                }

                try {
                    series.setData(seriesData);
                } catch (e) {
                    console.error('[indicators.js] setData failed on ' + name + '.' + key + ':', e);
                }

                // Attach horizontal reference lines (e.g., RSI 70/30, CCI +/-100, WR -20/-80) on first series
                if (i === 0 && Array.isArray(cfg.priceLines) && typeof series.createPriceLine === 'function') {
                    cfg.priceLines.forEach(function (pl) {
                        try {
                            series.createPriceLine({
                                price: pl.price,
                                color: pl.color || '#787B86',
                                lineWidth: 1,
                                lineStyle: pl.dashed ? 2 : 0,
                                axisLabelVisible: false,
                                title: ''
                            });
                        } catch (e) {}
                    });
                }

                entry.seriesList.push({ key: key, series: series, color: rawHex, index: i });
            });

            if (!isOverlay && entry.subPane && entry.seriesList.length > 0) {
                entry.subPane.primarySeries = entry.seriesList[0].series;
                // Sync sub-pane timeScale to mainChart
                try {
                    const mainRange = window.ChartState.mainChart &&
                        window.ChartState.mainChart.timeScale().getVisibleLogicalRange();
                    if (mainRange) {
                        targetChart.timeScale().setVisibleLogicalRange(mainRange);
                    }
                } catch (e) {}
            }

            if (typeof window.ChartState.alignPriceScales === 'function') {
                window.ChartState.alignPriceScales();
            }
            window.ChartState.requestOverlayRedraw();
        }

        function refreshAllActiveIndicators() {
            activeIndicators.forEach(function (name) {
                rebuildIndicatorSeries(name);
            });
            renderAllLegends();
        }

        window.ChartState.barsLoadedHandlers.push(refreshAllActiveIndicators);

        /* --------------------------------------------------------
         * Dynamic Per-Pane Legend Rows
         * -------------------------------------------------------- */
        function getTitleText(name) {
            const cfg = INDICATOR_CONFIG[name];
            if (!cfg) return name;
            if (cfg.params && cfg.params.length > 0) {
                return name + '(' + cfg.params.join(',') + ')';
            }
            return name;
        }

        function renderAllLegends() {
            try {
                const rootEl = document.getElementById('chart');
                if (!rootEl) return;

                // Remove stale legends for deleted indicators
                rootEl.querySelectorAll('.chart-integrated-legend').forEach(function (el) {
                    const name = el.dataset.indicatorName;
                    if (!activeIndicators.has(name)) {
                        el.remove();
                    }
                });

                if (activeIndicators.size === 0) return;

                let mainOverlayTop = 44;
                activeIndicators.forEach(function (name) {
                    const cfg = INDICATOR_CONFIG[name];
                    if (!cfg) return;

                    if (cfg.pane === 'candle_pane') {
                        ensureLegendElement(name, window.ChartState.mainPaneEl, 12, mainOverlayTop, 'candle_pane');
                        mainOverlayTop += 24;
                    } else {
                        const paneId = indicatorPaneMap[name] || cfg.pane;
                        const sub = window.ChartState.subPanes.get(paneId);
                        if (sub && sub.containerEl) {
                            ensureLegendElement(name, sub.containerEl, 12, 8, paneId);
                        }
                    }
                });

                updateLegendValues();
            } catch (err) {
                console.error('[indicators.js] renderAllLegends error:', err);
            }
        }

        window._syncIndicatorButtons = renderAllLegends;

        function ensureLegendElement(name, parentEl, left, top, paneId) {
            if (!parentEl) return null;
            let row = parentEl.querySelector('.leg-' + name);
            if (!row) {
                row = createLegendRow(name, left, top, paneId);
                parentEl.appendChild(row);
            } else {
                row.style.left = left + 'px';
                row.style.top  = top + 'px';
                const titleSpan = row.querySelector('.legend-title');
                if (titleSpan) titleSpan.textContent = getTitleText(name);
            }
            return row;
        }

        function createLegendRow(name, left, top, paneId) {
            const row = document.createElement('div');
            row.className = 'chart-integrated-legend leg-' + name;
            row.dataset.indicatorName = name;
            row.dataset.paneId = paneId;
            row.style.left = left + 'px';
            row.style.top  = top + 'px';

            const titleSpan = document.createElement('span');
            titleSpan.className = 'legend-title';
            titleSpan.textContent = getTitleText(name);
            row.appendChild(titleSpan);

            const btnGroup = document.createElement('div');
            btnGroup.className = 'legend-btn-group';

            const isVisible = indicatorVisibility[name] !== false;

            const eyeBtn = document.createElement('button');
            eyeBtn.type = 'button';
            eyeBtn.className = 'legend-btn legend-btn-eye' + (isVisible ? '' : ' off');
            eyeBtn.title = isVisible ? 'Hide indicator' : 'Show indicator';
            eyeBtn.innerHTML = isVisible ? '&#128065;' : '&#8856;';
            eyeBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                const next = !(indicatorVisibility[name] !== false);
                indicatorVisibility[name] = next;
                eyeBtn.innerHTML = next ? '&#128065;' : '&#8856;';
                eyeBtn.classList.toggle('off', !next);
                eyeBtn.title = next ? 'Hide indicator' : 'Show indicator';

                if (name === 'SMC') {
                    window.ChartState.wantSmc = next;
                    window.ChartState.requestOverlayRedraw();
                } else {
                    const cfg = INDICATOR_CONFIG[name];
                    const entry = indicatorSeriesMap[name];
                    if (entry && entry.seriesList) {
                        entry.seriesList.forEach(function (s, idx) {
                            const lineVis = (cfg && cfg.lineVisible && typeof cfg.lineVisible[idx] === 'boolean') ? cfg.lineVisible[idx] : true;
                            try { s.series.applyOptions({ visible: next && lineVis }); } catch (err) {}
                        });
                    }
                    window.ChartState.requestOverlayRedraw();
                }
            });
            btnGroup.appendChild(eyeBtn);

            const cfgBtn = document.createElement('button');
            cfgBtn.type = 'button';
            cfgBtn.className = 'legend-btn legend-btn-cfg';
            cfgBtn.title = 'Indicator settings';
            cfgBtn.innerHTML = '&#9881;';
            cfgBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                openSettingsModal(name, e);
            });
            btnGroup.appendChild(cfgBtn);

            const delBtn = document.createElement('button');
            delBtn.type = 'button';
            delBtn.className = 'legend-btn legend-btn-del';
            delBtn.title = 'Remove indicator';
            delBtn.innerHTML = '&#10005;';
            delBtn.addEventListener('click', function (e) {
                e.stopPropagation();
                removeIndicator(name);
            });
            btnGroup.appendChild(delBtn);

            row.appendChild(btnGroup);

            const valsSpan = document.createElement('span');
            valsSpan.className = 'ind-live-figures';
            row.appendChild(valsSpan);

            return row;
        }

        function updateLegendValues() {
            const bars = window.ChartState.currentBars || [];
            if (bars.length === 0) return;

            const dataIndex = (typeof latestCrosshairIndex === 'number' &&
                               latestCrosshairIndex >= 0 &&
                               latestCrosshairIndex < bars.length)
                ? latestCrosshairIndex
                : bars.length - 1;

            const rootEl = document.getElementById('chart');
            if (!rootEl) return;

            activeIndicators.forEach(function (name) {
                const row = rootEl.querySelector('.leg-' + name);
                if (!row) return;
                const figuresSpan = row.querySelector('.ind-live-figures');
                if (!figuresSpan) return;

                const cfg = INDICATOR_CONFIG[name];
                if (!cfg || !cfg.lines || cfg.lines.length === 0) {
                    figuresSpan.innerHTML = '';
                    return;
                }

                const resList = indicatorResults[name] || [];
                const vals = resList[dataIndex] || {};
                const activeColors = cfg.activeColors || DEFAULT_PALETTE;
                let html = '';

                cfg.lines.forEach(function (lineName, i) {
                    if (cfg.lineVisible && cfg.lineVisible[i] === false) return;
                    const key = cfg.keys && cfg.keys[i];
                    let v = key ? vals[key] : undefined;
                    if (name === 'VOL' && key === 'volume' && v === undefined && bars[dataIndex]) {
                        v = bars[dataIndex].volume;
                    }
                    const color = activeColors[i % activeColors.length];
                    if (typeof v === 'number' && !isNaN(v)) {
                        let formatted;
                        if (name === 'VOL' && key === 'volume') {
                            formatted = v >= 1e6 ? (v / 1e6).toFixed(2) + 'M' : (v >= 1e3 ? (v / 1e3).toFixed(1) + 'K' : String(Math.round(v)));
                        } else {
                            formatted = Number.isInteger(v) ? String(v) : v.toFixed(Math.abs(v) > 100 ? 2 : 3);
                        }
                        html += '<span style="color: ' + color + '; font-weight: 600;">' + lineName + ': ' + formatted + '</span>';
                    }
                });

                figuresSpan.innerHTML = html;
            });
        }

        window.ChartState.crosshairListeners.push(function (evt) {
            if (evt && typeof evt.dataIndex === 'number') {
                latestCrosshairIndex = evt.dataIndex;
            } else {
                latestCrosshairIndex = null;
            }
            updateLegendValues();
        });

        /* --------------------------------------------------------
         * Add / Remove Indicator
         * -------------------------------------------------------- */
        function addIndicator(name) {
            if (activeIndicators.has(name)) return;
            const cfg = INDICATOR_CONFIG[name];
            if (!cfg) return;

            activeIndicators.add(name);
            indicatorVisibility[name] = true;
            if (name === 'SMC') {
                window.ChartState.wantSmc = true;
            }

            rebuildIndicatorSeries(name);
            renderAllLegends();
            window.dispatchEvent(new CustomEvent('indicatorsChanged'));
        }

        function removeIndicator(name) {
            if (!activeIndicators.has(name)) return;
            if (activeIndModalEl && currentEditingIndicator === name) {
                closeIndicatorSettingsPopup();
            }
            activeIndicators.delete(name);
            delete indicatorVisibility[name];
            delete indicatorResults[name];
            delete indicatorPaneMap[name];

            if (name === 'SMC') {
                window.ChartState.wantSmc = false;
                smcComputedData = null;
                window.ChartState.requestOverlayRedraw();
            } else {
                disposeIndicatorSeries(name);
            }

            const rootEl = document.getElementById('chart');
            if (rootEl) {
                const row = rootEl.querySelector('.leg-' + name);
                if (row) row.remove();
            }

            renderAllLegends();
            window.dispatchEvent(new CustomEvent('indicatorsChanged'));
        }

        /* --------------------------------------------------------
         * TradingView-Style Indicator Settings Popup (Inputs + Style)
         * -------------------------------------------------------- */
        const IND_PALETTE_ROWS = [
            ['#ffffff', '#d1d4dc', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#131722', '#000000'],
            ['#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63'],
            ['#fdd8df', '#ffe0b2', '#fff9c4', '#c8e6c9', '#b2dfdb', '#b2ebf2', '#bbdefb', '#d1c4e9', '#e1bee7', '#f8bbd0'],
            ['#f7a6b0', '#ffcc80', '#fff59d', '#a5d6a7', '#80cbc4', '#80deea', '#90caf9', '#b39ddb', '#ce93d8', '#f48fb1'],
            ['#ef7a85', '#ffb74d', '#fff176', '#81c784', '#4db6ac', '#4dd0e1', '#64b5f6', '#9575cd', '#ba68c8', '#f06292'],
            ['#ec5360', '#ffa726', '#ffee58', '#66bb6a', '#26a69a', '#26c6da', '#42a5f5', '#7e57c2', '#ab47bc', '#ec407a'],
            ['#c62828', '#ef6c00', '#f9a825', '#2e7d32', '#00695c', '#00838f', '#1565c0', '#4527a0', '#6a1b9a', '#ad1457'],
            ['#801922', '#c2410c', '#e65100', '#1b5e20', '#004d40', '#006064', '#0d47a1', '#311b92', '#4a148c', '#880e4f']
        ];

        let activeIndModalEl = null;

        function closeIndicatorSettingsPopup() {
            if (activeIndModalEl) {
                if (typeof activeIndModalEl.__cleanup === 'function') {
                    activeIndModalEl.__cleanup();
                }
                activeIndModalEl.remove();
                activeIndModalEl = null;
            }
            currentEditingIndicator = null;
        }

        function ensureIndModalCSS() {
            let st = document.getElementById('tv-ind-style-popup-css');
            if (!st) {
                st = document.createElement('style');
                st.id = 'tv-ind-style-popup-css';
                document.head.appendChild(st);
            }
            st.textContent = [
                '.tv-draw-modal {',
                '    position: fixed; z-index: 9500; width: 256px;',
                '    background: #ffffff; border: 1px solid #e0e3eb; border-radius: 6px;',
                '    box-shadow: 0 8px 28px rgba(19, 23, 34, 0.20);',
                '    font-family: Arial, sans-serif; color: #131722; user-select: none;',
                '    display: flex; flex-direction: column;',
                '}',
                '.tv-ind-popup {',
                '    position: fixed; z-index: 9500; width: 256px;',
                '    background: #ffffff; border: 1px solid #e0e3eb; border-radius: 6px;',
                '    box-shadow: 0 8px 28px rgba(19, 23, 34, 0.20);',
                '    font-family: Arial, sans-serif; color: #131722; user-select: none;',
                '    display: flex; flex-direction: column;',
                '}',
                '.tv-draw-modal-header {',
                '    display: flex; align-items: center; justify-content: space-between;',
                '    padding: 9px 12px 0 12px; cursor: move;',
                '}',
                '.tv-draw-modal-title {',
                '    font-size: 13px; font-weight: 700; color: #131722;',
                '}',
                '.tv-draw-modal-close {',
                '    width: 22px; height: 22px; border: none; background: transparent;',
                '    color: #787b86; cursor: pointer; border-radius: 4px;',
                '    display: inline-flex; align-items: center; justify-content: center; padding: 0;',
                '}',
                '.tv-draw-modal-close:hover { background: #f0f3fa; color: #131722; }',
                '.tv-draw-modal-tabs {',
                '    display: flex; align-items: center; gap: 16px;',
                '    padding: 4px 12px 0 12px; border-bottom: 1px solid #e0e3eb;',
                '}',
                '.tv-draw-tab {',
                '    border: none; background: transparent; padding: 4px 2px 7px 2px;',
                '    font-family: Arial, sans-serif; font-size: 12px; font-weight: 700;',
                '    color: #787b86; cursor: pointer; position: relative;',
                '}',
                '.tv-draw-tab.active { color: #131722; }',
                '.tv-draw-tab.active::after {',
                '    content: ""; position: absolute; left: 0; right: 0; bottom: -1px;',
                '    height: 2px; background: #131722; border-radius: 1px;',
                '}',
                '.tv-draw-modal-body {',
                '    padding: 10px 12px; position: relative;',
                '}',
                '.tv-draw-top-controls {',
                '    display: flex; align-items: center; justify-content: space-between; margin-bottom: 8px;',
                '}',
                '.tv-ind-line-row {',
                '    display: flex; align-items: center; justify-content: space-between;',
                '    padding: 2px 0; margin-bottom: 4px;',
                '}',
                '.tv-draw-top-label, .tv-ind-line-row .tv-draw-top-label {',
                '    display: flex; align-items: center; gap: 6px; font-size: 12px; font-weight: 600; color: #131722; cursor: pointer;',
                '}',
                '.tv-draw-top-chk {',
                '    width: 14px; height: 14px; accent-color: #131722; cursor: pointer; margin: 0;',
                '}',
                '.tv-draw-pill-group { display: flex; align-items: center; gap: 5px; }',
                '.tv-draw-color-pill {',
                '    display: inline-flex; align-items: center; gap: 6px;',
                '    height: 26px; padding: 0 7px; border: 1px solid #d1d4dc;',
                '    border-radius: 5px; background: #ffffff; cursor: pointer;',
                '}',
                '.tv-draw-color-pill.active {',
                '    border: 1.5px solid #2962ff;',
                '}',
                '.tv-draw-color-pill-swatch {',
                '    width: 14px; height: 14px; border-radius: 3px; border: 1px solid rgba(0,0,0,0.15); flex-shrink: 0;',
                '}',
                '.tv-draw-color-pill-line {',
                '    width: 18px; height: 2px; background: #131722; border-radius: 1px;',
                '}',
                '.tv-draw-palette-card {',
                '    border: 1px solid #e0e3eb; border-radius: 6px; padding: 9px;',
                '    background: #ffffff; box-shadow: 0 3px 10px rgba(19, 23, 34, 0.06);',
                '}',
                '.tv-draw-swatch-grid {',
                '    display: grid; grid-template-columns: repeat(10, 1fr); gap: 3.5px; margin-bottom: 3.5px;',
                '}',
                '.tv-draw-swatch-row-gap { margin-bottom: 6px; }',
                '.tv-draw-swatch {',
                '    width: 17px; height: 17px; border-radius: 3px; cursor: pointer;',
                '    box-sizing: border-box; border: 1px solid rgba(0,0,0,0.12);',
                '    padding: 0; position: relative; transition: transform 0.08s ease;',
                '}',
                '.tv-draw-swatch:hover { transform: scale(1.1); }',
                '.tv-draw-swatch.selected {',
                '    box-shadow: 0 0 0 1px #ffffff, 0 0 0 2.5px #131722;',
                '    z-index: 2;',
                '}',
                '.tv-draw-custom-row {',
                '    display: flex; align-items: center; gap: 6px;',
                '    padding-top: 6px; margin-top: 4px; border-top: 1px solid #e0e3eb; margin-bottom: 8px;',
                '}',
                '.tv-draw-custom-swatch {',
                '    width: 17px; height: 17px; border-radius: 3px; border: 1px solid #d1d4dc;',
                '}',
                '.tv-draw-custom-btn {',
                '    width: 18px; height: 18px; border-radius: 3px; border: 1px solid transparent;',
                '    background: transparent; color: #131722; font-size: 15px; line-height: 1;',
                '    cursor: pointer; display: inline-flex; align-items: center; justify-content: center; padding: 0;',
                '}',
                '.tv-draw-custom-btn:hover { background: #f0f3fa; }',
                '.tv-draw-sec-label {',
                '    font-size: 11px; color: #787b86; margin-bottom: 4px; font-weight: 500;',
                '}',
                '.tv-draw-opacity-row {',
                '    display: flex; align-items: center; gap: 8px; margin-bottom: 8px;',
                '}',
                '.tv-draw-opacity-track-wrap {',
                '    position: relative; flex: 1; height: 8px; border-radius: 4px;',
                '    background-image: linear-gradient(45deg, #d1d4dc 25%, transparent 25%),',
                '                      linear-gradient(-45deg, #d1d4dc 25%, transparent 25%),',
                '                      linear-gradient(45deg, transparent 75%, #d1d4dc 75%),',
                '                      linear-gradient(-45deg, transparent 75%, #d1d4dc 75%);',
                '    background-size: 6px 6px;',
                '    background-position: 0 0, 0 3px, 3px -3px, -3px 0;',
                '    border: 1px solid #d1d4dc; display: flex; align-items: center;',
                '}',
                '.tv-draw-opacity-gradient {',
                '    position: absolute; inset: 0; border-radius: 3px; pointer-events: none;',
                '}',
                '.tv-draw-opacity-range {',
                '    position: relative; z-index: 2; width: 100%; margin: 0;',
                '    -webkit-appearance: none; appearance: none; background: transparent; cursor: pointer;',
                '}',
                '.tv-draw-opacity-range::-webkit-slider-thumb {',
                '    -webkit-appearance: none; appearance: none;',
                '    width: 12px; height: 12px; border-radius: 50%;',
                '    background: #ffffff; border: 2px solid #131722; box-shadow: 0 1px 2px rgba(0,0,0,0.22);',
                '}',
                '.tv-draw-opacity-val {',
                '    min-width: 40px; height: 22px; border: 1px solid #d1d4dc; border-radius: 4px;',
                '    display: inline-flex; align-items: center; justify-content: center;',
                '    font-size: 11px; font-weight: 600; color: #131722; background: #ffffff;',
                '}',
                '.tv-draw-seg-group {',
                '    display: grid; border: 1px solid #d1d4dc; border-radius: 4px;',
                '    overflow: hidden; margin-bottom: 8px;',
                '}',
                '.tv-draw-seg-group.cols-4 { grid-template-columns: repeat(4, 1fr); }',
                '.tv-draw-seg-group.cols-3 { grid-template-columns: repeat(3, 1fr); margin-bottom: 2px; }',
                '.tv-draw-seg-btn {',
                '    height: 24px; border: none; border-right: 1px solid #d1d4dc;',
                '    background: #ffffff; color: #131722; cursor: pointer;',
                '    display: inline-flex; align-items: center; justify-content: center; padding: 0;',
                '}',
                '.tv-draw-seg-btn:last-child { border-right: none; }',
                '.tv-draw-seg-btn:hover { background: #f0f3fa; }',
                '.tv-draw-seg-btn.active { background: #131722; color: #ffffff; }',
                '.tv-draw-inputs-row {',
                '    display: flex; align-items: center; justify-content: space-between;',
                '    gap: 8px; margin-bottom: 8px;',
                '}',
                '.tv-draw-inputs-row label { font-size: 12px; color: #131722; font-weight: 500; }',
                '.tv-draw-inputs-row input {',
                '    width: 96px; height: 26px; padding: 0 8px; border: 1px solid #d1d4dc;',
                '    border-radius: 4px; font-family: Arial, sans-serif; font-size: 12px; color: #131722; text-align: right;',
                '}',
                '.tv-draw-inputs-row input:focus { outline: none; border-color: #2962ff; }',
                '.tv-draw-modal-footer {',
                '    display: flex; align-items: center; justify-content: space-between;',
                '    padding: 8px 12px; border-top: 1px solid #e0e3eb; background: #ffffff;',
                '}',
                '.tv-draw-defaults-wrap { position: relative; display: inline-flex; }',
                '.tv-draw-defaults-btn {',
                '    height: 26px; padding: 0 8px; border: 1px solid #d1d4dc; border-radius: 4px;',
                '    background: #ffffff; color: #131722; font-family: Arial, sans-serif;',
                '    font-size: 11.5px; font-weight: 500; cursor: pointer;',
                '    display: inline-flex; align-items: center; gap: 4px;',
                '}',
                '.tv-draw-defaults-btn:hover { background: #f0f3fa; }',
                '.tv-draw-defaults-menu {',
                '    position: absolute; left: 0; bottom: calc(100% + 4px); min-width: 132px;',
                '    background: #ffffff; border: 1px solid #e0e3eb; border-radius: 5px;',
                '    box-shadow: 0 4px 16px rgba(19, 23, 34, 0.16); padding: 4px 0;',
                '    z-index: 9600; display: none; flex-direction: column;',
                '}',
                '.tv-draw-defaults-menu.open { display: flex; }',
                '.tv-draw-defaults-item {',
                '    width: 100%; border: none; background: transparent; padding: 6px 12px;',
                '    text-align: left; font-family: Arial, sans-serif; font-size: 11.5px;',
                '    font-weight: 500; color: #131722; cursor: pointer; white-space: nowrap;',
                '}',
                '.tv-draw-defaults-item:hover { background: #f0f3fa; }',
                '.tv-draw-footer-actions { display: flex; align-items: center; gap: 6px; }',
                '.tv-draw-btn-cancel {',
                '    height: 26px; padding: 0 11px; border: 1px solid #131722; border-radius: 4px;',
                '    background: #ffffff; color: #131722; font-family: Arial, sans-serif;',
                '    font-size: 11.5px; font-weight: 600; cursor: pointer;',
                '}',
                '.tv-draw-btn-cancel:hover { background: #f0f3fa; }',
                '.tv-draw-btn-ok {',
                '    height: 26px; padding: 0 13px; border: 1px solid #131722; border-radius: 4px;',
                '    background: #131722; color: #ffffff; font-family: Arial, sans-serif;',
                '    font-size: 11.5px; font-weight: 600; cursor: pointer;',
                '}',
                '.tv-draw-btn-ok:hover { background: #2a2e39; }'
            ].join('\n');
        }

        function getParamLabel(name, idx) {
            if (name === 'RSI')        return idx === 0 ? 'RSI Length' : 'EMA Length';
            if (name === 'SUPERTREND') return idx === 0 ? 'ATR Period' : 'ATR Multiplier';
            if (name === 'BOLL')       return idx === 0 ? 'Period' : 'StdDev';
            if (name === 'MACD')       return idx === 0 ? 'Fast Length' : (idx === 1 ? 'Slow Length' : 'Signal Length');
            if (name === 'KDJ')        return idx === 0 ? 'K Period' : (idx === 1 ? 'D Period' : 'J Period');
            if (name === 'SAR')        return idx === 0 ? 'Start' : (idx === 1 ? 'Increment' : 'Max Value');
            if (name === 'OSAVERAGE')  return idx === 0 ? 'Short L1' : (idx === 1 ? 'Short L2' : 'Short L3');
            if (name === 'VPSR')       return idx === 0 ? 'Lookback' : (idx === 1 ? 'Fast Len' : 'Smooth Len');
            return 'Length ' + (idx + 1);
        }

        function openSettingsModal(name, anchorEvent) {
            const cfg = INDICATOR_CONFIG[name];
            if (!cfg) return;
            ensureIndicatorStyleArrays(name);
            ensureIndModalCSS();
            closeIndicatorSettingsPopup();

            currentEditingIndicator = name;

            // Snapshot initial state so Cancel can revert cleanly
            const initialSnapshot = name === 'SMC'
                ? JSON.parse(JSON.stringify(SMC_SETTINGS))
                : {
                    params:        (cfg.params || []).slice(),
                    activeColors:  (cfg.activeColors || []).slice(),
                    lineWidths:    (cfg.lineWidths || []).slice(),
                    lineStyles:    (cfg.lineStyles || []).slice(),
                    lineOpacities: (cfg.lineOpacities || []).slice(),
                    lineVisible:   (cfg.lineVisible || []).slice()
                };

            const modal = document.createElement('div');
            modal.className = 'tv-draw-modal tv-ind-popup';

            // Header
            const header = document.createElement('div');
            header.className = 'tv-draw-modal-header';

            const titleEl = document.createElement('span');
            titleEl.className = 'tv-draw-modal-title';
            titleEl.textContent = name;
            header.appendChild(titleEl);

            const closeBtn = document.createElement('button');
            closeBtn.type = 'button';
            closeBtn.className = 'tv-draw-modal-close';
            closeBtn.title = 'Close';
            closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" stroke="currentColor" stroke-width="1.6"><line x1="2" y1="2" x2="12" y2="12"/><line x1="12" y1="2" x2="2" y2="12"/></svg>';
            header.appendChild(closeBtn);
            modal.appendChild(header);

            // Tabs (Inputs | Style)
            const tabsBar = document.createElement('div');
            tabsBar.className = 'tv-draw-modal-tabs';

            const tabInputs = document.createElement('button');
            tabInputs.type = 'button';
            tabInputs.className = 'tv-draw-tab';
            tabInputs.textContent = 'Inputs';

            const tabStyle = document.createElement('button');
            tabStyle.type = 'button';
            tabStyle.className = 'tv-draw-tab active';
            tabStyle.textContent = 'Style';

            tabsBar.appendChild(tabInputs);
            tabsBar.appendChild(tabStyle);
            modal.appendChild(tabsBar);

            // Body
            const body = document.createElement('div');
            body.className = 'tv-draw-modal-body';
            modal.appendChild(body);

            // 1. Inputs Pane
            const inputsPane = document.createElement('div');
            inputsPane.style.display = 'none';
            const inputEls = [];

            if (name === 'SMC') {
                const smcParams = [
                    { label: 'Swing Length',      key: 'swings_length' },
                    { label: 'Internal Length',   key: 'internal_length' },
                    { label: 'Swing OB Count',    key: 'swing_ob_size' },
                    { label: 'Internal OB Count', key: 'internal_ob_size' }
                ];
                smcParams.forEach(function (p) {
                    const row = document.createElement('div');
                    row.className = 'tv-draw-inputs-row';
                    const lbl = document.createElement('label');
                    lbl.textContent = p.label;
                    const inp = document.createElement('input');
                    inp.type = 'number';
                    inp.step = '1';
                    inp.min = '1';
                    inp.value = String(SMC_SETTINGS[p.key]);
                    inp.addEventListener('input', function () {
                        const v = parseFloat(inp.value);
                        if (!isNaN(v) && v > 0) {
                            SMC_SETTINGS[p.key] = Math.round(v);
                            computeSmcNow();
                            renderAllLegends();
                        }
                    });
                    inputEls.push({ key: p.key, el: inp });
                    row.appendChild(lbl);
                    row.appendChild(inp);
                    inputsPane.appendChild(row);
                });
            } else if (cfg.params && cfg.params.length > 0) {
                cfg.params.forEach(function (param, idx) {
                    const row = document.createElement('div');
                    row.className = 'tv-draw-inputs-row';
                    const lbl = document.createElement('label');
                    lbl.textContent = getParamLabel(name, idx);
                    const inp = document.createElement('input');
                    inp.type = 'number';
                    inp.step = 'any';
                    inp.min = '0.1';
                    inp.value = String(param);
                    inp.addEventListener('input', function () {
                        const v = parseFloat(inp.value);
                        if (!isNaN(v) && v > 0) {
                            cfg.params[idx] = v;
                            rebuildIndicatorSeries(name);
                            renderAllLegends();
                        }
                    });
                    inputEls.push({ index: idx, el: inp });
                    row.appendChild(lbl);
                    row.appendChild(inp);
                    inputsPane.appendChild(row);
                });
            } else {
                const emptyMsg = document.createElement('div');
                emptyMsg.className = 'tv-draw-sec-label';
                emptyMsg.textContent = 'No configurable inputs for this indicator.';
                inputsPane.appendChild(emptyMsg);
            }
            body.appendChild(inputsPane);

            // 2. Style Pane
            const stylePane = document.createElement('div');
            const linesListWrap = document.createElement('div');
            stylePane.appendChild(linesListWrap);

            // Determine line definitions for this indicator
            const lineItems = (name === 'SMC')
                ? [
                    { label: 'Internal Bullish OB', colorKey: 'internalBullColor', opacityKey: 'internalBullOpacity', idx: 0 },
                    { label: 'Internal Bearish OB', colorKey: 'internalBearColor', opacityKey: 'internalBearOpacity', idx: 1 },
                    { label: 'Swing Bullish OB',    colorKey: 'swingBullColor',    opacityKey: 'swingBullOpacity',    idx: 2 },
                    { label: 'Swing Bearish OB',    colorKey: 'swingBearColor',    opacityKey: 'swingBearOpacity',    idx: 3 }
                ]
                : (cfg.lines || []).map(function (ln, idx) {
                    return { label: ln, idx: idx };
                });

            let selectedLineIdx = 0;
            let paletteVisible = true;
            const rowControllers = [];

            function getLineState(idx) {
                if (name === 'SMC') {
                    const item = lineItems[idx] || lineItems[0];
                    const opVal = (item.opacityKey && typeof SMC_SETTINGS[item.opacityKey] === 'number')
                        ? SMC_SETTINGS[item.opacityKey]
                        : 18;
                    const lwVal = (Array.isArray(SMC_SETTINGS.lineWidths) && typeof SMC_SETTINGS.lineWidths[idx] === 'number')
                        ? SMC_SETTINGS.lineWidths[idx]
                        : 1;
                    const lsVal = (Array.isArray(SMC_SETTINGS.lineStyles) && SMC_SETTINGS.lineStyles[idx])
                        ? SMC_SETTINGS.lineStyles[idx]
                        : 'solid';
                    return {
                        color: SMC_SETTINGS[item.colorKey] || '#3179f5',
                        opacity: opVal,
                        lineWidth: lwVal,
                        lineStyle: lsVal,
                        visible: !SMC_SETTINGS.lineVisible || SMC_SETTINGS.lineVisible[idx] !== false
                    };
                }
                return {
                    color: (cfg.activeColors && cfg.activeColors[idx]) || '#2962ff',
                    opacity: (cfg.lineOpacities && typeof cfg.lineOpacities[idx] === 'number') ? cfg.lineOpacities[idx] : 100,
                    lineWidth: (cfg.lineWidths && typeof cfg.lineWidths[idx] === 'number') ? cfg.lineWidths[idx] : 2,
                    lineStyle: (cfg.lineStyles && cfg.lineStyles[idx]) || 'solid',
                    visible: !cfg.lineVisible || cfg.lineVisible[idx] !== false
                };
            }

            function updateLineState(idx, patch) {
                if (name === 'SMC') {
                    const item = lineItems[idx] || lineItems[0];
                    if (patch.color !== undefined) SMC_SETTINGS[item.colorKey] = patch.color;
                    if (patch.opacity !== undefined && item.opacityKey) SMC_SETTINGS[item.opacityKey] = patch.opacity;
                    if (patch.lineWidth !== undefined) {
                        if (!Array.isArray(SMC_SETTINGS.lineWidths)) SMC_SETTINGS.lineWidths = [1, 1, 1, 1];
                        SMC_SETTINGS.lineWidths[idx] = patch.lineWidth;
                    }
                    if (patch.lineStyle !== undefined) {
                        if (!Array.isArray(SMC_SETTINGS.lineStyles)) SMC_SETTINGS.lineStyles = ['solid', 'solid', 'solid', 'solid'];
                        SMC_SETTINGS.lineStyles[idx] = patch.lineStyle;
                    }
                    if (patch.visible !== undefined) {
                        if (!Array.isArray(SMC_SETTINGS.lineVisible)) SMC_SETTINGS.lineVisible = [true, true, true, true];
                        SMC_SETTINGS.lineVisible[idx] = patch.visible;
                    }
                    computeSmcNow();
                    renderAllLegends();
                    return;
                }
                if (patch.color !== undefined) cfg.activeColors[idx] = patch.color;
                if (patch.opacity !== undefined) cfg.lineOpacities[idx] = patch.opacity;
                if (patch.lineWidth !== undefined) cfg.lineWidths[idx] = patch.lineWidth;
                if (patch.lineStyle !== undefined) cfg.lineStyles[idx] = patch.lineStyle;
                if (patch.visible !== undefined) cfg.lineVisible[idx] = patch.visible;
                rebuildIndicatorSeries(name);
                renderAllLegends();
            }

            lineItems.forEach(function (item, idx) {
                const row = document.createElement('div');
                row.className = 'tv-ind-line-row';

                const lbl = document.createElement('label');
                lbl.className = 'tv-draw-top-label';
                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.className = 'tv-draw-top-chk';
                chk.checked = getLineState(idx).visible;
                chk.addEventListener('change', function () {
                    updateLineState(idx, { visible: chk.checked });
                    syncAllStyleUI();
                });
                const txt = document.createElement('span');
                txt.textContent = item.label;
                lbl.appendChild(chk);
                lbl.appendChild(txt);
                row.appendChild(lbl);

                const pillGroup = document.createElement('div');
                pillGroup.className = 'tv-draw-pill-group';

                const pill = document.createElement('button');
                pill.type = 'button';
                pill.className = 'tv-draw-color-pill';
                const pillSwatch = document.createElement('span');
                pillSwatch.className = 'tv-draw-color-pill-swatch';
                const pillLine = document.createElement('span');
                pillLine.className = 'tv-draw-color-pill-line';
                pill.appendChild(pillSwatch);
                pill.appendChild(pillLine);

                pill.addEventListener('click', function () {
                    if (selectedLineIdx === idx) {
                        paletteVisible = !paletteVisible;
                    } else {
                        selectedLineIdx = idx;
                        paletteVisible = true;
                    }
                    syncAllStyleUI();
                });

                pillGroup.appendChild(pill);
                row.appendChild(pillGroup);
                linesListWrap.appendChild(row);

                rowControllers.push({
                    idx: idx,
                    chk: chk,
                    pill: pill,
                    pillSwatch: pillSwatch,
                    pillLine: pillLine
                });
            });

            // Shared Palette Card inside Style Tab
            const paletteCard = document.createElement('div');
            paletteCard.className = 'tv-draw-palette-card';
            paletteCard.style.marginTop = '6px';

            const swatchButtons = [];
            IND_PALETTE_ROWS.forEach(function (rowColors, rIdx) {
                const gridRow = document.createElement('div');
                gridRow.className = 'tv-draw-swatch-grid' + (rIdx === 1 ? ' tv-draw-swatch-row-gap' : '');
                rowColors.forEach(function (hex) {
                    const sw = document.createElement('button');
                    sw.type = 'button';
                    sw.className = 'tv-draw-swatch';
                    sw.style.background = hex;
                    sw.dataset.hex = hex.toLowerCase();
                    sw.addEventListener('click', function () {
                        updateLineState(selectedLineIdx, { color: hex });
                        syncAllStyleUI();
                    });
                    swatchButtons.push(sw);
                    gridRow.appendChild(sw);
                });
                paletteCard.appendChild(gridRow);
            });

            // Custom color + button
            const customRow = document.createElement('div');
            customRow.className = 'tv-draw-custom-row';
            const customSwatch = document.createElement('div');
            customSwatch.className = 'tv-draw-custom-swatch';
            const customBtn = document.createElement('button');
            customBtn.type = 'button';
            customBtn.className = 'tv-draw-custom-btn';
            customBtn.title = 'Add custom color';
            customBtn.textContent = '+';
            const hiddenColorInput = document.createElement('input');
            hiddenColorInput.type = 'color';
            hiddenColorInput.style.position = 'absolute';
            hiddenColorInput.style.opacity = '0';
            hiddenColorInput.style.pointerEvents = 'none';
            hiddenColorInput.style.width = '1px';
            hiddenColorInput.style.height = '1px';

            customBtn.addEventListener('click', function () {
                hiddenColorInput.value = getLineState(selectedLineIdx).color || '#2962ff';
                hiddenColorInput.click();
            });
            hiddenColorInput.addEventListener('input', function () {
                updateLineState(selectedLineIdx, { color: hiddenColorInput.value });
                syncAllStyleUI();
            });

            customRow.appendChild(customSwatch);
            customRow.appendChild(customBtn);
            customRow.appendChild(hiddenColorInput);
            paletteCard.appendChild(customRow);

            // Opacity
            const opacityLbl = document.createElement('div');
            opacityLbl.className = 'tv-draw-sec-label';
            opacityLbl.textContent = 'Opacity';
            paletteCard.appendChild(opacityLbl);

            const opacityRow = document.createElement('div');
            opacityRow.className = 'tv-draw-opacity-row';
            const opacityTrackWrap = document.createElement('div');
            opacityTrackWrap.className = 'tv-draw-opacity-track-wrap';
            const opacityGrad = document.createElement('div');
            opacityGrad.className = 'tv-draw-opacity-gradient';
            const opacityRange = document.createElement('input');
            opacityRange.type = 'range';
            opacityRange.min = '5';
            opacityRange.max = '100';
            opacityRange.step = '1';
            opacityRange.className = 'tv-draw-opacity-range';
            opacityTrackWrap.appendChild(opacityGrad);
            opacityTrackWrap.appendChild(opacityRange);

            const opacityValBox = document.createElement('div');
            opacityValBox.className = 'tv-draw-opacity-val';

            opacityRange.addEventListener('input', function () {
                updateLineState(selectedLineIdx, { opacity: Number(opacityRange.value) });
                syncAllStyleUI();
            });

            opacityRow.appendChild(opacityTrackWrap);
            opacityRow.appendChild(opacityValBox);
            paletteCard.appendChild(opacityRow);

            // Thickness
            const thickLbl = document.createElement('div');
            thickLbl.className = 'tv-draw-sec-label';
            thickLbl.textContent = 'Thickness';
            paletteCard.appendChild(thickLbl);

            const thickGroup = document.createElement('div');
            thickGroup.className = 'tv-draw-seg-group cols-4';
            const thickButtons = [];
            [1, 2, 3, 4].forEach(function (w) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tv-draw-seg-btn';
                btn.dataset.width = String(w);
                btn.innerHTML = '<svg width="26" height="10" viewBox="0 0 26 10"><line x1="3" y1="5" x2="23" y2="5" stroke="currentColor" stroke-width="' + w + '" stroke-linecap="round"/></svg>';
                btn.addEventListener('click', function () {
                    updateLineState(selectedLineIdx, { lineWidth: w });
                    syncAllStyleUI();
                });
                thickButtons.push(btn);
                thickGroup.appendChild(btn);
            });
            paletteCard.appendChild(thickGroup);

            // Line style
            const styleLbl = document.createElement('div');
            styleLbl.className = 'tv-draw-sec-label';
            styleLbl.textContent = 'Line style';
            paletteCard.appendChild(styleLbl);

            const lineStyleGroup = document.createElement('div');
            lineStyleGroup.className = 'tv-draw-seg-group cols-3';
            const lineStyleButtons = [];
            [
                { id: 'solid',  dash: '' },
                { id: 'dashed', dash: 'stroke-dasharray="3.5 2.5"' },
                { id: 'dotted', dash: 'stroke-dasharray="1.2 2.2"' }
            ].forEach(function (ls) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tv-draw-seg-btn';
                btn.dataset.linestyle = ls.id;
                btn.innerHTML = '<svg width="34" height="10" viewBox="0 0 34 10"><line x1="4" y1="5" x2="30" y2="5" stroke="currentColor" stroke-width="1.6" ' + ls.dash + ' stroke-linecap="round"/></svg>';
                btn.addEventListener('click', function () {
                    updateLineState(selectedLineIdx, { lineStyle: ls.id });
                    syncAllStyleUI();
                });
                lineStyleButtons.push(btn);
                lineStyleGroup.appendChild(btn);
            });
            paletteCard.appendChild(lineStyleGroup);

            stylePane.appendChild(paletteCard);
            body.appendChild(stylePane);

            tabInputs.addEventListener('click', function () {
                tabInputs.classList.add('active');
                tabStyle.classList.remove('active');
                stylePane.style.display = 'none';
                inputsPane.style.display = 'block';
            });
            tabStyle.addEventListener('click', function () {
                tabStyle.classList.add('active');
                tabInputs.classList.remove('active');
                inputsPane.style.display = 'none';
                stylePane.style.display = 'block';
            });

            // Footer
            const footer = document.createElement('div');
            footer.className = 'tv-draw-modal-footer';

            const defaultsWrap = document.createElement('div');
            defaultsWrap.className = 'tv-draw-defaults-wrap';

            const defaultsBtn = document.createElement('button');
            defaultsBtn.type = 'button';
            defaultsBtn.className = 'tv-draw-defaults-btn';
            defaultsBtn.innerHTML = '<span>Defaults</span><svg width="9" height="9" viewBox="0 0 18 18"><polyline points="4,6.5 9,12 14,6.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

            const defaultsMenu = document.createElement('div');
            defaultsMenu.className = 'tv-draw-defaults-menu';

            const resetDefaultItem = document.createElement('button');
            resetDefaultItem.type = 'button';
            resetDefaultItem.className = 'tv-draw-defaults-item';
            resetDefaultItem.textContent = 'Defaults';
            resetDefaultItem.addEventListener('click', function (ev) {
                ev.stopPropagation();
                defaultsMenu.classList.remove('open');
                delete savedIndicatorDefaults[name];
                persistSavedIndicatorDefaults();
                if (name === 'SMC') {
                    Object.keys(DEFAULT_SMC_SNAPSHOT).forEach(function (k) {
                        SMC_SETTINGS[k] = JSON.parse(JSON.stringify(DEFAULT_SMC_SNAPSHOT[k]));
                    });
                    inputEls.forEach(function (item) {
                        if (item.key) item.el.value = String(SMC_SETTINGS[item.key]);
                    });
                    computeSmcNow();
                } else {
                    const def = DEFAULT_INDICATOR_SNAPSHOTS[name];
                    if (def) {
                        cfg.params        = def.params.slice();
                        cfg.activeColors  = def.activeColors.slice();
                        cfg.lineWidths    = def.lineWidths.slice();
                        cfg.lineStyles    = def.lineStyles.slice();
                        cfg.lineOpacities = def.lineOpacities.slice();
                        cfg.lineVisible   = def.lineVisible.slice();
                        inputEls.forEach(function (item) {
                            if (typeof item.index === 'number' && cfg.params[item.index] !== undefined) {
                                item.el.value = String(cfg.params[item.index]);
                            }
                        });
                        rebuildIndicatorSeries(name);
                    }
                }
                renderAllLegends();
                syncAllStyleUI();
            });

            const saveDefaultItem = document.createElement('button');
            saveDefaultItem.type = 'button';
            saveDefaultItem.className = 'tv-draw-defaults-item';
            saveDefaultItem.textContent = 'Save as default';
            saveDefaultItem.addEventListener('click', function (ev) {
                ev.stopPropagation();
                defaultsMenu.classList.remove('open');
                if (name === 'SMC') {
                    savedIndicatorDefaults.SMC = JSON.parse(JSON.stringify(SMC_SETTINGS));
                } else {
                    savedIndicatorDefaults[name] = {
                        params:        (cfg.params || []).slice(),
                        activeColors:  (cfg.activeColors || []).slice(),
                        lineWidths:    (cfg.lineWidths || []).slice(),
                        lineStyles:    (cfg.lineStyles || []).slice(),
                        lineOpacities: (cfg.lineOpacities || []).slice(),
                        lineVisible:   (cfg.lineVisible || []).slice()
                    };
                }
                persistSavedIndicatorDefaults();
            });

            defaultsMenu.appendChild(resetDefaultItem);
            defaultsMenu.appendChild(saveDefaultItem);

            defaultsBtn.addEventListener('click', function (ev) {
                ev.stopPropagation();
                defaultsMenu.classList.toggle('open');
            });

            modal.addEventListener('click', function (ev) {
                if (!defaultsWrap.contains(ev.target)) {
                    defaultsMenu.classList.remove('open');
                }
            });

            defaultsWrap.appendChild(defaultsBtn);
            defaultsWrap.appendChild(defaultsMenu);
            footer.appendChild(defaultsWrap);

            const footerActions = document.createElement('div');
            footerActions.className = 'tv-draw-footer-actions';

            const cancelBtn = document.createElement('button');
            cancelBtn.type = 'button';
            cancelBtn.className = 'tv-draw-btn-cancel';
            cancelBtn.textContent = 'Cancel';

            const okBtn = document.createElement('button');
            okBtn.type = 'button';
            okBtn.className = 'tv-draw-btn-ok';
            okBtn.textContent = 'Ok';

            function revertAndClose() {
                if (name === 'SMC') {
                    Object.keys(initialSnapshot).forEach(function (k) {
                        SMC_SETTINGS[k] = JSON.parse(JSON.stringify(initialSnapshot[k]));
                    });
                    computeSmcNow();
                } else {
                    cfg.params        = initialSnapshot.params.slice();
                    cfg.activeColors  = initialSnapshot.activeColors.slice();
                    cfg.lineWidths    = initialSnapshot.lineWidths.slice();
                    cfg.lineStyles    = initialSnapshot.lineStyles.slice();
                    cfg.lineOpacities = initialSnapshot.lineOpacities.slice();
                    cfg.lineVisible   = initialSnapshot.lineVisible.slice();
                    rebuildIndicatorSeries(name);
                }
                renderAllLegends();
                closeIndicatorSettingsPopup();
            }

            function commitAndClose() {
                closeIndicatorSettingsPopup();
            }

            cancelBtn.addEventListener('click', revertAndClose);
            okBtn.addEventListener('click', commitAndClose);
            closeBtn.addEventListener('click', commitAndClose);

            footerActions.appendChild(cancelBtn);
            footerActions.appendChild(okBtn);
            footer.appendChild(footerActions);
            modal.appendChild(footer);

            function syncAllStyleUI() {
                rowControllers.forEach(function (rc) {
                    const st = getLineState(rc.idx);
                    rc.chk.checked = st.visible;
                    rc.pill.classList.toggle('active', paletteVisible && rc.idx === selectedLineIdx);
                    rc.pillSwatch.style.background = hexToRgba(st.color, st.opacity / 100);
                    rc.pillLine.style.height = Math.max(1, st.lineWidth) + 'px';
                    rc.pillLine.style.background = st.color;
                });

                paletteCard.style.display = paletteVisible ? 'block' : 'none';
                if (!paletteVisible) return;

                const cur = getLineState(selectedLineIdx);
                const curColor = (cur.color || '#2962ff').toLowerCase();
                customSwatch.style.background = curColor;

                swatchButtons.forEach(function (sw) {
                    sw.classList.toggle('selected', sw.dataset.hex === curColor);
                });

                opacityRange.value = String(cur.opacity);
                opacityValBox.textContent = cur.opacity + '%';
                opacityGrad.style.background = 'linear-gradient(to right, ' + hexToRgba(curColor, 0) + ', ' + hexToRgba(curColor, 1) + ')';

                thickButtons.forEach(function (b) {
                    b.classList.toggle('active', Number(b.dataset.width) === cur.lineWidth);
                });

                lineStyleButtons.forEach(function (b) {
                    b.classList.toggle('active', b.dataset.linestyle === cur.lineStyle);
                });
            }

            syncAllStyleUI();
            document.body.appendChild(modal);

            // Position modal near clicked gear icon or centered inside viewport
            const rect = modal.getBoundingClientRect();
            const vw = window.innerWidth;
            const vh = window.innerHeight;
            let left = (anchorEvent && typeof anchorEvent.clientX === 'number') ? anchorEvent.clientX + 12 : (vw - rect.width) / 2;
            let top  = (anchorEvent && typeof anchorEvent.clientY === 'number') ? anchorEvent.clientY + 12 : (vh - rect.height) / 2;
            if (left + rect.width > vw - 12) left = Math.max(12, vw - rect.width - 16);
            if (top + rect.height > vh - 12) top = Math.max(12, vh - rect.height - 16);
            if (left < 12) left = 12;
            if (top < 12) top = 12;
            modal.style.left = Math.round(left) + 'px';
            modal.style.top  = Math.round(top) + 'px';

            // Header dragging
            let headerDrag = null;
            function onHeaderMouseDown(ev) {
                if (ev.target && ev.target.closest && ev.target.closest('button')) return;
                const r = modal.getBoundingClientRect();
                headerDrag = { startX: ev.clientX, startY: ev.clientY, origLeft: r.left, origTop: r.top };
                ev.preventDefault();
            }
            function onHeaderMouseMove(ev) {
                if (!headerDrag) return;
                const nx = Math.max(8, Math.min(window.innerWidth - 60, headerDrag.origLeft + (ev.clientX - headerDrag.startX)));
                const ny = Math.max(8, Math.min(window.innerHeight - 60, headerDrag.origTop + (ev.clientY - headerDrag.startY)));
                modal.style.left = Math.round(nx) + 'px';
                modal.style.top  = Math.round(ny) + 'px';
            }
            function onHeaderMouseUp() {
                headerDrag = null;
            }
            header.addEventListener('mousedown', onHeaderMouseDown);
            window.addEventListener('mousemove', onHeaderMouseMove);
            window.addEventListener('mouseup', onHeaderMouseUp);

            modal.__cleanup = function () {
                window.removeEventListener('mousemove', onHeaderMouseMove);
                window.removeEventListener('mouseup', onHeaderMouseUp);
            };

            activeIndModalEl = modal;
        }

        /* --------------------------------------------------------
         * Workspace Persistence API (consumed by drawtools.js)
         * -------------------------------------------------------- */
        window.ChartWorkspace = window.ChartWorkspace || {};

        window.ChartWorkspace.captureIndicators = function () {
            const out = [];
            activeIndicators.forEach(function (name) {
                const cfg = INDICATOR_CONFIG[name];
                if (!cfg) return;
                out.push({
                    name:          name,
                    paneId:        indicatorPaneMap[name] || cfg.pane,
                    calcParams:    Array.isArray(cfg.params) ? cfg.params.slice() : [],
                    colors:        Array.isArray(cfg.activeColors) ? cfg.activeColors.slice() : null,
                    lineWidths:    Array.isArray(cfg.lineWidths) ? cfg.lineWidths.slice() : null,
                    lineStyles:    Array.isArray(cfg.lineStyles) ? cfg.lineStyles.slice() : null,
                    lineOpacities: Array.isArray(cfg.lineOpacities) ? cfg.lineOpacities.slice() : null,
                    lineVisible:   Array.isArray(cfg.lineVisible) ? cfg.lineVisible.slice() : null,
                    visible:       indicatorVisibility[name] !== false
                });
            });
            return out;
        };

        window.ChartWorkspace.captureSmcSettings = function () {
            return JSON.parse(JSON.stringify(SMC_SETTINGS));
        };

        window.ChartWorkspace.clearIndicators = function () {
            Array.from(activeIndicators).forEach(function (name) {
                try { removeIndicator(name); } catch (e) {}
            });
        };

        window.ChartWorkspace.applyIndicators = function (list, smcSettings) {
            if (smcSettings && typeof smcSettings === 'object') {
                Object.keys(SMC_SETTINGS).forEach(function (k) {
                    if (smcSettings[k] !== undefined) SMC_SETTINGS[k] = smcSettings[k];
                });
            }
            if (!Array.isArray(list)) return;
            list.forEach(function (item) {
                if (!item || !item.name) return;
                const cfg = INDICATOR_CONFIG[item.name];
                if (!cfg) return;
                ensureIndicatorStyleArrays(item.name);
                if (Array.isArray(item.calcParams) && item.calcParams.length) {
                    cfg.params = item.calcParams.slice();
                }
                if (Array.isArray(item.colors) && item.colors.length) {
                    cfg.activeColors = item.colors.slice();
                }
                if (Array.isArray(item.lineWidths) && item.lineWidths.length) {
                    cfg.lineWidths = item.lineWidths.slice();
                }
                if (Array.isArray(item.lineStyles) && item.lineStyles.length) {
                    cfg.lineStyles = item.lineStyles.slice();
                }
                if (Array.isArray(item.lineOpacities) && item.lineOpacities.length) {
                    cfg.lineOpacities = item.lineOpacities.slice();
                }
                if (Array.isArray(item.lineVisible) && item.lineVisible.length) {
                    cfg.lineVisible = item.lineVisible.slice();
                }
                try { addIndicator(item.name); } catch (e) {}

                if (item.visible === false) {
                    indicatorVisibility[item.name] = false;
                    if (item.name === 'SMC') {
                        window.ChartState.wantSmc = false;
                    } else {
                        const entry = indicatorSeriesMap[item.name];
                        if (entry && entry.seriesList) {
                            entry.seriesList.forEach(function (s) {
                                try { s.series.applyOptions({ visible: false }); } catch (err) {}
                            });
                        }
                    }
                    window.ChartState.requestOverlayRedraw();
                    renderAllLegends();
                }
            });
        };

        /* --------------------------------------------------------
         * Indicators Modal Dialog & Search Filter
         * -------------------------------------------------------- */
        const INDICATOR_CATALOG = [
            {
                group: 'Main chart overlays',
                items: [
                    { name: 'MA',         label: 'MA (Moving Average)' },
                    { name: 'EMA',        label: 'EMA (Exponential Moving Average)' },
                    { name: 'BOLL',       label: 'BOLL (Bollinger Bands)' },
                    { name: 'SAR',        label: 'SAR (Parabolic SAR)' },
                    { name: 'SUPERTREND', label: 'SuperTrend' }
                ]
            },
            {
                group: 'Synced sub-pane oscillators',
                items: [
                    { name: 'VOL',  label: 'VOL (Trading Volume + MA)' },
                    { name: 'MACD', label: 'MACD (Moving Average Convergence Divergence)' },
                    { name: 'RSI',  label: 'RSI (Relative Strength Index)' },
                    { name: 'KDJ',  label: 'KDJ (Stochastic Indicator)' },
                    { name: 'BIAS', label: 'BIAS (Deviation Rate)' },
                    { name: 'CCI',  label: 'CCI (Commodity Channel Index)' },
                    { name: 'WR',   label: 'WR (Williams %R)' },
                    { name: 'OBV',  label: 'OBV (On-Balance Volume)' }
                ]
            },
            {
                group: 'Custom quantitative models',
                items: [
                    { name: 'SMC',       label: 'SMC (Smart Money Order Blocks & BOS/CHoCH)' },
                    { name: 'OSAVERAGE', label: 'OSAverage (Xtrender Oscillator)' },
                    { name: 'VPSR',      label: 'VPSR (Volume Profile Oscillator)' }
                ]
            }
        ];

        const SVG_CHECKED   = '<path d="M810.666667 128H213.333333c-46.933333 0-85.333333 38.4-85.333333 85.333333v597.333334c0 46.933333 38.4 85.333333 85.333333 85.333333h597.333334c46.933333 0 85.333333-38.4 85.333333-85.333333V213.333333c0-46.933333-38.4-85.333333-85.333333-85.333333z m-353.706667 567.04a42.496 42.496 0 0 1-60.16 0L243.626667 541.866667c-8.106667-8.106667-12.373333-18.773333-12.373334-29.866667s4.693333-22.186667 12.373334-29.866667a42.496 42.496 0 0 1 60.16 0L426.666667 604.586667l293.546666-293.546667a42.496 42.496 0 1 1 60.16 60.16l-323.413333 323.84z"></path>';
        const SVG_UNCHECKED = '<path d="M245.333333 128h533.333334A117.333333 117.333333 0 0 1 896 245.333333v533.333334A117.333333 117.333333 0 0 1 778.666667 896H245.333333A117.333333 117.333333 0 0 1 128 778.666667V245.333333A117.333333 117.333333 0 0 1 245.333333 128z m0 64c-29.44 0-53.333333 23.893333-53.333333 53.333333v533.333334c0 29.44 23.893333 53.333333 53.333333 53.333333h533.333334c29.44 0 53.333333-23.893333 53.333333-53.333333V245.333333c0-29.44-23.893333-53.333333-53.333333-53.333333H245.333333z"></path>';

        function buildIndicatorsModal() {
            const overlay     = document.getElementById('indicatorsOverlay');
            const listEl      = document.getElementById('indicatorsList');
            const openBtn     = document.getElementById('openIndicatorsBtn');
            const closeBtn    = document.getElementById('closeIndicators');
            const searchInput = document.getElementById('indicatorSearchInput');
            if (!overlay || !listEl || !openBtn || !closeBtn) return;
            if (overlay.__wired) return;
            overlay.__wired = true;

            function render() {
                const q = searchInput ? searchInput.value.trim().toLowerCase() : '';
                let html = '';
                INDICATOR_CATALOG.forEach(function (section) {
                    const items = !q ? section.items : section.items.filter(function (it) {
                        return it.name.toLowerCase().includes(q) || it.label.toLowerCase().includes(q);
                    });
                    if (items.length === 0) return;
                    html += '<li class="title">' + section.group + '</li>';
                    items.forEach(function (item) {
                        const checked = activeIndicators.has(item.name);
                        html +=
                            '<li class="row" data-name="' + item.name + '">' +
                                '<div class="indicator-checkbox' + (checked ? ' checked' : '') + '">' +
                                    '<svg viewBox="0 0 1024 1024" class="icon">' +
                                        (checked ? SVG_CHECKED : SVG_UNCHECKED) +
                                    '</svg>' +
                                    '<span class="label">' + item.label + '</span>' +
                                '</div>' +
                            '</li>';
                    });
                });
                listEl.innerHTML = html || '<div class="symbol-empty">No matching indicators found.</div>';
            }

            if (searchInput) {
                searchInput.addEventListener('input', render);
            }

            listEl.addEventListener('click', function (e) {
                const row = e.target.closest('li.row');
                if (!row) return;
                const name = row.dataset.name;
                if (!name) return;
                if (activeIndicators.has(name)) {
                    removeIndicator(name);
                } else {
                    addIndicator(name);
                }
                render();
            });

            openBtn.addEventListener('click', function () {
                if (searchInput) searchInput.value = '';
                render();
                overlay.classList.add('open');
                if (searchInput) setTimeout(function () { searchInput.focus(); }, 30);
            });
            closeBtn.addEventListener('click', function () {
                overlay.classList.remove('open');
            });
            overlay.addEventListener('click', function (e) {
                if (e.target === overlay) overlay.classList.remove('open');
            });

            window.addEventListener('indicatorsChanged', render);
        }

        buildIndicatorsModal();
    }

})();
