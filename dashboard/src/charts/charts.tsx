// Ride timeline: power, cadence, heart rate and speed as four uPlot charts that share one
// crosshair. "Whole ride" can be zoomed (drag across a chart, pinch, or ctrl + scroll) and
// panned (sideways swipe); double-click or Reset zoom goes back to the whole ride.
import { memo, useState, useEffect, useRef, useMemo, useCallback, type RefObject } from 'react';
import { plannedLine, powerTol, CAD_TOL, HR_TOL, SPEED_TOL } from '../workout/workout';
import { fmtGrade } from '../control/climb';
import { ZONES, nz, fmtT, zoneOf } from '../util/ride';
import { useEvent } from '../hooks/hooks';
import { createPlot, columns, niceStep, MIN_SPAN, type ChartDef, type PlotHandlers, type PlotMeta } from './plot';
import type uPlot from 'uplot';
import type { Sample, SeriesKey } from '../types/feed';
import type { PlanPoint, Workout } from '../types/workout';

const CHARTS: ChartDef[] = [
  { key: 'power_w', color: '--power', fill: true, min: 0, floorMax: 300, ftpRef: true, title: 'Power (W) · dashed line = FTP', name: 'Power', unit: 'W', h: 170 },
  { key: 'cadence_rpm', color: '--cadence', min: 0, floorMax: 120, title: 'Cadence (rpm)', name: 'Cadence', unit: 'rpm', h: 100 },
  { key: 'heart_rate_bpm', color: '--hr', autoMin: true, floorMax: 160, title: 'Heart rate (bpm)', name: 'Heart rate', unit: 'bpm', h: 100 },
  { key: 'speed_kmh', color: '--speed', min: 0, floorMax: 40, title: 'Speed (km/h)', name: 'Speed', unit: 'km/h', h: 124, xaxis: true },
];
const TOL: Record<SeriesKey, (v: number) => number> = { power_w: powerTol, cadence_rpm: () => CAD_TOL, heart_rate_bpm: () => HR_TOL, speed_kmh: () => SPEED_TOL };

// Whole ride until it is longer than the window, then the last `win` seconds.
// With a workout loaded the axis also shows what is coming: the whole plan, or the
// next third of the window.
function xRange(n: number, win: number, planEnd = 0): [number, number] {
  if (!planEnd) {
    if (win && n > win) return [n - win, n - 1];
    return [0, Math.max(n - 1, 59)];
  }
  if (!win) return [0, Math.max(n - 1, planEnd, 59)];
  const x0 = Math.max(0, Math.round(n - (win * 2) / 3));
  return [x0, x0 + win - 1];
}

// y axis for the samples and targets in view: floor maximum, FTP headroom, round steps
function yRange(c: ChartDef, hist: Sample[], x0: number, x1: number, ftp: number, plan: PlanPoint[]) {
  let ymax = c.floorMax, ymin = c.min ?? 0, vmin = Infinity, n = 0;
  for (let i = Math.max(0, Math.ceil(x0)), e = Math.min(hist.length - 1, Math.floor(x1)); i <= e; i++) {
    const v = hist[i][c.key];
    if (!nz(v)) continue;
    n++; if (v > ymax) ymax = v; if (v < vmin) vmin = v;
  }
  if (c.ftpRef) ymax = Math.max(ymax, ftp * 1.15);
  const inView = plan.filter(p => p.t1 > x0 && p.t0 <= x1);
  for (const p of inView) ymax = Math.max(ymax, p.a * 1.1, p.b * 1.1);
  if (c.autoMin) {
    ymin = n ? Math.max(0, Math.floor((vmin - 10) / 20) * 20) : 60;
    for (const p of inView) ymin = Math.min(ymin, Math.max(0, Math.floor((Math.min(p.a, p.b) - 15) / 20) * 20));
  }
  const step = niceStep(ymax - ymin, 4);
  return { ymin, ymax: Math.ceil(ymax / step) * step, step, n };
}

