/* ============================================================================
 * chart.js — TradingView Lightweight Charts Core & Multi-Pane Engine
 * ============================================================================
 * Replaces klinecharts with TradingView's lightweight-charts library:
 *  - Main candlestick chart with Logarithmic / Linear / Auto scale toggles
 *  - Multi-pane synchronization manager (timeScale logical range sync,
 *    crosshair position sync, right price scale alignment, bottom time-axis
 *    visibility management, and interactive pane height splitters)
 *  - High-DPI HTML5 overlay canvas for Smart Money Concepts (SMC) & Drawing
 *    tools with exact logical/time/price coordinate mapping
 *  - Persistent WebSocket stream (/ws) with exponential backoff & in-place
 *    bar updates across lifecycle events
 * ==========================================================================*/
(function () {
    'use strict';

    const rootContainer = document.getElementById('chart');
    if (!rootContainer) return;

    const CHART_FONT = "Arial, sans-serif";
    const RIGHT_SCALE_MIN_WIDTH = 88;

    /* ----------------------------------------------------------------
     * 1. Build DOM structure inside #chart:
     *    - #tv-main-pane (flex: 1) -> main chart mount + OHLCV bar + overlay canvas
     *    - #tv-subpanes (flex: 0)  -> stacked synchronized oscillator sub-panes
     * ---------------------------------------------------------------- */
    rootContainer.innerHTML = '';

    const mainPaneEl = document.createElement('div');
    mainPaneEl.id = 'tv-main-pane';
    mainPaneEl.className = 'tv-main-pane';

    const mainMountEl = document.createElement('div');
    mainMountEl.id = 'tv-main-mount';
    mainMountEl.className = 'tv-chart-mount';
    mainPaneEl.appendChild(mainMountEl);

    // Live TradingView-style OHLCV status bar
    const ohlcvBarEl = document.createElement('div');
    ohlcvBarEl.id = 'tv-ohlcv-bar';
    ohlcvBarEl.className = 'tv-ohlcv-bar';
    ohlcvBarEl.innerHTML =
        '<span class="tv-ohlcv-symbol" id="ohlcvSymbol">—</span>' +
        '<span class="tv-ohlcv-sep">·</span>' +
        '<span class="tv-ohlcv-tf" id="ohlcvTf">—</span>' +
        '<span class="tv-ohlcv-sep">·</span>' +
        '<div class="tv-ohlcv-values" id="ohlcvValues">' +
            '<span class="tv-ohlcv-item"><span class="k">O</span><span class="v" id="ohlcvO">—</span></span>' +
            '<span class="tv-ohlcv-item"><span class="k">H</span><span class="v" id="ohlcvH">—</span></span>' +
            '<span class="tv-ohlcv-item"><span class="k">L</span><span class="v" id="ohlcvL">—</span></span>' +
            '<span class="tv-ohlcv-item"><span class="k">C</span><span class="v" id="ohlcvC">—</span></span>' +
            '<span class="tv-ohlcv-item"><span class="v" id="ohlcvChg">—</span></span>' +
            '<span class="tv-ohlcv-item"><span class="k">Vol</span><span class="v" id="ohlcvVol">—</span></span>' +
        '</div>';
    mainPaneEl.appendChild(ohlcvBarEl);

    // High-DPI Overlay Canvas for SMC Order Blocks, BOLL fill & Drawing Tools
    const overlayCanvas = document.createElement('canvas');
    overlayCanvas.id = 'tv-overlay-canvas';
    overlayCanvas.className = 'tv-overlay-canvas';
    mainPaneEl.appendChild(overlayCanvas);

    // State banner for loading / error feedback
    const stateBannerEl = document.createElement('div');
    stateBannerEl.id = 'tv-state-banner';
    stateBannerEl.className = 'tv-chart-state-banner hidden';
    mainPaneEl.appendChild(stateBannerEl);

    const subPanesContainer = document.createElement('div');
    subPanesContainer.id = 'tv-subpanes';
    subPanesContainer.className = 'tv-subpanes-container';

    rootContainer.appendChild(mainPaneEl);
    rootContainer.appendChild(subPanesContainer);

    function showBanner(msg) {
        if (!stateBannerEl) return;
        if (!msg) {
            stateBannerEl.classList.add('hidden');
            stateBannerEl.textContent = '';
        } else {
            stateBannerEl.textContent = msg;
            stateBannerEl.classList.remove('hidden');
        }
    }

    /* ----------------------------------------------------------------
     * 2. Verify LightweightCharts is loaded & create compatibility helpers
     * ---------------------------------------------------------------- */
    function ensureLightweightChartsLoaded() {
        if (typeof LightweightCharts !== 'undefined') {
            return Promise.resolve(LightweightCharts);
        }
        return new Promise(function (resolve, reject) {
            const urls = [
                'https://unpkg.com/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js',
                'https://cdn.jsdelivr.net/npm/lightweight-charts@4.2.1/dist/lightweight-charts.standalone.production.js',
                '/static/lightweight-charts.standalone.production.js'
            ];
            let idx = 0;
            function tryNext() {
                if (typeof LightweightCharts !== 'undefined') {
                    return resolve(LightweightCharts);
                }
                if (idx >= urls.length) {
                    return reject(new Error('LightweightCharts library could not be loaded.'));
                }
                const s = document.createElement('script');
                s.src = urls[idx++];
                s.onload = function () {
                    if (typeof LightweightCharts !== 'undefined') resolve(LightweightCharts);
                    else tryNext();
                };
                s.onerror = tryNext;
                document.head.appendChild(s);
            }
            tryNext();
        });
    }

    /**
     * Cross-version series creator supporting both Lightweight Charts v4
     * (`chart.addCandlestickSeries(...)`) and v5 (`chart.addSeries(LightweightCharts.CandlestickSeries, ...)`).
     */
    function createSeries(chartInstance, type, options) {
        if (!chartInstance) return null;
        const opts = options || {};
        try {
            if (type === 'Candlestick') {
                if (typeof chartInstance.addCandlestickSeries === 'function') {
                    return chartInstance.addCandlestickSeries(opts);
                }
                if (typeof chartInstance.addSeries === 'function' && LightweightCharts.CandlestickSeries) {
                    return chartInstance.addSeries(LightweightCharts.CandlestickSeries, opts);
                }
            } else if (type === 'Line') {
                if (typeof chartInstance.addLineSeries === 'function') {
                    return chartInstance.addLineSeries(opts);
                }
                if (typeof chartInstance.addSeries === 'function' && LightweightCharts.LineSeries) {
                    return chartInstance.addSeries(LightweightCharts.LineSeries, opts);
                }
            } else if (type === 'Histogram') {
                if (typeof chartInstance.addHistogramSeries === 'function') {
                    return chartInstance.addHistogramSeries(opts);
                }
                if (typeof chartInstance.addSeries === 'function' && LightweightCharts.HistogramSeries) {
                    return chartInstance.addSeries(LightweightCharts.HistogramSeries, opts);
                }
            } else if (type === 'Area') {
                if (typeof chartInstance.addAreaSeries === 'function') {
                    return chartInstance.addAreaSeries(opts);
                }
                if (typeof chartInstance.addSeries === 'function' && LightweightCharts.AreaSeries) {
                    return chartInstance.addSeries(LightweightCharts.AreaSeries, opts);
                }
            }
        } catch (err) {
            console.error('[chart.js] Failed to create ' + type + ' series:', err);
        }
        return null;
    }

    function removeSeriesSafe(chartInstance, series) {
        if (!chartInstance || !series) return;
        try {
            chartInstance.removeSeries(series);
        } catch (e) {}
    }

    /* ----------------------------------------------------------------
     * 3. Global ChartState Initialization
     * ---------------------------------------------------------------- */
    const initCfg = window.APP_CONFIG || { initAsset: '34144395039913458', initTimeframe: '1d' };

    window.ChartState = {
        chart:               null,
        mainChart:           null,
        candleSeries:        null,
        volumeSeries:        null,
        rootContainer:       rootContainer,
        mainPaneEl:          mainPaneEl,
        mainMountEl:         mainMountEl,
        subPanesContainer:   subPanesContainer,
        overlayCanvas:       overlayCanvas,
        currentAsset:        initCfg.initAsset || '34144395039913458',
        currentTimeframe:    initCfg.initTimeframe || '1d',
        currentBars:         [],
        futureWhitespace:    [],
        timeToIndex:         new Map(),
        avgBarIntervalMs:    86400000,
        extraData:           {},
        wantSmc:             false,
        isLogScale:          false,
        isAutoScale:         true,
        barsLoadedHandlers:  [],
        overlayDrawHandlers: [],
        crosshairListeners:  [],
        subPanes:            new Map(),
        createSeries:        createSeries,
        removeSeriesSafe:    removeSeriesSafe
    };

    /* ----------------------------------------------------------------
     * 4. Coordinate Conversion & Overlay Canvas Redraw Engine
     * ---------------------------------------------------------------- */
    let overlayRafPending = false;

    function syncPaneCanvasSize(containerEl, canvasEl, chartInstance) {
        if (!containerEl || !canvasEl) return { width: 0, height: 0, plotWidth: 0, plotHeight: 0, dpr: 1 };
        const rect = containerEl.getBoundingClientRect();
        const dpr = window.devicePixelRatio || 1;
        const w = Math.max(1, Math.floor(rect.width));
        const h = Math.max(1, Math.floor(rect.height));

        if (canvasEl.width !== Math.floor(w * dpr) || canvasEl.height !== Math.floor(h * dpr)) {
            canvasEl.width = Math.floor(w * dpr);
            canvasEl.height = Math.floor(h * dpr);
            canvasEl.style.width = w + 'px';
            canvasEl.style.height = h + 'px';
        }

        let priceScaleWidth = RIGHT_SCALE_MIN_WIDTH;
        let timeScaleHeight = 0;
        try {
            if (chartInstance) {
                const pw = chartInstance.priceScale('right').width();
                if (typeof pw === 'number' && pw > 0) priceScaleWidth = pw;
                const th = chartInstance.timeScale().height();
                if (typeof th === 'number' && th >= 0) timeScaleHeight = th;
            }
        } catch (e) {}

        return {
            width: w,
            height: h,
            plotWidth: Math.max(1, w - priceScaleWidth),
            plotHeight: Math.max(1, h - timeScaleHeight),
            dpr: dpr
        };
    }

    function syncOverlayCanvasSize() {
        return syncPaneCanvasSize(mainPaneEl, overlayCanvas, window.ChartState.mainChart);
    }

    function getPanePlotDimensions(paneId) {
        if (!paneId || paneId === 'candle_pane') {
            return syncPaneCanvasSize(mainPaneEl, overlayCanvas, window.ChartState.mainChart);
        }
        const sub = window.ChartState.subPanes.get(paneId);
        if (!sub) return { width: 0, height: 0, plotWidth: 0, plotHeight: 0, dpr: 1 };
        return syncPaneCanvasSize(sub.containerEl, sub.overlayCanvas, sub.chart);
    }

    function timeToX(timestampMs) {
        const mainChart = window.ChartState.mainChart;
        const bars = window.ChartState.currentBars;
        if (!mainChart || !bars || bars.length === 0 || typeof timestampMs !== 'number' || isNaN(timestampMs)) {
            return null;
        }
        const ts = mainChart.timeScale();
        const timeSec = Math.floor(timestampMs / 1000);

        // 1. Exact bar lookup via O(1) map
        const exactIdx = window.ChartState.timeToIndex.get(timeSec);
        if (exactIdx !== undefined) {
            const x = ts.logicalToCoordinate(exactIdx);
            if (x !== null && isFinite(x)) return x;
        }

        // 2. Direct LightweightCharts timeToCoordinate
        try {
            const directX = ts.timeToCoordinate(timeSec);
            if (directX !== null && isFinite(directX)) return directX;
        } catch (e) {}

        // 3. Extrapolate beyond last bar or before first bar using logical index
        const firstBar = bars[0];
        const lastBar = bars[bars.length - 1];
        const interval = Math.max(1000, window.ChartState.avgBarIntervalMs || 60000);

        if (timestampMs >= lastBar.timestamp) {
            const extraBars = (timestampMs - lastBar.timestamp) / interval;
            return ts.logicalToCoordinate((bars.length - 1) + extraBars);
        }
        if (timestampMs <= firstBar.timestamp) {
            const priorBars = (firstBar.timestamp - timestampMs) / interval;
            return ts.logicalToCoordinate(-priorBars);
        }

        // 4. Binary search between existing bars
        let lo = 0, hi = bars.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const midTs = bars[mid].timestamp;
            if (midTs === timestampMs) return ts.logicalToCoordinate(mid);
            if (midTs < timestampMs) lo = mid + 1;
            else hi = mid - 1;
        }
        const i0 = Math.max(0, Math.min(bars.length - 1, hi));
        const i1 = Math.max(0, Math.min(bars.length - 1, lo));
        if (i0 === i1) return ts.logicalToCoordinate(i0);
        const span = bars[i1].timestamp - bars[i0].timestamp;
        const frac = span > 0 ? (timestampMs - bars[i0].timestamp) / span : 0;
        return ts.logicalToCoordinate(i0 + frac);
    }

    function timeToLogical(timestampMs) {
        const bars = window.ChartState.currentBars;
        if (!bars || bars.length === 0 || typeof timestampMs !== 'number' || isNaN(timestampMs)) {
            return null;
        }
        const timeSec = Math.floor(timestampMs / 1000);
        const exactIdx = window.ChartState.timeToIndex.get(timeSec);
        if (exactIdx !== undefined) return exactIdx;

        const firstBar = bars[0];
        const lastBar = bars[bars.length - 1];
        const interval = Math.max(1000, window.ChartState.avgBarIntervalMs || 60000);

        if (timestampMs >= lastBar.timestamp) {
            return (bars.length - 1) + Math.round((timestampMs - lastBar.timestamp) / interval);
        }
        if (timestampMs <= firstBar.timestamp) {
            return -Math.round((firstBar.timestamp - timestampMs) / interval);
        }

        let lo = 0, hi = bars.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            const midTs = bars[mid].timestamp;
            if (midTs === timestampMs) return mid;
            if (midTs < timestampMs) lo = mid + 1;
            else hi = mid - 1;
        }
        const i0 = Math.max(0, Math.min(bars.length - 1, hi));
        const i1 = Math.max(0, Math.min(bars.length - 1, lo));
        if (i0 === i1) return i0;
        return Math.abs(timestampMs - bars[i0].timestamp) <= Math.abs(bars[i1].timestamp - timestampMs) ? i0 : i1;
    }

    function logicalToTime(logicalIdx) {
        const bars = window.ChartState.currentBars;
        if (!bars || bars.length === 0 || typeof logicalIdx !== 'number' || !isFinite(logicalIdx)) {
            return null;
        }
        const interval = Math.max(1000, window.ChartState.avgBarIntervalMs || 60000);
        const roundedIdx = Math.round(logicalIdx);

        if (roundedIdx >= 0 && roundedIdx < bars.length) {
            const b = bars[roundedIdx];
            return {
                timestamp: b.timestamp,
                time: b.time,
                dataIndex: roundedIdx,
                logical: roundedIdx,
                bar: b
            };
        }
        if (roundedIdx >= bars.length) {
            const lastBar = bars[bars.length - 1];
            const extra = roundedIdx - (bars.length - 1);
            const extrapolatedMs = lastBar.timestamp + extra * interval;
            return {
                timestamp: extrapolatedMs,
                time: Math.floor(extrapolatedMs / 1000),
                dataIndex: roundedIdx,
                logical: roundedIdx,
                bar: null
            };
        }
        const firstBar = bars[0];
        const extrapolatedMs = firstBar.timestamp + roundedIdx * interval;
        return {
            timestamp: extrapolatedMs,
            time: Math.floor(extrapolatedMs / 1000),
            dataIndex: roundedIdx,
            logical: roundedIdx,
            bar: null
        };
    }

    function xToTime(xPx) {
        const mainChart = window.ChartState.mainChart;
        const bars = window.ChartState.currentBars;
        if (!mainChart || !bars || bars.length === 0) return null;
        const ts = mainChart.timeScale();
        const logical = ts.coordinateToLogical(xPx);
        if (logical === null || !isFinite(logical)) return null;
        const info = logicalToTime(logical);
        if (!info) return null;
        info.logical = logical;
        return info;
    }

    function getSeriesForPane(paneId) {
        if (!paneId || paneId === 'candle_pane') {
            return window.ChartState.candleSeries;
        }
        const sub = window.ChartState.subPanes.get(paneId);
        return sub ? sub.primarySeries : null;
    }

    function priceToYForPane(paneId, price) {
        const series = getSeriesForPane(paneId);
        if (!series || typeof price !== 'number' || isNaN(price)) return null;
        try {
            const y = series.priceToCoordinate(price);
            return (y !== null && isFinite(y)) ? y : null;
        } catch (e) {
            return null;
        }
    }

    function yToPriceForPane(paneId, yPx) {
        const series = getSeriesForPane(paneId);
        if (!series || typeof yPx !== 'number' || isNaN(yPx)) return null;
        try {
            const p = series.coordinateToPrice(yPx);
            return (p !== null && isFinite(p)) ? p : null;
        } catch (e) {
            return null;
        }
    }

    function priceToY(price) {
        return priceToYForPane('candle_pane', price);
    }

    function yToPrice(yPx) {
        return yToPriceForPane('candle_pane', yPx);
    }

    window.ChartState.timeToX       = timeToX;
    window.ChartState.xToTime       = xToTime;
    window.ChartState.timeToLogical = timeToLogical;
    window.ChartState.logicalToTime = logicalToTime;
    window.ChartState.priceToY      = priceToY;
    window.ChartState.yToPrice      = yToPrice;
    window.ChartState.priceToYForPane = priceToYForPane;
    window.ChartState.yToPriceForPane = yToPriceForPane;
    window.ChartState.getPanePlotDimensions = getPanePlotDimensions;

    function renderSinglePaneOverlay(paneId, containerEl, canvasEl, chartInstance) {
        const dims = syncPaneCanvasSize(containerEl, canvasEl, chartInstance);
        if (dims.width <= 0 || dims.height <= 0) return;

        const ctx = canvasEl.getContext('2d');
        if (!ctx) return;

        ctx.save();
        ctx.setTransform(dims.dpr, 0, 0, dims.dpr, 0, 0);
        ctx.clearRect(0, 0, dims.width, dims.height);

        // Clip drawing region to the pane's plot area so overlays never bleed over the price/time axes
        ctx.beginPath();
        ctx.rect(0, 0, dims.plotWidth, dims.plotHeight);
        ctx.clip();

        const helpers = {
            paneId:     paneId,
            width:      dims.width,
            height:     dims.height,
            plotWidth:  dims.plotWidth,
            plotHeight: dims.plotHeight,
            timeToX:    timeToX,
            xToTime:    xToTime,
            priceToY:   function (p) { return priceToYForPane(paneId, p); },
            yToPrice:   function (y) { return yToPriceForPane(paneId, y); }
        };

        const handlers = window.ChartState.overlayDrawHandlers || [];
        for (let i = 0; i < handlers.length; i++) {
            try {
                handlers[i](ctx, helpers);
            } catch (err) {
                console.error('[chart.js] overlayDrawHandler error on ' + paneId + ':', err);
            }
        }

        // If the user is hovering in another pane and the cursor is in the right whitespace offset
        // (where LightweightCharts setCrosshairPosition has no bar timestamp), draw the synced vertical
        // crosshair line at the exact synced X position.
        const ch = window.ChartState.crosshairState;
        if (ch && ch.active && ch.sourcePaneId !== paneId && ch.time === undefined && typeof ch.x === 'number' && ch.x >= 0 && ch.x <= dims.plotWidth) {
            ctx.save();
            ctx.strokeStyle = '#2962ff';
            ctx.lineWidth = 1;
            ctx.setLineDash([4, 4]);
            ctx.beginPath();
            ctx.moveTo(Math.round(ch.x) + 0.5, 0);
            ctx.lineTo(Math.round(ch.x) + 0.5, dims.plotHeight);
            ctx.stroke();
            ctx.restore();
        }

        ctx.restore();
    }

    function renderOverlayCanvasNow() {
        overlayRafPending = false;
        renderSinglePaneOverlay('candle_pane', mainPaneEl, overlayCanvas, window.ChartState.mainChart);

        window.ChartState.subPanes.forEach(function (sub) {
            if (sub && sub.containerEl && sub.overlayCanvas && sub.chart) {
                renderSinglePaneOverlay(sub.paneId, sub.containerEl, sub.overlayCanvas, sub.chart);
            }
        });
    }

    function requestOverlayRedraw() {
        if (overlayRafPending) return;
        overlayRafPending = true;
        requestAnimationFrame(renderOverlayCanvasNow);
    }

    window.ChartState.requestOverlayRedraw = requestOverlayRedraw;
    window.ChartState.renderOverlayCanvasNow = renderOverlayCanvasNow;

    /* ----------------------------------------------------------------
     * 5. Multi-Pane Synchronization Engine (TimeScale + Crosshair)
     * ---------------------------------------------------------------- */
    let isSyncingTimeScale = false;
    let isSyncingCrosshair = false;
    let activeCrosshairPaneId = null;
    let hoveredDomPaneId = null;

    mainPaneEl.addEventListener('pointerenter', function () {
        hoveredDomPaneId = 'candle_pane';
    }, { passive: true });
    mainPaneEl.addEventListener('pointermove', function () {
        hoveredDomPaneId = 'candle_pane';
    }, { passive: true });
    rootContainer.addEventListener('pointerleave', function () {
        hoveredDomPaneId = null;
    }, { passive: true });

    function getAllPanes() {
        const list = [];
        if (window.ChartState.mainChart && window.ChartState.candleSeries) {
            list.push({
                paneId: 'candle_pane',
                chart: window.ChartState.mainChart,
                primarySeries: window.ChartState.candleSeries,
                containerEl: mainPaneEl,
                overlayCanvas: overlayCanvas
            });
        }
        window.ChartState.subPanes.forEach(function (sub) {
            if (sub && sub.chart) list.push(sub);
        });
        return list;
    }

    function alignPriceScales() {
        const panes = getAllPanes();
        if (panes.length === 0) return;

        let maxRightWidth = RIGHT_SCALE_MIN_WIDTH;
        for (let i = 0; i < panes.length; i++) {
            try {
                const w = panes[i].chart.priceScale('right').width();
                if (typeof w === 'number' && w > maxRightWidth) {
                    maxRightWidth = Math.ceil(w);
                }
            } catch (e) {}
        }

        for (let j = 0; j < panes.length; j++) {
            try {
                panes[j].chart.applyOptions({
                    rightPriceScale: {
                        minimumWidth: maxRightWidth
                    }
                });
            } catch (e) {}
        }

        const mainChart = window.ChartState.mainChart;
        if (mainChart) {
            try {
                const range = mainChart.timeScale().getVisibleLogicalRange();
                if (range) {
                    syncTimeScaleFrom(mainChart, range);
                }
            } catch (e) {}
        }
    }

    window.ChartState.alignPriceScales = alignPriceScales;

    /**
     * Ensures only the bottom-most visible pane shows the horizontal time axis
     * labels so stacked panes look like a single unified TradingView workspace.
     */
    function updateTimeScaleVisibility() {
        const panes = getAllPanes();
        if (panes.length === 0) return;

        for (let i = 0; i < panes.length; i++) {
            const isLast = (i === panes.length - 1);
            try {
                panes[i].chart.applyOptions({
                    timeScale: {
                        visible: isLast,
                        minBarSpacing: 0.1,
                        timeVisible: isIntradayTimeframe(window.ChartState.currentTimeframe),
                        secondsVisible: false,
                        borderColor: '#e0e3eb',
                        rightOffset: 8
                    }
                });
            } catch (e) {}
        }
        alignPriceScales();
        resizeAllPanes();
    }

    function syncTimeScaleFrom(sourceChart, logicalRange) {
        if (isSyncingTimeScale || !logicalRange) return;
        isSyncingTimeScale = true;
        try {
            const panes = getAllPanes();
            for (let i = 0; i < panes.length; i++) {
                const target = panes[i].chart;
                if (target && target !== sourceChart) {
                    try {
                        target.timeScale().setVisibleLogicalRange(logicalRange);
                    } catch (e) {}
                }
            }
            requestOverlayRedraw();
        } finally {
            isSyncingTimeScale = false;
        }
    }

    /**
     * Resolves a valid finite sample value on `pane.primarySeries` at `barIdx`
     * so `chart.setCrosshairPosition(sampleVal, syncTime, primarySeries)` never
     * receives NaN/undefined even during indicator warmup bars.
     */
    function resolveSampleValueForPane(pane, barIdx) {
        const bars = window.ChartState.currentBars || [];
        if (pane.primarySeries && typeof pane.primarySeries.dataByIndex === 'function' && typeof barIdx === 'number') {
            try {
                const dp = pane.primarySeries.dataByIndex(barIdx, -1) || pane.primarySeries.dataByIndex(barIdx, 1);
                if (dp) {
                    if (typeof dp.value === 'number' && isFinite(dp.value)) return dp.value;
                    if (typeof dp.close === 'number' && isFinite(dp.close)) return dp.close;
                }
            } catch (e) {}
        }
        if (pane.paneId === 'candle_pane' && typeof barIdx === 'number' && bars[barIdx]) {
            return bars[barIdx].close;
        }
        if (typeof pane.getValueAtIndex === 'function' && typeof barIdx === 'number') {
            const v = pane.getValueAtIndex(barIdx);
            if (typeof v === 'number' && isFinite(v)) return v;
        }
        return 0;
    }

    /**
     * Propagates the crosshair position across all chart panes (`candle_pane` and all
     * synced oscillator sub-panes), ensuring that when the user hovers over one pane,
     * the vertical crosshair line appears at the exact same timestamp on all other panes.
     */
    function syncCrosshairFrom(sourcePaneId, param) {
        if (isSyncingCrosshair) return;
        // Ignore asynchronous crosshair events fired by non-hovered panes due to programmatic setCrosshairPosition
        if (hoveredDomPaneId && sourcePaneId !== hoveredDomPaneId) {
            return;
        }
        isSyncingCrosshair = true;
        try {
            const panes = getAllPanes();
            const bars = window.ChartState.currentBars || [];
            const hasValidPoint = !!(
                param &&
                param.point &&
                typeof param.point.x === 'number' &&
                typeof param.point.y === 'number' &&
                param.point.x >= 0 &&
                param.point.y >= 0
            );

            // Prevent a delayed mouseleave on a pane the cursor already exited from clearing the newly entered pane
            if (!hasValidPoint) {
                if ((hoveredDomPaneId && hoveredDomPaneId !== sourcePaneId) ||
                    (activeCrosshairPaneId && activeCrosshairPaneId !== sourcePaneId)) {
                    return;
                }
                activeCrosshairPaneId = null;
                window.ChartState.crosshairState = null;

                for (let i = 0; i < panes.length; i++) {
                    const p = panes[i];
                    if (!p.chart) continue;
                    try {
                        p.chart.applyOptions({
                            crosshair: {
                                vertLine: { visible: true, labelVisible: true },
                                horzLine: { visible: true, labelVisible: true }
                            }
                        });
                        if (p.paneId !== sourcePaneId && typeof p.chart.clearCrosshairPosition === 'function') {
                            p.chart.clearCrosshairPosition();
                        }
                    } catch (e) {}
                }

                const lastIdx = bars.length - 1;
                updateOhlcvHeader(lastIdx);
                const listeners = window.ChartState.crosshairListeners || [];
                for (let j = 0; j < listeners.length; j++) {
                    try {
                        listeners[j]({
                            dataIndex: lastIdx,
                            time: undefined,
                            point: undefined,
                            kLineData: bars[lastIdx] || null
                        });
                    } catch (e) {}
                }
                requestOverlayRedraw();
                return;
            }

            activeCrosshairPaneId = sourcePaneId;

            // Resolve exact timestamp and bar index for the hovered horizontal position
            let syncTime = param.time;
            let barIdx = (syncTime !== undefined) ? window.ChartState.timeToIndex.get(syncTime) : undefined;

            if (syncTime === undefined && typeof param.logical === 'number' && bars.length > 0) {
                const candidateIdx = Math.round(param.logical);
                if (candidateIdx >= 0 && candidateIdx < bars.length) {
                    barIdx = candidateIdx;
                    syncTime = bars[candidateIdx].time;
                } else if (candidateIdx >= bars.length) {
                    const futIdx = candidateIdx - bars.length;
                    const future = window.ChartState.futureWhitespace || [];
                    if (futIdx >= 0 && futIdx < future.length) {
                        barIdx = candidateIdx;
                        syncTime = future[futIdx].time;
                    }
                }
            }

            const clampedSampleIdx = (barIdx !== undefined && bars.length > 0)
                ? Math.max(0, Math.min(bars.length - 1, barIdx))
                : Math.max(0, bars.length - 1);

            window.ChartState.crosshairState = {
                active:       true,
                sourcePaneId: sourcePaneId,
                time:         syncTime,
                logical:      param.logical,
                x:            param.point.x,
                y:            param.point.y,
                dataIndex:    clampedSampleIdx
            };

            for (let i = 0; i < panes.length; i++) {
                const p = panes[i];
                if (!p.chart) continue;
                const isSource = (p.paneId === sourcePaneId);

                try {
                    // Show both vertical and horizontal crosshair lines on the hovered pane,
                    // and show ONLY the vertical crosshair line on all other synced panes.
                    p.chart.applyOptions({
                        crosshair: {
                            vertLine: { visible: true, labelVisible: true },
                            horzLine: { visible: isSource, labelVisible: isSource }
                        }
                    });

                    if (!isSource) {
                        if (syncTime !== undefined && p.primarySeries && typeof p.chart.setCrosshairPosition === 'function') {
                            const sampleVal = resolveSampleValueForPane(p, clampedSampleIdx);
                            p.chart.setCrosshairPosition(sampleVal, syncTime, p.primarySeries);
                        } else if (typeof p.chart.clearCrosshairPosition === 'function') {
                            p.chart.clearCrosshairPosition();
                        }
                    }
                } catch (e) {}
            }

            let activeIdx = bars.length - 1;
            if (barIdx !== undefined) {
                activeIdx = clampedSampleIdx;
            } else if (typeof param.logical === 'number') {
                const candidate = Math.round(param.logical);
                if (candidate >= 0 && candidate < bars.length) {
                    activeIdx = candidate;
                }
            }

            updateOhlcvHeader(activeIdx);

            const listeners = window.ChartState.crosshairListeners || [];
            for (let j = 0; j < listeners.length; j++) {
                try {
                    listeners[j]({
                        dataIndex: activeIdx,
                        time: syncTime,
                        point: param.point,
                        kLineData: bars[activeIdx] || null
                    });
                } catch (e) {}
            }

            requestOverlayRedraw();
        } finally {
            isSyncingCrosshair = false;
        }
    }

    function buildCommonChartOptions(width, height, showTimeScale) {
        return {
            width: Math.max(100, width || 800),
            height: Math.max(60, height || 400),
            layout: {
                background: { type: 'solid', color: '#ffffff' },
                textColor: '#363a45',
                fontFamily: CHART_FONT,
                fontSize: 11,
                attributionLogo: false
            },
            grid: {
                vertLines: { color: '#f0f3fa', style: 0, visible: true },
                horzLines: { color: '#f0f3fa', style: 0, visible: true }
            },
            crosshair: {
                mode: (LightweightCharts.CrosshairMode && LightweightCharts.CrosshairMode.Normal !== undefined)
                    ? LightweightCharts.CrosshairMode.Normal
                    : 0,
                vertLine: {
                    color: '#2962ff',
                    width: 1,
                    style: 2,
                    visible: true,
                    labelVisible: true,
                    labelBackgroundColor: '#2962ff'
                },
                horzLine: {
                    color: '#2962ff',
                    width: 1,
                    style: 2,
                    visible: true,
                    labelVisible: true,
                    labelBackgroundColor: '#2962ff'
                }
            },
            rightPriceScale: {
                visible: true,
                borderColor: '#e0e3eb',
                minimumWidth: RIGHT_SCALE_MIN_WIDTH,
                scaleMargins: { top: 0.08, bottom: 0.08 }
            },
            leftPriceScale: {
                visible: false
            },
            timeScale: {
                visible: showTimeScale !== false,
                borderColor: '#e0e3eb',
                rightOffset: 8,
                barSpacing: 10,
                minBarSpacing: 0.1,
                timeVisible: isIntradayTimeframe(window.ChartState.currentTimeframe),
                secondsVisible: false
            },
            handleScroll: {
                mouseWheel: true,
                pressedMouseMove: true,
                horzTouchDrag: true,
                vertTouchDrag: true
            },
            handleScale: {
                axisPressedMouseMove: { time: true, price: true },
                axisDoubleClickReset: { time: true, price: true },
                mouseWheel: true,
                pinch: true
            }
        };
    }

    function registerSubPane(paneId, config) {
        if (window.ChartState.subPanes.has(paneId)) {
            unregisterSubPane(paneId);
        }

        const initialHeight = (config && config.height) || 135;
        const paneEl = document.createElement('div');
        paneEl.className = 'tv-subpane';
        paneEl.dataset.paneId = paneId;
        paneEl.style.height = initialHeight + 'px';

        // Splitter handle to allow dragging subpane height
        const resizerEl = document.createElement('div');
        resizerEl.className = 'tv-subpane-resizer';
        paneEl.appendChild(resizerEl);

        const mountEl = document.createElement('div');
        mountEl.className = 'tv-chart-mount';
        paneEl.appendChild(mountEl);

        // Dedicated high-DPI overlay canvas for drawings on this oscillator sub-pane
        const subOverlayCanvas = document.createElement('canvas');
        subOverlayCanvas.className = 'tv-overlay-canvas';
        subOverlayCanvas.dataset.paneId = paneId;
        paneEl.appendChild(subOverlayCanvas);

        subPanesContainer.appendChild(paneEl);

        const rect = paneEl.getBoundingClientRect();
        const subChart = LightweightCharts.createChart(
            mountEl,
            buildCommonChartOptions(rect.width || mainPaneEl.clientWidth || 800, initialHeight, true)
        );

        const descriptor = {
            paneId: paneId,
            chart: subChart,
            primarySeries: null,
            containerEl: paneEl,
            container: paneEl,
            mountEl: mountEl,
            overlayCanvas: subOverlayCanvas,
            height: initialHeight,
            getValueAtIndex: (config && config.getValueAtIndex) || null
        };

        window.ChartState.subPanes.set(paneId, descriptor);

        // Track DOM hover pane so crosshair sync knows this sub-pane is the active user-hovered pane
        paneEl.addEventListener('pointerenter', function () {
            hoveredDomPaneId = paneId;
        }, { passive: true });
        paneEl.addEventListener('pointermove', function (e) {
            hoveredDomPaneId = paneId;
            if (e.buttons !== 0) requestOverlayRedraw();
        }, { passive: true });

        // Wire synchronization listeners
        subChart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
            syncTimeScaleFrom(subChart, range);
        });

        subChart.subscribeCrosshairMove(function (param) {
            syncCrosshairFrom(paneId, param);
        });

        // Redraw sub-pane overlay canvas when user drags oscillator price axis or zooms
        paneEl.addEventListener('wheel', requestOverlayRedraw, { passive: true });

        // Wire interactive vertical splitter resize
        wireSubPaneResizer(resizerEl, descriptor);

        // Sync initial visible logical range from mainChart
        try {
            const mainRange = window.ChartState.mainChart &&
                window.ChartState.mainChart.timeScale().getVisibleLogicalRange();
            if (mainRange) {
                subChart.timeScale().setVisibleLogicalRange(mainRange);
            }
        } catch (e) {}

        updateTimeScaleVisibility();
        return descriptor;
    }

    function unregisterSubPane(paneId) {
        const sub = window.ChartState.subPanes.get(paneId);
        if (!sub) return;
        window.ChartState.subPanes.delete(paneId);
        try {
            if (sub.chart && typeof sub.chart.remove === 'function') {
                sub.chart.remove();
            }
        } catch (e) {}
        try {
            if (sub.containerEl && sub.containerEl.parentNode) {
                sub.containerEl.parentNode.removeChild(sub.containerEl);
            }
        } catch (e) {}
        updateTimeScaleVisibility();
    }

    function wireSubPaneResizer(resizerEl, descriptor) {
        let startY = 0;
        let startH = descriptor.height;

        function onMouseMove(e) {
            const deltaY = startY - e.clientY;
            const nextH = Math.max(80, Math.min(340, startH + deltaY));
            descriptor.height = nextH;
            descriptor.containerEl.style.height = nextH + 'px';
            resizeAllPanes();
        }

        function onMouseUp() {
            resizerEl.classList.remove('dragging');
            window.removeEventListener('mousemove', onMouseMove);
            window.removeEventListener('mouseup', onMouseUp);
        }

        resizerEl.addEventListener('mousedown', function (e) {
            e.preventDefault();
            startY = e.clientY;
            startH = descriptor.containerEl.getBoundingClientRect().height || descriptor.height;
            resizerEl.classList.add('dragging');
            window.addEventListener('mousemove', onMouseMove);
            window.addEventListener('mouseup', onMouseUp);
        });
    }

    window.ChartState.registerSubPane = registerSubPane;
    window.ChartState.unregisterSubPane = unregisterSubPane;

    function resizeAllPanes() {
        try {
            const mainRect = mainPaneEl.getBoundingClientRect();
            if (window.ChartState.mainChart && mainRect.width > 0 && mainRect.height > 0) {
                window.ChartState.mainChart.applyOptions({
                    width: Math.floor(mainRect.width),
                    height: Math.floor(mainRect.height)
                });
            }
            window.ChartState.subPanes.forEach(function (sub) {
                if (!sub || !sub.chart || !sub.containerEl) return;
                const r = sub.containerEl.getBoundingClientRect();
                if (r.width > 0 && r.height > 0) {
                    sub.chart.applyOptions({
                        width: Math.floor(r.width),
                        height: Math.floor(r.height)
                    });
                }
            });
            requestOverlayRedraw();
            if (typeof window._syncIndicatorButtons === 'function') {
                window._syncIndicatorButtons();
            }
        } catch (e) {}
    }

    window.ChartState.resizeAllPanes = resizeAllPanes;

    /* ----------------------------------------------------------------
     * 6. Data Fetching, Normalization & Caching
     * ---------------------------------------------------------------- */
    let barsFetchId   = 0;
    let barsAbortCtrl = null;
    const responseCache = new Map();
    const CACHE_TTL_MS  = 30000;

    function cacheKey(asset, tf) {
        return asset + '|' + tf;
    }
    function cacheGet(key) {
        const entry = responseCache.get(key);
        if (!entry) return null;
        if (Date.now() - entry.ts > CACHE_TTL_MS) {
            responseCache.delete(key);
            return null;
        }
        return entry.data;
    }
    function cacheSet(key, data) {
        responseCache.set(key, { data: data, ts: Date.now() });
    }

    function isIntradayTimeframe(tf) {
        const norm = String(tf || '').toLowerCase();
        return norm !== '1d' && norm !== 'd' && norm !== 'w' && norm !== 'm' && norm !== 'y';
    }

    function normalizeBackendTimeframe(tf) {
        if (tf === 'D') return '1d';
        if (tf === '1H') return '1h';
        if (tf === '4H') return '4h';
        return tf;
    }

    /**
     * Normalizes raw `/data/{asset}/{timeframe}` records into strictly
     * ascending, deduplicated bars with both:
     *   - `time`: Unix timestamp in seconds (UTCTimestamp for LightweightCharts)
     *   - `timestamp`: Unix timestamp in milliseconds (for SMC & drawtools)
     */
    function normalizeBars(rawList) {
        if (!Array.isArray(rawList) || rawList.length === 0) return [];
        const parsed = [];
        for (let i = 0; i < rawList.length; i++) {
            const d = rawList[i];
            if (!d) continue;
            const rawTime = Number(d.time);
            if (!isFinite(rawTime) || rawTime <= 0) continue;

            // Auto-detect seconds vs milliseconds
            const timeSec = rawTime > 1e11 ? Math.floor(rawTime / 1000) : Math.floor(rawTime);
            const open  = parseFloat(d.open);
            const high  = parseFloat(d.high);
            const low   = parseFloat(d.low);
            const close = parseFloat(d.close);
            const vol   = d.volume != null ? parseFloat(d.volume) : 0;

            if (isNaN(open) || isNaN(high) || isNaN(low) || isNaN(close)) continue;
            if (open <= 0 || high <= 0 || low <= 0 || close <= 0) continue;

            parsed.push({
                time:      timeSec,
                timestamp: timeSec * 1000,
                timeStr:   d.timeStr || '',
                open:      open,
                high:      Math.max(high, open, close),
                low:       Math.min(low, open, close),
                close:     close,
                volume:    isNaN(vol) ? 0 : vol
            });
        }

        parsed.sort(function (a, b) { return a.time - b.time; });

        // Deduplicate identical timestamps (keep latest record)
        const deduped = [];
        for (let j = 0; j < parsed.length; j++) {
            const b = parsed[j];
            if (deduped.length > 0 && deduped[deduped.length - 1].time === b.time) {
                deduped[deduped.length - 1] = b;
            } else {
                deduped.push(b);
            }
        }
        return deduped;
    }

    function updateBarsLookup(bars) {
        const map = new Map();
        for (let i = 0; i < bars.length; i++) {
            map.set(bars[i].time, i);
        }

        if (bars.length >= 2) {
            const sampleCount = Math.min(bars.length - 1, 50);
            let diffs = [];
            for (let k = bars.length - sampleCount; k < bars.length; k++) {
                const diff = bars[k].timestamp - bars[k - 1].timestamp;
                if (diff > 0) diffs.push(diff);
            }
            if (diffs.length > 0) {
                diffs.sort(function (a, b) { return a - b; });
                window.ChartState.avgBarIntervalMs = diffs[Math.floor(diffs.length / 2)];
            }
        }

        // Forward-feed 1 month (~31 days) of future dates as visual whitespace points
        const future = [];
        if (bars.length > 0) {
            const lastBar = bars[bars.length - 1];
            const intervalSec = Math.max(60, Math.round((window.ChartState.avgBarIntervalMs || 86400000) / 1000));
            const oneMonthSec = 31 * 86400; // 1 month in seconds
            const futureCount = Math.min(1500, Math.max(30, Math.ceil(oneMonthSec / intervalSec)));
            for (let f = 1; f <= futureCount; f++) {
                const futSec = lastBar.time + f * intervalSec;
                future.push({ time: futSec });
                map.set(futSec, (bars.length - 1) + f);
            }
        }

        window.ChartState.timeToIndex = map;
        window.ChartState.futureWhitespace = future;
    }

    function applyBarsToChart(bars, preserveViewport) {
        const mainChart = window.ChartState.mainChart;
        const candleSeries = window.ChartState.candleSeries;
        const volumeSeries = window.ChartState.volumeSeries;
        if (!mainChart || !candleSeries) return;

        let savedLogicalRange = null;
        if (preserveViewport) {
            try {
                savedLogicalRange = mainChart.timeScale().getVisibleLogicalRange();
            } catch (e) {}
        }

        window.ChartState.currentBars = bars;
        updateBarsLookup(bars);
        const future = window.ChartState.futureWhitespace || [];

        try {
            candleSeries.setData(future.length > 0 ? bars.concat(future) : bars);
        } catch (err) {
            console.error('[chart.js] candleSeries.setData failed:', err);
        }

        // Populate main-pane bottom volume histogram overlay with 1:1 bar time alignment
        if (volumeSeries) {
            try {
                const volumeData = new Array(bars.length);
                for (let i = 0; i < bars.length; i++) {
                    const b = bars[i];
                    const isUp = b.close >= b.open;
                    volumeData[i] = {
                        time: b.time,
                        value: (typeof b.volume === 'number' && isFinite(b.volume)) ? b.volume : 0,
                        color: isUp ? 'rgba(38, 166, 154, 0.35)' : 'rgba(239, 83, 80, 0.35)'
                    };
                }
                volumeSeries.setData(future.length > 0 ? volumeData.concat(future) : volumeData);
            } catch (err) {
                console.error('[chart.js] volumeSeries.setData failed:', err);
            }
        }

        // Populate indicator sub-panes & overlays first so their series have the exact same bar count
        fireBarsLoaded();

        if (bars.length === 0) {
            showBanner('No historical bars available for this asset and timeframe.');
        } else {
            showBanner('');
            if (preserveViewport && savedLogicalRange) {
                try {
                    mainChart.timeScale().setVisibleLogicalRange(savedLogicalRange);
                    syncTimeScaleFrom(mainChart, savedLogicalRange);
                } catch (e) {}
            } else {
                resetScaleAndVisualizeCandles();
            }
        }

        updateOhlcvHeader(bars.length - 1);
        alignPriceScales();
        requestAnimationFrame(function () {
            alignPriceScales();
            if (!preserveViewport) {
                resetScaleAndVisualizeCandles();
            }
            requestOverlayRedraw();
        });
        if (!preserveViewport) {
            setTimeout(function () {
                resetScaleAndVisualizeCandles();
            }, 60);
        }
    }

    function loadBars(opts) {
        const preserveViewport = !!(opts && opts.preserveViewport);
        const bypassCache = !!(opts && opts.bypassCache);
        const myId = ++barsFetchId;

        if (barsAbortCtrl) {
            try { barsAbortCtrl.abort(); } catch (e) {}
        }
        barsAbortCtrl = new AbortController();

        const asset = window.ChartState.currentAsset;
        const rawTf = window.ChartState.currentTimeframe;
        const tf    = normalizeBackendTimeframe(rawTf);

        const key = cacheKey(asset, tf);
        if (!bypassCache) {
            const cached = cacheGet(key);
            if (cached) {
                window.ChartState.extraData = cached.extraData || {};
                applyBarsToChart(cached.bars, preserveViewport);
                return;
            }
        }

        if (!preserveViewport && window.ChartState.currentBars.length === 0) {
            showBanner('Loading market data…');
        }

        const url = '/data/' + encodeURIComponent(asset) + '/' + encodeURIComponent(tf) + '?limit=10000';
        fetch(url, { signal: barsAbortCtrl.signal })
            .then(function (res) {
                if (!res.ok) throw new Error('HTTP ' + res.status);
                return res.json();
            })
            .then(function (response) {
                if (myId !== barsFetchId) return;
                const bars = normalizeBars(response.chart_data || []);
                const extraData = response.extra_data || {};
                window.ChartState.extraData = extraData;
                cacheSet(key, { bars: bars, extraData: extraData });
                applyBarsToChart(bars, preserveViewport);
            })
            .catch(function (err) {
                if (err && err.name === 'AbortError') return;
                if (myId !== barsFetchId) return;
                console.error('[chart.js] Failed to fetch bars:', err);
                showBanner('Error loading market data (' + (err.message || 'Network error') + ')');
                applyBarsToChart([], false);
            });
    }

    function fireBarsLoaded() {
        const handlers = (window.ChartState.barsLoadedHandlers || []).slice();
        for (let i = 0; i < handlers.length; i++) {
            try { handlers[i](); } catch (e) { console.error(e); }
        }
    }

    /* ----------------------------------------------------------------
     * 7. Live OHLCV Header Formatting
     * ---------------------------------------------------------------- */
    function formatPriceNumber(n) {
        if (typeof n !== 'number' || isNaN(n)) return '—';
        if (Math.abs(n) >= 1000) return n.toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
        if (Math.abs(n) >= 1)    return n.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        return n.toFixed(4);
    }

    function formatVolNumber(v) {
        if (typeof v !== 'number' || isNaN(v)) return '—';
        if (v >= 1e9) return (v / 1e9).toFixed(2) + 'B';
        if (v >= 1e6) return (v / 1e6).toFixed(2) + 'M';
        if (v >= 1e3) return (v / 1e3).toFixed(1) + 'K';
        return String(Math.round(v));
    }

    function updateOhlcvHeader(dataIndex) {
        const symEl = document.getElementById('ohlcvSymbol');
        const tfEl  = document.getElementById('ohlcvTf');
        if (symEl) symEl.textContent = getAssetLabel(window.ChartState.currentAsset);
        if (tfEl)  tfEl.textContent  = String(window.ChartState.currentTimeframe || '').toUpperCase();

        const bars = window.ChartState.currentBars || [];
        if (bars.length === 0) return;

        const idx = (typeof dataIndex === 'number' && dataIndex >= 0 && dataIndex < bars.length)
            ? dataIndex
            : bars.length - 1;
        const bar = bars[idx];
        if (!bar) return;

        const prevBar = idx > 0 ? bars[idx - 1] : bar;
        const isUp = bar.close >= bar.open;
        const chg = bar.close - prevBar.close;
        const chgPct = prevBar.close !== 0 ? (chg / prevBar.close) * 100 : 0;
        const dirClass = isUp ? 'v up' : 'v down';

        const oEl   = document.getElementById('ohlcvO');
        const hEl   = document.getElementById('ohlcvH');
        const lEl   = document.getElementById('ohlcvL');
        const cEl   = document.getElementById('ohlcvC');
        const chgEl = document.getElementById('ohlcvChg');
        const volEl = document.getElementById('ohlcvVol');

        if (oEl)   { oEl.textContent = formatPriceNumber(bar.open);  oEl.className = dirClass; }
        if (hEl)   { hEl.textContent = formatPriceNumber(bar.high);  hEl.className = dirClass; }
        if (lEl)   { lEl.textContent = formatPriceNumber(bar.low);   lEl.className = dirClass; }
        if (cEl)   { cEl.textContent = formatPriceNumber(bar.close); cEl.className = dirClass; }
        if (chgEl) {
            const sign = chg >= 0 ? '+' : '';
            chgEl.textContent = sign + formatPriceNumber(chg) + ' (' + sign + chgPct.toFixed(2) + '%)';
            chgEl.className = chg >= 0 ? 'v up' : 'v down';
        }
        if (volEl) {
            volEl.textContent = formatVolNumber(bar.volume);
        }
    }

    /* ----------------------------------------------------------------
     * 8. Main Chart Initialization & Lifecycle
     * ---------------------------------------------------------------- */
    function createMainChart() {
        try {
            if (window.ChartState.mainChart && typeof window.ChartState.mainChart.remove === 'function') {
                window.ChartState.mainChart.remove();
            }
        } catch (e) {}

        mainMountEl.innerHTML = '';
        const rect = mainPaneEl.getBoundingClientRect();
        const initW = Math.max(300, Math.floor(rect.width) || 960);
        const initH = Math.max(220, Math.floor(rect.height) || 540);

        let mainChart;
        try {
            mainChart = LightweightCharts.createChart(
                mainMountEl,
                buildCommonChartOptions(initW, initH, window.ChartState.subPanes.size === 0)
            );
        } catch (err) {
            console.error('[chart.js] Error initializing LightweightCharts:', err);
            showBanner('Chart initialization failed: ' + err.message);
            return null;
        }

        const candleSeries = createSeries(mainChart, 'Candlestick', {
            upColor:         '#26a69a',
            downColor:       '#ef5350',
            borderVisible:   true,
            borderUpColor:   '#26a69a',
            borderDownColor: '#ef5350',
            wickUpColor:     '#26a69a',
            wickDownColor:   '#ef5350',
            priceFormat: {
                type: 'price',
                precision: 2,
                minMove: 0.01
            }
        });

        // Volume Histogram overlay at the bottom of the main candlestick pane
        const volumeSeries = createSeries(mainChart, 'Histogram', {
            priceFormat: {
                type: 'volume'
            },
            priceScaleId:     'volume_overlay',
            lastValueVisible: false,
            priceLineVisible: false
        });

        if (volumeSeries) {
            try {
                volumeSeries.priceScale().applyOptions({
                    scaleMargins: {
                        top: 0.80,
                        bottom: 0
                    }
                });
            } catch (e) {}
        }

        // Apply saved scale mode (Normal = 0, Logarithmic = 1) and reserve bottom margin for volume overlay
        try {
            mainChart.priceScale('right').applyOptions({
                mode: window.ChartState.isLogScale ? 1 : 0,
                autoScale: window.ChartState.isAutoScale,
                scaleMargins: {
                    top: 0.08,
                    bottom: 0.22
                }
            });
        } catch (e) {}

        // Subscribe time scale logical range & visible time range for multi-pane sync and overlay canvas redraw
        mainChart.timeScale().subscribeVisibleLogicalRangeChange(function (range) {
            syncTimeScaleFrom(mainChart, range);
            requestOverlayRedraw();
        });

        if (typeof mainChart.timeScale().subscribeSizeChange === 'function') {
            mainChart.timeScale().subscribeSizeChange(function () {
                requestOverlayRedraw();
            });
        }

        mainChart.subscribeCrosshairMove(function (param) {
            syncCrosshairFrom('candle_pane', param);
        });

        // Redraw overlay canvas during vertical price-scale drag or wheel zoom on main pane
        mainPaneEl.addEventListener('wheel', requestOverlayRedraw, { passive: true });
        mainPaneEl.addEventListener('pointermove', function (e) {
            if (e.buttons !== 0) requestOverlayRedraw();
        }, { passive: true });

        window.ChartState.chart = mainChart;
        window.ChartState.mainChart = mainChart;
        window.ChartState.candleSeries = candleSeries;
        window.ChartState.volumeSeries = volumeSeries;

        window.dispatchEvent(new CustomEvent('chartStateReady', { detail: mainChart }));

        loadBars({ preserveViewport: false, bypassCache: false });
        return mainChart;
    }

    /* ----------------------------------------------------------------
     * 9. Scale & View Control Helpers
     * ---------------------------------------------------------------- */
    function setLogScale(enabled) {
        window.ChartState.isLogScale = !!enabled;
        const mainChart = window.ChartState.mainChart;
        if (mainChart) {
            try {
                // LightweightCharts PriceScaleMode: 0 = Normal (Linear), 1 = Logarithmic
                mainChart.priceScale('right').applyOptions({
                    mode: window.ChartState.isLogScale ? 1 : 0
                });
            } catch (err) {
                console.warn('[chart.js] Failed to toggle price scale mode:', err);
            }
        }
        const btnLogScale = document.getElementById('btnLogScale');
        if (btnLogScale) {
            btnLogScale.classList.toggle('active', window.ChartState.isLogScale);
        }
        requestOverlayRedraw();
    }

    function setAutoScale(enabled) {
        window.ChartState.isAutoScale = !!enabled;
        const mainChart = window.ChartState.mainChart;
        if (mainChart) {
            try {
                if (window.ChartState.isAutoScale) {
                    mainChart.priceScale('right').applyOptions({ autoScale: false });
                    mainChart.priceScale('right').applyOptions({
                        autoScale: true,
                        scaleMargins: { top: 0.08, bottom: 0.22 }
                    });
                } else {
                    mainChart.priceScale('right').applyOptions({
                        autoScale: false
                    });
                }
            } catch (e) {}
        }
        const btnAuto = document.getElementById('btnAutoScale');
        if (btnAuto) {
            btnAuto.classList.toggle('active', window.ChartState.isAutoScale);
        }
        requestOverlayRedraw();
    }

    function resetScaleAndVisualizeCandles() {
        const mainChart = window.ChartState.mainChart;
        const bars = window.ChartState.currentBars || [];
        if (!mainChart || bars.length === 0) return;

        // Force Auto Scale state and UI button active
        window.ChartState.isAutoScale = true;
        const btnAuto = document.getElementById('btnAutoScale');
        if (btnAuto) {
            btnAuto.classList.add('active');
        }

        try {
            // Toggling autoScale false then true forces LightweightCharts to clear
            // any manual price drag / locked min-max price bounds and re-autoscale to the current data
            mainChart.priceScale('right').applyOptions({
                autoScale: false
            });
            mainChart.priceScale('right').applyOptions({
                autoScale: true,
                scaleMargins: {
                    top: 0.08,
                    bottom: 0.22
                }
            });
        } catch (e) {}

        // Reset autoScale on all oscillator sub-panes
        try {
            window.ChartState.subPanes.forEach(function (sub) {
                if (sub && sub.chart) {
                    try {
                        sub.chart.priceScale('right').applyOptions({ autoScale: false });
                        sub.chart.priceScale('right').applyOptions({ autoScale: true });
                    } catch (err) {}
                }
            });
        } catch (e) {}

        // Reset visible logical range so candles are optimally centered and visualized
        try {
            const visibleBars = Math.min(bars.length, 140);
            const future = window.ChartState.futureWhitespace || [];
            const futurePad = Math.min(future.length, 31);
            const targetRange = {
                from: Math.max(0, bars.length - visibleBars),
                to: (bars.length - 1) + Math.max(4, futurePad)
            };
            mainChart.timeScale().setVisibleLogicalRange(targetRange);
            syncTimeScaleFrom(mainChart, targetRange);
        } catch (e) {}

        alignPriceScales();
        requestOverlayRedraw();
    }

    function resetChartView() {
        resetScaleAndVisualizeCandles();
    }

    window.ChartState.setLogScale = setLogScale;
    window.ChartState.setAutoScale = setAutoScale;
    window.ChartState.resetChartView = resetChartView;
    window.ChartState.resetScaleAndVisualizeCandles = resetScaleAndVisualizeCandles;

    window.ChartState.reloadData = function (preserveViewport) {
        loadBars({
            preserveViewport: preserveViewport !== false,
            bypassCache: true
        });
    };

    /* ----------------------------------------------------------------
     * 10. UI Wiring (Symbol Search, Timeframes, Scale Toggles, Menus)
     * ---------------------------------------------------------------- */
    function pushUrlState() {
        try {
            const u = new URL(window.location);
            u.searchParams.set('asset', window.ChartState.currentAsset);
            u.searchParams.set('timeframe', window.ChartState.currentTimeframe);
            window.history.pushState({}, '', u);
        } catch (e) {}
    }

    function getAssetLabel(value) {
        const list = window.APP_ASSETS || [];
        const found = list.find(function (a) { return a.value === value; });
        return found ? found.label : value;
    }

    function updateSymbolButton() {
        const btn = document.getElementById('currentSymbol');
        const avatar = document.getElementById('symbolAvatar');
        const label = getAssetLabel(window.ChartState.currentAsset);
        if (btn) btn.textContent = label;
        if (avatar) avatar.textContent = (label || '?').charAt(0).toUpperCase();
    }

    function updatePeriodSelection() {
        const bar = document.getElementById('periodBar');
        if (!bar) return;
        const tf = window.ChartState.currentTimeframe;
        bar.querySelectorAll('.tv-period').forEach(function (el) {
            const isMatch = el.dataset.tf === tf ||
                (tf === '1d' && el.dataset.tf === 'D') ||
                (tf === 'D'  && el.dataset.tf === '1d') ||
                (tf === '1h' && el.dataset.tf === '1H') ||
                (tf === '4h' && el.dataset.tf === '4H');
            el.classList.toggle('selected', isMatch);
        });
    }

    function applySelection(asset, timeframe, opts) {
        const nextAsset = asset || window.ChartState.currentAsset;
        const nextTf    = normalizeBackendTimeframe(timeframe || window.ChartState.currentTimeframe);

        const assetChanged     = nextAsset !== window.ChartState.currentAsset;
        const timeframeChanged = nextTf    !== window.ChartState.currentTimeframe;

        window.ChartState.currentAsset     = nextAsset;
        window.ChartState.currentTimeframe = nextTf;

        updateSymbolButton();
        updatePeriodSelection();
        updateTimeScaleVisibility();

        if (assetChanged) {
            window.ChartState.isAutoScale = true;
            const btnAuto = document.getElementById('btnAutoScale');
            if (btnAuto) btnAuto.classList.add('active');
        }

        if (assetChanged || timeframeChanged || (opts && opts.forceReload)) {
            loadBars({ preserveViewport: false, bypassCache: false });
        }

        pushUrlState();
    }

    window.ChartState.applySelection = applySelection;

    function wirePeriodBar() {
        const bar = document.getElementById('periodBar');
        if (!bar || bar.__wired) return;
        bar.__wired = true;

        bar.addEventListener('click', function (e) {
            const target = e.target.closest('.tv-period');
            if (!target) return;
            const tf = normalizeBackendTimeframe(target.dataset.tf);
            if (!tf || tf === window.ChartState.currentTimeframe) return;
            applySelection(window.ChartState.currentAsset, tf, { forceReload: false });
        });
    }

    function wireSymbolSearch() {
        const btn      = document.getElementById('symbolBtn');
        const overlay  = document.getElementById('symbolSearchOverlay');
        const closeBtn = document.getElementById('closeSymbolSearch');
        const input    = document.getElementById('symbolSearchInput');
        const list     = document.getElementById('symbolList');
        if (!btn || !overlay || !input || !list) return;
        if (overlay.__wired) return;
        overlay.__wired = true;

        let highlightedIndex = 0;
        let filtered = [];

        function renderList() {
            const q = input.value.trim().toLowerCase();
            const all = window.APP_ASSETS || [];
            filtered = !q ? all.slice() : all.filter(function (a) {
                return a.value.toLowerCase().includes(q) || a.label.toLowerCase().includes(q);
            });

            if (filtered.length === 0) {
                list.innerHTML = '<div class="symbol-empty">No symbols match your search.</div>';
                highlightedIndex = -1;
                return;
            }

            if (highlightedIndex < 0 || highlightedIndex >= filtered.length) {
                highlightedIndex = 0;
            }

            list.innerHTML = filtered.map(function (a, i) {
                const initial = (a.label || a.value || '?').charAt(0).toUpperCase();
                return (
                    '<li data-value="' + a.value + '" class="' + (i === highlightedIndex ? 'highlighted' : '') + '">' +
                        '<div class="row-left">' +
                            '<span class="symbol-avatar">' + initial + '</span>' +
                            '<div class="sym-text">' +
                                '<span class="code">' + a.label + '</span>' +
                                '<span class="name">' + a.value + '</span>' +
                            '</div>' +
                        '</div>' +
                        '<span class="market">Market</span>' +
                    '</li>'
                );
            }).join('');
        }

        function openModal() {
            overlay.classList.add('open');
            input.value = '';
            highlightedIndex = 0;
            renderList();
            setTimeout(function () { input.focus(); }, 30);
        }

        function closeModal() {
            overlay.classList.remove('open');
        }

        btn.addEventListener('click', openModal);
        if (closeBtn) closeBtn.addEventListener('click', closeModal);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) closeModal();
        });

        input.addEventListener('input', function () {
            highlightedIndex = 0;
            renderList();
        });

        input.addEventListener('keydown', function (e) {
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                if (filtered.length === 0) return;
                highlightedIndex = (highlightedIndex + 1) % filtered.length;
                renderList();
            } else if (e.key === 'ArrowUp') {
                e.preventDefault();
                if (filtered.length === 0) return;
                highlightedIndex = (highlightedIndex - 1 + filtered.length) % filtered.length;
                renderList();
            } else if (e.key === 'Enter') {
                e.preventDefault();
                if (filtered.length === 0 || highlightedIndex < 0) return;
                const chosen = filtered[highlightedIndex];
                closeModal();
                if (chosen.value === window.ChartState.currentAsset) {
                    resetScaleAndVisualizeCandles();
                    return;
                }
                applySelection(chosen.value, window.ChartState.currentTimeframe, { forceReload: true });
            } else if (e.key === 'Escape') {
                closeModal();
            }
        });

        list.addEventListener('click', function (e) {
            const li = e.target.closest('li[data-value]');
            if (!li) return;
            const value = li.dataset.value;
            closeModal();
            if (value === window.ChartState.currentAsset) {
                resetScaleAndVisualizeCandles();
                return;
            }
            applySelection(value, window.ChartState.currentTimeframe, { forceReload: true });
        });

        // Quick-open Symbol Search with '/' key when not typing in an input
        window.addEventListener('keydown', function (e) {
            if (e.key === '/' && !e.ctrlKey && !e.metaKey && !e.altKey) {
                const tag = (document.activeElement && document.activeElement.tagName) || '';
                if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
                e.preventDefault();
                openModal();
            }
        });
    }

    function wireScaleButtons() {
        const btnLogScale = document.getElementById('btnLogScale');
        if (btnLogScale && !btnLogScale.__wired) {
            btnLogScale.__wired = true;
            btnLogScale.addEventListener('click', function () {
                setLogScale(!window.ChartState.isLogScale);
            });
        }

        const btnAutoScale = document.getElementById('btnAutoScale');
        if (btnAutoScale && !btnAutoScale.__wired) {
            btnAutoScale.__wired = true;
            btnAutoScale.addEventListener('click', function () {
                setAutoScale(!window.ChartState.isAutoScale);
            });
        }

        const btnResetChart = document.getElementById('btnResetChart');
        if (btnResetChart && !btnResetChart.__wired) {
            btnResetChart.__wired = true;
            btnResetChart.addEventListener('click', function () {
                resetChartView();
            });
        }

        window.addEventListener('keydown', function (e) {
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;
            if (e.altKey && (e.key === 'r' || e.key === 'R')) {
                e.preventDefault();
                resetChartView();
            }
        });
    }

    function wireAnalysisMenu() {
        const wrap = document.getElementById('analysisMenuWrap');
        const btn  = document.getElementById('analysisMenuBtn');
        const menu = document.getElementById('analysisMenu');
        if (!wrap || !btn || !menu || wrap.__wired) return;
        wrap.__wired = true;

        function open() {
            menu.classList.add('open');
            btn.classList.add('open');
            document.addEventListener('mousedown', onDocMouseDown, true);
            document.addEventListener('keydown', onEsc, true);
        }
        function close() {
            if (!menu.classList.contains('open')) return;
            menu.classList.remove('open');
            btn.classList.remove('open');
            document.removeEventListener('mousedown', onDocMouseDown, true);
            document.removeEventListener('keydown', onEsc, true);
        }
        function toggle() {
            if (menu.classList.contains('open')) close();
            else open();
        }
        function onDocMouseDown(e) {
            if (!wrap.contains(e.target)) close();
        }
        function onEsc(e) {
            if (e.key === 'Escape') close();
        }

        btn.addEventListener('click', function (e) {
            e.stopPropagation();
            toggle();
        });

        menu.querySelectorAll('[data-href]').forEach(function (item) {
            item.addEventListener('click', function (e) {
                e.stopPropagation();
                const href = item.getAttribute('data-href');
                close();
                if (href) window.location.href = href;
            });
        });
    }

    /* ----------------------------------------------------------------
     * 11. Persistent WebSocket Stream (/ws)
     *     Survives chart re-renders, visibility changes & network drops.
     * ---------------------------------------------------------------- */
    function wireWebSocket() {
        if (window.__chartWsWired) return;
        if (typeof WebSocket === 'undefined') return;
        window.__chartWsWired = true;

        let socket     = null;
        let retryDelay = 1000;
        let heartbeat  = null;
        let reconnectTimer = null;

        function wsUrl() {
            const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
            return proto + '//' + window.location.host + '/ws';
        }

        function scheduleReconnect() {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            reconnectTimer = setTimeout(connect, retryDelay);
            retryDelay = Math.min(retryDelay * 2, 30000);
        }

        function connect() {
            if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
                return;
            }
            try {
                socket = new WebSocket(wsUrl());
            } catch (e) {
                scheduleReconnect();
                return;
            }

            socket.addEventListener('open', function () {
                retryDelay = 1000;
                clearInterval(heartbeat);
                heartbeat = setInterval(function () {
                    if (socket && socket.readyState === WebSocket.OPEN) {
                        try { socket.send('ping'); } catch (e) {}
                    }
                }, 25000);
            });

            socket.addEventListener('message', function (evt) {
                if (evt.data !== 'refresh') return;
                responseCache.clear();
                try {
                    if (window.ChartState && typeof window.ChartState.reloadData === 'function') {
                        window.ChartState.reloadData(true);
                    }
                } catch (e) {}
            });

            socket.addEventListener('close', function () {
                clearInterval(heartbeat);
                scheduleReconnect();
            });

            socket.addEventListener('error', function () {
                try { socket.close(); } catch (e) {}
            });
        }

        // Reconnect immediately if tab wakes up or network comes back online
        window.addEventListener('online', function () {
            retryDelay = 1000;
            connect();
        });
        document.addEventListener('visibilitychange', function () {
            if (document.visibilityState === 'visible') {
                connect();
            }
        });

        connect();
    }

    function wireControls() {
        wirePeriodBar();
        wireSymbolSearch();
        wireScaleButtons();
        wireAnalysisMenu();
        wireWebSocket();

        updateSymbolButton();
        updatePeriodSelection();

        if (!window.__chartResizeWired) {
            window.__chartResizeWired = true;
            window.addEventListener('resize', resizeAllPanes);
            if (typeof ResizeObserver !== 'undefined') {
                const ro = new ResizeObserver(function () {
                    resizeAllPanes();
                });
                ro.observe(rootContainer);
            }
        }
    }

    /* ----------------------------------------------------------------
     * 12. Boot Sequence
     * ---------------------------------------------------------------- */
    async function boot() {
        wireControls();

        try {
            if (document.fonts && document.fonts.ready) {
                await Promise.race([
                    document.fonts.ready,
                    new Promise(function (resolve) { setTimeout(resolve, 1500); })
                ]);
            }
        } catch (e) {}

        try {
            await ensureLightweightChartsLoaded();
            createMainChart();
        } catch (err) {
            console.error('[chart.js] TradingView LightweightCharts library failed to load:', err);
            showBanner('Unable to initialize chart: LightweightCharts library not loaded.');
        }
    }

    boot();

})();
