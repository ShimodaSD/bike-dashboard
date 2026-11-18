// X2Max live dashboard (React). Talks to thinkrider_logger.py:
//   GET  /events  Server-Sent Events: init, sample, status, laps
//   POST /lap     start a new lap
import React, { useState, useEffect, useRef, useMemo, useCallback, useLayoutEffect } from 'react';
import { createRoot } from 'react-dom/client';

// ------------------------------------------------------------------ constants & helpers
const ZONES = [
  { n: 'Z1', name: 'Recovery',   lo: 0,    hi: 0.55 },
  { n: 'Z2', name: 'Endurance',  lo: 0.55, hi: 0.75 },
  { n: 'Z3', name: 'Tempo',      lo: 0.75, hi: 0.90 },
  { n: 'Z4', name: 'Threshold',  lo: 0.90, hi: 1.05 },
  { n: 'Z5', name: 'VO2max',     lo: 1.05, hi: 1.20 },
  { n: 'Z6', name: 'Anaerobic',  lo: 1.20, hi: 1.50 },
  { n: 'Z7', name: 'Neuromusc.', lo: 1.50, hi: Infinity },
];
const CSV_COLS = ['t', 'timestamp_utc', 'lap', 'power_w', 'cadence_rpm', 'speed_kmh',
                  'heart_rate_bpm', 'distance_m', 'energy_kj'];

const nz = v => v !== null && v !== undefined;
const r0 = v => (nz(v) ? Math.round(v) : '–');
const pad2 = n => String(n).padStart(2, '0');
const fmtT = s => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
};
const fmtClock = s => `${Math.floor(s / 3600)}:${pad2(Math.floor((s % 3600) / 60))}:${pad2(s % 60)}`;
const zoneOf = (p, ftp) => { const i = ZONES.findIndex(z => p / ftp < z.hi); return i < 0 ? 6 : i; };
const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

function useStored(key, initial) {
  const [v, setV] = useState(() => {
    try { const s = localStorage.getItem('x2max.' + key); return s === null || s === '' ? initial : JSON.parse(s); }
    catch (e) { return initial; }
  });
  useEffect(() => { try { localStorage.setItem('x2max.' + key, JSON.stringify(v)); } catch (e) {} }, [key, v]);
  return [v, setV];
}

// Summary over a slice of 1 Hz samples. `before` = the sample just before the slice (for distance/kJ deltas).
function stats(a, ftp, before) {
  const out = { n: a.length, moving: 0, avgP: null, np: null, maxP: null, avgCad: null, avgSpd: null,
                avgHr: null, maxHr: null, dist: 0, kj: 0, tiz: new Array(7).fill(0) };
  if (!a.length) return out;
  let sp = 0, mc = 0, sc = 0, cc = 0, ss = 0, sn = 0, sh = 0, hn = 0, mh = 0, mp = 0;
  let roll = 0, sum4 = 0, n4 = 0;
  a.forEach((s, i) => {
    const p = s.power_w || 0;
    const moving = p > 0 || (s.cadence_rpm || 0) > 0;
    if (moving) { out.moving++; sp += p; mc++; out.tiz[zoneOf(p, ftp)]++; }
    if (p > mp) mp = p;
    if (s.cadence_rpm > 0) { sc += s.cadence_rpm; cc++; }
    if (moving && nz(s.speed_kmh)) { ss += s.speed_kmh; sn++; }
    if (nz(s.heart_rate_bpm)) { sh += s.heart_rate_bpm; hn++; if (s.heart_rate_bpm > mh) mh = s.heart_rate_bpm; }
    roll += p; if (i >= 30) roll -= a[i - 30].power_w || 0;          // 30 s rolling average
    if (i >= 29) { sum4 += Math.pow(roll / 30, 4); n4++; }
  });
  out.avgP = mc ? sp / mc : null;
  out.maxP = mp;
  out.np = n4 ? Math.pow(sum4 / n4, 0.25) : null;
  out.avgCad = cc ? sc / cc : null;
  out.avgSpd = sn ? ss / sn : null;
  out.avgHr = hn ? sh / hn : null;
  out.maxHr = hn ? mh : null;
  const last = a[a.length - 1];
  out.dist = last.distance_m - (before ? before.distance_m : 0);
  out.kj = last.energy_kj - (before ? before.energy_kj : 0);
  return out;
}

