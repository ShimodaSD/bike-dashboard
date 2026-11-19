// X2Max live dashboard (React). Talks to logger/thinkrider_logger.py:
//   GET  /events  Server-Sent Events: init, sample, preview, status, laps,
//                 live (instant numbers on every trainer packet; ?live=2 caps it at 2/s)
//   POST /lap     start a new lap
//   POST /start, /finish   begin / end a recorded ride
//   POST /devices/scan, /devices/use|search|off?role=trainer|hr   device panel
//   POST /control?on=1|0, /control/grade?pct=, /control/power?w=   trainer control (control/climb.jsx)
//   POST /clear   empty the dashboard (files on disk stay)
//   POST /quit    stop the logger
//   GET  /ride.fit  the finished ride (or the ride so far)
//
// State comes from two external stores read with useSyncExternalStore: the logger's live feed
// (hooks/feed.js) and settings in localStorage (hooks/stored.js). Everything else is derived while
// rendering. Effects are kept for real outside systems only: drawing the canvases, document key
// and focus handling, the device scan while that panel is open, and the trainer / audio.
import React, { memo, useState, useEffect, useRef, useMemo, useCallback } from 'react';
import { createRoot } from 'react-dom/client';
import { WorkoutBand, WorkoutSettings, plannedLine, powerTol, workoutAt, CAD_TOL, HR_TOL, SPEED_TOL } from './workout/workout.jsx';
import { ClimbBand, useWorkoutControl, controlKey, fmtGrade } from './control/climb.jsx';
import { useLiveFeed } from './hooks/feed.js';
import { useStored } from './hooks/stored.js';
import { useArmed, useEvent, useWidth } from './hooks/hooks.js';

// ------------------------------------------------------------------ constants & helpers
const ZONES = [
  { n: 'Z1', name: 'Recovery',   lo: 0,    hi: 0.55 },
  { n: 'Z2', name: 'Endurance',  lo: 0.55, hi: 0.75 },
  { n: 'Z3', name: 'Tempo',      lo: 0.75, hi: 0.90 },
  { n: 'Z4', name: 'Threshold',  lo: 0.90, hi: 1.05 },
  { n: 'Z5', name: 'VO2max',     lo: 1.05, hi: 1.20 },
  { n: 'Z6', name: 'Anaerobic',  lo: 1.20, hi: 1.50 },
  { n: 'Z7', name: 'Neuromuscular', lo: 1.50, hi: Infinity },
];
const CSV_COLS = ['t', 'timestamp_utc', 'lap', 'power_w', 'cadence_rpm', 'speed_kmh',
                  'heart_rate_bpm', 'distance_m', 'energy_kj', 'grade_pct'];