// The uPlot instance lives outside React: a ref callback creates it (and resizes it with the
// box), and the one effect hands it the data and scales once per ride second.
interface ChartProps {
  c: ChartDef; hist: Sample[]; laps: number[]; ftp: number; version: number; x0: number; x1: number;
  workout: Workout | null; zoomable: boolean; zoomed: boolean; on: PlotHandlers;
}
const Chart = memo(function Chart({ c, hist, laps, ftp, version, x0, x1, workout, zoomable, zoomed, on }: ChartProps) {
  const plot = useRef<uPlot | null>(null);
  const meta = useRef<PlotMeta>({ c, laps: [0], plan: [], ftp, x0, x1, ymin: 0, ymax: 1, step: 1, tol: TOL[c.key] }).current;
  const plan = useMemo(() => (workout ? plannedLine(workout, ftp, c.key) : []), [workout, ftp, c.key]);

  const ro = useRef<ResizeObserver | null>(null);
  const ref = useCallback((node: HTMLDivElement | null) => {
    if (ro.current) { ro.current.disconnect(); ro.current = null; }
    if (plot.current) { plot.current.destroy(); plot.current = null; }
    if (!node) return;
    const u = plot.current = createPlot(node, c, meta, on);
    ro.current = new ResizeObserver(([e]) => {
      const w = Math.round(e.contentRect.width);
      if (w && w !== u.width) u.setSize({ width: w, height: c.h });
    });
    ro.current.observe(node);
  }, [c, meta, on]);

  useEffect(() => {
    const u = plot.current; if (!u) return;
    const y = yRange(c, hist, x0, x1, ftp, plan);
    Object.assign(meta, { laps, plan, ftp, x0, x1, zoomable, zoomed, ymin: y.ymin, ymax: y.ymax, step: y.step,
      empty: y.n ? null : c.key === 'heart_rate_bpm' && hist.length ? 'No heart-rate data' : 'Waiting for data…' });
    const cols = columns(hist);
    u.batch(() => {
      u.setData([cols.t, cols[c.key]], false);
      u.setScale('x', { min: x0, max: x1 });
      u.setScale('y', { min: y.ymin, max: y.ymax });
    });
  }, [version, x0, x1, ftp, laps, plan, zoomable, zoomed, hist, c, meta]);

  return (
    <div className="chart">
      <div className="title"><span className="key" style={{ background: `var(${c.color})` }} />{c.title}
        {plan.length > 0 && <span className="plan-key"><span className="key" />workout target (shaded = on target)</span>}</div>
      <div className={'plot' + (zoomable ? ' zoomable' : '')} ref={ref} style={{ height: c.h }}
           role="img" aria-label={chartSummary(c, hist)} />
    </div>
  );
});

function chartSummary(c: ChartDef, hist: Sample[]) {
  let n = 0, sum = 0, max = -Infinity, last: number | undefined;       // one pass, no spread: rides can be hours long
  for (const s of hist) { const v = s[c.key]; if (nz(v)) { n++; sum += v; if (v > max) max = v; last = v; } }
  if (!n) return `${c.name}: no data yet`;
  return `${c.name} over ${fmtT(hist.length)}: now ${last} ${c.unit}, average ${Math.round(sum / n)}, max ${max}`;
}

const TipRow = ({ col, k, v }: { col: string; k: string; v: string }) => (
  <div className="row"><span className="k"><i style={{ background: col }} />{k}</span><b>{v}</b></div>
);