// ------------------------------------------------------------------ live feed (SSE)
// History lives in a ref (it can be hours long) and `version` bumps on each change.
function useLiveFeed() {
  const hist = useRef([]);
  const [laps, setLaps] = useState([0]);
  const [status, setStatus] = useState({});
  const [online, setOnline] = useState(true);
  const [version, setVersion] = useState(0);

  useEffect(() => {
    let es, closed = false;
    const open = () => {
      es = new EventSource('/events');
      es.addEventListener('init', e => {
        const d = JSON.parse(e.data);
        hist.current = d.history; setLaps(d.laps); setStatus(d.status);
        setOnline(true); setVersion(v => v + 1);
      });
      es.addEventListener('sample', e => {
        const s = JSON.parse(e.data), h = hist.current;
        if (s.t === h.length) { h.push(s); setVersion(v => v + 1); }
        else if (s.t > h.length) { es.close(); if (!closed) open(); }  // missed samples: resync via init
      });
      es.addEventListener('laps', e => { setLaps(JSON.parse(e.data)); setVersion(v => v + 1); });
      es.addEventListener('status', e => setStatus(JSON.parse(e.data)));
      es.onerror = () => setOnline(false);  // EventSource retries by itself; init clears this
    };
    open();
    return () => { closed = true; es.close(); };
  }, []);

  return { hist: hist.current, laps, status, online, version };
}

const postLap = () => fetch('/lap', { method: 'POST' }).catch(() => {});

// ------------------------------------------------------------------ header
const STATUS = {
  connected:    ['--good', s => `Connected · ${s.device || 'trainer'}`],
  demo:         ['--power', () => 'Demo ride (simulated data)'],
  searching:    ['--warning', () => 'Searching for trainer…'],
  reconnecting: ['--warning', () => 'Trainer lost · reconnecting (timer paused)'],
  starting:     ['--warning', () => 'Starting…'],
};

function Header({ status, seconds, ftp, setFtp, win, setWin, onCsv }) {
  const [col, txt] = STATUS[status.state] || ['--text-muted', () => status.state || 'Connecting…'];
  const [ftpDraft, setFtpDraft] = useState(String(ftp));
  useEffect(() => setFtpDraft(String(ftp)), [ftp]);
  const commitFtp = () => { const v = +ftpDraft; if (v >= 50 && v <= 600) setFtp(v); else setFtpDraft(String(ftp)); };
  return (
    <header>
      <h1>X2Max · Live training</h1>
      <span className="pill"><span className="dot" style={{ background: `var(${col})` }} />{txt(status)}</span>
      <div className="controls">
        <button className="primary" onClick={postLap} title="Shortcut: L">Lap</button>
        <label className="ftp">FTP
          <input type="number" min="50" max="600" step="1" value={ftpDraft}
                 onChange={e => setFtpDraft(e.target.value)} onBlur={commitFtp}
                 onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} /> W
        </label>
        <select value={win} onChange={e => setWin(+e.target.value)} aria-label="Chart window">
          <option value={300}>Last 5 min</option>
          <option value={1200}>Last 20 min</option>
          <option value={0}>Whole ride</option>
        </select>
        <button onClick={onCsv}>Export CSV</button>
      </div>
      <div className="clock" title="Ride time">{fmtClock(seconds)}</div>
    </header>
  );
}

// ------------------------------------------------------------------ tiles
function Tile({ label, keyColor, value, unit, sub, className = '', children }) {
  return (
    <div className={'tile ' + className}>
      <div className="label">{keyColor && <span className="key" style={{ background: `var(${keyColor})` }} />}{label}</div>
      <div className="value">{value}{unit && <span className="unit">{unit}</span>}</div>
      {sub !== undefined && <div className="sub">{sub || ' '}</div>}
      {children}
    </div>
  );
}

