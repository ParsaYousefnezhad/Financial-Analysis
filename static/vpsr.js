/* ============================================================================
 * vpsr.js — Custom Lightweight Charts Indicator: VPSR (Volume Profile Osc)
 * ==========================================================================*/
(function () {
    'use strict';

    function calcEma(dataList, period, key) {
        const k = 2 / (period + 1);
        const ema = [];
        let currentEma = null;

        dataList.forEach(function (data, index) {
            const val = typeof key === 'function' ? key(data) : data[key];
            if (index === 0 || currentEma === null) {
                currentEma = val;
            } else {
                currentEma = (val - currentEma) * k + currentEma;
            }
            ema.push(currentEma);
        });
        return ema;
    }

    const definition = {
        name: 'VPSR',
        shortName: 'VPSR',
        calcParams: [50, 5, 50],
        calc: function (dataList, indicator) {
            const calcParams = (indicator && indicator.calcParams) || [50, 5, 50];
            const lookback = calcParams[0] || 50;
            const smoothing = calcParams[1] || 5;
            const midline_period = calcParams[2] || 50;
            const sensitivity = 1.0;

            const rawOsc = [];

            dataList.forEach(function (kline, i) {
                if (i < lookback) {
                    rawOsc.push(50);
                    return;
                }

                const slice = dataList.slice(i - lookback, i);
                let sumVol = 0, sumPriceVol = 0;

                slice.forEach(function (b) {
                    sumVol += b.volume;
                    sumPriceVol += (b.close * b.volume);
                });
                const vwap = sumVol > 0 ? sumPriceVol / sumVol : kline.close;

                let sumDev = 0;
                slice.forEach(function (b) {
                    const weight = sumVol > 0 ? b.volume / sumVol : 0;
                    sumDev += Math.abs(b.close - vwap) * weight;
                });
                const priceDev = sumDev === 0 ? 0.001 : sumDev;

                const oscVal = 50 + ((kline.close - vwap) / (priceDev * sensitivity)) * 25;
                rawOsc.push(oscVal);
            });

            const oscillator = calcEma(rawOsc, smoothing, function (v) { return v; });
            const fastSignal = calcEma(oscillator, 5, function (v) { return v; });

            const midline = [];
            let sumMid = 0;
            oscillator.forEach(function (v, i) {
                sumMid += v;
                if (i >= midline_period) {
                    sumMid -= oscillator[i - midline_period];
                    midline.push(sumMid / midline_period);
                } else {
                    midline.push(sumMid / (i + 1));
                }
            });

            return dataList.map(function (_, i) {
                return {
                    oscillator: oscillator[i],
                    fastSignal: fastSignal[i],
                    midline: midline[i]
                };
            });
        }
    };

    if (window.TVIndicators && typeof window.TVIndicators.register === 'function') {
        window.TVIndicators.register(definition);
    } else if (typeof klinecharts !== 'undefined' && typeof klinecharts.registerIndicator === 'function') {
        klinecharts.registerIndicator(definition);
    }
})();