interface TipPos { t: number; x: number; y: number }
function Tooltip({ s, pos, ftp, boxRef }: { s: Sample | null; pos: TipPos | null; ftp: number; boxRef: RefObject<HTMLDivElement> }) {
  if (!s || !pos) return null;
  const z = s.power_w > 0 ? ZONES[zoneOf(s.power_w, ftp)].n : '';
  // Beside the pointer, flipped to its left near the right edge. The tip's width is only known
  // once it is in the page, so this ref callback (new each render) places it before paint.
  const place = (el: HTMLDivElement | null) => {
    if (!el || !boxRef.current) return;
    const bw = boxRef.current.getBoundingClientRect().width, tw = el.offsetWidth;
    el.style.left = `${pos.x + 14 + tw > bw - 8 ? pos.x - tw - 14 : pos.x + 14}px`;
  };
  return (
    <div className="tip" ref={place} style={{ display: 'block', top: Math.max(8, pos.y - 40) }}>
      <div className="t">{fmtT(s.t)} · lap {s.lap}</div>
      <TipRow col="var(--power)" k="Power" v={`${s.power_w} W ${z}`} />
      <TipRow col="var(--cadence)" k="Cadence" v={`${s.cadence_rpm} rpm`} />
      <TipRow col="var(--hr)" k="Heart rate" v={nz(s.heart_rate_bpm) ? `${s.heart_rate_bpm} bpm` : '–'} />
      <TipRow col="var(--speed)" k="Speed" v={nz(s.speed_kmh) ? `${s.speed_kmh.toFixed(1)} km/h` : '–'} />
      {nz(s.grade_pct) && <TipRow col="var(--text-secondary)" k="Grade" v={`${fmtGrade(s.grade_pct)} %`} />}
    </div>
  );
}

// Charts, Stats, time in zone and laps redraw once per ride second (`version`), not on every
// live packet: they are memoized and the history is one array that grows in place.
interface ChartsProps {
  win: number; setWin: (win: number) => void; hist: Sample[]; laps: number[]; ftp: number; version: number;
  workout: Workout | null;
}
export const Charts = memo(function Charts({ win, setWin, hist, laps, ftp, version, workout }: ChartsProps) {
  const [tip, setTip] = useState<TipPos | null>(null);             // under the pointer
  const [zoom, setZoom] = useState<[number, number] | null>(null);  // [lo, hi] seconds, whole ride only
  const [zoomWin, setZoomWin] = useState(win);
  if (zoomWin !== win) { setZoomWin(win); setZoom(null); }   // a new window starts unzoomed
  const box = useRef<HTMLDivElement>(null);

  const full = xRange(hist.length, win, workout ? workout.total : 0);
  const [x0, x1] = zoom || full;
  const zoomable = win === 0;

  // Gestures ask for any range; it is kept inside the ride and no closer than MIN_SPAN.
  const zoomTo = useEvent((lo: number, hi: number) => {
    const [a, b] = full, w = Math.max(MIN_SPAN, hi - lo);
    if (w >= b - a) return setZoom(null);
    const s = Math.min(Math.max(a, lo), b - w);
    setZoom([s, s + w]);
  });
  const hoverAt = useEvent((t: number | null, over?: HTMLDivElement, left?: number, top?: number) => {
    if (t === null || t < 0 || t >= hist.length || !over || left == null || top == null || !box.current) return setTip(null);
    const o = over.getBoundingClientRect(), bx = box.current.getBoundingClientRect();
    setTip({ t, x: o.left - bx.left + left, y: o.top - bx.top + top });
  });
  const on = useMemo<PlotHandlers>(() => ({ zoom: zoomTo, hover: hoverAt, reset: () => setZoom(null) }), [zoomTo, hoverAt]);

  return (
    <div className="charts" ref={box}>
      <div className="head">
        <h2>Ride timeline</h2>
        <div className="head-ctl">
          {zoom ? <button className="quiet" onClick={() => setZoom(null)}>Reset zoom
                    <small> {fmtT(x0)}–{fmtT(x1)}</small></button>
                : zoomable && hist.length > MIN_SPAN && <span className="zoom-hint" aria-hidden="true" />}
          <select value={win} onChange={e => setWin(+e.target.value)} aria-label="Chart time window">
            <option value={300}>Last 5 min</option>
            <option value={1200}>Last 20 min</option>
            <option value={0}>Whole ride</option>
          </select>
        </div>
      </div>
      {CHARTS.map(c => <Chart key={c.key} c={c} hist={hist} laps={laps} ftp={ftp} version={version} x0={x0} x1={x1}
                              workout={workout} zoomable={zoomable} zoomed={!!zoom} on={on} />)}
      <Tooltip s={tip ? hist[tip.t] : null} pos={tip} ftp={ftp} boxRef={box} />
    </div>
  );
});