function Hero({ hist, st, ftp }) {
  const last = hist[hist.length - 1];
  const w3 = hist.slice(-3);
  const p3 = w3.length ? w3.reduce((t, s) => t + (s.power_w || 0), 0) / w3.length : null;
  const zi = p3 > 0 ? zoneOf(p3, ftp) : -1;
  const z = ZONES[zi];
  return (
    <section className="hero">
      <Tile className="power" label="Power · 3 s" keyColor="--power" value={r0(p3)} unit="W"
            sub={!last ? '' : p3 > 0 ? `${z.n} · ${z.name} · ${Math.round((p3 / ftp) * 100)}% FTP` : 'Not pedaling'}>
        <div className="zonebar">
          {ZONES.map((zz, i) => <span key={zz.n} className={i === zi ? 'on' : ''}
                                      style={{ background: `var(--z${i + 1})` }} title={`${zz.n} ${zz.name}`} />)}
        </div>
      </Tile>
      <Tile label="Cadence" keyColor="--cadence" value={last ? r0(last.cadence_rpm) : '–'} unit="rpm"
            sub={st.avgCad ? `avg ${Math.round(st.avgCad)}` : ''} />
      <Tile label="Speed" value={last && nz(last.speed_kmh) ? last.speed_kmh.toFixed(1) : '–'} unit="km/h"
            sub={st.avgSpd ? `avg ${st.avgSpd.toFixed(1)}` : last && !nz(last.speed_kmh) ? 'Trainer sends no speed' : ''} />
      <Tile label="Heart rate" keyColor="--hr" value={last ? r0(last.heart_rate_bpm) : '–'} unit="bpm"
            sub={!last ? '' : st.avgHr ? `avg ${Math.round(st.avgHr)} · max ${st.maxHr}` : 'No HR data'} />
    </section>
  );
}

function Stats({ hist, st, ftp, kg, setKg }) {
  const w3 = hist.slice(-3);
  const p3 = w3.length ? w3.reduce((t, s) => t + (s.power_w || 0), 0) / w3.length : 0;
  let ifTss = '–';
  if (st.np) {
    const IF = st.np / ftp, tss = ((hist.length * st.np * IF) / (ftp * 3600)) * 100;
    ifTss = `${IF.toFixed(2)} · ${Math.round(tss)}`;
  }
  return (
    <section className="stats">
      <Tile label="Moving time" value={fmtT(st.moving)} />
      <Tile label="Distance" value={(st.dist / 1000).toFixed(2)} unit="km" />
      <Tile label="Avg power" value={r0(st.avgP)} unit="W" />
      <Tile label="Normalized power" value={r0(st.np)} unit="W" />
      <Tile label="Max power" value={r0(st.maxP)} unit="W" />
      {/* ~1 kJ of work ≈ 1 kcal burned (≈24 % gross efficiency) */}
      <Tile label="Energy" value={Math.round(st.kj)} unit="kJ" sub={`≈ ${Math.round(st.kj)} kcal`} />
      <Tile label="IF · TSS" value={ifTss} />
      <Tile label="W/kg" value={kg ? (p3 / kg).toFixed(2) : '–'}
            sub={<><input type="number" min="30" max="200" step="0.1" placeholder="kg" value={kg ?? ''}
                          style={{ width: 70, padding: '2px 6px' }}
                          onChange={e => { const v = +e.target.value; setKg(v > 0 ? v : null); }} /> kg</>} />
    </section>
  );
}

// ------------------------------------------------------------------ charts
const CHARTS = [
  { key: 'power_w', color: '--power', fill: true, min: 0, floorMax: 300, ftpRef: true, title: 'Power (W) · dashed line = FTP', h: 200 },
  { key: 'cadence_rpm', color: '--cadence', min: 0, floorMax: 120, title: 'Cadence (rpm)', h: 120 },
  { key: 'heart_rate_bpm', color: '--hr', autoMin: true, floorMax: 160, title: 'Heart rate (bpm)', h: 140, xaxis: true },
];

