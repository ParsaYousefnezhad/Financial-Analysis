/* ============================================================================
 * diagnostics.js — Runtime Verification for TradingView LightweightCharts
 *                  Global Exposure & #chart Container Geometry
 * ============================================================================
 * 1. Verifies `window.LightweightCharts` is globally exposed and validates
 *    required API properties (`createChart`, `CrosshairMode`, `PriceScaleMode`,
 *    `LineStyle`, `version`, and series constructors).
 * 2. Inspects the `#chart` DOM container dimensions (`clientWidth`,
 *    `clientHeight`, `getBoundingClientRect()`) and logs a structured error
 *    via `console.error` if `#chart` is missing or its runtime size is 0x0.
 * 3. Exposes `window.LightweightChartsDiagnostics.run()` for on-demand checks.
 * ==========================================================================*/
(function () {
    'use strict';

    const REQUIRED_PROPERTIES = [
        { key: 'createChart',    expectedType: 'function', critical: true },
        { key: 'CrosshairMode',  expectedType: 'object',   critical: false },
        { key: 'PriceScaleMode', expectedType: 'object',   critical: false },
        { key: 'LineStyle',      expectedType: 'object',   critical: false }
    ];

    function verifyLightweightChartsGlobal() {
        const report = {
            exposed: false,
            version: null,
            properties: {},
            missingCritical: [],
            valid: false
        };

        if (typeof window === 'undefined' || typeof window.LightweightCharts === 'undefined' || window.LightweightCharts === null) {
            console.error(
                '[LightweightCharts Diagnostics] CRITICAL: window.LightweightCharts is undefined at runtime. ' +
                'Verify that lightweight-charts.standalone.production.js loaded before chart scripts.'
            );
            return report;
        }

        const lwc = window.LightweightCharts;
        report.exposed = true;

        try {
            report.version = typeof lwc.version === 'function'
                ? lwc.version()
                : (lwc.version || '4.x-standalone');
        } catch (e) {
            report.version = 'unknown';
        }

        REQUIRED_PROPERTIES.forEach(function (prop) {
            const actualType = typeof lwc[prop.key];
            const ok = actualType === prop.expectedType || (prop.expectedType === 'object' && lwc[prop.key] != null);
            report.properties[prop.key] = {
                present: lwc[prop.key] !== undefined,
                type: actualType,
                ok: ok
            };
            if (!ok && prop.critical) {
                report.missingCritical.push(prop.key);
            }
        });

        // Check v5 unified series descriptors if present
        report.properties.v5SeriesDescriptors = {
            CandlestickSeries: typeof lwc.CandlestickSeries !== 'undefined',
            LineSeries:        typeof lwc.LineSeries !== 'undefined',
            HistogramSeries:   typeof lwc.HistogramSeries !== 'undefined',
            AreaSeries:        typeof lwc.AreaSeries !== 'undefined'
        };

        if (report.missingCritical.length > 0) {
            console.error(
                '[LightweightCharts Diagnostics] CRITICAL: window.LightweightCharts is missing required API properties:',
                report.missingCritical,
                'Exposed keys:',
                Object.keys(lwc)
            );
            report.valid = false;
        } else {
            report.valid = true;
            console.info(
                '[LightweightCharts Diagnostics] window.LightweightCharts verified (version: ' +
                report.version + ', properties: ' + Object.keys(lwc).join(', ') + ')'
            );
        }

        return report;
    }

    function verifyChartContainerGeometry(stageLabel) {
        const stage = stageLabel || 'runtime';
        const container = document.getElementById('chart');

        if (!container) {
            console.error(
                '[LightweightCharts Diagnostics] CRITICAL (' + stage + '): Container element "#chart" was not found in the DOM.'
            );
            return {
                found: false,
                width: 0,
                height: 0,
                valid: false
            };
        }

        const rect = container.getBoundingClientRect();
        const width = Math.round(rect.width || container.clientWidth || 0);
        const height = Math.round(rect.height || container.clientHeight || 0);
        const computed = window.getComputedStyle ? window.getComputedStyle(container) : null;

        const details = {
            found: true,
            stage: stage,
            width: width,
            height: height,
            clientWidth: container.clientWidth,
            clientHeight: container.clientHeight,
            offsetWidth: container.offsetWidth,
            offsetHeight: container.offsetHeight,
            display: computed ? computed.display : 'unknown',
            visibility: computed ? computed.visibility : 'unknown',
            position: computed ? computed.position : 'unknown',
            valid: width > 0 && height > 0
        };

        if (width <= 0 || height <= 0) {
            console.error(
                '[LightweightCharts Diagnostics] ERROR (' + stage + '): Container "#chart" has invalid 0x0 dimensions (' +
                width + 'x' + height + 'px). Chart canvas cannot render into a zero-sized container.',
                details
            );
        } else {
            console.info(
                '[LightweightCharts Diagnostics] Container "#chart" geometry OK (' + stage + '): ' +
                width + 'x' + height + 'px'
            );
        }

        return details;
    }

    function runDiagnostics(stageLabel) {
        const libReport = verifyLightweightChartsGlobal();
        const domReport = verifyChartContainerGeometry(stageLabel || 'manual');
        return {
            timestamp: new Date().toISOString(),
            library: libReport,
            container: domReport,
            ok: libReport.valid && domReport.valid
        };
    }

    window.LightweightChartsDiagnostics = {
        run: runDiagnostics,
        verifyLibrary: verifyLightweightChartsGlobal,
        verifyContainer: verifyChartContainerGeometry
    };

    // 1. Run immediate synchronous check when script loads
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', function () {
            runDiagnostics('DOMContentLoaded');
        });
    } else {
        runDiagnostics('script-load');
    }

    // 2. Re-verify after window load and attach ResizeObserver to catch genuine runtime 0x0 collapses
    let isPageUnloading = false;
    window.addEventListener('beforeunload', function () { isPageUnloading = true; });
    window.addEventListener('pagehide', function () { isPageUnloading = true; });

    window.addEventListener('load', function () {
        runDiagnostics('window-load');

        const container = document.getElementById('chart');
        if (container && typeof ResizeObserver !== 'undefined') {
            let pendingZeroCheckRaf = null;
            const ro = new ResizeObserver(function (entries) {
                if (isPageUnloading || document.visibilityState === 'hidden' || !container.isConnected) {
                    return;
                }
                for (let i = 0; i < entries.length; i++) {
                    const cr = entries[i].contentRect;
                    const w = Math.round(cr.width || container.clientWidth || 0);
                    const h = Math.round(cr.height || container.clientHeight || 0);
                    if (w <= 0 || h <= 0) {
                        if (pendingZeroCheckRaf) cancelAnimationFrame(pendingZeroCheckRaf);
                        pendingZeroCheckRaf = requestAnimationFrame(function () {
                            pendingZeroCheckRaf = null;
                            if (isPageUnloading || document.visibilityState === 'hidden' || !container.isConnected) {
                                return;
                            }
                            const rect = container.getBoundingClientRect();
                            const rw = Math.round(rect.width || container.clientWidth || 0);
                            const rh = Math.round(rect.height || container.clientHeight || 0);
                            if (rw <= 0 || rh <= 0) {
                                console.error(
                                    '[LightweightCharts Diagnostics] ERROR (ResizeObserver): Container "#chart" collapsed to ' +
                                    rw + 'x' + rh + 'px at runtime.'
                                );
                            } else if (window.ChartState && typeof window.ChartState.resizeAllPanes === 'function') {
                                window.ChartState.resizeAllPanes();
                            }
                        });
                    } else if (window.ChartState && typeof window.ChartState.resizeAllPanes === 'function') {
                        window.ChartState.resizeAllPanes();
                    }
                }
            });
            ro.observe(container);
        }
    });
})();
