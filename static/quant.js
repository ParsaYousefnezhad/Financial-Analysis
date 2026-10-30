(function() {

    const calcBtn = document.getElementById('calcBtn');
    
    // Fail-safe to prevent execution if script is accidentally loaded on a page without the calcBtn
    if (!calcBtn) return;

    const timeframeLabels = {
        "1m": "1 Minute", "5m": "5 Minutes", "10m": "10 Minutes",
        "15m": "15 Minutes", "30m": "30 Minutes", "1h": "Hourly", "1d": "Daily"
    };

    calcBtn.addEventListener('click', async function() {
        const a1Select = document.getElementById('asset1');
        const a2Select = document.getElementById('asset2');
        const a1 = a1Select.value;
        const a2 = a2Select.value;
        const a1Name = a1Select.options[a1Select.selectedIndex].text;
        const a2Name = a2Select.options[a2Select.selectedIndex].text;

        calcBtn.disabled = true;
        calcBtn.textContent = "Calculating...";

        try {
            const res = await fetch(`/api/analysis?asset1=${a1}&asset2=${a2}&timeframe=1d`);
            const data = await res.json();

            if (data.error) throw new Error(data.error);

            // Populate Meta Bar
            document.getElementById('dateRange').textContent = `${data.start_date} to ${data.end_date}`;
            document.getElementById('tfDisplay').textContent = timeframeLabels[data.timeframe] || data.timeframe;

            // Populate KPI labels & metrics
            const rf1Val = (data.rf_data.asset1.rate * 100).toFixed(2);
            const rf2Val = (data.rf_data.asset2.rate * 100).toFixed(2);
            
            // Asset 1 KPIs
            document.getElementById('a1VolLabel').textContent = `${a1Name} Volatility`;
            document.getElementById('a1Vol').textContent = (data.annualized_volatility[a1] * 100).toFixed(2) + '%';
            
            document.getElementById('a1SharpeLabel').textContent = `${a1Name} Sharpe`;
            document.getElementById('a1Sharpe').textContent = data.sharpe_ratio[a1].toFixed(2);
            document.getElementById('a1SharpeSubtext').innerHTML = `Annualized (Dynamic $R_f$)=${rf1Val}%`;

            // Asset 2 KPIs
            document.getElementById('a2VolLabel').textContent = `${a2Name} Volatility`;
            document.getElementById('a2Vol').textContent = (data.annualized_volatility[a2] * 100).toFixed(2) + '%';
            
            document.getElementById('a2SharpeLabel').textContent = `${a2Name} Sharpe`;
            document.getElementById('a2Sharpe').textContent = data.sharpe_ratio[a2].toFixed(2);
            document.getElementById('a2SharpeSubtext').innerHTML = `Annualized (Dynamic $R_f$)=${rf2Val}%`;

            // Populate Matrix Headers
            ['thCorr1', 'rowCorr1', 'thCov1', 'rowCov1'].forEach(id => document.getElementById(id).textContent = a1Name);
            ['thCorr2', 'rowCorr2', 'thCov2', 'rowCov2'].forEach(id => document.getElementById(id).textContent = a2Name);

            // Sensitivity Table Headers
            document.getElementById('thSens1').textContent = `${a1Name} Weight`;
            document.getElementById('thSens2').textContent = `${a2Name} Weight`;

            // Correlation Cells
            const corrValue = data.correlation[a1][a2];
            document.getElementById('c12').textContent = corrValue.toFixed(4);
            document.getElementById('c21').textContent = corrValue.toFixed(4);

            // Correlation Assessment Badge
            const badge = document.getElementById('corrBadge');
            if (corrValue > 0.7) {
                badge.className = 'badge bg-danger';
                badge.textContent = `Strong Positive (${corrValue.toFixed(2)})`;
            } else if (corrValue > 0.3) {
                badge.className = 'badge bg-warning text-dark';
                badge.textContent = `Moderate Positive (${corrValue.toFixed(2)})`;
            } else if (corrValue > -0.3) {
                badge.className = 'badge bg-secondary';
                badge.textContent = `Low/Neutral (${corrValue.toFixed(2)})`;
            } else {
                badge.className = 'badge bg-success';
                badge.textContent = `Inverse Diversifier (${corrValue.toFixed(2)})`;
            }

            // Covariance Cells
            document.getElementById('cov11').textContent = data.covariance[a1][a1].toFixed(6);
            document.getElementById('cov12').textContent = data.covariance[a1][a2].toFixed(6);
            document.getElementById('cov21').textContent = data.covariance[a2][a1].toFixed(6);
            document.getElementById('cov22').textContent = data.covariance[a2][a2].toFixed(6);

            // --- POPULATE SENSITIVITY TABLE ---
            const tbody = document.getElementById('sensitivityBody');
            tbody.innerHTML = '';
            
            let maxSharpe = -Infinity;
            let maxSharpeIndex = 0;
            let minVol = Infinity;
            let minVolIndex = 0;
            
            data.sensitivity_table.forEach((row, i) => {
                if(row.sharpe > maxSharpe) {
                    maxSharpe = row.sharpe;
                    maxSharpeIndex = i;
                }
                if(row.volatility < minVol) {
                    minVol = row.volatility;
                    minVolIndex = i;
                }
            });

            data.sensitivity_table.forEach((row, i) => {
                const tr = document.createElement('tr');
                
                if(i === maxSharpeIndex) {
                    tr.className = 'optimal-row';
                }

                const w1 = (row.weight_1 * 100).toFixed(0) + '%';
                const w2 = (row.weight_2 * 100).toFixed(0) + '%';
                const ret = (row.return * 100).toFixed(2) + '%';
                const vol = (row.volatility * 100).toFixed(2) + '%';
                const sharpe = row.sharpe.toFixed(2);
                
                tr.innerHTML = `
                    <td class="fw-semibold">${w1}</td>
                    <td class="fw-semibold">${w2}</td>
                    <td class="${row.return >= 0 ? 'text-success' : 'text-danger'} fw-semibold">${ret}</td>
                    <td>${vol}</td>
                    <td class="fw-bold">${sharpe} ${i === maxSharpeIndex ? '⭐' : ''}</td>
                `;
                tbody.appendChild(tr);
            });

            // --- GENERATE EFFICIENT FRONTIER PLOT WITH CHART.JS ---
            if (window.frontierChartInstance) {
                window.frontierChartInstance.destroy();
            }

            const ctx = document.getElementById('frontierChart').getContext('2d');
            
            const curvePoints = data.sensitivity_table.map(row => ({
                x: row.volatility * 100,
                y: row.return * 100,
                weight1: row.weight_1,
                sharpe: row.sharpe
            }));

            const pointBackgroundColors = curvePoints.map((p, i) => {
                if (i === maxSharpeIndex) return '#28a745'; // Green for Tangency Portfolio
                if (i === minVolIndex) return '#ffc107';    // Yellow for Min Variance
                return '#0d6efd';                           // Blue for Standard Portfolios
            });

            const pointRadii = curvePoints.map((p, i) => {
                if (i === maxSharpeIndex || i === minVolIndex) return 8;
                return 5;
            });

            window.frontierChartInstance = new Chart(ctx, {
                type: 'scatter',
                data: {
                    datasets: [{
                        label: 'Portfolios',
                        data: curvePoints,
                        showLine: true,
                        borderColor: 'rgba(13, 110, 253, 0.4)',
                        borderWidth: 2,
                        backgroundColor: pointBackgroundColors,
                        pointRadius: pointRadii,
                        pointHoverRadius: 10,
                        fill: false,
                        tension: 0.2 // Smooth curve connecting the discrete weight steps
                    }]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    plugins: {
                        legend: { display: false },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    const p = context.raw;
                                    const w1 = (p.weight1 * 100).toFixed(0);
                                    const w2 = (100 - p.weight1 * 100).toFixed(0);
                                    return [
                                        `Weight: ${w1}% ${a1Name} / ${w2}% ${a2Name}`,
                                        `Return: ${p.y.toFixed(2)}%`,
                                        `Volatility: ${p.x.toFixed(2)}%`,
                                        `Sharpe: ${p.sharpe.toFixed(2)}`
                                    ];
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            title: { display: true, text: 'Annualized Volatility (Risk) %', font: { weight: 'bold' } },
                            ticks: { callback: value => value + '%' }
                        },
                        y: {
                            title: { display: true, text: 'Expected Return %', font: { weight: 'bold' } },
                            ticks: { callback: value => value + '%' }
                        }
                    }
                }
            });

            // --- GENERATE AUTOMATED INSIGHT & BONDS TABLE ---
            const optW1 = (data.sensitivity_table[maxSharpeIndex].weight_1 * 100).toFixed(0);
            const optW2 = (data.sensitivity_table[maxSharpeIndex].weight_2 * 100).toFixed(0);
            const maxSharpeVal = data.sensitivity_table[maxSharpeIndex].sharpe.toFixed(2);
            const optRet = (data.sensitivity_table[maxSharpeIndex].return * 100).toFixed(2);

            const minW1 = (data.sensitivity_table[minVolIndex].weight_1 * 100).toFixed(0);
            const minW2 = (data.sensitivity_table[minVolIndex].weight_2 * 100).toFixed(0);
            const minVolVal = (minVol * 100).toFixed(2);

            // Calculate the exact weighted Rf for the tangency portfolio
            const optRfPercent = ((optW1/100 * data.rf_data.asset1.rate) + (optW2/100 * data.rf_data.asset2.rate)) * 100;

            const insightHtml = `
                This matrix models the risk-return trade-offs between <strong>${a1Name}</strong> and <strong>${a2Name}</strong>. 
                The portfolio Sharpe Ratio is calculated using an asset-weighted dynamic Risk-Free Rate (Optimal $R_f$: <strong>${optRfPercent.toFixed(2)}%</strong>).
                <br><br>
                The tangency portfolio, which maximizes the risk-adjusted return, is achieved at a <strong>${optW1}% / ${optW2}%</strong> weight distribution, yielding a peak Sharpe Ratio of <strong>${maxSharpeVal}</strong> with an annualized expected return of <strong>${optRet}%</strong>. 
                <br><br>
                Furthermore, the global minimum variance portfolio is located at the <strong>${minW1}% / ${minW2}%</strong> allocation, suppressing total annualized volatility to a baseline of <strong>${minVolVal}%</strong>.
            `;
            
            document.getElementById('autoSummary').innerHTML = insightHtml;

            // Populate Bonds Table (Categorized by Market)
            const bondsBody = document.getElementById('bondsBody');
            bondsBody.innerHTML = '';

            if (data.active_bonds && data.active_bonds.length > 0) {
                
                // Display multi-proxy badge if assets belong to different domains
                let activeProxies = [];
                if (data.rf_data.asset1.symbol === data.rf_data.asset2.symbol) {
                    activeProxies.push(`${data.rf_data.asset1.symbol} (${rf1Val}%)`);
                } else {
                    activeProxies.push(`${data.rf_data.asset1.symbol}`);
                    activeProxies.push(`${data.rf_data.asset2.symbol}`);
                }
                document.getElementById('selectedRfBadge').textContent = `Active Proxies: ${activeProxies.join(' & ')}`;
                
                const usBonds = data.active_bonds.filter(b => b.market && b.market.includes('US'));
                const irBonds = data.active_bonds.filter(b => !b.market || b.market.includes('Akhza') || b.market.includes('IRR'));

                const renderGroup = (title, list) => {
                    if (!list || list.length === 0) return;
                    
                    const headerTr = document.createElement('tr');
                    headerTr.className = 'table-secondary fw-bold text-uppercase';
                    headerTr.style.fontSize = '0.75rem';
                    headerTr.innerHTML = `<td colspan="4" class="py-1 px-2">${title}</td>`;
                    bondsBody.appendChild(headerTr);

                    list.sort((a, b) => a.days_to_maturity - b.days_to_maturity);
                    list.forEach(bond => {
                        const tr = document.createElement('tr');
                        
                        // Highlight if it matches EITHER asset's Rf symbol
                        const isSelected = (bond.symbol === data.rf_data.asset1.symbol || bond.symbol === data.rf_data.asset2.symbol);
                        
                        if (isSelected) {
                            tr.className = 'table-info fw-bold';
                            tr.title = 'Active Risk-Free Rate Used';
                        }
                        
                        tr.innerHTML = `
                            <td>${bond.symbol} ${isSelected ? '' : ''}</td>
                            <td>${bond.maturity_date}</td>
                            <td>${bond.days_to_maturity}</td>
                            <td>${(bond.ytm * 100).toFixed(2)}%</td>
                        `;
                        bondsBody.appendChild(tr);
                    });
                };

                renderGroup('🇺🇸 US Treasury Yield Curve (USD)', usBonds);
                renderGroup('🇮🇷 TSETMC Akhza Yield Curve (IRR)', irBonds);
            } else {
                document.getElementById('selectedRfBadge').textContent = `Fixed Rf Active`;
                bondsBody.innerHTML = '<tr><td colspan="4" class="text-muted">No yield data available.</td></tr>';
            }

            // --- POPULATE DISTRIBUTION & STATIONARITY METRICS ---
            document.getElementById('thDist1').textContent = a1Name;
            document.getElementById('thDist2').textContent = a2Name;

            document.getElementById('skew1').innerHTML = `<span class="${data.distribution[a1].skew < 0 ? 'text-danger' : 'text-success'}">${data.distribution[a1].skew.toFixed(2)}</span>`;
            document.getElementById('skew2').innerHTML = `<span class="${data.distribution[a2].skew < 0 ? 'text-danger' : 'text-success'}">${data.distribution[a2].skew.toFixed(2)}</span>`;
            
            document.getElementById('kurt1').innerHTML = `<span class="${data.distribution[a1].kurtosis > 3 ? 'text-danger fw-bold' : ''}">${data.distribution[a1].kurtosis.toFixed(2)}</span>`;
            document.getElementById('kurt2').innerHTML = `<span class="${data.distribution[a2].kurtosis > 3 ? 'text-danger fw-bold' : ''}">${data.distribution[a2].kurtosis.toFixed(2)}</span>`;

            document.getElementById('adf1').textContent = data.stationarity[a1].adf_stat.toFixed(3);
            document.getElementById('adf2').textContent = data.stationarity[a2].adf_stat.toFixed(3);
            
            document.getElementById('pval1').textContent = data.stationarity[a1].p_value.toFixed(4);
            document.getElementById('pval2').textContent = data.stationarity[a2].p_value.toFixed(4);

            document.getElementById('stat1').innerHTML = data.stationarity[a1].is_stationary 
                ? '<span class="badge bg-success">Yes</span>' 
                : '<span class="badge bg-danger">No</span>';
            document.getElementById('stat2').innerHTML = data.stationarity[a2].is_stationary 
                ? '<span class="badge bg-success">Yes</span>' 
                : '<span class="badge bg-danger">No</span>';

            // --- DRAW DISTRIBUTION KDE CHART ---
            if (window.distChartInstance) {
                window.distChartInstance.destroy();
            }

            const distCtx = document.getElementById('distChart').getContext('2d');
            
            // Format Python dicts into Chart.js scatter coordinates
            const kdeData1 = data.distribution[a1].kde_x.map((x, i) => ({ x: x, y: data.distribution[a1].kde_y[i] }));
            const kdeData2 = data.distribution[a2].kde_x.map((x, i) => ({ x: x, y: data.distribution[a2].kde_y[i] }));

            window.distChartInstance = new Chart(distCtx, {
                type: 'scatter',
                data: {
                    datasets: [
                        {
                            label: a1Name,
                            data: kdeData1,
                            showLine: true,
                            fill: true,
                            backgroundColor: 'rgba(13, 110, 253, 0.2)', // Blue
                            borderColor: 'rgba(13, 110, 253, 1)',
                            borderWidth: 2,
                            pointRadius: 0,
                            pointHitRadius: 5,
                            tension: 0.4 // Smooth curve
                        },
                        {
                            label: a2Name,
                            data: kdeData2,
                            showLine: true,
                            fill: true,
                            backgroundColor: 'rgba(40, 167, 69, 0.2)', // Green
                            borderColor: 'rgba(40, 167, 69, 1)',
                            borderWidth: 2,
                            pointRadius: 0,
                            pointHitRadius: 5,
                            tension: 0.4
                        }
                    ]
                },
                options: {
                    responsive: true,
                    maintainAspectRatio: false,
                    interaction: { mode: 'index', intersect: false },
                    plugins: {
                        legend: { position: 'top' },
                        tooltip: {
                            callbacks: {
                                label: function(context) {
                                    return `${context.dataset.label}: ${context.raw.x.toFixed(2)}% Return`;
                                }
                            }
                        }
                    },
                    scales: {
                        x: {
                            type: 'linear',
                            title: { display: true, text: 'Return (%)', font: { weight: 'bold' } },
                            ticks: { callback: value => value + '%' }
                        },
                        y: {
                            title: { display: true, text: 'Density', font: { weight: 'bold' } },
                            ticks: { display: false }, 
                            grid: { drawBorder: false }
                        }
                    }
                }
            });    

            // --- HISTORICAL PERFORMANCE & ROLLING STATS --- 
            // Update Tab Names
            document.getElementById('tab-asset1').textContent = a1Name;
            document.getElementById('tab-asset2').textContent = a2Name;

            const perfData = data.performance;

            // Function to render charts based on selected asset
            function renderPerformanceDashboard(assetKey, assetLabel) {
                // Safe access with fallbacks
                const pData = perfData ? perfData[assetKey] : null;
                if (!pData) return;

                // 1. Build Monthly Returns Heatmap
                const heatmapTable = document.getElementById('heatmapTable');
                heatmapTable.innerHTML = '';
                
                // Added ?. to prevent undefined length errors
                if (pData?.heatmap?.length > 0) {
                    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
                    let thead = '<thead class="table-light"><tr><th>Year</th>';
                    months.forEach(m => thead += `<th>${m}</th>`);
                    thead += '</tr></thead>';
                    
                    const grouped = {};
                    pData.heatmap.forEach(d => {
                        if (!grouped[d.year]) grouped[d.year] = {};
                        grouped[d.year][d.month] = d.return;
                    });

                    let tbody = '<tbody>';
                    Object.keys(grouped).sort((a, b) => b - a).forEach(year => {
                        tbody += `<tr><td class="fw-bold bg-light">${year}</td>`;
                        for (let m = 1; m <= 12; m++) {
                            const val = grouped[year][m];
                            if (val !== undefined) {
                                const pct = val * 100;
                                let bgColor = pct > 0 
                                    ? `rgba(13, 110, 253, ${Math.min(pct / 15, 1).toFixed(2)})` 
                                    : `rgba(220, 53, 69, ${Math.min(Math.abs(pct) / 15, 1).toFixed(2)})`;
                                let textColor = Math.abs(pct) > 7 ? 'white' : 'black';
                                
                                tbody += `<td style="background-color: ${bgColor}; color: ${textColor};">${pct.toFixed(1)}</td>`;
                            } else {
                                tbody += `<td class="text-muted bg-light">--</td>`;
                            }
                        }
                        tbody += '</tr>';
                    });
                    tbody += '</tbody>';
                    heatmapTable.innerHTML = thead + tbody;
                }

                // 2. Draw Yearly Returns Bar Chart
                if (window.yearlyChartInstance) window.yearlyChartInstance.destroy();
                const yrCtx = document.getElementById('yearlyChart').getContext('2d');
                
                // Added || [] fallback to guarantee an array is passed
                const safeYearly = pData?.yearly || [];
                const yLabels = safeYearly.map(d => d.year);
                const yData = safeYearly.map(d => d.return * 100);
                const meanReturn = yData.reduce((a, b) => a + b, 0) / (yData.length || 1);

                window.yearlyChartInstance = new Chart(yrCtx, {
                    type: 'bar',
                    data: {
                        labels: yLabels,
                        datasets: [{
                            label: 'Yearly Return %',
                            data: yData,
                            backgroundColor: yData.map(v => v >= 0 ? '#0d6efd' : '#dc3545'),
                            borderWidth: 1
                        }]
                    },
                    options: {
                        indexAxis: 'y',
                        responsive: true,
                        maintainAspectRatio: false, 
                        plugins: {
                            legend: { display: false },
                            annotation: {
                                annotations: {
                                    meanLine: {
                                        type: 'line',
                                        xMin: meanReturn,
                                        xMax: meanReturn,
                                        borderColor: 'rgba(0,0,0,0.5)',
                                        borderWidth: 2,
                                        borderDash: [5, 5],
                                        label: { display: true, content: 'Mean', position: 'end' }
                                    }
                                }
                            }
                        },
                        scales: {
                            x: {
                                title: { display: true, text: 'Return (%)', font: { weight: 'bold' } },
                                ticks: { callback: value => value + '%' }
                            },
                            y: { grid: { display: false }, ticks: { font: { weight: 'bold' } } }
                        }
                    }
                });

                // 3. Draw Rolling Statistics (1 Month) Line Chart
                if (window.rollingChartInstance) window.rollingChartInstance.destroy();
                const rollCtx = document.getElementById('rollingChart').getContext('2d');
                
                // Added safe access fallbacks for rolling data
                const safeRolling = pData?.rolling || { dates: [], returns: [], volatility: [] };

                window.rollingChartInstance = new Chart(rollCtx, {
                    type: 'line',
                    data: {
                        labels: safeRolling.dates,
                        datasets: [
                            {
                                label: `Rolling Return (1M) - ${assetLabel}`,
                                data: safeRolling.returns.map(v => v * 100),
                                borderColor: '#0d6efd',
                                backgroundColor: 'rgba(13, 110, 253, 0.1)',
                                borderWidth: 2,
                                pointRadius: 0,
                                tension: 0.2
                            },
                            {
                                label: `Rolling Volatility (1M) - ${assetLabel}`,
                                data: safeRolling.volatility.map(v => v * 100),
                                borderColor: '#6c757d',
                                backgroundColor: 'transparent',
                                borderWidth: 2,
                                pointRadius: 0,
                                tension: 0.2
                            }
                        ]
                    },
                    options: {
                        responsive: true,
                        maintainAspectRatio: false,
                        interaction: { mode: 'index', intersect: false },
                        plugins: { legend: { position: 'top', align: 'end' } },
                        scales: {
                            x: { grid: { display: false }, ticks: { maxTicksLimit: 12 } },
                            y: {
                                title: { display: false },
                                ticks: { callback: value => value + '%' },
                                grid: { color: (ctx) => ctx.tick.value === 0 ? '#000' : 'rgba(0,0,0,0.1)' }
                            }
                        }
                    }
                });
            }

            // Render default asset on initial calculate
            renderPerformanceDashboard(a1, a1Name);

            // Assign click listeners to the tabs
            document.getElementById('tab-asset1').onclick = () => renderPerformanceDashboard(a1, a1Name);
            document.getElementById('tab-asset2').onclick = () => renderPerformanceDashboard(a2, a2Name);

            document.getElementById('resultsContainer').style.display = 'block';

            // Re-render LaTeX math formulas asynchronously
            if (window.MathJax) {
                MathJax.typesetPromise();
            }

        } catch (err) {
            alert(`Analysis failed: ${err.message}`);
        } finally {
            calcBtn.disabled = false;
            calcBtn.textContent = "Compute Statistics";
        }
    });

})();