function niceStep(range, n) {
  const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

function xRange(n, win) {
  if (win) { const end = Math.max(n - 1, win - 1); return [end - win + 1, end]; }
  return [0, Math.max(n - 1, 59)];
}

function useWidth(ref) {
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.round(e.contentRect.width)));
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, [ref]);
  return w;
}

function Chart({ c, hist, laps, ftp, win, version, hover, setHover }) {
  const cv = useRef(null);
  const W = useWidth(cv), H = c.h;
  const pad = { l: 40, r: 10, t: 8, b: c.xaxis ? 22 : 6 };
  const [x0, x1] = xRange(hist.length, win);

  useEffect(() => {
    const el = cv.current; if (!el || !W) return;
    const dpr = window.devicePixelRatio || 1;
    el.width = Math.round(W * dpr); el.height = Math.round(H * dpr);
    const g = el.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, W, H);
    const tok = { grid: cssVar('--grid'), muted: cssVar('--text-muted'), sec: cssVar('--text-secondary'),
                  surf: cssVar('--surface-1'), col: cssVar(c.color) };

    const data = hist.slice(Math.max(0, x0), x1 + 1);
    const vals = data.map(s => s[c.key]).filter(nz);
    let ymax = c.floorMax, ymin = c.min ?? 0, vmin = Infinity;
    for (const v of vals) { if (v > ymax) ymax = v; if (v < vmin) vmin = v; }
    if (c.ftpRef) ymax = Math.max(ymax, ftp * 1.15);
    if (c.autoMin) ymin = vals.length ? Math.max(0, Math.floor((vmin - 10) / 20) * 20) : 60;
    const step = niceStep(ymax - ymin, 4); ymax = Math.ceil(ymax / step) * step;
    const X = t => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
    const Y = v => pad.t + (1 - (v - ymin) / (ymax - ymin)) * (H - pad.t - pad.b);

    // grid + y labels
    g.font = '11px system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'right';
    for (let v = ymin; v <= ymax + 1e-9; v += step) {
      const y = Math.round(Y(v)) + 0.5;
      g.strokeStyle = tok.grid; g.lineWidth = 1; g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke();
      g.fillStyle = tok.muted; g.fillText(Math.round(v), pad.l - 6, Y(v));
    }
    // x labels (time)
    if (c.xaxis) {
      g.textAlign = 'center'; g.textBaseline = 'top'; g.fillStyle = tok.muted;
      const span = x1 - x0, xs = [60, 120, 300, 600, 900, 1800, 3600, 7200].find(s => span / s <= 7) || 7200;
      for (let t = Math.ceil(Math.max(0, x0) / xs) * xs; t <= x1; t += xs) g.fillText(fmtT(t), X(t), H - pad.b + 6);
    }
    // lap markers
    g.strokeStyle = tok.muted; g.setLineDash([2, 4]); g.lineWidth = 1;
    laps.slice(1).forEach(l => {
      if (l >= x0 && l <= x1) { const x = Math.round(X(l)) + 0.5; g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, H - pad.b); g.stroke(); }
    });
    g.setLineDash([]);
    // FTP reference
    if (c.ftpRef) {
      const y = Math.round(Y(ftp)) + 0.5;
      g.strokeStyle = tok.sec; g.setLineDash([6, 5]); g.beginPath(); g.moveTo(pad.l, y); g.lineTo(W - pad.r, y); g.stroke(); g.setLineDash([]);
      g.fillStyle = tok.sec; g.textAlign = 'left'; g.textBaseline = 'bottom'; g.fillText('FTP ' + ftp, pad.l + 4, y - 3);
    }
    if (!vals.length) {
      g.fillStyle = tok.muted; g.textAlign = 'center'; g.textBaseline = 'middle';
      g.fillText(c.key === 'heart_rate_bpm' && hist.length ? 'No heart-rate data' : 'Waiting for data…', (W + pad.l) / 2, H / 2);
      return;
    }
    // line (+ area for power), broken at gaps
    const segs = []; let cur = [];
    data.forEach(s => { if (nz(s[c.key])) cur.push(s); else if (cur.length) { segs.push(cur); cur = []; } });
    if (cur.length) segs.push(cur);
    for (const seg of segs) {
      if (c.fill) {
        g.beginPath(); g.moveTo(X(seg[0].t), Y(ymin));
        seg.forEach(s => g.lineTo(X(s.t), Y(s[c.key])));
        g.lineTo(X(seg[seg.length - 1].t), Y(ymin)); g.closePath();
        g.fillStyle = tok.col + '2e'; g.fill();
      }
      g.beginPath(); seg.forEach((s, i) => (i ? g.lineTo : g.moveTo).call(g, X(s.t), Y(s[c.key])));
      g.strokeStyle = tok.col; g.lineWidth = 2; g.lineJoin = 'round'; g.stroke();
    }
    // hover crosshair + point
    if (hover !== null && hover >= x0 && hover <= x1) {
      const x = Math.round(X(hover)) + 0.5;
      g.strokeStyle = tok.sec; g.lineWidth = 1; g.beginPath(); g.moveTo(x, pad.t); g.lineTo(x, H - pad.b); g.stroke();
      const s = hist[hover];
      if (s && nz(s[c.key])) {
        g.beginPath(); g.arc(X(hover), Y(s[c.key]), 4.5, 0, Math.PI * 2);
        g.fillStyle = tok.col; g.fill(); g.lineWidth = 2; g.strokeStyle = tok.surf; g.stroke();
      }
    }
  }, [version, W, H, x0, x1, ftp, laps, hover, hist, c]);

  const onMove = e => {
    const r = cv.current.getBoundingClientRect(), x = e.clientX - r.left;
    const t = Math.round(x0 + ((x - pad.l) / (W - pad.l - pad.r)) * (x1 - x0));
    const box = cv.current.closest('.charts').getBoundingClientRect();
    setHover(t >= 0 && t < hist.length ? t : null, { x: e.clientX - box.left, y: e.clientY - box.top });
  };

  return (
    <div className="chart">
      <div className="title"><span className="key" style={{ background: `var(${c.color})` }} />{c.title}</div>
      <canvas ref={cv} style={{ height: H }} onMouseMove={onMove} onMouseLeave={() => setHover(null, null)} />
    </div>
  );
}

