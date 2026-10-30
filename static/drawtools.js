/* ============================================================================
 * drawtools.js — Interactive Drawing Primitives & Layout Manager for
 *                TradingView Lightweight Charts
 * ============================================================================
 * Implements all 9 TradingView drawing tools on the synchronized Lightweight
 * Charts coordinate space (TimeScale logical/timestamp + PriceScale linear/log):
 *   1. trendLine       — 2-point trend line
 *   2. horizontalLine  — 1-point full-width price level with price badge
 *   3. horizontalRay   — 2-point directional horizontal ray with price badge
 *   4. verticalLine    — 1-point vertical time marker
 *   5. longPosition    — 3-point Long R/R tool (Entry, TP, SL, R/R ratio)
 *   6. shortPosition   — 3-point Short R/R tool (Entry, TP, SL, R/R ratio)
 *   7. priceRange      — 2-point horizontal price range band
 *   8. dateRange       — 2-point vertical time & bar count range band
 *   9. datePriceRange  — 2-point combined Date & Price box
 *
 * Workspace persistence (manual, per (asset, timeframe)):
 *   Save   - captures drawings + indicators + SMC settings + scale mode (Log/Linear)
 *            to localStorage under tv_workspace:<asset>:<timeframe>.
 *   Load   - lists every saved layout for the current asset; restores drawings,
 *            indicators, SMC settings, and scale mode.
 *   Delete - removes the saved layout for the current (asset, timeframe).
 *   Clear  - wipes only the drawings currently on the chart.
 * ==========================================================================*/