const nz = v => v !== null && v !== undefined;
const r0 = v => (nz(v) ? Math.round(v) : '–');
const pad2 = n => String(n).padStart(2, '0');
const fmtT = s => {
  s = Math.max(0, Math.round(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), x = s % 60;
  return h ? `${h}:${pad2(m)}:${pad2(x)}` : `${m}:${pad2(x)}`;
};
const zoneOf = (p, ftp) => { const i = ZONES.findIndex(z => p / ftp < z.hi); return i < 0 ? 6 : i; };
const cssVar = v => getComputedStyle(document.documentElement).getPropertyValue(v).trim();

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

// ------------------------------------------------------------------ live feed (SSE): hooks/feed.js
// Instant numbers older than this are ignored (trainer stopped sending).
const FRESH_MS = 2500;

const post = path => fetch(path, { method: 'POST' }).catch(() => {});
// Touch screens say "Tap", mice say "Click".
const PRESS = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches ? 'Tap' : 'Click';
const postLap = () => post('/lap');

// ------------------------------------------------------------------ header
// [dot colour, full label, short label for phones]
const STATUS = {
  connected:    ['--good', s => `Trainer · ${s.device || 'connected'}`, 'Trainer'],
  demo:         ['--power', s => s.device ? `Demo · ${s.device.replace(/\s*\(demo\)$/i, '')}` : 'Demo · simulated data', 'Demo'],
  searching:    ['--warning', s => s.device ? `Looking for ${s.device}…` : 'Searching for trainer…', 'Searching…'],
  reconnecting: ['--warning', () => 'Trainer lost · reconnecting (timer paused)', 'Trainer lost'],
  starting:     ['--warning', () => 'Starting…', 'Starting…'],
  off:          ['--text-muted', () => 'Trainer search off', 'Trainer off'],
};

// Separate heart-rate device (Garmin watch broadcasting HR, chest strap ...)
const HR_STATUS = {
  connected:    ['--good', h => `HR · ${h.device || 'connected'}`, 'HR'],
  searching:    ['--warning', h => h.device ? `HR · looking for ${h.device}` : 'HR · looking for watch or strap', 'HR…'],
  reconnecting: ['--warning', h => `HR · ${h.device || 'device'} lost, reconnecting`, 'HR lost'],
  off:          ['--text-muted', () => 'HR · off', 'HR off'],
};
const Pill = ({ col, long, short }) => (
  <span className="pill"><span className="dot" style={{ background: `var(${col})` }} />
    <span className="long">{long}</span><span className="short" aria-hidden="true">{short}</span></span>);

// Buttons that need a second press: useArmed in hooks/hooks.js.
// Armed look: red fill plus a bar that drains over the 4 s, so the timeout is visible.
const armedCls = (armed, base = '') => (armed ? `${base} danger armed`.trim() : base);

const Kbd = ({ k }) => <kbd aria-hidden="true">{k}</kbd>;

function Header({ status, ride, act, panel, toggle }) {
  const settingsOpen = panel === 'settings', devicesOpen = panel === 'devices';
  const recording = ride.state === 'recording';
  const [col, txt, short] = STATUS[status.state] || ['--text-muted', () => status.state || 'Connecting…', 'Connecting…'];
  const hr = status.hr || {};
  const hrPill = HR_STATUS[hr.state];
  return (
    <header>
      <h1>Bike <span>Live training</span></h1>
      <button className={'pills' + (devicesOpen ? ' on' : '')} onClick={() => toggle('devices')}
              aria-expanded={devicesOpen} aria-controls="devices" title="Choose the trainer and heart-rate device">
        <Pill col={col} long={txt(status)} short={short} />
        {hrPill && <Pill col={hrPill[0]} long={hrPill[1](hr)} short={hrPill[2]} />}
        <span className="pills-act">Devices</span>
      </button>
      <div className="controls">
        {recording ? <>
          <button className="primary lap" onClick={act.lap} aria-keyshortcuts="L">Lap <Kbd k="L" /></button>
          <button className={armedCls(act.finishArmed, 'finish')} onClick={act.finish} aria-keyshortcuts="F">
            {act.finishArmed ? `${PRESS} again to finish` : <>Finish <Kbd k="F" /></>}</button>
        </> : <button className={armedCls(act.startArmed, 'start')} onClick={act.start} aria-keyshortcuts="S">
          {act.startArmed ? `${PRESS} again to start` : <>{ride.state === 'finished' ? 'Start new ride' : 'Start'} <Kbd k="S" /></>}
        </button>}
        <button className={'quiet settings-btn' + (settingsOpen ? ' on' : '')} onClick={() => toggle('settings')}
                aria-expanded={settingsOpen} aria-controls="settings">Settings</button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ drawer: Devices or Settings, one at a time
// Floats over the page instead of pushing it down, so the live numbers never move mid-ride.
// Not a modal: the page behind keeps updating and stays usable. Esc or Close puts focus back.
function Drawer({ id, title, onClose, children }) {
  const ref = useRef(null);
  const close = useEvent(onClose);
  useEffect(() => {      // focus moves in while open and back out on close; Esc works anywhere on the page
    const back = document.activeElement;
    ref.current.focus();
    const k = e => { if (e.key === 'Escape') close(); };
    document.addEventListener('keydown', k);
    return () => { document.removeEventListener('keydown', k); if (back && back.focus) back.focus(); };
  }, [close]);
  return (
    <aside className="drawer" id={id} aria-label={title} tabIndex={-1} ref={ref}>
      <div className="drawer-head">
        <h2>{title}</h2>
        <button className="quiet" onClick={onClose}>Close <Kbd k="Esc" /></button>
      </div>
      {children}
    </aside>
  );
}

// ------------------------------------------------------------------ settings
// The draft is what is typed; it is committed on blur / Enter. Keyed by the saved value, so a new
// FTP or weight (from here or another tab) starts a fresh draft instead of an effect copying it in.
function FtpField({ ftp, setFtp }) {
  const [ftpDraft, setFtpDraft] = useState(String(ftp));
  const [ftpErr, setFtpErr] = useState(false);
  const commitFtp = () => {
    const v = Math.round(+ftpDraft);
    if (v >= 50 && v <= 600) { setFtp(v); setFtpDraft(String(v)); setFtpErr(false); } else { setFtpErr(true); setFtpDraft(String(ftp)); }
  };
  return (
    <div className="field">
      <label htmlFor="ftp">FTP</label>
      <div className="inline">
        <input id="ftp" type="number" inputMode="numeric" min="50" max="600" step="1" value={ftpDraft}
               aria-invalid={ftpErr} aria-describedby="ftp-help"
               onChange={e => { setFtpDraft(e.target.value); setFtpErr(false); }} onBlur={commitFtp}
               onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} /> W
      </div>
      <p id="ftp-help" className={'help' + (ftpErr ? ' err' : '')}>
        {ftpErr ? 'FTP must be between 50 and 600 W. Kept ' + ftp + ' W.' : 'Sets the power zones and the FTP line.'}</p>
    </div>
  );
}

function WeightField({ kg, setKg }) {
  // typed as text so a half-typed "7" or a comma ("72,5") isn't wiped while typing
  const [kgDraft, setKgDraft] = useState(kg == null ? '' : String(kg));
  const [kgErr, setKgErr] = useState(false);
  const commitKg = () => {
    const t = kgDraft.trim().replace(',', '.'), v = Math.round(+t * 10) / 10;
    if (t === '') { setKg(null); setKgErr(false); }
    else if (v >= 30 && v <= 200) { setKg(v); setKgDraft(String(v)); setKgErr(false); }
    else setKgErr(true);
  };
  return (
    <div className="field">
      <label htmlFor="kg">Weight</label>
      <div className="inline">
        <input id="kg" type="text" inputMode="decimal" value={kgDraft} aria-invalid={kgErr}
               onChange={e => { setKgDraft(e.target.value); setKgErr(false); }} onBlur={commitKg}
               onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} /> kg
      </div>
      <p className={'help' + (kgErr ? ' err' : '')}>
        {kgErr ? 'Weight must be between 30 and 200 kg.' : 'Used for W/kg. FTP and weight are remembered in this browser.'}</p>
    </div>
  );
}

function Settings({ ftp, setFtp, kg, setKg, onCsv, canCsv, smooth, setSmooth, liveRate, setLiveRate, recording, workout }) {
  return (
    <section className="settings">
      <FtpField key={ftp} ftp={ftp} setFtp={setFtp} />
      <WeightField key={kg ?? ''} kg={kg} setKg={setKg} />
      <div className="field">
        <label htmlFor="smooth">Power number</label>
        <div className="inline">
          <select id="smooth" value={smooth} onChange={e => setSmooth(+e.target.value)}>
            <option value={0}>Instant</option>
            <option value={3}>3 s average</option>
            <option value={5}>5 s average</option>
          </select>
        </div>
        <p className="help">Instant shows each reading from the trainer. Averages are steadier.</p>
      </div>
      <div className="field">
        <label htmlFor="liverate">Live updates</label>
        <div className="inline">
          <select id="liverate" value={liveRate} onChange={e => setLiveRate(e.target.value)}>
            <option value="auto">Automatic</option>
            <option value="fast">Instant</option>
            <option value="saver">Battery saver (2 per second)</option>
          </select>
        </div>
        <p className="help">Automatic is instant on a computer and battery saver on a phone or tablet.</p>
      </div>
      <div className="field">
        <span className="flabel">Workout</span>
        <WorkoutSettings {...workout} />
      </div>
      <div className="field">
        <span className="flabel">This ride</span>
        <div className="inline"><button onClick={onCsv} disabled={!canCsv}>Export CSV</button></div>
        <p className="help">The logger also writes a CSV and a .FIT file to its ride folder.</p>
      </div>
      <div className="field">
        <span className="flabel">Clear data</span>
        <ClearData recording={recording} />
      </div>
      <div className="field">
        <span className="flabel">Logger</span>
        <StopLogger />
      </div>
      <div className="field wide">
        <span className="flabel">Tips</span>
        <p className="help">Garmin watch heart rate: turn on <b>Broadcast Heart Rate</b> on the watch.
          Close Zwift and the ThinkRider app first: the trainer and the watch accept one connection at a time.
          <span className="keys"> Keys: <Kbd k="S" /> start, <Kbd k="L" /> lap, <Kbd k="F" /> twice to finish,
          <Kbd k="−" /> <Kbd k="+" /> grade (Trainer control on).</span></p>
      </div>
    </section>
  );
}

// Clearing would throw away the ride in progress, so it waits until the ride is finished.
function ClearData({ recording }) {
  const [armed, press] = useArmed(recording);
  return <>
    <div className="inline"><button className={armedCls(armed)} disabled={recording} onClick={() => press(() => post('/clear'))}>
      {armed ? `${PRESS} again to clear` : 'Clear all data'}</button></div>
    <p className="help">{recording ? 'Finish the ride first. Clearing during a ride would throw it away.'
      : 'Empties the dashboard: ride, laps, totals and charts. Files already in the ride folder are kept.'}</p>
  </>;
}

function StopLogger() {
  const [armed, press] = useArmed();
  return <>
    <div className="inline"><button className={armedCls(armed)} onClick={() => press(() => post('/quit'))}>
      {armed ? `${PRESS} again to stop` : 'Stop logger'}</button></div>
    <p className="help">Saves a ride in progress, then closes the logger. Start it again with <b>Start X2Max</b>.</p>
  </>;
}

// ------------------------------------------------------------------ devices (disclosure): pick trainer + HR source
const ROLE = {
  trainer: { title: 'Trainer', any: 'Any smart trainer',
             tip: 'Pedal to wake the trainer. Close Zwift and the ThinkRider app first: it takes one connection at a time.' },
  hr:      { title: 'Heart rate', any: 'Any heart-rate broadcast',
             tip: <>On the Forerunner turn on <b>Broadcast Heart Rate</b> (hold UP › Settings › Sensors &amp; Accessories › Wrist Heart Rate).</> },
};
const KIND = { trainer: 'Smart trainer', hr: 'Heart-rate broadcast', other: 'Other device' };
const useUrl = (role, d) => `/devices/use?role=${role}&address=${encodeURIComponent(d.address)}&name=${encodeURIComponent(d.name || '')}`;

function Bars({ rssi }) {
  const n = rssi == null ? 0 : rssi >= -65 ? 3 : rssi >= -80 ? 2 : 1;
  const word = ['Unknown', 'Weak', 'Good', 'Strong'][n];
  return <span className="bars" role="img" aria-label={`Signal ${word}`} title={rssi == null ? word : `${word} signal (${rssi} dBm)`}>
    {[1, 2, 3].map(i => <i key={i} className={i <= n ? 'on' : ''} />)}</span>;
}

function slotInfo(role, status) {
  const s = role === 'trainer' ? status : (status.hr || {});
  const choice = (status.devices || {})[role] || { mode: 'auto' };
  const name = s.device || choice.name || choice.address;
  if (choice.mode === 'off' || s.state === 'off')
    return { dot: '--text-muted', name: choice.name || 'None', off: true,
             text: `Search is off. It won't look for ${role === 'trainer' ? 'the trainer' : 'a heart-rate broadcast'}, even after a restart, until you turn it on.` };
  if (s.state === 'connected' || s.state === 'demo')
    return { dot: '--good', name, text: 'Connected. Reconnects by itself if it drops.', on: true };
  if (s.state === 'reconnecting')
    return { dot: '--warning', name: name || ROLE[role].any, text: 'Connection lost, reconnecting…' };
  if (choice.mode === 'device') return { dot: '--warning', name, text: 'Looking for it…' };
  return { dot: '--warning', name: ROLE[role].any, text: 'Looking… or pick one below.' };
}

function Slot({ role, status, recording }) {
  const info = slotInfo(role, status);
  const choice = (status.devices || {})[role] || {};
  const confirm = role === 'trainer' && recording && info.on;      // dropping the trainer pauses the ride
  const [armed, press] = useArmed(info.text);
  const off = () => confirm ? press(() => post(`/devices/off?role=${role}`)) : post(`/devices/off?role=${role}`);
  return (
    <div className="slot">
      <span className="flabel">{ROLE[role].title}</span>
      <div className="slot-dev"><span className="dot" style={{ background: `var(${info.dot})` }} /><b>{info.name}</b></div>
      <p className="help">{info.text}</p>
      <div className="inline">
        {info.off ? <>
            <button className="primary" onClick={() => post(`/devices/search?role=${role}`)}>
              {choice.address ? `Search for ${choice.name || 'it'}` : 'Turn search on'}</button>
            {choice.address && <button onClick={() => post(`/devices/auto?role=${role}`)}>Search for any</button>}
          </> : <button className={armedCls(armed)} onClick={off}>
            {armed ? `${PRESS} again (pauses the ride)` : info.on ? 'Disconnect and stop searching' : 'Stop searching'}</button>}
      </div>
      {!info.on && !info.off && <p className="help">{ROLE[role].tip}</p>}
    </div>
  );
}

function DeviceRow({ d, choice }) {
  const inUse = ['trainer', 'hr'].find(r => (choice[r] || {}).mode !== 'off' && (choice[r] || {}).address === d.address);
  const roles = d.kind === 'other' ? ['trainer', 'hr'] : [d.kind];
  return (
    <li>
      <Bars rssi={d.rssi} />
      <span className="dname">{d.name || 'Unnamed device'}<small>{KIND[d.kind]}</small></span>
      <span className="dact">
        {inUse ? <span className="badge done">{ROLE[inUse].title}</span>
          : roles.map(r => <button key={r} className={d.kind === r ? 'primary' : ''} onClick={() => post(useUrl(r, d))}
                                   aria-label={`Use ${d.name || 'this device'} for ${ROLE[r].title.toLowerCase()}`}>
              {d.kind === 'other' ? `As ${ROLE[r].title.toLowerCase()}` : 'Connect'}</button>)}
      </span>
    </li>
  );
}

function Devices({ status, recording }) {
  const scan = status.scan || {};
  const choice = status.devices || {};
  const [showOther, setShowOther] = useState(false);
  useEffect(() => { post('/devices/scan'); }, []);   // a short Bluetooth scan while the panel is open (it mounts on open)
  const scanning = scan.state === 'scanning';
  const found = scan.found || [];
  const main = found.filter(d => d.kind !== 'other'), other = found.filter(d => d.kind === 'other');
  return (
    <section className="devices">
      <div className="slots">
        <Slot role="trainer" status={status} recording={recording} />
        <Slot role="hr" status={status} recording={recording} />
      </div>
      <div className="nearby">
        <div className="head">
          <h2>Nearby</h2>
          <button onClick={() => post('/devices/scan')} disabled={scanning}>{scanning ? 'Scanning…' : 'Scan again'}</button>
        </div>
        <ul aria-busy={scanning}>
          {main.map(d => <DeviceRow key={d.address} d={d} choice={choice} />)}
          {showOther && other.map(d => <DeviceRow key={d.address} d={d} choice={choice} />)}
        </ul>
        {!main.length && <p className="empty">
          {scanning ? 'Looking for trainers and heart-rate broadcasts…'
            : scan.state === 'error' ? `Bluetooth scan failed: ${scan.error}`
            : scan.state === 'done' ? 'No trainer or heart-rate broadcast found. Pedal to wake the trainer, check Broadcast Heart Rate on the watch, then scan again.'
            : ''}</p>}
        {other.length > 0 && <button className="quiet" onClick={() => setShowOther(o => !o)} aria-expanded={showOther}>
          {showOther ? 'Hide other devices' : `Show other devices (${other.length})`}</button>}
      </div>
    </section>
  );
}

// ------------------------------------------------------------------ tiles
function Tile({ label, keyColor, value, unit, sub, className = '', badge, style, children }) {
  return (
    <div className={'tile ' + className} style={style}>
      <div className="label">{keyColor && <span className="key" style={{ background: `var(${keyColor})` }} />}{label}{badge}</div>
      <div className="value">{value}{unit && <span className="unit">{unit}</span>}</div>
      {sub !== undefined && <div className="sub">{sub || ' '}</div>}
      {children}
    </div>
  );
}

// Best average power over any `sec`-second stretch of the ride (null if the ride is shorter).
function bestPower(h, sec) {
  if (h.length < sec) return null;
  let sum = 0, best = 0;
  h.forEach((s, i) => { sum += s.power_w || 0; if (i >= sec) sum -= h[i - sec].power_w || 0; if (i >= sec - 1 && sum > best) best = sum; });
  return best / sec;
}
const tssOf = (n, np, ftp) => (np ? ((n * np * (np / ftp)) / (ftp * 3600)) * 100 : null);
const fmtTss = t => (t === null ? '–' : t < 10 ? t.toFixed(1) : Math.round(t));

const avg3 = h => { const w = h.slice(-3); return w.length ? w.reduce((t, s) => t + (s.power_w || 0), 0) / w.length : null; };

// Recording: live ride.  Ready: live preview (nothing saved).  Finished: the ride's summary.
// Power shown live: the latest packet (instant) or the mean of the last `smooth` seconds of packets.
function livePower(now, recent, smooth) {
  if (!smooth) return now.power_w;
  const w = recent.filter(x => now.at - x.at < smooth * 1000);
  return w.length ? w.reduce((t, x) => t + x.p, 0) / w.length : now.power_w;
}

function Hero({ hist, laps, st, ftp, preview, mode, now, recent, smooth }) {
  const done = mode === 'finished' && hist.length > 0;
  const fresh = now && Date.now() - now.at < FRESH_MS;
  const live = fresh ? [now] : mode === 'recording' ? hist : preview ? [preview] : [];
  const last = live[live.length - 1];
  const p = done ? st.avgP : fresh ? livePower(now, recent, smooth) : avg3(live);
  const zi = p > 0 ? zoneOf(p, ftp) : -1;
  const z = ZONES[zi];
  const zoneTxt = p > 0 ? <><b className="zn">{z.n}</b><span className="zrest"><b>{z.name}</b> · {Math.round((p / ftp) * 100)}% FTP</span></> : null;
  // current lap at a glance: number, time and average power so far
  const lapStart = laps[laps.length - 1] || 0, lapRows = hist.slice(lapStart);
  const lapAvg = lapRows.length ? lapRows.reduce((t, s) => t + (s.power_w || 0), 0) / lapRows.length : null;
  const timeBadge = mode === 'recording' ? <span className="badge rec">REC</span>
                  : mode === 'finished' ? <span className="badge done">Finished</span>
                  : null;   // the strip above already says Preview
  return (
    <section className={'hero ' + mode}>
      <Tile className={'power' + (zi >= 0 ? ' zoned' : '')} style={zi >= 0 ? { '--zc': `var(--z${zi + 1})` } : undefined} label={done ? 'Avg power · ride' : smooth ? `Power · ${smooth} s` : 'Power'} keyColor="--power" value={r0(p)} unit="W"
            sub={done ? <>{zoneTxt}{last ? <span className="live-now">now {r0(avg3(live))} W</span> : null}</>
                      : !last ? '' : p > 0 ? zoneTxt : 'Not pedaling'}>
        <div className="zonebar" aria-hidden="true">
          {ZONES.map((zz, i) => <span key={zz.n} className={i === zi ? 'on' : ''} style={{ background: `var(--z${i + 1})` }} />)}
        </div>
      </Tile>
      <Tile className={'time ' + mode} label="Ride time" badge={timeBadge}
            value={mode === 'ready' ? '0:00' : fmtT(hist.length)}
            sub={mode === 'ready' ? 'Press Start to record' : `moving ${fmtT(st.moving)}`}>
        {mode === 'recording' && <div className="lapnow" aria-label="Current lap">
          <b>Lap {laps.length}</b><span>{fmtT(lapRows.length)}</span><span>{r0(lapAvg)} W avg</span></div>}
      </Tile>
      <Tile label={done ? 'Avg cadence' : 'Cadence'} keyColor="--cadence" unit="rpm"
            value={done ? r0(st.avgCad) : last ? r0(last.cadence_rpm) : '–'}
            sub={!done && mode === 'recording' && st.avgCad ? `avg ${Math.round(st.avgCad)}` : ''} />
      <Tile label={done ? 'Avg speed' : 'Speed'} keyColor="--speed" unit="km/h"
            value={done ? (st.avgSpd ? st.avgSpd.toFixed(1) : '–') : last && nz(last.speed_kmh) ? last.speed_kmh.toFixed(1) : '–'}
            sub={mode === 'recording' && st.avgSpd ? `avg ${st.avgSpd.toFixed(1)}`
                 : last && !nz(last.speed_kmh) && !done ? 'Trainer sends no speed' : ''} />
      <Tile label={done ? 'Avg heart rate' : 'Heart rate'} keyColor="--hr" unit="bpm"
            value={done ? r0(st.avgHr) : last ? r0(last.heart_rate_bpm) : '–'}
            sub={done ? (st.maxHr ? `max ${st.maxHr}` : 'No HR data')
                 : !last ? '' : mode === 'recording' && st.avgHr ? `avg ${Math.round(st.avgHr)} · max ${st.maxHr}`
                 : nz(last.heart_rate_bpm) ? '' : 'No HR data'} />
    </section>
  );
}

const Stats = memo(function Stats({ hist, st, ftp, kg, more, setMore, mode }) {
  const done = mode === 'finished';
  const p3 = mode === 'recording' ? avg3(hist) || 0 : st.avgP || 0;
  const IF = st.np ? st.np / ftp : null, tss = tssOf(hist.length, st.np, ftp);
  const best = useMemo(() => {
    if (!done) return null;
    const sec = hist.length >= 1200 ? 1200 : hist.length >= 300 ? 300 : 60;
    return { sec, p: bestPower(hist, sec) };
  }, [done, hist.length]); // eslint-disable-line
  const np = <Tile key="np" label="Normalized power" value={r0(st.np)} unit="W" sub={st.np ? '' : 'after 30 s'} />;
  const avgP = <Tile key="avg" label="Avg power" value={r0(st.avgP)} unit="W" />;
  const maxP = <Tile key="max" label="Max power" value={r0(st.maxP)} unit="W" />;
  const dist = <Tile key="dist" label="Distance" value={(st.dist / 1000).toFixed(2)} unit="km" />;
  // ~1 kJ of work ≈ 1 kcal burned (≈24 % gross efficiency), so one number covers both
  const kj = <Tile key="kj" label="Energy" value={Math.round(st.kj)} unit="kJ" sub="≈ kcal burned" />;
  const tssT = <Tile key="tss" label="TSS" value={fmtTss(tss)} sub="training stress" />;
  const ifT = <Tile key="if" label="Intensity factor" value={IF ? IF.toFixed(2) : '–'} sub="NP ÷ FTP" />;
  const wkg = <Tile key="wkg" label="W/kg" value={kg ? (p3 / kg).toFixed(2) : '–'} sub={kg ? `at ${kg} kg` : 'Set weight in Settings'} />;
  const bestT = best && <Tile key="best" label={`Best ${best.sec / 60} min`} value={r0(best.p)} unit="W"
                             sub={best.p ? `${Math.round((best.p / ftp) * 100)}% FTP` : 'ride too short'} />;
  // riding: the running totals; finished: what the ride achieved first
  const [first, rest] = done ? [[np, bestT, tssT, kj], [avgP, maxP, dist, ifT, wkg]]
                             : [[np, avgP, dist, kj], [maxP, ifT, tssT, wkg]];
  return (
    <section className={'stats' + (more ? ' more' : '')}>
      {first}
      {more && rest}
      <button className="quiet more-btn" onClick={() => setMore(!more)} aria-expanded={more}>
        {more ? 'Fewer stats' : 'More stats'}</button>
    </section>
  );
});

// ------------------------------------------------------------------ charts
const CHARTS = [
  { key: 'power_w', color: '--power', fill: true, min: 0, floorMax: 300, ftpRef: true, title: 'Power (W) · dashed line = FTP', name: 'Power', unit: 'W', h: 170 },
  { key: 'cadence_rpm', color: '--cadence', min: 0, floorMax: 120, title: 'Cadence (rpm)', name: 'Cadence', unit: 'rpm', h: 100 },
  { key: 'heart_rate_bpm', color: '--hr', autoMin: true, floorMax: 160, title: 'Heart rate (bpm)', name: 'Heart rate', unit: 'bpm', h: 100 },
  { key: 'speed_kmh', color: '--speed', min: 0, floorMax: 40, title: 'Speed (km/h)', name: 'Speed', unit: 'km/h', h: 124, xaxis: true },
];

function niceStep(range, n) {
  const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// Whole ride until it is longer than the window, then the last `win` seconds.
// With a workout loaded the axis also shows what is coming: the whole plan, or the
// next third of the window.
function xRange(n, win, planEnd = 0) {
  if (!planEnd) {
    if (win && n > win) return [n - win, n - 1];
    return [0, Math.max(n - 1, 59)];
  }
  if (!win) return [0, Math.max(n - 1, planEnd, 59)];
  const x0 = Math.max(0, Math.round(n - (win * 2) / 3));
  return [x0, x0 + win - 1];
}

// The canvas is drawn imperatively: the one effect here keeps its pixels in sync with the data.
function Chart({ c, hist, laps, ftp, win, version, hover, setHover, workout }) {
  const cv = useRef(null);
  const [cvRef, W] = useWidth(cv), H = c.h;
  const pad = { l: 40, r: 10, t: 8, b: c.xaxis ? 22 : 6 };
  const [x0, x1] = xRange(hist.length, win, workout ? workout.total : 0);
  const plan = useMemo(() => (workout ? plannedLine(workout, ftp, c.key) : []), [workout, ftp, c.key]);

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
    for (const p of plan) if (p.t1 > x0 && p.t0 <= x1) ymax = Math.max(ymax, p.a * 1.1, p.b * 1.1);
    if (c.autoMin) ymin = vals.length ? Math.max(0, Math.floor((vmin - 10) / 20) * 20) : 60;
    for (const p of plan) if (c.autoMin && p.t1 > x0 && p.t0 <= x1) ymin = Math.min(ymin, Math.max(0, Math.floor((Math.min(p.a, p.b) - 15) / 20) * 20));
    const step = niceStep(ymax - ymin, 4); ymax = Math.ceil(ymax / step) * step;
    const X = t => pad.l + ((t - x0) / Math.max(1, x1 - x0)) * (W - pad.l - pad.r);
    const Y = v => pad.t + (1 - (v - ymin) / (ymax - ymin)) * (H - pad.t - pad.b);

    // grid + y labels
    g.font = '12px system-ui, sans-serif'; g.textBaseline = 'middle'; g.textAlign = 'right';
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
    // planned workout: target band (the on-target range) and the target line
    if (plan.length) {
      const tol = v => (c.key === 'power_w' ? powerTol(v) : c.key === 'heart_rate_bpm' ? HR_TOL : c.key === 'speed_kmh' ? SPEED_TOL : CAD_TOL);
      const cl = t => Math.min(Math.max(t, x0), x1);
      g.save(); g.beginPath(); g.rect(pad.l, pad.t, W - pad.l - pad.r, H - pad.t - pad.b); g.clip();
      for (const p of plan) {
        if (p.t1 <= x0 || p.t0 > x1) continue;
        const at = t => p.a + (p.b - p.a) * ((t - p.t0) / Math.max(1, p.t1 - p.t0));
        const ta = cl(p.t0), tb = cl(p.t1), va = at(ta), vb = at(tb);
        g.beginPath();
        g.moveTo(X(ta), Y(va + tol(va))); g.lineTo(X(tb), Y(vb + tol(vb)));
        g.lineTo(X(tb), Y(Math.max(ymin, vb - tol(vb)))); g.lineTo(X(ta), Y(Math.max(ymin, va - tol(va)))); g.closePath();
        g.fillStyle = tok.sec + '1f'; g.fill();
        g.beginPath(); g.moveTo(X(ta), Y(va)); g.lineTo(X(tb), Y(vb));
        g.strokeStyle = tok.sec; g.lineWidth = 1.5; g.stroke();
      }
      g.restore();
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
  }, [version, W, H, x0, x1, ftp, laps, hover, hist, c, plan]);

  const onMove = e => {
    const r = cv.current.getBoundingClientRect(), x = e.clientX - r.left;
    const t = Math.round(x0 + ((x - pad.l) / (W - pad.l - pad.r)) * (x1 - x0));
    const box = cv.current.closest('.charts').getBoundingClientRect();
    setHover(t >= 0 && t < hist.length ? t : null, { x: e.clientX - box.left, y: e.clientY - box.top });
  };

  return (
    <div className="chart">
      <div className="title"><span className="key" style={{ background: `var(${c.color})` }} />{c.title}
        {plan.length > 0 && <span className="plan-key"><span className="key" />workout target (shaded = on target)</span>}</div>
      <canvas ref={cvRef} style={{ height: H }} onMouseMove={onMove} onMouseLeave={() => setHover(null, null)}
              role="img" aria-label={chartSummary(c, hist)} />
    </div>
  );
}

function chartSummary(c, hist) {
  let n = 0, sum = 0, max = -Infinity, last;       // one pass, no spread: rides can be hours long
  for (const s of hist) { const v = s[c.key]; if (nz(v)) { n++; sum += v; if (v > max) max = v; last = v; } }
  if (!n) return `${c.name}: no data yet`;
  return `${c.name} over ${fmtT(hist.length)}: now ${last} ${c.unit}, average ${Math.round(sum / n)}, max ${max}`;
}

const TipRow = ({ col, k, v }) => (
  <div className="row"><span className="k"><i style={{ background: col }} />{k}</span><b>{v}</b></div>
);

function Tooltip({ s, pos, ftp, boxRef }) {
  if (!s || !pos) return null;
  const z = s.power_w > 0 ? ZONES[zoneOf(s.power_w, ftp)].n : '';
  // Beside the pointer, flipped to its left near the right edge. The tip's width is only known
  // once it is in the page, so this ref callback (new each render) places it before paint.
  const place = el => {
    if (!el) return;
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

// Charts, Stats, time in zone and laps redraw once per ride second (`version` / `st`), not on
// every live packet: they are memoized and the history is one array that grows in place.
const Charts = memo(function Charts({ win, setWin, ...props }) {
  const [hover, setHoverT] = useState(null);
  const [pos, setPos] = useState(null);
  const box = useRef(null);
  const setHover = useCallback((t, p) => { setHoverT(t); setPos(p); }, []);
  return (
    <div className="charts" ref={box}>
      <div className="head">
        <h2>Ride timeline</h2>
        <select value={win} onChange={e => setWin(+e.target.value)} aria-label="Chart time window">
          <option value={300}>Last 5 min</option>
          <option value={1200}>Last 20 min</option>
          <option value={0}>Whole ride</option>
        </select>
      </div>
      {CHARTS.map(c => <Chart key={c.key} c={c} {...props} win={win} hover={hover} setHover={setHover} />)}
      <Tooltip s={hover !== null ? props.hist[hover] : null} pos={pos} ftp={props.ftp} boxRef={box} />
    </div>
  );
});

// ------------------------------------------------------------------ side panels
const TimeInZone = memo(function TimeInZone({ st, ftp }) {
  const tot = st.tiz.reduce((a, b) => a + b, 0) || 1, mx = Math.max(...st.tiz, 1);
  return (
    <div className="panel">
      <h2>Time in power zone</h2>
      <div className="tiz">
        {ZONES.map((z, i) => {
          const lo = Math.round(z.lo * ftp), hi = z.hi === Infinity ? null : Math.round(z.hi * ftp) - 1;
          return (
            <div className="r" key={z.n}>
              <span className="name">{z.n} {z.name}<small>{lo}{hi !== null ? '–' + hi : '+'} W</small></span>
              <span className="bar"><i style={{ width: `${(st.tiz[i] / mx) * 100}%`, background: `var(--z${i + 1})` }} /></span>
              <span className="v">{fmtT(st.tiz[i])} <span className="pct">{Math.round((st.tiz[i] / tot) * 100)}%</span></span>
            </div>
          );
        })}
      </div>
    </div>
  );
});

const Laps = memo(function Laps({ hist, laps, ftp, recording }) {   // `version` prop: see Charts
  const rows = laps.map((start, i) => {
    const end = i + 1 < laps.length ? laps[i + 1] : hist.length;
    return { i, cur: recording && i === laps.length - 1, ls: stats(hist.slice(start, end), ftp, start > 0 ? hist[start - 1] : null) };
  }).reverse();
  return (
    <div className="panel">
      <h2>Laps</h2>
      <div className="laps">
        <table>
          <thead><tr><th>#</th><th>Time</th><th>Avg W</th><th>NP</th><th>rpm</th><th>bpm</th><th>km</th></tr></thead>
          <tbody>
            {!hist.length ? <tr><td colSpan="7" className="empty">Laps appear here once you press Start.</td></tr> :
              rows.map(({ i, cur, ls }) => (
                <tr key={i} className={cur ? 'current' : ''}>
                  <td>{i + 1}{cur && <span className="now">now</span>}</td><td>{fmtT(ls.n)}</td><td>{r0(ls.avgP)}</td><td>{r0(ls.np)}</td>
                  <td>{r0(ls.avgCad)}</td><td>{r0(ls.avgHr)}</td><td>{(ls.dist / 1000).toFixed(2)}</td>
                </tr>
              ))}
          </tbody>
        </table>
      </div>
    </div>
  );
});

// ------------------------------------------------------------------ Strava / Garmin: download the .FIT and open
// the site's upload page in a new tab, ready to drag the file in (Strava's API needs a paid plan).
const Check = () => <svg className="check" width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
  <path d="M2.5 7.5l3 3 6-7" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" /></svg>;

// Download / Send buttons. Once used for this ride they show a check and drop their fill,
// so the finished screen tells you what you already did.
function SendTo({ ride, href, label, className = '', used, onDownload }) {
  return <a className={'btn ' + (used ? 'used' : className)} href="/ride.fit" download={ride.fit}
            aria-label={used ? `${label} (done)` : undefined}
            onClick={() => { onDownload(); if (href) window.open(href, '_blank', 'noopener'); }}>{used && <Check />}{label}</a>;
}

// ------------------------------------------------------------------ ride strip: one band, same height in every state
function RideStrip({ ride, seconds, startArmed, lapFlash, sent, onDownload }) {
  const dir = ride.dir ? `${ride.dir}/` : 'the ride folder';
  let cls = 'ready', body;
  if (ride.state === 'recording') {
    cls = 'rec';
    body = <><span className="badge rec">REC</span>
      <span>Recording ride {ride.n || 1} · saved every second to <b>{dir}</b></span>
      {lapFlash ? <span className="flash">Lap {lapFlash} started</span> : null}</>;
  } else if (ride.state === 'finished' && ride.fit) {
    cls = 'done';
    const used = sent.fit === ride.fit ? sent.to : [];
    body = <>
      <span className="badge done">Saved</span>
      <span className="what">Saved on this computer · {fmtT(seconds)}<small>{ride.fit} in {dir}</small></span>
      <button className="quiet resume" onClick={() => post('/resume')}>Resume ride</button>
      <span className="actions">
        <SendTo ride={ride} className="primary" label="Download .FIT" used={used.includes('file')} onDownload={() => onDownload('file')} />
        <SendTo ride={ride} className="strava" href="https://www.strava.com/upload/select" label="Send to Strava"
                used={used.includes('strava')} onDownload={() => onDownload('strava', 'file')} />
        <SendTo ride={ride} href="https://connect.garmin.com/modern/import-data" label="Send to Garmin Connect"
                used={used.includes('garmin')} onDownload={() => onDownload('garmin', 'file')} />
      </span>
      <span className={'hint' + (used.length ? '' : ' next')}>{used.length
        ? <>Downloaded {ride.fit}. Drag it into the upload page to finish.</>
        : <>Not on Strava or Garmin yet. <b>Send to…</b> downloads the .FIT and opens the upload page: drag the file in.</>}</span>
      {startArmed && <span className="warn">Starting again clears these buttons. The file stays in {dir}</span>}</>;
  } else if (ride.state === 'finished') {
    body = <span>Ride finished. Nothing was recorded.</span>;
  } else {
    body = <><span className="badge">Preview</span>
      <span>Live numbers only. Nothing is saved until you press <b>Start</b>.</span></>;
  }
  return <div className={'strip ' + cls} role="status" aria-live="polite">{body}</div>;
}

// ------------------------------------------------------------------ app
function exportCsv(hist) {
  const csv = [CSV_COLS.join(',')].concat(hist.map(s => CSV_COLS.map(c => s[c] ?? '').join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'x2max_ride.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Phones and tablets get the battery-saver live rate by default. Read once, like PRESS.
const TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
const NOT_SENT = { fit: null, to: [] };
const LAP_FLASH_S = 3;                               // "Lap N started" for the lap's first seconds

function App() {
  const [smooth, setSmooth] = useStored('powerSmooth', 0);
  const [liveRate, setLiveRate] = useStored('liveRate', 'auto');
  const rate = liveRate === 'saver' || (liveRate === 'auto' && TOUCH) ? 2 : 0;
  const { hist, laps, status, online, version, preview, now, recent } = useLiveFeed(rate);
  const ride = status.ride || {};
  const mode = ride.state === 'recording' ? 'recording' : ride.state === 'finished' ? 'finished' : 'ready';
  const [ftp, setFtp] = useStored('ftp', 200);    // FTP and weight stay in this browser
  const [kg, setKg] = useStored('kg', null);
  const [win, setWin] = useStored('win', 1200);
  const [more, setMore] = useStored('moreStats', false);
  const [wo, setWo] = useStored('workout', null);
  const [woSound, setWoSound] = useStored('workoutSound', true);
  const [sent, setSent] = useStored('sent', NOT_SENT);   // which buttons were used for which .fit

  const [panel, setPanel] = useState(null);           // 'devices' | 'settings' | null
  const toggle = p => setPanel(o => (o === p ? null : p));
  const closePanel = useCallback(() => setPanel(null), []);
  // Adjusted while rendering, when the logger's answer arrives (no effect, no extra paint):
  // open the device panel once when no trainer is remembered yet (or it was turned off) ...
  const devChoice = (status.devices || {}).trainer;
  const [askedDevices, setAskedDevices] = useState(false);
  if (devChoice && !askedDevices) {
    setAskedDevices(true);
    if (devChoice.mode !== 'device' && mode !== 'recording') setPanel('devices');
  }
  // ... and close the panels when a ride starts, so the numbers are clear.
  const [prevMode, setPrevMode] = useState(mode);
  if (prevMode !== mode) {
    setPrevMode(mode);
    if (mode === 'recording') setPanel(null);
  }
  const [finishArmed, pressFinish] = useArmed(ride.state);
  const [startArmed, pressStart] = useArmed(ride.state);
  const lapStart = laps[laps.length - 1] || 0;
  const lapFlash = mode === 'recording' && laps.length > 1 && hist.length - lapStart < LAP_FLASH_S ? laps.length : 0;

  const st = useMemo(() => stats(hist, ftp, null), [version, ftp]); // eslint-disable-line react-hooks/exhaustive-deps -- hist grows in place

  // the finished ride is "unsaved" until its .FIT was downloaded from here
  const unsaved = mode === 'finished' && ride.fit && !(sent && sent.fit === ride.fit && sent.to.length);
  // Send to… also downloads the file, so it marks Download .FIT as done too
  const markSent = (...to) => setSent(s => ({ fit: ride.fit, to: [...new Set([...(s && s.fit === ride.fit ? s.to : []), ...to])] }));

  // The ride state on <html> (for CSS), and back to the top when a ride finishes.
  const lastMode = useRef(mode);
  useEffect(() => {
    document.documentElement.dataset.ride = mode;
    if (lastMode.current === 'recording' && mode === 'finished') window.scrollTo({ top: 0 });
    lastMode.current = mode;
  }, [mode]);

  const act = {
    finishArmed, startArmed,
    lap: postLap,
    finish: () => pressFinish(() => post('/finish')),
    start: () => unsaved ? pressStart(() => post('/start')) : post('/start'),
  };

  // trainer control: climb / ERG, workout steps drive it while recording
  const ctl = status.control;
  const woAt = wo && mode === 'recording' ? workoutAt(wo, hist.length, ftp) : null;
  useWorkoutControl({ ctl, at: woAt, recording: mode === 'recording' });
  const woDrives = wo && wo.segs.some(s => s.grade != null) ? 'Workout steps with a grade set it when they start.'
                 : wo && ctl && ctl.mode === 'erg' ? 'The workout sets the power at each step.' : null;
  const showCtl = ctl && (status.connected || ctl.enabled || ctl.msg);

  // Keys: S start, L lap, F finish, − / + grade or ERG power. One document listener for the
  // app's lifetime; useEvent lets it see the current ride and control state.
  const onKey = useEvent(e => {
    if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
    const key = e.key.toLowerCase();
    if (key === 'l' && mode === 'recording') act.lap();
    else if (key === 'f' && mode === 'recording') act.finish();
    else if (key === 's' && mode !== 'recording') act.start();
    else controlKey(e, ctl);
  });
  useEffect(() => {
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onKey]);

  // live numbers for the workout band: the latest packet while fresh, else the last second
  const fresh = now && Date.now() - now.at < FRESH_MS, last = hist.length ? hist[hist.length - 1] : null;

  return (
    <div className="wrap">
      <Header status={status} ride={ride} act={act} panel={panel} toggle={toggle} />
      {panel === 'devices' && <Drawer id="devices" title="Devices" onClose={closePanel}>
        <Devices status={status} recording={mode === 'recording'} /></Drawer>}
      {panel === 'settings' && <Drawer id="settings" title="Settings" onClose={closePanel}><Settings ftp={ftp} setFtp={setFtp} kg={kg} setKg={setKg} smooth={smooth} setSmooth={setSmooth} liveRate={liveRate} setLiveRate={setLiveRate}
                                 onCsv={() => exportCsv(hist)} canCsv={hist.length > 0} recording={mode === 'recording'}
                                 workout={{ wo, setWo, sound: woSound, setSound: setWoSound }} /></Drawer>}
      {!online && <div className="offline" role="alert">The dashboard lost contact with the logger.
        If it was stopped, start it again with <b>Start X2Max</b>. Retrying…</div>}
      <RideStrip ride={ride} seconds={hist.length} startArmed={startArmed} lapFlash={lapFlash}
                 sent={sent || NOT_SENT} onDownload={markSent} />
      {showCtl && <ClimbBand ctl={ctl} ftp={ftp} follow={woDrives} />}
      {wo && mode !== 'finished' ? <WorkoutBand wo={wo} t={hist.length} mode={mode} ftp={ftp} sound={woSound} onRemove={() => setWo(null)}
                            power={fresh ? livePower(now, recent, 3) : last ? avg3(hist) : null}
                            cadence={fresh ? now.cadence_rpm : last ? last.cadence_rpm : null}
                            hr={fresh ? now.heart_rate_bpm : last ? last.heart_rate_bpm : null}
                            speed={fresh ? now.speed_kmh : last ? last.speed_kmh : null} /> : null}
      <Hero hist={hist} laps={laps} st={st} ftp={ftp} preview={mode === 'recording' ? null : preview} mode={mode}
            now={now} recent={recent} smooth={smooth} />
      <Stats hist={hist} st={st} ftp={ftp} kg={kg} more={more} setMore={setMore} mode={mode} />
      <section className="main">
        <Charts hist={hist} laps={laps} ftp={ftp} win={win} setWin={setWin} version={version}
                workout={wo} />
        <div className="side">
          <TimeInZone st={st} ftp={ftp} />
          <Laps hist={hist} laps={laps} ftp={ftp} recording={mode === 'recording'} version={version} />
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