function Tooltip({ s, pos, ftp, boxRef }) {
  const ref = useRef(null);
  const [left, setLeft] = useState(0);
  useLayoutEffect(() => {
    if (!ref.current || !pos) return;
    const bw = boxRef.current.getBoundingClientRect().width, tw = ref.current.offsetWidth;
    setLeft(pos.x + 14 + tw > bw - 8 ? pos.x - tw - 14 : pos.x + 14);
  }, [pos, s, boxRef]);
  if (!s || !pos) return null;
  const z = s.power_w > 0 ? ZONES[zoneOf(s.power_w, ftp)].n : '';
  const Row = ({ col, k, v }) => (
    <div className="row"><span className="k"><i style={{ background: col }} />{k}</span><b>{v}</b></div>
  );
  return (
    <div className="tip" ref={ref} style={{ display: 'block', left, top: Math.max(8, pos.y - 40) }}>
      <div className="t">{fmtT(s.t)} · lap {s.lap}</div>
      <Row col="var(--power)" k="Power" v={`${s.power_w} W ${z}`} />
      <Row col="var(--cadence)" k="Cadence" v={`${s.cadence_rpm} rpm`} />
      <Row col="var(--hr)" k="Heart rate" v={nz(s.heart_rate_bpm) ? `${s.heart_rate_bpm} bpm` : '–'} />
      <Row col="transparent" k="Speed" v={nz(s.speed_kmh) ? `${s.speed_kmh.toFixed(1)} km/h` : '–'} />
    </div>
  );
}