(function () {
    'use strict';

    /* ============================================================
     * 0. Formatting & Drawing Helpers
     * ============================================================ */
    const C = {
        line:      '#2962FF',
        green:     '#089981',
        red:       '#f23645',
        greenFill: 'rgba(8, 153, 129, 0.15)',
        redFill:   'rgba(242, 54, 69, 0.15)',
        blueFill:  'rgba(41, 98, 255, 0.11)',
        blueEdge:  'rgba(41, 98, 255, 0.88)',
        neutral:   '#787b86'
    };

    function fmtPrice(v) {
        if (typeof v !== 'number' || isNaN(v)) return '--';
        if (Math.abs(v) >= 1000) return v.toFixed(2);
        if (Math.abs(v) >= 1)    return v.toFixed(2);
        return v.toFixed(4);
    }

    function fmtPct(v) {
        if (typeof v !== 'number' || isNaN(v)) return '--';
        const sign = v >= 0 ? '+' : '';
        return sign + v.toFixed(2) + '%';
    }

    function fmtDate(ts) {
        if (!ts) return '--';
        const d = new Date(ts);
        const pad = function (n) { return String(n).padStart(2, '0'); };
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }

    function fmtDuration(ms) {
        if (!ms || ms < 0) return '--';
        const totalMin = Math.floor(ms / 60000);
        const days = Math.floor(totalMin / 1440);
        const hours = Math.floor((totalMin % 1440) / 60);
        const mins = totalMin % 60;
        if (days > 0) return days + 'd ' + hours + 'h';
        if (hours > 0) return hours + 'h ' + mins + 'm';
        return mins + 'm';
    }

    function drawBadge(ctx, x, y, text, bgColor, align, baseline) {
        if (!text) return;
        ctx.save();
        ctx.font = "600 11px Arial, sans-serif";
        const padX = 6;
        const padY = 3;
        const metrics = ctx.measureText(text);
        const w = Math.ceil(metrics.width) + padX * 2;
        const h = 18;

        let rx = x;
        if (align === 'center') rx = x - w / 2;
        else if (align === 'right') rx = x - w;

        let ry = y;
        if (baseline === 'middle') ry = y - h / 2;
        else if (baseline === 'bottom') ry = y - h;

        ctx.fillStyle = bgColor;
        ctx.beginPath();
        if (typeof ctx.roundRect === 'function') {
            ctx.roundRect(rx, ry, w, h, 3);
        } else {
            ctx.rect(rx, ry, w, h);
        }
        ctx.fill();

        ctx.fillStyle = '#ffffff';
        ctx.textAlign = 'left';
        ctx.textBaseline = 'middle';
        ctx.fillText(text, rx + padX, ry + h / 2 + 0.5);
        ctx.restore();
    }

    function drawHandle(ctx, x, y, isSelected, color) {
        ctx.save();
        ctx.beginPath();
        ctx.arc(x, y, isSelected ? 4.5 : 3.5, 0, Math.PI * 2);
        ctx.fillStyle = '#ffffff';
        ctx.fill();
        ctx.lineWidth = 1.8;
        ctx.strokeStyle = color || '#2962FF';
        ctx.stroke();
        ctx.restore();
    }

    function hexToRgba(hex, alpha) {
        const a = (typeof alpha === 'number' && !isNaN(alpha)) ? Math.max(0, Math.min(1, alpha)) : 1;
        if (!hex || typeof hex !== 'string') return 'rgba(41, 98, 255, ' + a + ')';
        const clean = hex.trim();
        if (clean.indexOf('rgb') === 0) {
            const m = clean.match(/(\d+)\s*,\s*(\d+)\s*,\s*(\d+)/);
            if (m) return 'rgba(' + m[1] + ', ' + m[2] + ', ' + m[3] + ', ' + a + ')';
            return clean;
        }
        let h = clean.replace('#', '');
        if (h.length === 3) {
            h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
        }
        const num = parseInt(h, 16);
        if (isNaN(num)) return 'rgba(41, 98, 255, ' + a + ')';
        const r = (num >> 16) & 255;
        const g = (num >> 8) & 255;
        const b = num & 255;
        return 'rgba(' + r + ', ' + g + ', ' + b + ', ' + a + ')';
    }

    const DRAW_DEFAULTS_STORAGE_KEY = 'tv_draw_default_styles_v1';
    let savedToolDefaultStyles = {};
    try {
        const raw = window.localStorage && window.localStorage.getItem(DRAW_DEFAULTS_STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object') savedToolDefaultStyles = parsed;
        }
    } catch (e) {}

    function persistSavedToolDefaults() {
        try {
            if (window.localStorage) {
                window.localStorage.setItem(DRAW_DEFAULTS_STORAGE_KEY, JSON.stringify(savedToolDefaultStyles));
            }
        } catch (e) {}
    }

    function factoryStyleForTool(toolName) {
        const isPos = (toolName === 'longPosition' || toolName === 'shortPosition');
        const isRange = (toolName === 'priceRange' || toolName === 'datePriceRange');
        return {
            color: isPos ? '#089981' : '#2962ff',
            opacity: 100,
            lineWidth: isPos ? 1 : 2,
            lineStyle: 'solid',
            customColor: !(isPos || isRange),
            extendLeft: false,
            extendRight: false,
            locked: false
        };
    }

    function defaultStyleForTool(toolName) {
        const fac = factoryStyleForTool(toolName);
        const saved = toolName && savedToolDefaultStyles[toolName];
        if (!saved || typeof saved !== 'object') return fac;
        return {
            color: saved.color || fac.color,
            opacity: typeof saved.opacity === 'number' ? saved.opacity : fac.opacity,
            lineWidth: typeof saved.lineWidth === 'number' ? saved.lineWidth : fac.lineWidth,
            lineStyle: saved.lineStyle || fac.lineStyle,
            customColor: typeof saved.customColor === 'boolean' ? saved.customColor : fac.customColor,
            extendLeft: typeof saved.extendLeft === 'boolean' ? saved.extendLeft : fac.extendLeft,
            extendRight: typeof saved.extendRight === 'boolean' ? saved.extendRight : fac.extendRight,
            locked: false
        };
    }

    function getDrawingStyle(d) {
        const def = defaultStyleForTool(d && d.name);
        if (!d || !d.style) return def;
        return {
            color: d.style.color || def.color,
            opacity: (typeof d.style.opacity === 'number' && !isNaN(d.style.opacity)) ? d.style.opacity : def.opacity,
            lineWidth: (typeof d.style.lineWidth === 'number' && d.style.lineWidth >= 1) ? d.style.lineWidth : def.lineWidth,
            lineStyle: d.style.lineStyle || def.lineStyle,
            customColor: typeof d.style.customColor === 'boolean' ? d.style.customColor : def.customColor,
            extendLeft: typeof d.style.extendLeft === 'boolean' ? d.style.extendLeft : def.extendLeft,
            extendRight: typeof d.style.extendRight === 'boolean' ? d.style.extendRight : def.extendRight,
            locked: typeof d.style.locked === 'boolean' ? d.style.locked : false
        };
    }

    function getTrendLineRenderEndpoints(coords, plotWidth, plotHeight, extendLeft, extendRight) {
        const p0 = coords[0];
        const p1 = coords[1];
        if (!extendLeft && !extendRight) {
            return { x1: p0.x, y1: p0.y, x2: p1.x, y2: p1.y };
        }
        const leftPt  = p0.x <= p1.x ? p0 : p1;
        const rightPt = p0.x <= p1.x ? p1 : p0;
        const dx = rightPt.x - leftPt.x;
        const dy = rightPt.y - leftPt.y;

        if (Math.abs(dx) < 0.0001) {
            const topY = Math.min(p0.y, p1.y);
            const botY = Math.max(p0.y, p1.y);
            return {
                x1: leftPt.x,
                y1: extendLeft ? Math.min(0, topY) : topY,
                x2: rightPt.x,
                y2: extendRight ? Math.max(plotHeight, botY) : botY
            };
        }

        const slope  = dy / dx;
        const startX = extendLeft ? Math.min(0, leftPt.x) : leftPt.x;
        const startY = leftPt.y + slope * (startX - leftPt.x);
        const endX   = extendRight ? Math.max(plotWidth, rightPt.x) : rightPt.x;
        const endY   = rightPt.y + slope * (endX - rightPt.x);

        return { x1: startX, y1: startY, x2: endX, y2: endY };
    }

    function applyLineStyleToCtx(ctx, lineStyle, lineWidth) {
        const w = Math.max(1, lineWidth || 2);
        if (lineStyle === 'dashed') {
            ctx.setLineDash([Math.max(5, w * 3), Math.max(4, w * 2)]);
        } else if (lineStyle === 'dotted') {
            ctx.setLineDash([Math.max(1.5, w * 0.9), Math.max(3, w * 1.8)]);
        } else {
            ctx.setLineDash([]);
        }
    }

    function distToSegment(px, py, x1, y1, x2, y2) {
        const dx = x2 - x1;
        const dy = y2 - y1;
        const lenSq = dx * dx + dy * dy;
        if (lenSq === 0) return Math.hypot(px - x1, py - y1);
        let t = ((px - x1) * dx + (py - y1) * dy) / lenSq;
        t = Math.max(0, Math.min(1, t));
        return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy));
    }

    /* ============================================================
     * 1. Tool Definitions & Step Counts
     * ============================================================ */
    const TV_ICONS = {
        trendLine:
            '<line x1="3.5" y1="14.5" x2="14.5" y2="3.5"/>' +
            '<circle cx="3.5" cy="14.5" r="1.6" fill="currentColor" stroke="none"/>' +
            '<circle cx="14.5" cy="3.5" r="1.6" fill="currentColor" stroke="none"/>',

        horizontalLine:
            '<line x1="3" y1="5"  x2="15" y2="5"/>' +
            '<line x1="3" y1="9"  x2="15" y2="9"/>' +
            '<line x1="3" y1="13" x2="15" y2="13"/>' +
            '<circle cx="12.5" cy="9" r="1.6" fill="currentColor" stroke="none"/>',

        horizontalRay:
            '<line x1="3.5" y1="5"  x2="14.5" y2="5"  stroke-dasharray="1.6 1.6"/>' +
            '<line x1="3"   y1="9"  x2="15"   y2="9"/>' +
            '<line x1="3.5" y1="13" x2="14.5" y2="13" stroke-dasharray="1.6 1.6"/>' +
            '<circle cx="3.8" cy="9" r="1.6" fill="currentColor" stroke="none"/>',

        verticalLine:
            '<line x1="5"  y1="3" x2="5"  y2="15"/>' +
            '<line x1="9"  y1="3" x2="9"  y2="15"/>' +
            '<line x1="13" y1="3" x2="13" y2="15"/>' +
            '<circle cx="9" cy="12.5" r="1.6" fill="currentColor" stroke="none"/>',

        longPosition:
            '<line x1="3.5" y1="4.5"  x2="3.5"  y2="13.5"/>' +
            '<line x1="3.5" y1="4.5"  x2="11"   y2="4.5"/>'  +
            '<line x1="3.5" y1="13.5" x2="14.5" y2="13.5"/>' +
            '<circle cx="3.5"  cy="4.5"  r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="11"   cy="4.5"  r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="3.5"  cy="13.5" r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="14.5" cy="13.5" r="1.4" fill="currentColor" stroke="none"/>',

        shortPosition:
            '<line x1="3.5" y1="4.5"  x2="3.5"  y2="13.5"/>' +
            '<line x1="3.5" y1="4.5"  x2="14.5" y2="4.5"/>'  +
            '<line x1="3.5" y1="13.5" x2="11"   y2="13.5"/>' +
            '<circle cx="3.5"  cy="4.5"  r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="14.5" cy="4.5"  r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="3.5"  cy="13.5" r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="11"   cy="13.5" r="1.4" fill="currentColor" stroke="none"/>',

        priceRange:
            '<line x1="4" y1="4"  x2="14" y2="4"/>' +
            '<line x1="4" y1="14" x2="14" y2="14"/>' +
            '<line x1="9" y1="5"  x2="9"  y2="13"/>' +
            '<polyline points="6.5,6.5 9,4 11.5,6.5"   fill="none"/>' +
            '<polyline points="6.5,11.5 9,14 11.5,11.5" fill="none"/>',

        dateRange:
            '<line x1="4"  y1="4" x2="4"  y2="14"/>' +
            '<line x1="14" y1="4" x2="14" y2="14"/>' +
            '<line x1="5"  y1="9" x2="13" y2="9"/>' +
            '<polyline points="6.5,6.5 4,9 6.5,11.5"   fill="none"/>' +
            '<polyline points="11.5,6.5 14,9 11.5,11.5" fill="none"/>',

        datePriceRange:
            '<rect x="4" y="4" width="10" height="10" fill="none"/>' +
            '<line x1="4" y1="9"  x2="14" y2="9"  stroke-dasharray="1.4 1.4" opacity="0.55"/>' +
            '<line x1="9" y1="4"  x2="9"  y2="14" stroke-dasharray="1.4 1.4" opacity="0.55"/>' +
            '<circle cx="4"  cy="4"  r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="14" cy="4"  r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="4"  cy="14" r="1.4" fill="currentColor" stroke="none"/>' +
            '<circle cx="14" cy="14" r="1.4" fill="currentColor" stroke="none"/>',

        trash:
            '<polyline points="3.5,5 14.5,5" fill="none"/>' +
            '<path d="M6,5 L6.5,15 L11.5,15 L12,5" fill="none"/>' +
            '<path d="M7.5,5 L7.5,3.5 L10.5,3.5 L10.5,5" fill="none"/>' +
            '<line x1="8"   y1="7.5" x2="8.3"  y2="12.5"/>' +
            '<line x1="10"  y1="7.5" x2="9.7"  y2="12.5"/>',

        chevronDown:
            '<polyline points="4,6.5 9,12 14,6.5" fill="none"/>',

        save:
            '<path d="M3 3 L11 3 L15 7 L15 15 L3 15 Z" fill="none"/>' +
            '<path d="M6 3 L6 8 L12 8 L12 3" fill="none"/>' +
            '<rect x="6" y="10.5" width="6" height="4.5" fill="none"/>',

        load:
            '<path d="M9 2.5 L9 10" fill="none"/>' +
            '<polyline points="5.5,7 9,10.5 12.5,7" fill="none"/>' +
            '<path d="M3 12 L3 14.5 L15 14.5 L15 12" fill="none"/>',

        deleteSaved:
            '<path d="M4 5 L14 5" fill="none"/>' +
            '<path d="M6 5 L6.5 15 L11.5 15 L12 5" fill="none"/>' +
            '<path d="M7.5 5 L7.5 3.5 L10.5 3.5 L10.5 5" fill="none"/>',

        lock:
            '<rect x="4" y="8" width="10" height="7" rx="1.5" fill="none"/>' +
            '<path d="M6 8 V5.5 a3 3 0 0 1 6 0 V8" fill="none"/>'
    };

    const TOOLS = [
        { name: 'trendLine',      title: 'Trend Line',         pointsNeeded: 2, icon: TV_ICONS.trendLine },
        { name: 'horizontalLine', title: 'Horizontal Line',    pointsNeeded: 1, icon: TV_ICONS.horizontalLine },
        { name: 'horizontalRay',  title: 'Horizontal Ray',     pointsNeeded: 2, icon: TV_ICONS.horizontalRay },
        { name: 'verticalLine',   title: 'Vertical Line',      pointsNeeded: 1, icon: TV_ICONS.verticalLine },
        { name: 'longPosition',   title: 'Long Position',      pointsNeeded: 3, icon: TV_ICONS.longPosition },
        { name: 'shortPosition',  title: 'Short Position',     pointsNeeded: 3, icon: TV_ICONS.shortPosition },
        { name: 'priceRange',     title: 'Price Range',        pointsNeeded: 2, icon: TV_ICONS.priceRange },
        { name: 'dateRange',      title: 'Date Range',         pointsNeeded: 2, icon: TV_ICONS.dateRange },
        { name: 'datePriceRange', title: 'Date & Price Range', pointsNeeded: 2, icon: TV_ICONS.datePriceRange }
    ];

    const TOOL_NAMES = TOOLS.map(function (t) { return t.name; });
    const TOOL_MAP = {};
    TOOLS.forEach(function (t) { TOOL_MAP[t.name] = t; });

    function makeIconSVG(body, size) {
        const s = size || 18;
        const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('viewBox', '0 0 18 18');
        svg.setAttribute('width', s);
        svg.setAttribute('height', s);
        svg.setAttribute('fill', 'none');
        svg.setAttribute('stroke', 'currentColor');
        svg.setAttribute('stroke-width', '1.4');
        svg.setAttribute('stroke-linecap', 'round');
        svg.setAttribute('stroke-linejoin', 'round');
        svg.innerHTML = body;
        return svg;
    }

    /* ============================================================
     * 2. Drawing State & Rendering Engine on Lightweight Charts
     * ============================================================ */
    const drawings = [];
    let nextDrawingId = 1;
    let activeTool = null;
    let draftDrawing = null;
    let hoveredDrawingId = null;
    let selectedDrawingId = null;
    let dragState = null; // { drawing, pointIndex }
    let allDrawingsLocked = false;

    function isDrawingLocked(d) {
        if (allDrawingsLocked) return true;
        const st = getDrawingStyle(d);
        return !!st.locked;
    }

    function resolveBarIndexForTimestamp(tsMs) {
        const bars = (window.ChartState && window.ChartState.currentBars) || [];
        if (bars.length === 0 || !tsMs) return null;
        const timeSec = Math.floor(tsMs / 1000);
        const exact = window.ChartState.timeToIndex && window.ChartState.timeToIndex.get(timeSec);
        if (exact !== undefined) return exact;
        let lo = 0, hi = bars.length - 1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (bars[mid].timestamp < tsMs) lo = mid + 1;
            else hi = mid - 1;
        }
        return Math.max(0, Math.min(bars.length - 1, lo));
    }

    function applyPointConstraints(drawing, pointIdx) {
        const pts = drawing.points;
        if (!pts || pts.length === 0) return;

        if (drawing.name === 'horizontalRay' && pts.length >= 2) {
            if (pointIdx === 0) pts[1].value = pts[0].value;
            else pts[0].value = pts[1].value;
        } else if (drawing.name === 'longPosition') {
            const delta = Math.max(Math.abs(pts[0].value) * 0.01, 0.5);
            if (pts.length >= 2 && pts[1].value <= pts[0].value) {
                pts[1].value = pts[0].value + delta;
            }
            if (pts.length >= 3) {
                if (pts[2].value >= pts[0].value) {
                    pts[2].value = pts[0].value - delta;
                }
                if (pointIdx === 1) {
                    pts[2].timestamp = pts[1].timestamp;
                    pts[2].dataIndex = pts[1].dataIndex;
                } else if (pointIdx === 2) {
                    pts[1].timestamp = pts[2].timestamp;
                    pts[1].dataIndex = pts[2].dataIndex;
                }
            }
        } else if (drawing.name === 'shortPosition') {
            const delta = Math.max(Math.abs(pts[0].value) * 0.01, 0.5);
            if (pts.length >= 2 && pts[1].value >= pts[0].value) {
                pts[1].value = pts[0].value - delta;
            }
            if (pts.length >= 3) {
                if (pts[2].value <= pts[0].value) {
                    pts[2].value = pts[0].value + delta;
                }
                if (pointIdx === 1) {
                    pts[2].timestamp = pts[1].timestamp;
                    pts[2].dataIndex = pts[1].dataIndex;
                } else if (pointIdx === 2) {
                    pts[1].timestamp = pts[2].timestamp;
                    pts[1].dataIndex = pts[2].dataIndex;
                }
            }
        }
    }

    function renderSingleDrawing(ctx, helpers, d, isDraft) {
        const pts = d.points || [];
        if (pts.length === 0) return;

        const coords = [];
        for (let i = 0; i < pts.length; i++) {
            const x = helpers.timeToX(pts[i].timestamp);
            const y = helpers.priceToY(pts[i].value);
            if (x === null || y === null) return;
            coords.push({ x: x, y: y, value: pts[i].value, timestamp: pts[i].timestamp });
        }

        const isHovered = (d.id === hoveredDrawingId);
        const isSelected = (d.id === selectedDrawingId);
        const showHandles = isDraft || isHovered || isSelected;
        const showPositionLabels = isDraft || isHovered || isSelected;

        const st = getDrawingStyle(d);
        const alpha = Math.max(0.05, Math.min(1, st.opacity / 100));
        const baseWidth = st.lineWidth || 2;
        const activeWidth = (isHovered || isSelected) ? Math.min(baseWidth + 0.5, 6) : baseWidth;
        const mainStroke = hexToRgba(st.color, alpha);
        const badgeColor = hexToRgba(st.color, Math.max(0.55, alpha));

        ctx.save();

        if (d.name === 'trendLine') {
            if (coords.length >= 2) {
                const seg = getTrendLineRenderEndpoints(
                    coords,
                    helpers.plotWidth,
                    helpers.plotHeight,
                    !!st.extendLeft,
                    !!st.extendRight
                );
                ctx.strokeStyle = mainStroke;
                ctx.lineWidth = activeWidth;
                applyLineStyleToCtx(ctx, st.lineStyle, baseWidth);
                ctx.beginPath();
                ctx.moveTo(seg.x1, seg.y1);
                ctx.lineTo(seg.x2, seg.y2);
                ctx.stroke();
                ctx.setLineDash([]);
            }
        } else if (d.name === 'horizontalLine') {
            const y = coords[0].y;
            ctx.strokeStyle = mainStroke;
            ctx.lineWidth = activeWidth;
            applyLineStyleToCtx(ctx, st.lineStyle, baseWidth);
            ctx.beginPath();
            ctx.moveTo(0, y);
            ctx.lineTo(helpers.plotWidth, y);
            ctx.stroke();
            ctx.setLineDash([]);
            drawBadge(ctx, helpers.plotWidth - 6, y - 6, fmtPrice(coords[0].value), badgeColor, 'right', 'bottom');
        } else if (d.name === 'horizontalRay') {
            const y = coords[0].y;
            const pointsRight = coords.length < 2 || coords[0].x <= coords[1].x;
            const startX = st.extendLeft ? 0 : (pointsRight ? coords[0].x : 0);
            const endX   = st.extendRight ? helpers.plotWidth : (pointsRight ? helpers.plotWidth : coords[0].x);
            ctx.strokeStyle = mainStroke;
            ctx.lineWidth = activeWidth;
            applyLineStyleToCtx(ctx, st.lineStyle, baseWidth);
            ctx.beginPath();
            ctx.moveTo(startX, y);
            ctx.lineTo(endX, y);
            ctx.stroke();
            ctx.setLineDash([]);
            drawBadge(
                ctx,
                endX === helpers.plotWidth ? endX - 6 : startX + 6,
                y - 6,
                fmtPrice(coords[0].value),
                badgeColor,
                endX === helpers.plotWidth ? 'right' : 'left',
                'bottom'
            );
        } else if (d.name === 'verticalLine') {
            const x = coords[0].x;
            ctx.strokeStyle = mainStroke;
            ctx.lineWidth = activeWidth;
            applyLineStyleToCtx(ctx, st.lineStyle, baseWidth);
            ctx.beginPath();
            ctx.moveTo(x, 0);
            ctx.lineTo(x, helpers.plotHeight);
            ctx.stroke();
            ctx.setLineDash([]);
            drawBadge(ctx, x, helpers.plotHeight - 6, fmtDate(coords[0].timestamp), badgeColor, 'center', 'bottom');
        } else if (d.name === 'longPosition' || d.name === 'shortPosition') {
            if (coords.length >= 2) {
                const isLong = d.name === 'longPosition';
                const entry = coords[0].value;
                const target = coords[1].value;
                const fallbackDelta = Math.max(Math.abs(entry) * 0.015, 0.5);
                const stopVal = coords.length > 2
                    ? coords[2].value
                    : (isLong ? entry - fallbackDelta : entry + fallbackDelta);
                const stopY = coords.length > 2 ? coords[2].y : (helpers.priceToY(stopVal) || coords[0].y);
                const stopX = coords.length > 2 ? coords[2].x : coords[1].x;

                const gain = isLong ? Math.abs(target - entry) : Math.abs(entry - target);
                const loss = Math.abs(stopVal - entry);
                const rr = loss > 0 ? (gain / loss).toFixed(2) + ':1' : '1:0';
                const gainPct = entry !== 0 ? ((target - entry) / Math.abs(entry)) * 100 : 0;
                const lossPct = entry !== 0 ? ((stopVal - entry) / Math.abs(entry)) * 100 : 0;

                const tpBaseHex = st.customColor ? st.color : C.green;
                const tpFill = hexToRgba(tpBaseHex, 0.16 * alpha);
                const tpEdge = hexToRgba(tpBaseHex, alpha);
                const slFill = hexToRgba(C.red, 0.16 * alpha);
                const slEdge = hexToRgba(C.red, alpha);

                // TP Zone
                const gxLeft  = st.extendLeft ? 0 : Math.min(coords[0].x, coords[1].x);
                const gxRight = st.extendRight ? helpers.plotWidth : Math.max(coords[0].x, coords[1].x);
                const gy = Math.min(coords[0].y, coords[1].y);
                const gw = Math.max(2, gxRight - gxLeft);
                const gh = Math.abs(coords[1].y - coords[0].y);
                ctx.fillStyle = tpFill;
                ctx.strokeStyle = tpEdge;
                ctx.lineWidth = baseWidth;
                applyLineStyleToCtx(ctx, st.lineStyle, baseWidth);
                ctx.fillRect(gxLeft, gy, gw, gh);
                ctx.strokeRect(gxLeft, gy, gw, gh);

                // SL Red Zone
                const rxLeft  = st.extendLeft ? 0 : Math.min(coords[0].x, stopX);
                const rxRight = st.extendRight ? helpers.plotWidth : Math.max(coords[0].x, stopX);
                const ry = Math.min(coords[0].y, stopY);
                const rw = Math.max(2, rxRight - rxLeft);
                const rh = Math.abs(stopY - coords[0].y);
                ctx.fillStyle = slFill;
                ctx.strokeStyle = slEdge;
                ctx.fillRect(rxLeft, ry, rw, rh);
                ctx.strokeRect(rxLeft, ry, rw, rh);
                ctx.setLineDash([]);

                // Dashed Entry Line
                ctx.save();
                ctx.strokeStyle = C.neutral;
                ctx.lineWidth = Math.max(1, baseWidth);
                ctx.setLineDash([4, 4]);
                ctx.beginPath();
                ctx.moveTo(gxLeft, coords[0].y);
                ctx.lineTo(gxRight, coords[0].y);
                ctx.stroke();
                ctx.restore();

                if (showPositionLabels) {
                    drawBadge(
                        ctx,
                        coords[0].x + (coords[1].x - coords[0].x) / 2,
                        coords[0].y + (coords[1].y - coords[0].y) / 2,
                        'TP ' + fmtPrice(target) + '  ' + fmtPct(gainPct),
                        tpBaseHex,
                        'center',
                        'middle'
                    );
                    drawBadge(
                        ctx,
                        coords[0].x + (stopX - coords[0].x) / 2,
                        coords[0].y + (stopY - coords[0].y) / 2,
                        'SL ' + fmtPrice(stopVal) + '  ' + fmtPct(lossPct),
                        C.red,
                        'center',
                        'middle'
                    );
                    drawBadge(
                        ctx,
                        coords[1].x + 6,
                        Math.min(coords[1].y, stopY) - 6,
                        'R/R ' + rr,
                        C.neutral,
                        'left',
                        'bottom'
                    );
                    drawBadge(
                        ctx,
                        coords[0].x - 6,
                        coords[0].y,
                        'Entry ' + fmtPrice(entry),
                        C.neutral,
                        'right',
                        'middle'
                    );
                }
            }
        } else if (d.name === 'priceRange') {
            if (coords.length >= 2) {
                const p1 = coords[0].value;
                const p2 = coords[1].value;
                const hi = Math.max(p1, p2);
                const lo = Math.min(p1, p2);
                const yTop = Math.min(coords[0].y, coords[1].y);
                const yBot = Math.max(coords[0].y, coords[1].y);
                const pct = lo !== 0 ? ((hi - lo) / Math.abs(lo)) * 100 : 0;

                let baseHex = C.line;
                if (st.customColor) {
                    baseHex = st.color;
                } else if (p2 > p1) {
                    baseHex = C.green;
                } else if (p2 < p1) {
                    baseHex = C.red;
                }

                ctx.fillStyle = hexToRgba(baseHex, 0.15 * alpha);
                ctx.strokeStyle = hexToRgba(baseHex, alpha);
                ctx.lineWidth = baseWidth;
                applyLineStyleToCtx(ctx, st.lineStyle, baseWidth);
                ctx.fillRect(0, yTop, helpers.plotWidth, yBot - yTop);
                ctx.strokeRect(0, yTop, helpers.plotWidth, yBot - yTop);
                ctx.setLineDash([]);

                const bColor = hexToRgba(baseHex, Math.max(0.6, alpha));
                drawBadge(ctx, helpers.plotWidth - 6, yTop + 4, fmtPrice(hi), bColor, 'right', 'top');
                drawBadge(ctx, helpers.plotWidth - 6, yBot - 4, fmtPrice(lo), bColor, 'right', 'bottom');
                drawBadge(ctx, helpers.plotWidth / 2, (yTop + yBot) / 2, fmtPct(pct), bColor, 'center', 'middle');
            }
        } else if (d.name === 'dateRange') {
            if (coords.length >= 2) {
                const xL = st.extendLeft ? 0 : Math.min(coords[0].x, coords[1].x);
                const xR = st.extendRight ? helpers.plotWidth : Math.max(coords[0].x, coords[1].x);
                const t1 = coords[0].timestamp;
                const t2 = coords[1].timestamp;
                const i1 = resolveBarIndexForTimestamp(t1);
                const i2 = resolveBarIndexForTimestamp(t2);
                const barCount = (i1 !== null && i2 !== null) ? Math.abs(i2 - i1) + 1 : '--';
                const dur = fmtDuration(Math.abs(t2 - t1));

                const baseHex = st.color || C.line;
                ctx.fillStyle = hexToRgba(baseHex, 0.12 * alpha);
                ctx.strokeStyle = hexToRgba(baseHex, 0.88 * alpha);
                ctx.lineWidth = baseWidth;
                applyLineStyleToCtx(ctx, st.lineStyle, baseWidth);
                ctx.fillRect(xL, 0, xR - xL, helpers.plotHeight);
                ctx.strokeRect(xL, 0, xR - xL, helpers.plotHeight);
                ctx.setLineDash([]);

                drawBadge(ctx, xL + 4, 12, fmtDate(Math.min(t1, t2)), badgeColor, 'left', 'top');
                drawBadge(ctx, xR - 4, 12, fmtDate(Math.max(t1, t2)), badgeColor, 'right', 'top');
                drawBadge(ctx, (xL + xR) / 2, helpers.plotHeight / 2, barCount + ' bars  |  ' + dur, badgeColor, 'center', 'middle');
            }
        } else if (d.name === 'datePriceRange') {
            if (coords.length >= 2) {
                const xL = st.extendLeft ? 0 : Math.min(coords[0].x, coords[1].x);
                const xR = st.extendRight ? helpers.plotWidth : Math.max(coords[0].x, coords[1].x);
                const yT = Math.min(coords[0].y, coords[1].y);
                const yB = Math.max(coords[0].y, coords[1].y);
                const p1 = coords[0].value;
                const p2 = coords[1].value;
                const hi = Math.max(p1, p2);
                const lo = Math.min(p1, p2);
                const pct = lo !== 0 ? ((hi - lo) / Math.abs(lo)) * 100 : 0;
                const t1 = coords[0].timestamp;
                const t2 = coords[1].timestamp;
                const i1 = resolveBarIndexForTimestamp(t1);
                const i2 = resolveBarIndexForTimestamp(t2);
                const barCount = (i1 !== null && i2 !== null) ? Math.abs(i2 - i1) + 1 : '--';
                const dur = fmtDuration(Math.abs(t2 - t1));

                let baseHex = C.line;
                if (st.customColor) {
                    baseHex = st.color;
                } else if (p2 > p1) {
                    baseHex = C.green;
                } else if (p2 < p1) {
                    baseHex = C.red;
                }

                ctx.fillStyle = hexToRgba(baseHex, 0.15 * alpha);
                ctx.strokeStyle = hexToRgba(baseHex, alpha);
                ctx.lineWidth = baseWidth;
                applyLineStyleToCtx(ctx, st.lineStyle, baseWidth);
                ctx.fillRect(xL, yT, xR - xL, yB - yT);
                ctx.strokeRect(xL, yT, xR - xL, yB - yT);
                ctx.setLineDash([]);

                const bColor = hexToRgba(baseHex, Math.max(0.6, alpha));
                drawBadge(ctx, xR - 4, yT + 4, fmtPrice(hi), bColor, 'right', 'top');
                drawBadge(ctx, xR - 4, yB - 4, fmtPrice(lo), bColor, 'right', 'bottom');
                drawBadge(ctx, (xL + xR) / 2, (yT + yB) / 2, fmtPct(pct) + '  |  ' + barCount + ' bars  |  ' + dur, bColor, 'center', 'middle');
            }
        }

        if (showHandles && !isDrawingLocked(d)) {
            for (let k = 0; k < coords.length; k++) {
                drawHandle(ctx, coords[k].x, coords[k].y, isSelected, st.color);
            }
        }

        ctx.restore();
    }

    function drawAllDrawingsOnCanvas(ctx, helpers) {
        const targetPaneId = (helpers && helpers.paneId) || 'candle_pane';
        for (let i = 0; i < drawings.length; i++) {
            const d = drawings[i];
            if ((d.paneId || 'candle_pane') !== targetPaneId) continue;
            renderSingleDrawing(ctx, helpers, d, false);
        }
        if (draftDrawing && (draftDrawing.paneId || 'candle_pane') === targetPaneId) {
            renderSingleDrawing(ctx, helpers, draftDrawing, true);
        }
    }

    /* ============================================================
     * 3. Multi-Pane Coordinate Resolution, Hit Testing & Mouse Handling
     * ============================================================ */
    function getPaneHelpers(paneId) {
        const resolvedPaneId = paneId || 'candle_pane';
        const dims = (window.ChartState && typeof window.ChartState.getPanePlotDimensions === 'function')
            ? window.ChartState.getPanePlotDimensions(resolvedPaneId)
            : {
                plotWidth: window.ChartState.mainPaneEl ? window.ChartState.mainPaneEl.clientWidth - 78 : 800,
                plotHeight: window.ChartState.mainPaneEl ? window.ChartState.mainPaneEl.clientHeight - 28 : 500
            };
        return {
            paneId: resolvedPaneId,
            plotWidth: dims.plotWidth,
            plotHeight: dims.plotHeight,
            timeToX: window.ChartState.timeToX,
            priceToY: function (price) {
                return window.ChartState.priceToYForPane
                    ? window.ChartState.priceToYForPane(resolvedPaneId, price)
                    : window.ChartState.priceToY(price);
            },
            yToPrice: function (y) {
                return window.ChartState.yToPriceForPane
                    ? window.ChartState.yToPriceForPane(resolvedPaneId, y)
                    : window.ChartState.yToPrice(y);
            }
        };
    }

    function getPaneContainerEl(paneId) {
        if (!window.ChartState) return null;
        if (!paneId || paneId === 'candle_pane') {
            return window.ChartState.mainPaneEl;
        }
        const sub = window.ChartState.subPanes && window.ChartState.subPanes.get(paneId);
        return sub ? (sub.containerEl || sub.container) : null;
    }

    function resolvePaneAtClientXY(clientX, clientY) {
        if (!window.ChartState) return null;
        const mainEl = window.ChartState.mainPaneEl;
        if (mainEl) {
            const r = mainEl.getBoundingClientRect();
            if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
                const dims = window.ChartState.getPanePlotDimensions
                    ? window.ChartState.getPanePlotDimensions('candle_pane')
                    : { plotWidth: Math.max(0, mainEl.clientWidth - 78), plotHeight: Math.max(0, mainEl.clientHeight - 28) };
                return {
                    paneId: 'candle_pane',
                    el: mainEl,
                    x: clientX - r.left,
                    y: clientY - r.top,
                    plotWidth: dims.plotWidth,
                    plotHeight: dims.plotHeight
                };
            }
        }
        if (window.ChartState.subPanes) {
            for (const [paneId, sub] of window.ChartState.subPanes.entries()) {
                const subEl = sub && (sub.containerEl || sub.container);
                if (!subEl) continue;
                const r = subEl.getBoundingClientRect();
                if (clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom) {
                    const dims = window.ChartState.getPanePlotDimensions
                        ? window.ChartState.getPanePlotDimensions(paneId)
                        : { plotWidth: Math.max(0, subEl.clientWidth - 78), plotHeight: Math.max(0, subEl.clientHeight) };
                    return {
                        paneId: paneId,
                        el: subEl,
                        x: clientX - r.left,
                        y: clientY - r.top,
                        plotWidth: dims.plotWidth,
                        plotHeight: dims.plotHeight
                    };
                }
            }
        }
        return null;
    }

    function getLocalCoordsForPane(paneId, clientX, clientY) {
        const el = getPaneContainerEl(paneId);
        if (!el) return null;
        const r = el.getBoundingClientRect();
        const dims = window.ChartState.getPanePlotDimensions
            ? window.ChartState.getPanePlotDimensions(paneId)
            : { plotWidth: Math.max(0, el.clientWidth - 78), plotHeight: Math.max(0, el.clientHeight) };
        return {
            paneId: paneId || 'candle_pane',
            el: el,
            x: clientX - r.left,
            y: clientY - r.top,
            plotWidth: dims.plotWidth,
            plotHeight: dims.plotHeight
        };
    }

    function setCursorOnAllPanes(cursorValue) {
        if (!window.ChartState) return;
        if (window.ChartState.mainPaneEl) {
            window.ChartState.mainPaneEl.style.cursor = cursorValue || '';
        }
        if (window.ChartState.subPanes) {
            window.ChartState.subPanes.forEach(function (sub) {
                const subEl = sub && (sub.containerEl || sub.container);
                if (subEl) {
                    subEl.style.cursor = cursorValue || '';
                }
            });
        }
    }

    function setChartScrollEnabled(enabled) {
        const opts = {
            handleScroll: { pressedMouseMove: enabled, horzTouchDrag: enabled, vertTouchDrag: enabled }
        };
        const mc = window.ChartState && window.ChartState.mainChart;
        if (mc) {
            try { mc.applyOptions(opts); } catch (e) {}
        }
        if (window.ChartState && window.ChartState.subPanes) {
            window.ChartState.subPanes.forEach(function (sub) {
                if (sub && sub.chart) {
                    try { sub.chart.applyOptions(opts); } catch (e) {}
                }
            });
        }
    }

    function hitTestDrawings(paneId, mx, my) {
        const targetPaneId = paneId || 'candle_pane';
        const helpers = getPaneHelpers(targetPaneId);

        for (let i = drawings.length - 1; i >= 0; i--) {
            const d = drawings[i];
            if ((d.paneId || 'candle_pane') !== targetPaneId) continue;
            const pts = d.points || [];
            const coords = [];
            for (let j = 0; j < pts.length; j++) {
                const x = helpers.timeToX(pts[j].timestamp);
                const y = helpers.priceToY(pts[j].value);
                if (x !== null && y !== null) coords.push({ x: x, y: y });
            }
            if (coords.length === 0) continue;

            const st = getDrawingStyle(d);

            // 1. Check control point handles first (radius 9px)
            for (let pIdx = 0; pIdx < coords.length; pIdx++) {
                if (Math.hypot(mx - coords[pIdx].x, my - coords[pIdx].y) <= 9) {
                    return { drawing: d, pointIndex: pIdx };
                }
            }

            // 2. Check geometry body
            if (d.name === 'trendLine' && coords.length >= 2) {
                const seg = getTrendLineRenderEndpoints(
                    coords,
                    helpers.plotWidth,
                    helpers.plotHeight,
                    !!st.extendLeft,
                    !!st.extendRight
                );
                if (distToSegment(mx, my, seg.x1, seg.y1, seg.x2, seg.y2) <= 7) {
                    return { drawing: d, pointIndex: -1 };
                }
            } else if (d.name === 'horizontalLine') {
                if (Math.abs(my - coords[0].y) <= 6) {
                    return { drawing: d, pointIndex: 0 };
                }
            } else if (d.name === 'horizontalRay' && coords.length >= 2) {
                const pointsRight = coords[0].x <= coords[1].x;
                const startX = st.extendLeft ? 0 : (pointsRight ? coords[0].x : 0);
                const endX   = st.extendRight ? helpers.plotWidth : (pointsRight ? helpers.plotWidth : coords[0].x);
                if (distToSegment(mx, my, startX, coords[0].y, endX, coords[0].y) <= 7) {
                    return { drawing: d, pointIndex: 0 };
                }
            } else if (d.name === 'verticalLine') {
                if (Math.abs(mx - coords[0].x) <= 6) {
                    return { drawing: d, pointIndex: 0 };
                }
            } else if ((d.name === 'longPosition' || d.name === 'shortPosition') && coords.length >= 2) {
                const xL = st.extendLeft ? 0 : Math.min(coords[0].x, coords[1].x);
                const xR = st.extendRight ? helpers.plotWidth : Math.max(coords[0].x, coords[1].x);
                const yVals = coords.map(function (c) { return c.y; });
                const yT = Math.min.apply(null, yVals);
                const yB = Math.max.apply(null, yVals);
                if (mx >= xL && mx <= xR && my >= yT && my <= yB) {
                    return { drawing: d, pointIndex: -1 };
                }
            } else if (d.name === 'priceRange' && coords.length >= 2) {
                const yT = Math.min(coords[0].y, coords[1].y);
                const yB = Math.max(coords[0].y, coords[1].y);
                if (my >= yT && my <= yB) {
                    return { drawing: d, pointIndex: -1 };
                }
            } else if (d.name === 'dateRange' && coords.length >= 2) {
                const xL = st.extendLeft ? 0 : Math.min(coords[0].x, coords[1].x);
                const xR = st.extendRight ? helpers.plotWidth : Math.max(coords[0].x, coords[1].x);
                if (mx >= xL && mx <= xR) {
                    return { drawing: d, pointIndex: -1 };
                }
            } else if (d.name === 'datePriceRange' && coords.length >= 2) {
                const xL = st.extendLeft ? 0 : Math.min(coords[0].x, coords[1].x);
                const xR = st.extendRight ? helpers.plotWidth : Math.max(coords[0].x, coords[1].x);
                const yT = Math.min(coords[0].y, coords[1].y);
                const yB = Math.max(coords[0].y, coords[1].y);
                if (mx >= xL && mx <= xR && my >= yT && my <= yB) {
                    return { drawing: d, pointIndex: -1 };
                }
            }
        }
        return null;
    }

    /**
     * Converts local pane coordinates `(mx, my)` into `{ timestamp, value, dataIndex, logical }`.
     * By default follows the exact mouse cursor price without jumping to candle OHLCs;
     * if `useMagnet` is true (e.g. holding Ctrl/Cmd), snaps to nearest OHLC within 10px.
     */
    function snapPointWithWeakMagnet(paneId, mx, my, useMagnet) {
        const resolvedPaneId = paneId || 'candle_pane';
        const helpers = getPaneHelpers(resolvedPaneId);
        const tInfo = window.ChartState.xToTime(mx);
        let rawPrice = helpers.yToPrice(my);
        if (!tInfo || rawPrice === null || !isFinite(rawPrice)) return null;

        if (useMagnet) {
            if (resolvedPaneId === 'candle_pane') {
                if (tInfo.bar) {
                    const candidates = [tInfo.bar.open, tInfo.bar.high, tInfo.bar.low, tInfo.bar.close];
                    let bestPrice = rawPrice;
                    let bestDist = 10;
                    for (let i = 0; i < candidates.length; i++) {
                        const py = helpers.priceToY(candidates[i]);
                        if (py !== null && Math.abs(py - my) < bestDist) {
                            bestDist = Math.abs(py - my);
                            bestPrice = candidates[i];
                        }
                    }
                    rawPrice = bestPrice;
                }
            } else if (window.ChartState.subPanes) {
                const sub = window.ChartState.subPanes.get(resolvedPaneId);
                if (sub && typeof sub.getValueAtIndex === 'function' && tInfo.dataIndex !== undefined) {
                    const oscVal = sub.getValueAtIndex(tInfo.dataIndex);
                    if (oscVal !== null && oscVal !== undefined && isFinite(oscVal)) {
                        const py = helpers.priceToY(oscVal);
                        if (py !== null && Math.abs(py - my) < 8) {
                            rawPrice = oscVal;
                        }
                    }
                }
            }
        }

        const logicalIdx = (typeof tInfo.dataIndex === 'number')
            ? tInfo.dataIndex
            : Math.round(typeof tInfo.logical === 'number' ? tInfo.logical : 0);

        return {
            timestamp: tInfo.timestamp,
            value:     rawPrice,
            dataIndex: tInfo.dataIndex,
            logical:   logicalIdx
        };
    }

    /* ============================================================
     * 3b. TradingView-Style Drawing Settings & Style Popup (Double-Click)
     *     + Right-Click Drawing Removal
     * ============================================================ */
    const TV_PALETTE_ROWS = [
        ['#ffffff', '#d1d4dc', '#b2b5be', '#9598a1', '#787b86', '#5d606b', '#434651', '#2a2e39', '#131722', '#000000'],
        ['#f23645', '#ff9800', '#ffeb3b', '#4caf50', '#089981', '#00bcd4', '#2962ff', '#673ab7', '#9c27b0', '#e91e63'],
        ['#fdd8df', '#ffe0b2', '#fff9c4', '#c8e6c9', '#b2dfdb', '#b2ebf2', '#bbdefb', '#d1c4e9', '#e1bee7', '#f8bbd0'],
        ['#f7a6b0', '#ffcc80', '#fff59d', '#a5d6a7', '#80cbc4', '#80deea', '#90caf9', '#b39ddb', '#ce93d8', '#f48fb1'],
        ['#ef7a85', '#ffb74d', '#fff176', '#81c784', '#4db6ac', '#4dd0e1', '#64b5f6', '#9575cd', '#ba68c8', '#f06292'],
        ['#ec5360', '#ffa726', '#ffee58', '#66bb6a', '#26a69a', '#26c6da', '#42a5f5', '#7e57c2', '#ab47bc', '#ec407a'],
        ['#c62828', '#ef6c00', '#f9a825', '#2e7d32', '#00695c', '#00838f', '#1565c0', '#4527a0', '#6a1b9a', '#ad1457'],
        ['#801922', '#c2410c', '#e65100', '#1b5e20', '#004d40', '#006064', '#0d47a1', '#311b92', '#4a148c', '#880e4f']
    ];

    let activeStylePopupEl = null;
    let activeStylePopupDrawingId = null;

    function closeDrawingStylePopup() {
        if (activeStylePopupEl) {
            if (typeof activeStylePopupEl.__cleanup === 'function') {
                activeStylePopupEl.__cleanup();
            }
            activeStylePopupEl.remove();
            activeStylePopupEl = null;
        }
        activeStylePopupDrawingId = null;
    }

    function removeDrawingById(drawingId) {
        const idx = drawings.findIndex(function (d) { return d.id === drawingId; });
        if (idx === -1) return false;
        drawings.splice(idx, 1);
        if (selectedDrawingId === drawingId) selectedDrawingId = null;
        if (hoveredDrawingId === drawingId) hoveredDrawingId = null;
        if (activeStylePopupDrawingId === drawingId) {
            closeDrawingStylePopup();
        }
        setCursorOnAllPanes('');
        if (window.ChartState && typeof window.ChartState.requestOverlayRedraw === 'function') {
            window.ChartState.requestOverlayRedraw();
        }
        return true;
    }

    function ensureStylePopupCSS() {
        let st = document.getElementById('tv-draw-style-popup-css');
        if (!st) {
            st = document.createElement('style');
            st.id = 'tv-draw-style-popup-css';
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
            '.tv-draw-modal.tv-ind-modal {',
            '    width: 320px;',
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
            '.tv-draw-top-label {',
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
            '    width: 110px; height: 26px; padding: 0 8px; border: 1px solid #d1d4dc;',
            '    border-radius: 4px; font-family: Arial, sans-serif; font-size: 12px; color: #131722;',
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
            '.tv-draw-btn-ok:hover { background: #2a2e39; }',
            '.tv-draw-extra-opts {',
            '    display: grid; grid-template-columns: 1fr 1fr; gap: 6px 8px;',
            '    margin-top: 8px; padding-top: 8px; border-top: 1px solid #e0e3eb;',
            '}',
            '.tv-draw-opt-label {',
            '    display: inline-flex; align-items: center; gap: 6px;',
            '    font-size: 11.5px; font-weight: 500; color: #131722; cursor: pointer;',
            '}'
        ].join('\n');
    }

    function openDrawingStylePopup(drawing, clientX, clientY) {
        if (!drawing) return;
        ensureStylePopupCSS();
        closeDrawingStylePopup();

        const initialStyle = getDrawingStyle(drawing);

        drawing.style = {
            color: initialStyle.color,
            opacity: initialStyle.opacity,
            lineWidth: initialStyle.lineWidth,
            lineStyle: initialStyle.lineStyle,
            customColor: initialStyle.customColor,
            extendLeft: initialStyle.extendLeft,
            extendRight: initialStyle.extendRight,
            locked: initialStyle.locked
        };

        activeStylePopupDrawingId = drawing.id;
        const toolSpec = TOOL_MAP[drawing.name] || { title: 'Drawing' };

        const modal = document.createElement('div');
        modal.className = 'tv-draw-modal';

        // Header
        const header = document.createElement('div');
        header.className = 'tv-draw-modal-header';

        const titleEl = document.createElement('span');
        titleEl.className = 'tv-draw-modal-title';
        titleEl.textContent = toolSpec.title;
        header.appendChild(titleEl);

        const closeBtn = document.createElement('button');
        closeBtn.type = 'button';
        closeBtn.className = 'tv-draw-modal-close';
        closeBtn.title = 'Close';
        closeBtn.innerHTML = '<svg width="12" height="12" viewBox="0 0 14 14" stroke="currentColor" stroke-width="1.6"><line x1="2" y1="2" x2="12" y2="12"/><line x1="12" y1="2" x2="2" y2="12"/></svg>';
        header.appendChild(closeBtn);
        modal.appendChild(header);

        // Tabs Bar — Style only for drawing tools (no Inputs tab)
        const tabsBar = document.createElement('div');
        tabsBar.className = 'tv-draw-modal-tabs';

        const tabStyle = document.createElement('button');
        tabStyle.type = 'button';
        tabStyle.className = 'tv-draw-tab active';
        tabStyle.textContent = 'Style';

        tabsBar.appendChild(tabStyle);
        modal.appendChild(tabsBar);

        // Body
        const body = document.createElement('div');
        body.className = 'tv-draw-modal-body';
        modal.appendChild(body);

        // Style Panel
        const stylePane = document.createElement('div');

        const topControls = document.createElement('div');
        topControls.className = 'tv-draw-top-controls';

        const topLabel = document.createElement('label');
        topLabel.className = 'tv-draw-top-label';
        const topChk = document.createElement('input');
        topChk.type = 'checkbox';
        topChk.checked = true;
        topChk.className = 'tv-draw-top-chk';
        const topLabelText = document.createElement('span');
        topLabelText.textContent = 'Line';
        topLabel.appendChild(topChk);
        topLabel.appendChild(topLabelText);
        topControls.appendChild(topLabel);

        const pillGroup = document.createElement('div');
        pillGroup.className = 'tv-draw-pill-group';

        const colorPill = document.createElement('div');
        colorPill.className = 'tv-draw-color-pill active';
        const pillSwatch = document.createElement('span');
        pillSwatch.className = 'tv-draw-color-pill-swatch';
        const pillLine = document.createElement('span');
        pillLine.className = 'tv-draw-color-pill-line';
        colorPill.appendChild(pillSwatch);
        colorPill.appendChild(pillLine);
        pillGroup.appendChild(colorPill);

        topControls.appendChild(pillGroup);
        stylePane.appendChild(topControls);

        // Palette Card
        const paletteCard = document.createElement('div');
        paletteCard.className = 'tv-draw-palette-card';

        const swatchButtons = [];
        TV_PALETTE_ROWS.forEach(function (rowColors, rIdx) {
            const gridRow = document.createElement('div');
            gridRow.className = 'tv-draw-swatch-grid' + (rIdx === 1 ? ' tv-draw-swatch-row-gap' : '');
            rowColors.forEach(function (hex) {
                const sw = document.createElement('button');
                sw.type = 'button';
                sw.className = 'tv-draw-swatch';
                sw.style.background = hex;
                sw.dataset.hex = hex.toLowerCase();
                sw.addEventListener('click', function () {
                    drawing.style.color = hex;
                    drawing.style.customColor = true;
                    syncStyleUI();
                    window.ChartState.requestOverlayRedraw();
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
            hiddenColorInput.value = drawing.style.color || '#2962ff';
            hiddenColorInput.click();
        });
        hiddenColorInput.addEventListener('input', function () {
            drawing.style.color = hiddenColorInput.value;
            drawing.style.customColor = true;
            syncStyleUI();
            window.ChartState.requestOverlayRedraw();
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
            drawing.style.opacity = Number(opacityRange.value);
            syncStyleUI();
            window.ChartState.requestOverlayRedraw();
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
                drawing.style.lineWidth = w;
                syncStyleUI();
                window.ChartState.requestOverlayRedraw();
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
                drawing.style.lineStyle = ls.id;
                syncStyleUI();
                window.ChartState.requestOverlayRedraw();
            });
            lineStyleButtons.push(btn);
            lineStyleGroup.appendChild(btn);
        });
        paletteCard.appendChild(lineStyleGroup);

        // Extend Left, Extend Right, Lock checkboxes
        const extraOpts = document.createElement('div');
        extraOpts.className = 'tv-draw-extra-opts';

        function createOptCheckbox(labelText, getValue, onChange) {
            const lbl = document.createElement('label');
            lbl.className = 'tv-draw-opt-label';
            const chk = document.createElement('input');
            chk.type = 'checkbox';
            chk.className = 'tv-draw-top-chk';
            chk.checked = !!getValue();
            chk.addEventListener('change', function () {
                onChange(chk.checked);
                syncStyleUI();
                window.ChartState.requestOverlayRedraw();
            });
            const span = document.createElement('span');
            span.textContent = labelText;
            lbl.appendChild(chk);
            lbl.appendChild(span);
            return { el: lbl, chk: chk };
        }

        const extendLeftOpt = createOptCheckbox(
            'Extend left',
            function () { return drawing.style.extendLeft; },
            function (v) { drawing.style.extendLeft = v; }
        );
        const extendRightOpt = createOptCheckbox(
            'Extend right',
            function () { return drawing.style.extendRight; },
            function (v) { drawing.style.extendRight = v; }
        );
        const lockOpt = createOptCheckbox(
            'Lock',
            function () { return drawing.style.locked; },
            function (v) { drawing.style.locked = v; }
        );

        extraOpts.appendChild(extendLeftOpt.el);
        extraOpts.appendChild(extendRightOpt.el);
        extraOpts.appendChild(lockOpt.el);
        paletteCard.appendChild(extraOpts);

        stylePane.appendChild(paletteCard);
        body.appendChild(stylePane);

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
            delete savedToolDefaultStyles[drawing.name];
            persistSavedToolDefaults();
            const fac = factoryStyleForTool(drawing.name);
            drawing.style = {
                color: fac.color,
                opacity: fac.opacity,
                lineWidth: fac.lineWidth,
                lineStyle: fac.lineStyle,
                customColor: fac.customColor,
                extendLeft: fac.extendLeft,
                extendRight: fac.extendRight,
                locked: fac.locked
            };
            syncStyleUI();
            window.ChartState.requestOverlayRedraw();
        });

        const saveDefaultItem = document.createElement('button');
        saveDefaultItem.type = 'button';
        saveDefaultItem.className = 'tv-draw-defaults-item';
        saveDefaultItem.textContent = 'Save as default';
        saveDefaultItem.addEventListener('click', function (ev) {
            ev.stopPropagation();
            defaultsMenu.classList.remove('open');
            savedToolDefaultStyles[drawing.name] = {
                color: drawing.style.color,
                opacity: drawing.style.opacity,
                lineWidth: drawing.style.lineWidth,
                lineStyle: drawing.style.lineStyle,
                customColor: drawing.style.customColor,
                extendLeft: !!drawing.style.extendLeft,
                extendRight: !!drawing.style.extendRight
            };
            persistSavedToolDefaults();
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
            drawing.style = {
                color: initialStyle.color,
                opacity: initialStyle.opacity,
                lineWidth: initialStyle.lineWidth,
                lineStyle: initialStyle.lineStyle,
                customColor: initialStyle.customColor,
                extendLeft: initialStyle.extendLeft,
                extendRight: initialStyle.extendRight,
                locked: initialStyle.locked
            };
            closeDrawingStylePopup();
            window.ChartState.requestOverlayRedraw();
        }

        function commitAndClose() {
            closeDrawingStylePopup();
            window.ChartState.requestOverlayRedraw();
        }

        cancelBtn.addEventListener('click', revertAndClose);
        okBtn.addEventListener('click', commitAndClose);
        closeBtn.addEventListener('click', commitAndClose);

        footerActions.appendChild(cancelBtn);
        footerActions.appendChild(okBtn);
        footer.appendChild(footerActions);
        modal.appendChild(footer);

        function syncStyleUI() {
            const curColor = (drawing.style.color || '#2962ff').toLowerCase();
            const curOpacity = typeof drawing.style.opacity === 'number' ? drawing.style.opacity : 100;
            const curWidth = drawing.style.lineWidth || 2;
            const curLineStyle = drawing.style.lineStyle || 'solid';

            pillSwatch.style.background = hexToRgba(curColor, curOpacity / 100);
            pillLine.style.height = Math.max(1, curWidth) + 'px';
            pillLine.style.background = curColor;
            customSwatch.style.background = curColor;

            swatchButtons.forEach(function (sw) {
                sw.classList.toggle('selected', sw.dataset.hex === curColor);
            });

            opacityRange.value = String(curOpacity);
            opacityValBox.textContent = curOpacity + '%';
            opacityGrad.style.background = 'linear-gradient(to right, ' + hexToRgba(curColor, 0) + ', ' + hexToRgba(curColor, 1) + ')';

            thickButtons.forEach(function (b) {
                b.classList.toggle('active', Number(b.dataset.width) === curWidth);
            });

            lineStyleButtons.forEach(function (b) {
                b.classList.toggle('active', b.dataset.linestyle === curLineStyle);
            });

            extendLeftOpt.chk.checked  = !!drawing.style.extendLeft;
            extendRightOpt.chk.checked = !!drawing.style.extendRight;
            lockOpt.chk.checked        = !!drawing.style.locked;
        }

        syncStyleUI();
        document.body.appendChild(modal);

        // Position near double-click or centered inside viewport
        const rect = modal.getBoundingClientRect();
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let left = (typeof clientX === 'number') ? clientX + 16 : (vw - rect.width) / 2;
        let top  = (typeof clientY === 'number') ? clientY - 40 : (vh - rect.height) / 2;
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

        activeStylePopupEl = modal;
    }

    function wireCanvasInteractions() {
        const rootEl = (window.ChartState && window.ChartState.rootContainer) || document.getElementById('chart');
        if (!rootEl || rootEl.__drawWired) return;
        rootEl.__drawWired = true;

        // Right-click (contextmenu) on any line or shape removes it immediately
        rootEl.addEventListener('contextmenu', function (e) {
            if (activeTool || draftDrawing) {
                e.preventDefault();
                e.stopPropagation();
                cancelActiveTool();
                return;
            }
            const hitPane = resolvePaneAtClientXY(e.clientX, e.clientY);
            if (!hitPane) return;
            const hit = hitTestDrawings(hitPane.paneId, hitPane.x, hitPane.y);
            if (hit && hit.drawing) {
                e.preventDefault();
                e.stopPropagation();
                removeDrawingById(hit.drawing.id);
            }
        }, true);

        // Double-click (dblclick) on any line or shape opens the TradingView Style & Thickness popup
        rootEl.addEventListener('dblclick', function (e) {
            if (activeTool || draftDrawing) return;
            if (e.target && e.target.closest && (
                e.target.closest('.tv-pane-legend') ||
                e.target.closest('.tv-subpane-resizer')
            )) {
                return;
            }
            const hitPane = resolvePaneAtClientXY(e.clientX, e.clientY);
            if (!hitPane) return;
            const hit = hitTestDrawings(hitPane.paneId, hitPane.x, hitPane.y);
            if (hit && hit.drawing) {
                e.preventDefault();
                e.stopPropagation();
                dragState = null;
                setChartScrollEnabled(true);
                selectedDrawingId = hit.drawing.id;
                openDrawingStylePopup(hit.drawing, e.clientX, e.clientY);
                window.ChartState.requestOverlayRedraw();
            }
        }, true);

        // Use capture phase (true) so drawing placement and drawing drag intercept mousedown
        // BEFORE LightweightCharts' internal canvas starts a chart pan gesture.
        rootEl.addEventListener('mousedown', function (e) {
            // Intercept right-mousedown on drawings so chart doesn't pan before contextmenu fires
            if (e.button === 2) {
                const hitPaneR = resolvePaneAtClientXY(e.clientX, e.clientY);
                if (hitPaneR) {
                    const hitR = hitTestDrawings(hitPaneR.paneId, hitPaneR.x, hitPaneR.y);
                    if (hitR && hitR.drawing) {
                        e.stopPropagation();
                        e.preventDefault();
                    }
                }
                return;
            }
            if (e.button !== 0) return;
            // Ignore clicks on indicator legends, buttons, or pane resizers
            if (e.target && e.target.closest && (
                e.target.closest('.tv-pane-legend') ||
                e.target.closest('.tv-subpane-resizer')
            )) {
                return;
            }

            const hitPane = resolvePaneAtClientXY(e.clientX, e.clientY);
            if (!hitPane) return;

            // Ignore clicks on right price scale or bottom time axis
            if (hitPane.x < 0 || hitPane.y < 0 || hitPane.x > hitPane.plotWidth || hitPane.y > hitPane.plotHeight) {
                return;
            }

            const targetPaneId = (draftDrawing && draftDrawing.paneId) ? draftDrawing.paneId : hitPane.paneId;
            const localPos = (targetPaneId === hitPane.paneId)
                ? hitPane
                : (getLocalCoordsForPane(targetPaneId, e.clientX, e.clientY) || hitPane);

            // Case 1: Active tool placement on either main candle pane or any oscillator sub-pane
            if (activeTool) {
                const toolSpec = TOOL_MAP[activeTool];
                const pt = snapPointWithWeakMagnet(targetPaneId, localPos.x, localPos.y, e.ctrlKey || e.metaKey);
                if (!toolSpec || !pt) return;

                setChartScrollEnabled(false);
                e.stopPropagation();
                e.preventDefault();

                if (!draftDrawing) {
                    if (toolSpec.pointsNeeded === 1) {
                        const created = {
                            id: nextDrawingId++,
                            name: activeTool,
                            paneId: targetPaneId,
                            points: [pt],
                            style: defaultStyleForTool(activeTool),
                            extendData: {}
                        };
                        drawings.push(created);
                        selectedDrawingId = created.id;
                        clearActiveState();
                        window.ChartState.requestOverlayRedraw();
                        return;
                    }

                    // Initialize multi-point draft drawing on the clicked pane
                    const initPts = [
                        pt,
                        { timestamp: pt.timestamp, value: pt.value, dataIndex: pt.dataIndex, logical: pt.logical }
                    ];
                    draftDrawing = {
                        id: nextDrawingId++,
                        name: activeTool,
                        paneId: targetPaneId,
                        points: initPts,
                        style: defaultStyleForTool(activeTool),
                        step: 1,
                        extendData: {}
                    };
                    applyPointConstraints(draftDrawing, 1);
                    window.ChartState.requestOverlayRedraw();
                    return;
                } else {
                    // Advance multi-point draft
                    if (draftDrawing.step === 1 && toolSpec.pointsNeeded === 2) {
                        draftDrawing.points[1] = pt;
                        applyPointConstraints(draftDrawing, 1);
                        drawings.push(draftDrawing);
                        selectedDrawingId = draftDrawing.id;
                        draftDrawing = null;
                        clearActiveState();
                        window.ChartState.requestOverlayRedraw();
                        return;
                    }

                    if (draftDrawing.step === 1 && toolSpec.pointsNeeded === 3) {
                        draftDrawing.points[1] = pt;
                        applyPointConstraints(draftDrawing, 1);
                        const entryVal = draftDrawing.points[0].value;
                        const defaultStop = draftDrawing.name === 'longPosition'
                            ? entryVal - Math.max(Math.abs(pt.value - entryVal) * 0.5, 0.5)
                            : entryVal + Math.max(Math.abs(entryVal - pt.value) * 0.5, 0.5);
                        draftDrawing.points.push({
                            timestamp: pt.timestamp,
                            value: defaultStop,
                            dataIndex: pt.dataIndex,
                            logical: pt.logical
                        });
                        draftDrawing.step = 2;
                        applyPointConstraints(draftDrawing, 2);
                        window.ChartState.requestOverlayRedraw();
                        return;
                    }

                    if (draftDrawing.step === 2 && toolSpec.pointsNeeded === 3) {
                        draftDrawing.points[2] = pt;
                        applyPointConstraints(draftDrawing, 2);
                        drawings.push(draftDrawing);
                        selectedDrawingId = draftDrawing.id;
                        draftDrawing = null;
                        clearActiveState();
                        window.ChartState.requestOverlayRedraw();
                        return;
                    }
                }
            }

            // Case 2: Hit-test existing drawings on the clicked pane for selection / dragging
            const hit = hitTestDrawings(hitPane.paneId, hitPane.x, hitPane.y);
            if (hit) {
                selectedDrawingId = hit.drawing.id;
                if (activeStylePopupDrawingId && activeStylePopupDrawingId !== hit.drawing.id) {
                    closeDrawingStylePopup();
                }
                if (!isDrawingLocked(hit.drawing)) {
                    const drawingPaneId = hit.drawing.paneId || 'candle_pane';
                    const helpers = getPaneHelpers(drawingPaneId);
                    const pt = snapPointWithWeakMagnet(drawingPaneId, hitPane.x, hitPane.y, false);
                    if (pt) {
                        setChartScrollEnabled(false);
                        e.stopPropagation();
                        e.preventDefault();

                        dragState = {
                            drawing: hit.drawing,
                            paneId: drawingPaneId,
                            pointIndex: hit.pointIndex,
                            startX: hitPane.x,
                            startY: hitPane.y,
                            startLogical: pt.logical,
                            startTimestamp: pt.timestamp,
                            startValue: pt.value,
                            origPoints: hit.drawing.points.map(function (p) {
                                const logical = (window.ChartState.timeToLogical && typeof window.ChartState.timeToLogical === 'function')
                                    ? window.ChartState.timeToLogical(p.timestamp)
                                    : resolveBarIndexForTimestamp(p.timestamp);
                                const origY = helpers.priceToY(p.value);
                                return {
                                    timestamp: p.timestamp,
                                    value: p.value,
                                    dataIndex: p.dataIndex,
                                    logical: logical !== null ? logical : 0,
                                    origY: origY !== null ? origY : hitPane.y
                                };
                            })
                        };
                    }
                }
                window.ChartState.requestOverlayRedraw();
            } else {
                if (activeStylePopupEl) {
                    closeDrawingStylePopup();
                }
                if (selectedDrawingId !== null) {
                    selectedDrawingId = null;
                    window.ChartState.requestOverlayRedraw();
                }
            }
        }, true);

        window.addEventListener('mousemove', function (e) {
            if (draftDrawing) {
                const targetPaneId = draftDrawing.paneId || 'candle_pane';
                const pos = getLocalCoordsForPane(targetPaneId, e.clientX, e.clientY);
                if (!pos) return;
                const pt = snapPointWithWeakMagnet(targetPaneId, pos.x, pos.y, e.ctrlKey || e.metaKey);
                if (!pt) return;
                const targetIdx = draftDrawing.step;
                if (draftDrawing.points[targetIdx]) {
                    draftDrawing.points[targetIdx] = pt;
                    applyPointConstraints(draftDrawing, targetIdx);
                    window.ChartState.requestOverlayRedraw();
                }
                return;
            }

            if (dragState) {
                const targetPaneId = dragState.paneId || (dragState.drawing && dragState.drawing.paneId) || 'candle_pane';
                const pos = getLocalCoordsForPane(targetPaneId, e.clientX, e.clientY);
                if (!pos) return;
                const d = dragState.drawing;
                if (isDrawingLocked(d)) {
                    dragState = null;
                    setChartScrollEnabled(true);
                    return;
                }

                if (dragState.pointIndex >= 0) {
                    const pt = snapPointWithWeakMagnet(targetPaneId, pos.x, pos.y, e.ctrlKey || e.metaKey);
                    if (!pt) return;
                    d.points[dragState.pointIndex] = pt;
                    applyPointConstraints(d, dragState.pointIndex);
                } else {
                    // Whole-drawing drag: shift horizontally by logical bar count (deltaBars)
                    // and vertically by pixel offset (dy) so endpoints never warp across weekend/holiday
                    // date gaps or logarithmic price scales.
                    const tInfo = window.ChartState.xToTime(pos.x);
                    if (!tInfo) return;
                    const curLogical = (typeof tInfo.dataIndex === 'number')
                        ? tInfo.dataIndex
                        : Math.round(typeof tInfo.logical === 'number' ? tInfo.logical : dragState.startLogical);
                    const deltaBars = curLogical - dragState.startLogical;
                    const dy = pos.y - dragState.startY;
                    const helpers = getPaneHelpers(targetPaneId);
                    const clampLog = (targetPaneId === 'candle_pane' && window.ChartState && window.ChartState.isLogScale);

                    for (let i = 0; i < d.points.length; i++) {
                        const orig = dragState.origPoints[i];
                        if (window.ChartState.logicalToTime && typeof orig.logical === 'number') {
                            const nextTime = window.ChartState.logicalToTime(orig.logical + deltaBars);
                            if (nextTime) {
                                d.points[i].timestamp = nextTime.timestamp;
                                d.points[i].dataIndex = nextTime.dataIndex;
                                d.points[i].logical   = nextTime.logical;
                            }
                        } else {
                            const dt = tInfo.timestamp - dragState.startTimestamp;
                            d.points[i].timestamp = orig.timestamp + dt;
                            d.points[i].dataIndex = resolveBarIndexForTimestamp(d.points[i].timestamp);
                        }

                        if (typeof orig.origY === 'number') {
                            const nextVal = helpers.yToPrice(orig.origY + dy);
                            if (nextVal !== null && isFinite(nextVal)) {
                                d.points[i].value = clampLog ? Math.max(0.0001, nextVal) : nextVal;
                            }
                        }
                    }
                }
                window.ChartState.requestOverlayRedraw();
                return;
            }

            // Hover detection across whichever pane the cursor is over
            if (!activeTool) {
                const hitPane = resolvePaneAtClientXY(e.clientX, e.clientY);
                const hit = hitPane ? hitTestDrawings(hitPane.paneId, hitPane.x, hitPane.y) : null;
                const nextHover = hit ? hit.drawing.id : null;
                if (nextHover !== hoveredDrawingId) {
                    hoveredDrawingId = nextHover;
                    setCursorOnAllPanes('');
                    if (hit && hitPane && hitPane.el) {
                        const locked = isDrawingLocked(hit.drawing);
                        hitPane.el.style.cursor = locked ? 'default' : (hit.pointIndex >= 0 ? 'pointer' : 'move');
                    }
                    window.ChartState.requestOverlayRedraw();
                } else if (hit && hitPane && hitPane.el) {
                    const locked = isDrawingLocked(hit.drawing);
                    hitPane.el.style.cursor = locked ? 'default' : (hit.pointIndex >= 0 ? 'pointer' : 'move');
                }
            }
        });

        window.addEventListener('mouseup', function () {
            if (dragState) {
                dragState = null;
                if (!activeTool) {
                    setChartScrollEnabled(true);
                }
            }
        });

        window.addEventListener('keydown', function (e) {
            const tag = (document.activeElement && document.activeElement.tagName) || '';
            if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return;

            if (e.key === 'Escape') {
                if (activeStylePopupEl) {
                    closeDrawingStylePopup();
                } else if (activeTool || draftDrawing) {
                    cancelActiveTool();
                } else if (selectedDrawingId !== null) {
                    selectedDrawingId = null;
                    window.ChartState.requestOverlayRedraw();
                }
            } else if ((e.key === 'Delete' || e.key === 'Backspace') && selectedDrawingId !== null) {
                removeDrawingById(selectedDrawingId);
            }
        });
    }

    /* ============================================================
     * 4. Workspace Persistence (Save / Load / Delete / Clear)
     * ============================================================ */
    const WORKSPACE_PREFIX = 'tv_workspace:';

    function currentAssetKey() {
        return (window.ChartState && window.ChartState.currentAsset) || 'default';
    }
    function currentTimeframeKey() {
        return (window.ChartState && window.ChartState.currentTimeframe) || 'default';
    }
    function workspaceKeyFor(asset, timeframe) {
        return WORKSPACE_PREFIX + asset + ':' + (timeframe || 'default');
    }

    function formatRelativeTime(iso) {
        if (!iso) return '';
        const t = Date.parse(iso);
        if (isNaN(t)) return '';
        const diff = Date.now() - t;
        const mins = Math.floor(diff / 60000);
        if (mins < 1)   return 'just now';
        if (mins < 60)  return mins + 'm ago';
        const hours = Math.floor(mins / 60);
        if (hours < 24) return hours + 'h ago';
        const days = Math.floor(hours / 24);
        if (days < 30)  return days + 'd ago';
        const d = new Date(t);
        const pad = function (n) { return String(n).padStart(2, '0'); };
        return d.getUTCFullYear() + '-' + pad(d.getUTCMonth() + 1) + '-' + pad(d.getUTCDate());
    }

    function listSavedLayouts(asset) {
        const prefix = WORKSPACE_PREFIX + asset + ':';
        const out = [];
        try {
            for (let i = 0; i < localStorage.length; i++) {
                const key = localStorage.key(i);
                if (!key || key.indexOf(prefix) !== 0) continue;
                let payload = null;
                try { payload = JSON.parse(localStorage.getItem(key) || 'null'); }
                catch (e) { payload = null; }
                const fallbackTf = key.substring(prefix.length);
                out.push({
                    asset:     (payload && payload.asset)     || asset,
                    timeframe: (payload && payload.timeframe) || fallbackTf,
                    savedAt:   (payload && payload.savedAt)   || null,
                    key:       key
                });
            }
        } catch (e) {}
        out.sort(function (a, b) {
            const ta = a.savedAt ? Date.parse(a.savedAt) : 0;
            const tb = b.savedAt ? Date.parse(b.savedAt) : 0;
            return tb - ta;
        });
        return out;
    }

    function captureDrawings() {
        return drawings
            .filter(function (o) { return o && TOOL_NAMES.indexOf(o.name) !== -1; })
            .map(function (o) {
                return {
                    name: o.name,
                    paneId: o.paneId || 'candle_pane',
                    points: (o.points || []).map(function (p) {
                        return {
                            timestamp: p.timestamp,
                            value:     p.value
                        };
                    }),
                    style: getDrawingStyle(o),
                    extendData: o.extendData || {}
                };
            });
    }

    function removeAllDrawingOverlays() {
        closeDrawingStylePopup();
        drawings.length = 0;
        draftDrawing = null;
        selectedDrawingId = null;
        hoveredDrawingId = null;
        if (window.ChartState && typeof window.ChartState.requestOverlayRedraw === 'function') {
            window.ChartState.requestOverlayRedraw();
        }
    }

    function applyDrawings(savedList) {
        if (!Array.isArray(savedList) || savedList.length === 0) return 0;
        let created = 0;
        savedList.forEach(function (o) {
            if (!o || !o.name || TOOL_NAMES.indexOf(o.name) === -1) return;
            const pts = (o.points || []).map(function (p) {
                const ts = p.timestamp > 1e11 ? p.timestamp : p.timestamp * 1000;
                return {
                    timestamp: ts,
                    value:     Number(p.value),
                    dataIndex: resolveBarIndexForTimestamp(ts)
                };
            });
            if (pts.length > 0) {
                drawings.push({
                    id: nextDrawingId++,
                    name: o.name,
                    paneId: o.paneId || 'candle_pane',
                    points: pts,
                    style: getDrawingStyle(o),
                    extendData: o.extendData || {}
                });
                created++;
            }
        });
        if (window.ChartState && typeof window.ChartState.requestOverlayRedraw === 'function') {
            window.ChartState.requestOverlayRedraw();
        }
        return created;
    }

    function showToast(msg, kind) {
        const el = document.createElement('div');
        el.className = 'draw-toast draw-toast-' + (kind || 'info');
        el.textContent = msg;
        document.body.appendChild(el);
        requestAnimationFrame(function () { el.classList.add('draw-toast-show'); });
        setTimeout(function () {
            el.classList.remove('draw-toast-show');
            setTimeout(function () { el.remove(); }, 300);
        }, 2200);
    }

    function saveWorkspace() {
        if (!window.ChartState || !window.ChartState.mainChart) {
            return { ok: false, error: 'Chart not ready' };
        }
        const asset = currentAssetKey();
        const timeframe = currentTimeframeKey();
        const capturedDrawings = captureDrawings();

        let indicators = [];
        let smcSettings = null;
        if (window.ChartWorkspace) {
            if (typeof window.ChartWorkspace.captureIndicators === 'function') {
                try { indicators = window.ChartWorkspace.captureIndicators(); } catch (e) {}
            }
            if (typeof window.ChartWorkspace.captureSmcSettings === 'function') {
                try { smcSettings = window.ChartWorkspace.captureSmcSettings(); } catch (e) {}
            }
        }

        const payload = {
            version: 3,
            savedAt: new Date().toISOString(),
            asset: asset,
            timeframe: timeframe,
            isLogScale: !!window.ChartState.isLogScale,
            drawings: capturedDrawings,
            indicators: indicators,
            smcSettings: smcSettings
        };

        try {
            localStorage.setItem(workspaceKeyFor(asset, timeframe), JSON.stringify(payload));
        } catch (e) {
            return { ok: false, error: e.message };
        }
        return {
            ok: true,
            counts: { drawings: capturedDrawings.length, indicators: indicators.length }
        };
    }

    function loadWorkspaceFor(asset, timeframe) {
        if (!window.ChartState || !window.ChartState.mainChart) {
            return { ok: false, error: 'Chart not ready' };
        }

        let raw;
        try { raw = localStorage.getItem(workspaceKeyFor(asset, timeframe)); }
        catch (e) { return { ok: false, error: 'localStorage unavailable' }; }
        if (!raw) return { ok: false, error: 'No saved workspace for this asset and timeframe' };

        let payload;
        try { payload = JSON.parse(raw); }
        catch (e) { return { ok: false, error: 'Saved workspace is corrupt' }; }

        removeAllDrawingOverlays();
        if (window.ChartWorkspace && typeof window.ChartWorkspace.clearIndicators === 'function') {
            try { window.ChartWorkspace.clearIndicators(); } catch (e) {}
        }

        if (typeof payload.isLogScale === 'boolean' && typeof window.ChartState.setLogScale === 'function') {
            window.ChartState.setLogScale(payload.isLogScale);
        }

        if (window.ChartWorkspace && typeof window.ChartWorkspace.applyIndicators === 'function') {
            try {
                window.ChartWorkspace.applyIndicators(
                    payload.indicators || [],
                    payload.smcSettings || null
                );
            } catch (e) {}
        }

        const savedDrawings = payload.drawings || [];
        applyDrawings(savedDrawings);

        return {
            ok: true,
            counts: {
                drawings: savedDrawings.length,
                indicators: (payload.indicators || []).length
            }
        };
    }

    function applySavedLayout(entry) {
        if (!window.ChartState || !window.ChartState.mainChart) {
            showToast('Chart not ready', 'error');
            return;
        }

        const targetAsset = entry.asset || currentAssetKey();
        const targetTf    = entry.timeframe || currentTimeframeKey();
        const currentTf   = currentTimeframeKey();

        if (targetTf !== currentTf) {
            const onBarsLoaded = function () {
                const i = window.ChartState.barsLoadedHandlers.indexOf(onBarsLoaded);
                if (i >= 0) window.ChartState.barsLoadedHandlers.splice(i, 1);
                setTimeout(function () {
                    const res = loadWorkspaceFor(targetAsset, targetTf);
                    if (res.ok) showToast('Layout loaded', 'success');
                    else        showToast('Load failed: ' + (res.error || 'unknown error'), 'error');
                }, 60);
            };
            window.ChartState.barsLoadedHandlers.push(onBarsLoaded);

            if (typeof window.ChartState.applySelection === 'function') {
                window.ChartState.applySelection(targetAsset, targetTf);
            } else {
                const res = loadWorkspaceFor(targetAsset, targetTf);
                if (res.ok) showToast('Layout loaded', 'success');
                else        showToast('Load failed: ' + (res.error || 'unknown error'), 'error');
            }
        } else {
            const res = loadWorkspaceFor(targetAsset, targetTf);
            if (res.ok) showToast('Layout loaded', 'success');
            else        showToast('Load failed: ' + (res.error || 'unknown error'), 'error');
        }
    }

    function deleteWorkspace() {
        const asset = currentAssetKey();
        const timeframe = currentTimeframeKey();
        try {
            localStorage.removeItem(workspaceKeyFor(asset, timeframe));
            return { ok: true };
        } catch (e) {
            return { ok: false, error: e.message };
        }
    }

    function hasSavedWorkspace() {
        try {
            return !!localStorage.getItem(workspaceKeyFor(currentAssetKey(), currentTimeframeKey()));
        } catch (e) {
            return false;
        }
    }

    /* ============================================================
     * 5. Toolbar & Workspace Dropdown Construction
     * ============================================================ */
    function clearActiveState() {
        activeTool = null;
        draftDrawing = null;
        setCursorOnAllPanes('');
        setChartScrollEnabled(true);
        document.querySelectorAll('#drawToolbar .draw-tool-btn.active:not(.draw-lock-btn)').forEach(function (el) {
            el.classList.remove('active');
        });
    }

    function cancelActiveTool() {
        clearActiveState();
        if (window.ChartState && typeof window.ChartState.requestOverlayRedraw === 'function') {
            window.ChartState.requestOverlayRedraw();
        }
    }

    function buildToolbar() {
        if (document.getElementById('drawToolbar')) return;

        if (!document.getElementById('drawtools-style')) {
            const style = document.createElement('style');
            style.id = 'drawtools-style';
            style.textContent = [
                '.draw-toolbar { display: flex; align-items: center; gap: 2px; user-select: none; }',
                '.draw-toolbar .draw-tool-btn {',
                '    display: inline-flex; align-items: center; justify-content: center;',
                '    width: 26px; height: 26px; border: 1px solid transparent; border-radius: 4px;',
                '    background: transparent; color: #131722; cursor: pointer; padding: 0;',
                '    transition: background 0.12s ease;',
                '}',
                '.draw-toolbar .draw-tool-btn:hover { background: #f0f3fa; }',
                '.draw-toolbar .draw-tool-btn.active { background: #2962ff; color: #ffffff; }',
                '.draw-ws-wrap { position: relative; display: inline-flex; align-items: center; }',
                '.draw-ws-trigger {',
                '    display: inline-flex; align-items: center; justify-content: center;',
                '    width: 26px; height: 26px; border: 1px solid transparent; border-radius: 4px;',
                '    background: transparent; color: #131722; cursor: pointer; padding: 0;',
                '    transition: background 0.12s ease;',
                '}',
                '.draw-ws-trigger:hover { background: #f0f3fa; }',
                '.draw-ws-trigger.open { background: #e8efff; color: #2962ff; }',
                '.draw-ws-trigger.open svg { transform: rotate(180deg); }',
                '.draw-ws-trigger svg { transition: transform 0.15s ease; }',
                '.draw-ws-menu {',
                '    position: absolute; top: calc(100% + 6px); right: 0; min-width: 220px;',
                '    background: #ffffff; border: 1px solid #e0e3eb; border-radius: 6px;',
                '    box-shadow: 0 8px 24px rgba(19, 23, 34, 0.12); padding: 6px 0;',
                '    z-index: 9000; display: none; font-family: inherit;',
                '}',
                '.draw-ws-menu.open { display: block; }',
                '.draw-ws-header {',
                '    padding: 8px 12px 4px 12px; font-size: 11px; font-weight: 600;',
                '    color: #9598a1; letter-spacing: 0.04em;',
                '}',
                '.draw-ws-item {',
                '    display: flex; align-items: center; gap: 10px; padding: 8px 12px;',
                '    font-size: 13px; color: #131722; cursor: pointer; border: none;',
                '    background: transparent; width: 100%; text-align: left;',
                '    font-family: inherit; transition: background 0.1s ease;',
                '}',
                '.draw-ws-item:hover { background: #f0f3fa; }',
                '.draw-ws-item .draw-ws-item-icon {',
                '    display: inline-flex; align-items: center; justify-content: center;',
                '    width: 18px; height: 18px; flex-shrink: 0; color: #555e70;',
                '}',
                '.draw-ws-item .draw-ws-item-label { flex: 1 1 auto; }',
                '.draw-ws-item .draw-ws-item-shortcut { color: #9598a1; font-size: 12px; font-weight: 400; }',
                '.draw-ws-item.danger .draw-ws-item-icon,',
                '.draw-ws-item.danger .draw-ws-item-label { color: #f23645; }',
                '.draw-ws-sep { height: 1px; background: #e0e3eb; margin: 4px 0; }',
                '.draw-toast {',
                '    position: fixed; top: 20px; left: 50%;',
                '    transform: translateX(-50%) translateY(-20px); padding: 8px 16px;',
                '    border-radius: 6px; background: #131722; color: #fff;',
                '    font-size: 13px; font-weight: 500; box-shadow: 0 4px 16px rgba(0,0,0,0.2);',
                '    opacity: 0; transition: opacity 0.2s, transform 0.2s; z-index: 10000;',
                '    pointer-events: none; white-space: nowrap;',
                '}',
                '.draw-toast-show { opacity: 1; transform: translateX(-50%) translateY(0); }',
                '.draw-toast-success { background: #089981; }',
                '.draw-toast-error   { background: #f23645; }'
            ].join('\n');
            document.head.appendChild(style);
        }

        const toolbar = document.createElement('div');
        toolbar.className = 'draw-toolbar';
        toolbar.id = 'drawToolbar';

        TOOLS.forEach(function (tool) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'draw-tool-btn';
            btn.title = tool.title;
            btn.dataset.tool = tool.name;
            btn.appendChild(makeIconSVG(tool.icon));

            btn.addEventListener('click', function () {
                if (activeTool === tool.name) {
                    cancelActiveTool();
                    return;
                }
                cancelActiveTool();
                selectedDrawingId = null;
                hoveredDrawingId = null;
                activeTool = tool.name;
                btn.classList.add('active');
                setCursorOnAllPanes('crosshair');
                setChartScrollEnabled(false);
                if (window.ChartState && typeof window.ChartState.requestOverlayRedraw === 'function') {
                    window.ChartState.requestOverlayRedraw();
                }
            });

            toolbar.appendChild(btn);
        });

        // Lock All Drawings toggle button on toolbar
        const lockAllBtn = document.createElement('button');
        lockAllBtn.type = 'button';
        lockAllBtn.className = 'draw-tool-btn draw-lock-btn';
        lockAllBtn.id = 'btnLockAllDrawings';
        lockAllBtn.title = 'Lock All Drawing Tools';
        lockAllBtn.appendChild(makeIconSVG(TV_ICONS.lock));
        lockAllBtn.addEventListener('click', function () {
            allDrawingsLocked = !allDrawingsLocked;
            lockAllBtn.classList.toggle('active', allDrawingsLocked);
            if (window.ChartState && typeof window.ChartState.requestOverlayRedraw === 'function') {
                window.ChartState.requestOverlayRedraw();
            }
        });
        toolbar.appendChild(lockAllBtn);

        const wsWrap = document.createElement('div');
        wsWrap.className = 'draw-ws-wrap';

        const wsTrigger = document.createElement('button');
        wsTrigger.type = 'button';
        wsTrigger.className = 'draw-ws-trigger';
        wsTrigger.title = 'Workspace: Save / Load / Delete Layouts';
        wsTrigger.setAttribute('aria-haspopup', 'true');
        wsTrigger.setAttribute('aria-expanded', 'false');
        wsTrigger.appendChild(makeIconSVG(TV_ICONS.chevronDown));
        wsWrap.appendChild(wsTrigger);

        const wsMenu = document.createElement('div');
        wsMenu.className = 'draw-ws-menu';
        wsMenu.setAttribute('role', 'menu');
        wsWrap.appendChild(wsMenu);

        function makeMenuItem(opts) {
            const btn = document.createElement('button');
            btn.type = 'button';
            btn.className = 'draw-ws-item' + (opts.danger ? ' danger' : '');
            btn.setAttribute('role', 'menuitem');

            const iconSpan = document.createElement('span');
            iconSpan.className = 'draw-ws-item-icon';
            iconSpan.appendChild(makeIconSVG(opts.icon, 16));
            btn.appendChild(iconSpan);

            const labelSpan = document.createElement('span');
            labelSpan.className = 'draw-ws-item-label';
            labelSpan.textContent = opts.label;
            btn.appendChild(labelSpan);

            if (opts.shortcut) {
                const shortcutSpan = document.createElement('span');
                shortcutSpan.className = 'draw-ws-item-shortcut';
                shortcutSpan.textContent = opts.shortcut;
                btn.appendChild(shortcutSpan);
            }

            btn.addEventListener('click', function (e) {
                e.stopPropagation();
                if (!opts.keepOpen) closeMenu();
                opts.onClick();
            });

            return btn;
        }

        function doSave() {
            const res = saveWorkspace();
            if (res.ok) {
                const d = res.counts.drawings;
                const i = res.counts.indicators;
                showToast(
                    'Saved ' + d + ' drawing' + (d === 1 ? '' : 's') +
                    '  |  ' + i + ' indicator' + (i === 1 ? '' : 's'),
                    'success'
                );
            } else {
                showToast('Save failed: ' + (res.error || 'unknown error'), 'error');
            }
        }

        function doDelete() {
            const tf = currentTimeframeKey();
            if (!hasSavedWorkspace()) {
                showToast('No saved workspace for this ' + tf + ' layout', 'error');
                return;
            }
            const res = deleteWorkspace();
            if (res.ok) showToast('Saved workspace deleted (' + tf + ')', 'success');
            else        showToast('Delete failed: ' + (res.error || 'unknown error'), 'error');
        }

        function doClearDrawings() {
            removeAllDrawingOverlays();
            clearActiveState();
            showToast('Drawings cleared', 'success');
        }

        function showLoadPicker() {
            const asset = currentAssetKey();
            const saved = listSavedLayouts(asset);

            if (saved.length === 0) {
                showToast('No saved workspace for this asset', 'error');
                closeMenu();
                return;
            }

            if (saved.length === 1) {
                closeMenu();
                applySavedLayout(saved[0]);
                return;
            }

            wsMenu.innerHTML = '';

            const header = document.createElement('div');
            header.className = 'draw-ws-header';
            header.textContent = 'Select saved timeframe';
            wsMenu.appendChild(header);

            saved.forEach(function (entry) {
                const when = formatRelativeTime(entry.savedAt);
                wsMenu.appendChild(makeMenuItem({
                    icon: TV_ICONS.load,
                    label: entry.timeframe || 'default',
                    shortcut: when,
                    keepOpen: true,
                    onClick: function () {
                        closeMenu();
                        applySavedLayout(entry);
                    }
                }));
            });

            const backSep = document.createElement('div');
            backSep.className = 'draw-ws-sep';
            wsMenu.appendChild(backSep);

            wsMenu.appendChild(makeMenuItem({
                icon: TV_ICONS.chevronDown,
                label: 'Back',
                keepOpen: true,
                onClick: renderMainMenu
            }));
        }

        function renderMainMenu() {
            wsMenu.innerHTML = '';

            wsMenu.appendChild(makeMenuItem({
                icon: TV_ICONS.save,
                label: 'Save layout',
                shortcut: 'Ctrl + S',
                onClick: doSave
            }));

            wsMenu.appendChild(makeMenuItem({
                icon: TV_ICONS.load,
                label: 'Load layout',
                keepOpen: true,
                onClick: showLoadPicker
            }));

            const menuSep = document.createElement('div');
            menuSep.className = 'draw-ws-sep';
            wsMenu.appendChild(menuSep);

            wsMenu.appendChild(makeMenuItem({
                icon: TV_ICONS.deleteSaved,
                label: 'Delete saved',
                danger: true,
                onClick: doDelete
            }));

            wsMenu.appendChild(makeMenuItem({
                icon: TV_ICONS.trash,
                label: 'Clear drawings',
                danger: true,
                onClick: doClearDrawings
            }));
        }

        function openMenu() {
            renderMainMenu();
            wsMenu.classList.add('open');
            wsTrigger.classList.add('open');
            wsTrigger.setAttribute('aria-expanded', 'true');
            document.addEventListener('mousedown', onDocMouseDown, true);
            document.addEventListener('keydown', onEscKey, true);
        }
        function closeMenu() {
            if (!wsMenu.classList.contains('open')) return;
            wsMenu.classList.remove('open');
            wsTrigger.classList.remove('open');
            wsTrigger.setAttribute('aria-expanded', 'false');
            document.removeEventListener('mousedown', onDocMouseDown, true);
            document.removeEventListener('keydown', onEscKey, true);
        }
        function toggleMenu() {
            if (wsMenu.classList.contains('open')) closeMenu();
            else openMenu();
        }
        function onDocMouseDown(e) {
            if (!wsWrap.contains(e.target)) closeMenu();
        }
        function onEscKey(e) {
            if (e.key === 'Escape') closeMenu();
        }

        wsTrigger.addEventListener('click', function (e) {
            e.stopPropagation();
            toggleMenu();
        });

        wsWrap.__triggerSave = doSave;

        const mainToolbar = document.querySelector('.tv-toolbar');
        const periodBar   = document.getElementById('periodBar');
        const toolsGroup  = mainToolbar ? mainToolbar.querySelector('.tv-tools') : null;

        if (mainToolbar && periodBar && toolsGroup) {
            const leadSep = document.createElement('span');
            leadSep.className = 'tv-tool-sep';
            leadSep.setAttribute('aria-hidden', 'true');
            mainToolbar.insertBefore(leadSep, toolsGroup);
            mainToolbar.insertBefore(toolbar, toolsGroup);
        } else if (mainToolbar) {
            mainToolbar.appendChild(toolbar);
        }

        if (toolsGroup) {
            toolsGroup.insertBefore(wsWrap, toolsGroup.firstChild);

            const sepAfterWs = document.createElement('span');
            sepAfterWs.className = 'tv-tool-sep';
            sepAfterWs.setAttribute('aria-hidden', 'true');
            wsWrap.insertAdjacentElement('afterend', sepAfterWs);

            const indicatorsBtnEl = document.getElementById('openIndicatorsBtn');
            if (indicatorsBtnEl && indicatorsBtnEl.parentNode === toolsGroup) {
                const sepAfterInd = document.createElement('span');
                sepAfterInd.className = 'tv-tool-sep';
                sepAfterInd.setAttribute('aria-hidden', 'true');
                indicatorsBtnEl.insertAdjacentElement('afterend', sepAfterInd);
            }
        } else if (mainToolbar) {
            mainToolbar.appendChild(wsWrap);
        }
    }

    window.addEventListener('keydown', function (e) {
        if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && (e.key === 's' || e.key === 'S')) {
            e.preventDefault();
            const wrap = document.querySelector('.draw-ws-wrap');
            if (wrap && typeof wrap.__triggerSave === 'function') {
                wrap.__triggerSave();
            }
        }
    });

    /* ============================================================
     * 6. Clear chart drawings/indicators when asset changes
     * ============================================================ */
    let __lastSeenAsset = null;

    function clearChartOnAssetChange() {
        const asset = currentAssetKey();
        if (__lastSeenAsset === null) {
            __lastSeenAsset = asset;
            return;
        }
        if (asset === __lastSeenAsset) return;
        __lastSeenAsset = asset;

        removeAllDrawingOverlays();
        if (window.ChartWorkspace && typeof window.ChartWorkspace.clearIndicators === 'function') {
            try { window.ChartWorkspace.clearIndicators(); } catch (e) {}
        }
        clearActiveState();
    }

    /* ============================================================
     * 7. Boot
     * ============================================================ */
    function initDrawTools() {
        if (!window.ChartState) return;
        window.ChartState.overlayDrawHandlers.push(drawAllDrawingsOnCanvas);
        window.ChartState.barsLoadedHandlers.unshift(clearChartOnAssetChange);
        __lastSeenAsset = currentAssetKey();
        buildToolbar();
        wireCanvasInteractions();
    }

    if (window.ChartState && window.ChartState.mainChart) {
        initDrawTools();
    } else {
        window.addEventListener('chartStateReady', function () {
            initDrawTools();
        }, { once: true });
    }

})();
