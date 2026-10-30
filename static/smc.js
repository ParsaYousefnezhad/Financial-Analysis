/* ============================================================================
 * smc.js — Client-side Smart Money Concepts (SMC) engine
 * ----------------------------------------------------------------------------
 * Ports and extends the Python compute_smc():
 *
 *   • Order blocks                 — same algorithm as the Python version
 *   • Internal / swing structure   — BOS / CHoCH events (new)
 *   • Trailing strong/weak highs   — running extremes + labels (new)
 *
 * Exposes:
 *     window.SMCEngine.compute(bars, params) -> {
 *         swing:     [ OrderBlock, ... ],
 *         internal:  [ OrderBlock, ... ],
 *         structure: {
 *             swing:    [ { startTime, endTime, level, tag, bias } ],
 *             internal: [ { ... } ]
 *         },
 *         trailing:  { top, bottom, lastTopTime, lastBottomTime,
 *                      barTime, barIndex, swingTrend } | null
 *     }
 *
 * `startTime`, `endTime`, `lastTopTime`, `lastBottomTime`, `barTime` are all
 * in milliseconds — same unit as `bar.timestamp`.
 * ==========================================================================*/

(function () {
    'use strict';

    const BULLISH = 1;
    const BEARISH = -1;

    /* 200-period rolling mean — mirrors pandas rolling(200).mean() by
       leaving NaN for the first 199 slots. */
    function rollingMean200(values) {
        const n = values.length;
        const out = new Array(n).fill(NaN);
        let sum = 0;
        for (let i = 0; i < n; i++) {
            sum += values[i];
            if (i >= 200) sum -= values[i - 200];
            if (i >= 199) out[i] = sum / 200;
        }
        return out;
    }

    function expandingMean(values) {
        const n = values.length;
        const out = new Array(n);
        let sum = 0;
        for (let i = 0; i < n; i++) {
            sum += values[i];
            out[i] = sum / (i + 1);
        }
        return out;
    }

    function emptyResult() {
        return {
            swing: [],
            internal: [],
            structure: { swing: [], internal: [] },
            trailing: null
        };
    }

    function compute(bars, params) {
        params = params || {};
        const swings_length    = params.swings_length    || 50;
        const internal_length  = params.internal_length  || 5;
        const internal_ob_size = params.internal_ob_size || 5;
        const swing_ob_size    = params.swing_ob_size    || 5;

        /* Feature toggles (all default to ON) */
        const showInternalStructure = params.showInternalStructure !== false;
        const showSwingStructure    = params.showSwingStructure    !== false;
        const showStrongWeak        = params.showStrongWeak        !== false;

        /* Structure event counts follow the order-block size limits — same
           concept ("how many of these to keep"), same length. Callers can
           override via swingStructureLimit / internalStructureLimit. */
        const swingStructureLimit    = params.swingStructureLimit    || swing_ob_size;
        const internalStructureLimit = params.internalStructureLimit || internal_ob_size;

        const n = bars.length;
        if (n === 0) return emptyResult();

        /* -----------------------------------------------------------
         * 1. True range, ATR, cumulative mean TR
         * --------------------------------------------------------- */
        const tr = new Array(n);
        for (let i = 0; i < n; i++) {
            const h  = bars[i].high;
            const l  = bars[i].low;
            const pc = i > 0 ? bars[i - 1].close : h;
            tr[i] = Math.max(h - l, Math.abs(h - pc), Math.abs(l - pc));
        }
        const atr    = rollingMean200(tr);
        const cum_tr = expandingMean(tr);

        /* -----------------------------------------------------------
         * 2. Pivot / trend state
         * --------------------------------------------------------- */
        const swingHigh    = { currentLevel: NaN, lastLevel: NaN, crossed: false, barIndex: 0, barTime: null };
        const swingLow     = { currentLevel: NaN, lastLevel: NaN, crossed: false, barIndex: 0, barTime: null };
        const internalHigh = { currentLevel: NaN, lastLevel: NaN, crossed: false, barIndex: 0, barTime: null };
        const internalLow  = { currentLevel: NaN, lastLevel: NaN, crossed: false, barIndex: 0, barTime: null };

        /* Trend biases — these drive the BOS vs CHoCH tag. */
        const swingTrend    = { bias: 0 };
        const internalTrend = { bias: 0 };

        const swing_obs    = [];
        const internal_obs = [];

        /* Structure event collectors (new) */
        const swingStructures    = [];
        const internalStructures = [];

        const parsed_highs = new Array(n);
        const parsed_lows  = new Array(n);

        /* Trailing extremes (new) */
        let trailingTop            = -Infinity;
        let trailingBottom         =  Infinity;
        let trailingLastTopTime    = null;
        let trailingLastBottomTime = null;
        let trailingBarTime        = null;
        let trailingBarIndex       = null;

        /* -----------------------------------------------------------
         * 3. Leg classification
         * --------------------------------------------------------- */
        function getLeg(i, size) {
            if (i < size) return -1;
            let hmax = -Infinity, lmin = Infinity;
            for (let j = i - size + 1; j <= i; j++) {
                if (bars[j].high > hmax) hmax = bars[j].high;
                if (bars[j].low  < lmin) lmin = bars[j].low;
            }
            if (bars[i - size].high > hmax) return 0;
            if (bars[i - size].low  < lmin) return 1;
            return -1;
        }

        let last_swing_leg    = -1;
        let last_internal_leg = -1;

        /* -----------------------------------------------------------
         * 4. Main loop
         * --------------------------------------------------------- */
        for (let i = 0; i < n; i++) {
            const k     = bars[i];
            const high  = k.high;
            const low   = k.low;
            const close = k.close;

            let volatility_measure = atr[i];
            if (isNaN(volatility_measure)) volatility_measure = cum_tr[i];

            const hv = (high - low) >= (2 * volatility_measure);
            parsed_highs[i] = hv ? low  : high;
            parsed_lows[i]  = hv ? high : low;

            /* --- 4a. Order-block mitigation ------------------------- */
            const bear_mit = high;
            const bull_mit = low;
            function mitigate(list) {
                for (let j = list.length - 1; j >= 0; j--) {
                    const ob = list[j];
                    if ((bear_mit > ob.barHigh && ob.bias === BEARISH) ||
                        (bull_mit < ob.barLow  && ob.bias === BULLISH)) {
                        list.splice(j, 1);
                    }
                }
            }
            mitigate(internal_obs);
            mitigate(swing_obs);

            /* --- 4b. Pivot formation -------------------------------- */
            function processStructure(size, isInternal, lastLeg) {
                let currentLeg = getLeg(i, size);
                if (currentLeg === -1) currentLeg = lastLeg;

                const newPivot  = (currentLeg !== lastLeg) && (lastLeg !== -1);
                const pivotLow  = (currentLeg === 1 && lastLeg === 0);
                const pivotHigh = (currentLeg === 0 && lastLeg === 1);

                const p_low  = isInternal ? internalLow  : swingLow;
                const p_high = isInternal ? internalHigh : swingHigh;

                if (newPivot) {
                    if (pivotLow) {
                        p_low.lastLevel    = p_low.currentLevel;
                        p_low.currentLevel = bars[i - size].low;
                        p_low.crossed      = false;
                        p_low.barIndex     = i - size;
                        p_low.barTime      = bars[i - size].timestamp;
                    } else if (pivotHigh) {
                        p_high.lastLevel    = p_high.currentLevel;
                        p_high.currentLevel = bars[i - size].high;
                        p_high.crossed      = false;
                        p_high.barIndex     = i - size;
                        p_high.barTime      = bars[i - size].timestamp;
                    }
                }
                return currentLeg;
            }

            last_swing_leg    = processStructure(swings_length,   false, last_swing_leg);
            last_internal_leg = processStructure(internal_length, true,  last_internal_leg);

            /* --- 4c. Breakout detection ----------------------------- */
            function checkBreakout(isInternal) {
                const p_high = isInternal ? internalHigh : swingHigh;
                const p_low  = isInternal ? internalLow  : swingLow;
                const trend  = isInternal ? internalTrend : swingTrend;
                const tgtList = isInternal ? internal_obs : swing_obs;
                const tgtCap  = isInternal ? internal_ob_size : swing_ob_size;
                const strArr  = isInternal ? internalStructures : swingStructures;
                const wantsStructure =
                    (isInternal && showInternalStructure) ||
                    (!isInternal && showSwingStructure);

                /* --- Bullish crossover --- */
                const extraBull = isInternal
                    ? (p_high.currentLevel !== swingHigh.currentLevel)
                    : true;

                if (!isNaN(p_high.currentLevel) &&
                    close > p_high.currentLevel &&
                    i > 0 &&
                    bars[i - 1].close <= p_high.currentLevel &&
                    !p_high.crossed &&
                    extraBull) {

                    p_high.crossed = true;

                    const prevBias = trend.bias;
                    trend.bias = BULLISH;

                    if (wantsStructure && p_high.barTime != null) {
                        strArr.push({
                            startTime: p_high.barTime,
                            endTime:   k.timestamp,
                            level:     p_high.currentLevel,
                            tag:       prevBias === BEARISH ? 'CHoCH' : 'BOS',
                            bias:      BULLISH
                        });
                    }

                    /* Store order block (unchanged from existing logic) */
                    const start = p_high.barIndex;
                    const end   = i;
                    if (end >= start) {
                        let minIdx = start;
                        let minVal = parsed_lows[start];
                        for (let j = start + 1; j <= end; j++) {
                            if (parsed_lows[j] < minVal) {
                                minVal = parsed_lows[j];
                                minIdx = j;
                            }
                        }
                        tgtList.unshift({
                            barHigh: parsed_highs[minIdx],
                            barLow:  parsed_lows[minIdx],
                            barIndex: minIdx,
                            bias: BULLISH
                        });
                        while (tgtList.length > tgtCap) tgtList.pop();
                    }
                }

                /* --- Bearish crossunder --- */
                const extraBear = isInternal
                    ? (p_low.currentLevel !== swingLow.currentLevel)
                    : true;

                if (!isNaN(p_low.currentLevel) &&
                    close < p_low.currentLevel &&
                    i > 0 &&
                    bars[i - 1].close >= p_low.currentLevel &&
                    !p_low.crossed &&
                    extraBear) {

                    p_low.crossed = true;

                    const prevBias = trend.bias;
                    trend.bias = BEARISH;

                    if (wantsStructure && p_low.barTime != null) {
                        strArr.push({
                            startTime: p_low.barTime,
                            endTime:   k.timestamp,
                            level:     p_low.currentLevel,
                            tag:       prevBias === BULLISH ? 'CHoCH' : 'BOS',
                            bias:      BEARISH
                        });
                    }

                    const start = p_low.barIndex;
                    const end   = i;
                    if (end >= start) {
                        let maxIdx = start;
                        let maxVal = parsed_highs[start];
                        for (let j = start + 1; j <= end; j++) {
                            if (parsed_highs[j] > maxVal) {
                                maxVal = parsed_highs[j];
                                maxIdx = j;
                            }
                        }
                        tgtList.unshift({
                            barHigh: parsed_highs[maxIdx],
                            barLow:  parsed_lows[maxIdx],
                            barIndex: maxIdx,
                            bias: BEARISH
                        });
                        while (tgtList.length > tgtCap) tgtList.pop();
                    }
                }
            }

            checkBreakout(true);
            checkBreakout(false);

            /* --- 4d. Trailing extremes -------------------------------- */
            if (showStrongWeak) {
                if (high > trailingTop) {
                    trailingTop = high;
                    trailingLastTopTime = k.timestamp;
                    trailingBarTime = k.timestamp;
                    trailingBarIndex = i;
                }
                if (low < trailingBottom) {
                    trailingBottom = low;
                    trailingLastBottomTime = k.timestamp;
                    trailingBarTime = k.timestamp;
                    trailingBarIndex = i;
                }
            }
        }

        /* -----------------------------------------------------------
         * 5. Serialize
         * --------------------------------------------------------- */
        function serializeOB(list) {
            return list.map(ob => {
                const bar = bars[ob.barIndex];
                return {
                    high:  ob.barHigh,
                    low:   ob.barLow,
                    index: ob.barIndex,
                    bias:  ob.bias,
                    time:  bar ? bar.timestamp / 1000 : null
                };
            });
        }

        const trimmedSwing    = swingStructures.slice(-swingStructureLimit);
        const trimmedInternal = internalStructures.slice(-internalStructureLimit);

        return {
            swing:    serializeOB(swing_obs),
            internal: serializeOB(internal_obs),
            structure: {
                swing:    trimmedSwing,
                internal: trimmedInternal
            },
            trailing: (showStrongWeak &&
                       isFinite(trailingTop) &&
                       isFinite(trailingBottom) &&
                       trailingLastTopTime != null &&
                       trailingLastBottomTime != null)
                ? {
                    top:               trailingTop,
                    bottom:            trailingBottom,
                    lastTopTime:       trailingLastTopTime,
                    lastBottomTime:    trailingLastBottomTime,
                    barTime:           trailingBarTime,
                    barIndex:          trailingBarIndex,
                    swingTrend:        swingTrend.bias
                }
                : null
        };
    }

    window.SMCEngine = { compute: compute };
})();