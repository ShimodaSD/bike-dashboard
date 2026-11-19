// One uPlot chart of the ride timeline. Everything React passes in lands in `meta` (a plain
// object the chart keeps), and the draw hooks read it when uPlot paints: lap markers, the FTP
// line and the planned workout go under the series, the "waiting" message over it.
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';
import { fmtT, cssVar } from '../util/ride.js';

const FONT = '12px system-ui, sans-serif';
const MIN_SPAN = 30;                                  // seconds: the closest zoom

export function niceStep(range, n) {
  const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// Ride columns for uPlot, built once and appended to as the ride grows: the history is one
// array that grows in place, so a full rebuild only happens when it is replaced or cleared.
const cache = new WeakMap();
export const KEYS = ['power_w', 'cadence_rpm', 'heart_rate_bpm', 'speed_kmh'];
export function columns(hist) {
  let c = cache.get(hist);
  if (!c || c.n > hist.length || (c.n && hist[c.n - 1] !== c.last)) {
    c = { n: 0, last: null, t: [] };
    for (const k of KEYS) c[k] = [];
    cache.set(hist, c);
  }
  for (let i = c.n; i < hist.length; i++) {
    const s = hist[i];
    c.t.push(i);
    for (const k of KEYS) c[k].push(s[k] ?? null);
  }
  c.n = hist.length; c.last = hist[c.n - 1] || null;
  return c;
}

// Under the series: lap markers, FTP line, workout target band and line.
function drawUnder(u, meta, tok) {
  const { ctx: g, bbox: b } = u, pr = uPlot.pxRatio;
  const X = v => u.valToPos(v, 'x', true), Y = v => u.valToPos(v, 'y', true);
  const { x0, x1, ymin, c } = meta;
  g.save();
  g.beginPath(); g.rect(b.left, b.top, b.width, b.height); g.clip();
  g.lineWidth = pr;
  g.strokeStyle = tok.muted; g.setLineDash([2 * pr, 4 * pr]);
  for (const l of meta.laps.slice(1)) {
    if (l < x0 || l > x1) continue;
    const x = Math.round(X(l)) + 0.5;
    g.beginPath(); g.moveTo(x, b.top); g.lineTo(x, b.top + b.height); g.stroke();
  }
  if (c.ftpRef) {
    const y = Math.round(Y(meta.ftp)) + 0.5;
    g.strokeStyle = tok.sec; g.setLineDash([6 * pr, 5 * pr]);
    g.beginPath(); g.moveTo(b.left, y); g.lineTo(b.left + b.width, y); g.stroke();
    g.setLineDash([]);
    g.font = `${12 * pr}px system-ui, sans-serif`; g.fillStyle = tok.sec;
    g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText('FTP ' + meta.ftp, b.left + 4 * pr, y - 3 * pr);
  }
  g.setLineDash([]);
  const cl = t => Math.min(Math.max(t, x0), x1);
  for (const p of meta.plan) {
    if (p.t1 <= x0 || p.t0 > x1) continue;
    const at = t => p.a + (p.b - p.a) * ((t - p.t0) / Math.max(1, p.t1 - p.t0));
    const ta = cl(p.t0), tb = cl(p.t1), va = at(ta), vb = at(tb), tol = meta.tol;
    g.beginPath();
    g.moveTo(X(ta), Y(va + tol(va))); g.lineTo(X(tb), Y(vb + tol(vb)));
    g.lineTo(X(tb), Y(Math.max(ymin, vb - tol(vb)))); g.lineTo(X(ta), Y(Math.max(ymin, va - tol(va)))); g.closePath();
    g.fillStyle = tok.sec + '1f'; g.fill();
    g.beginPath(); g.moveTo(X(ta), Y(va)); g.lineTo(X(tb), Y(vb));
    g.strokeStyle = tok.sec; g.lineWidth = 1.5 * pr; g.stroke(); g.lineWidth = pr;
  }
  g.restore();
}

function drawEmpty(u, meta, tok) {
  if (!meta.empty) return;
  const { ctx: g, bbox: b } = u, pr = uPlot.pxRatio;
  g.save();
  g.font = `${12 * pr}px system-ui, sans-serif`; g.fillStyle = tok.muted;
  g.textAlign = 'center'; g.textBaseline = 'middle';
  g.fillText(meta.empty, b.left + b.width / 2, b.top + b.height / 2);
  g.restore();
}

// x ticks: a round step that gives as many labels as fit (at most 7)
function xSplits(u, i, min, max) {
  const fit = Math.max(3, Math.min(7, Math.floor(u.bbox.width / uPlot.pxRatio / 64)));   // ~64 px per label
  const span = max - min, xs = [60, 120, 300, 600, 900, 1200, 1800, 3600, 7200].find(s => span / s <= fit) || 7200;
  const out = [];
  // the last label stays clear of the right edge, where it would be cut off
  for (let t = Math.ceil(Math.max(0, min) / xs) * xs; t <= max - span * 0.04; t += xs) out.push(t);
  return out;
}

// Pinch (two fingers) and trackpad gestures: zoom and pan the whole-ride view.
// One finger keeps scrolling the page.
function bindGestures(u, meta, on) {
  const over = u.over;
  const span = () => [meta.x0, meta.x1];
  const valAt = clientX => {
    const r = over.getBoundingClientRect(), [a, b] = span();
    return [a + ((clientX - r.left) / r.width) * (b - a), (clientX - r.left) / r.width];
  };
  over.addEventListener('wheel', e => {
    if (!meta.zoomable) return;
    const [a, b] = span();
    if (e.ctrlKey) {                                   // trackpad pinch, or ctrl + wheel
      e.preventDefault();
      const [v, f] = valAt(e.clientX), w = (b - a) * Math.exp(e.deltaY * 0.01);
      on.zoom(v - f * w, v - f * w + w);
    } else if (meta.zoomed && Math.abs(e.deltaX) > Math.abs(e.deltaY)) {   // sideways swipe pans
      e.preventDefault();
      const d = (e.deltaX / over.clientWidth) * (b - a);
      on.zoom(a + d, b + d);
    }
  }, { passive: false });

  let pinch = null;
  const mid = t => [(t[0].clientX + t[1].clientX) / 2, Math.abs(t[0].clientX - t[1].clientX) || 1];
  over.addEventListener('touchstart', e => {
    if (!meta.zoomable || e.touches.length !== 2) { pinch = null; return; }
    const [cx, d] = mid(e.touches), [v, f] = valAt(cx);
    pinch = { v, f, d, w: meta.x1 - meta.x0 };
  }, { passive: true });
  over.addEventListener('touchmove', e => {
    if (!pinch || e.touches.length !== 2) return;
    e.preventDefault();
    const [cx, d] = mid(e.touches), r = over.getBoundingClientRect();
    const w = pinch.w * (pinch.d / d), f = (cx - r.left) / r.width;
    on.zoom(pinch.v - f * w, pinch.v - f * w + w);
  }, { passive: false });
  over.addEventListener('touchend', e => { if (e.touches.length < 2) pinch = null; }, { passive: true });
  over.addEventListener('mouseleave', () => on.hover(null));
}

// `on`: { hover(t, over, left, top) | hover(null), zoom(lo, hi), reset() }
export function createPlot(node, c, meta, on) {
  const tok = { grid: cssVar('--grid'), muted: cssVar('--text-muted'), sec: cssVar('--text-secondary'),
                surf: cssVar('--surface-1'), col: cssVar(c.color) };
  const opts = {
    width: node.clientWidth || 300, height: c.h,
    padding: [8, 10, c.xaxis ? 0 : 6, 0],
    legend: { show: false },
    scales: {
      x: { time: false, auto: false, range: (u, a, b) => [a, b] },
      y: { auto: false, range: (u, a, b) => [a, b] },
    },
    series: [
      {},
      { stroke: tok.col, width: 2, fill: c.fill ? tok.col + '2e' : undefined, points: { show: false }, spanGaps: false },
    ],
    axes: [
      { show: !!c.xaxis, stroke: tok.muted, font: FONT, size: 22, gap: 6, grid: { show: false },
        ticks: { show: false }, splits: xSplits, values: (u, v) => v.map(fmtT) },
      { stroke: tok.muted, font: FONT, size: 40, gap: 6, ticks: { show: false },
        grid: { stroke: tok.grid, width: 1 },
        splits: () => { const out = []; for (let v = meta.ymin; v <= meta.ymax + 1e-9; v += meta.step) out.push(v); return out; },
        values: (u, v) => v.map(Math.round) },
    ],
    cursor: {
      sync: { key: 'ride' },
      y: false,
      points: { size: 9, width: 2, fill: tok.col, stroke: tok.surf },
      drag: { x: true, y: false, setScale: false, dist: 8 },
      bind: { dblclick: () => () => { on.reset(); return null; } },
    },
    hooks: {
      drawAxes: [u => drawUnder(u, meta, tok)],
      draw: [u => drawEmpty(u, meta, tok)],
      setCursor: [u => {
        if (!u.cursor.event) return;                  // only the chart under the pointer drives the tip
        const l = u.cursor.left;
        if (l == null || l < 0) return on.hover(null);
        on.hover(Math.round(u.posToVal(l, 'x')), u.over, l, u.cursor.top);
      }],
      setSelect: [u => {
        const s = u.select;
        if (s.width < 8) return;
        if (meta.zoomable) on.zoom(u.posToVal(s.left, 'x'), u.posToVal(s.left + s.width, 'x'));
        u.setSelect({ left: 0, top: 0, width: 0, height: 0 }, false);
      }],
    },
  };
  const u = new uPlot(opts, [[], []], node);
  bindGestures(u, meta, on);
  return u;
}

export { MIN_SPAN };
