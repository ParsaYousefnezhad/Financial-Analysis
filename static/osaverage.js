/* ============================================================================
 * osaverage.js — Custom Lightweight Charts Indicator: OSAverage (Xtrender)
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

    function calcRsi(dataList, period) {
        const rsi = new Array(dataList.length).fill(0);
        let gains = 0, losses = 0;
        for (let i = 1; i < dataList.length; i++) {
            const diff = dataList[i] - dataList[i - 1];
            if (i <= period) {
                gains += diff > 0 ? diff : 0;
                losses += diff < 0 ? -diff : 0;
            }
            if (i >= period) {
                let avgGain, avgLoss;
                if (i === period) {
                    avgGain = gains / period;
                    avgLoss = losses / period;
                } else {
                    const currentGain = diff > 0 ? diff : 0;
                    const currentLoss = diff < 0 ? -diff : 0;
                    avgGain = (rsi[i - 1].gain * (period - 1) + currentGain) / period;
                    avgLoss = (rsi[i - 1].loss * (period - 1) + currentLoss) / period;
                }
                const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
                rsi[i] = {
                    value: avgLoss === 0 ? 100 : 100 - (100 / (1 + rs)),
                    gain: avgGain,
                    loss: avgLoss
                };
            }
        }
        return rsi.map(function (r) { return r.value || 0; });
    }

    const definition = {
        name: 'OSAVERAGE',
        shortName: 'OSAverage',
        calcParams: [5, 20, 15],
        calc: function (dataList, indicator) {
            const params = (indicator && indicator.calcParams) || [5, 20, 15];
            const short_l1 = params[0] || 5;
            const short_l2 = params[1] || 20;
            const short_l3 = params[2] || 15;

            const ema5 = calcEma(dataList, short_l1, 'close');
            const ema20 = calcEma(dataList, short_l2, 'close');

            const emaDiff = ema5.map(function (v, i) {
                if (v === null || ema20[i] === null) return 0;
                return v - ema20[i];
            });

            const xtrenderRsi = calcRsi(emaDiff, short_l3);

            return dataList.map(function (_, i) {
                if (i < short_l2 + short_l3) return {};
                const val = xtrenderRsi[i] - 50;
                return {
                    xtrender: val,
                    _barColor: val >= 0 ? '#00c853' : '#f23645'
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