function Charts(props) {
  const [hover, setHoverT] = useState(null);
  const [pos, setPos] = useState(null);
  const box = useRef(null);
  const setHover = useCallback((t, p) => { setHoverT(t); setPos(p); }, []);
  return (
    <div className="charts" ref={box}>
      <div className="head"><h2>Ride timeline</h2></div>
      {CHARTS.map(c => <Chart key={c.key} c={c} {...props} hover={hover} setHover={setHover} />)}
      <Tooltip s={hover !== null ? props.hist[hover] : null} pos={pos} ftp={props.ftp} boxRef={box} />
    </div>
  );
}

// ------------------------------------------------------------------ side panels
function TimeInZone({ st, ftp }) {
  const tot = st.tiz.reduce((a, b) => a + b, 0) || 1, mx = Math.max(...st.tiz, 1);
  return (
    <div className="panel">
      <h2>Time in power zone</h2>
      <div className="tiz">
        {ZONES.map((z, i) => {
          const lo = Math.round(z.lo * ftp), hi = z.hi === Infinity ? null : Math.round(z.hi * ftp) - 1;
          return (
            <div className="r" key={z.n} title={`${lo}${hi !== null ? '–' + hi : '+'} W`}>
              <span className="name">{z.n} {z.name}</span>
              <span className="bar"><i style={{ width: `${(st.tiz[i] / mx) * 100}%`, background: `var(--z${i + 1})` }} /></span>
              <span className="v">{fmtT(st.tiz[i])} <span style={{ color: 'var(--text-muted)' }}>{Math.round((st.tiz[i] / tot) * 100)}%</span></span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function Laps({ hist, laps, ftp }) {
  const rows = laps.map((start, i) => {
    const end = i + 1 < laps.length ? laps[i + 1] : hist.length;
    return { i, cur: i === laps.length - 1, ls: stats(hist.slice(start, end), ftp, start > 0 ? hist[start - 1] : null) };
  }).reverse();
  return (
    <div className="panel">
      <h2>Laps</h2>
      <div className="laps">
        <table>
          <thead><tr><th>#</th><th>Time</th><th>Avg W</th><th>NP</th><th>rpm</th><th>bpm</th><th>km</th></tr></thead>
          <tbody>
            {!hist.length ? <tr><td colSpan="7" className="empty">No data yet</td></tr> :
              rows.map(({ i, cur, ls }) => (
                <tr key={i} className={cur ? 'current' : ''}>
                  <td>{i + 1}{cur ? ' ▸' : ''}</td><td>{fmtT(ls.n)}</td><td>{r0(ls.avgP)}</td><td>{r0(ls.np)}</td>
                  <td>{r0(ls.avgCad)}</td><td>{r0(ls.avgHr)}</td><td>{(ls.dist / 1000).toFixed(2)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ app
function exportCsv(hist) {
  const csv = [CSV_COLS.join(',')].concat(hist.map(s => CSV_COLS.map(c => s[c] ?? '').join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'x2max_ride.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

function App() {
  const { hist, laps, status, online, version } = useLiveFeed();
  const [ftp, setFtp] = useStored('ftp', 200);
  const [kg, setKg] = useStored('kg', null);
  const [win, setWin] = useStored('win', 1200);

  const st = useMemo(() => stats(hist, ftp, null), [version, ftp]); // eslint-disable-line

  useEffect(() => {
    const k = e => {
      if ((e.key === 'l' || e.key === 'L') && !['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) postLap();
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);

  return (
    <div className="wrap">
      <Header status={status} seconds={hist.length} ftp={ftp} setFtp={setFtp} win={win} setWin={setWin}
              onCsv={() => exportCsv(hist)} />
      {!online && <div className="offline">The dashboard lost contact with the script.
        Is <code>thinkrider_logger.py</code> still running? Retrying…</div>}
      <Hero hist={hist} st={st} ftp={ftp} />
      <Stats hist={hist} st={st} ftp={ftp} kg={kg} setKg={setKg} />
      <section className="main">
        <Charts hist={hist} laps={laps} ftp={ftp} win={win} version={version} />
        <div className="side">
          <TimeInZone st={st} ftp={ftp} />
          <Laps hist={hist} laps={laps} ftp={ftp} />
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
