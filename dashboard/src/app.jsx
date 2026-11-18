// X2Max live dashboard (React). Talks to thinkrider_logger.py:
//   GET  /events  Server-Sent Events: init, sample, preview, status, laps,
//                 live (instant numbers on every trainer packet; ?live=2 caps it at 2/s)
//   POST /lap     start a new lap
//   POST /start, /finish   begin / end a recorded ride
//   POST /devices/scan, /devices/use|off?role=trainer|hr   device panel
//   POST /quit    stop the logger
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
  { n: 'Z7', name: 'Neuromuscular', lo: 1.50, hi: Infinity },
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
// Instant numbers older than this are ignored (trainer stopped sending).
const FRESH_MS = 2500;

function useLiveFeed(rate) {
  const [now, setNow] = useState(null);           // instant numbers, every packet
  const recent = useRef([]);                       // last few seconds of them, for 3 s / 5 s power
  const hist = useRef([]);
  const [laps, setLaps] = useState([0]);
  const [status, setStatus] = useState({});
  const [online, setOnline] = useState(true);
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState(null);   // live numbers while not recording

  useEffect(() => {
    let es, closed = false;
    const open = () => {
      es = new EventSource(rate ? `/events?live=${rate}` : '/events');
      es.addEventListener('live', e => {
        const v = JSON.parse(e.data), at = Date.now(), r = recent.current;
        r.push({ at, p: v.power_w });
        while (r.length && at - r[0].at > 6000) r.shift();
        setNow({ ...v, at });
      });
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
      es.addEventListener('preview', e => setPreview(JSON.parse(e.data)));
      es.addEventListener('laps', e => { setLaps(JSON.parse(e.data)); setVersion(v => v + 1); });
      es.addEventListener('status', e => setStatus(JSON.parse(e.data)));
      es.onerror = () => setOnline(false);  // EventSource retries by itself; init clears this
    };
    open();
    return () => { closed = true; es.close(); };
  }, [rate]);

  return { hist: hist.current, laps, status, online, version, preview, now, recent: recent.current };
}

const post = path => fetch(path, { method: 'POST' }).catch(() => {});
const postLap = () => post('/lap');

// ------------------------------------------------------------------ header
const STATUS = {
  connected:    ['--good', s => `Trainer · ${s.device || 'connected'}`],
  demo:         ['--power', s => `Demo · ${s.device || 'simulated data'}`],
  searching:    ['--warning', s => s.device ? `Looking for ${s.device}…` : 'Searching for trainer…'],
  reconnecting: ['--warning', () => 'Trainer lost · reconnecting (timer paused)'],
  starting:     ['--warning', () => 'Starting…'],
  off:          ['--text-muted', () => 'No trainer connected'],
};

// Separate heart-rate device (Garmin watch broadcasting HR, chest strap ...)
const HR_STATUS = {
  connected:    ['--good', h => `HR · ${h.device || 'connected'}`],
  searching:    ['--warning', h => h.device ? `HR · looking for ${h.device}` : 'HR · looking for watch or strap'],
  reconnecting: ['--warning', h => `HR · ${h.device || 'device'} lost, reconnecting`],
  off:          ['--text-muted', () => 'HR · off'],
};

// A button that needs a second click within 4 s (Finish, Start over an unsaved ride, Disconnect).
function useArmed(resetKey) {
  const [armed, setArmed] = useState(false);
  useEffect(() => { if (!armed) return; const t = setTimeout(() => setArmed(false), 4000); return () => clearTimeout(t); }, [armed]);
  useEffect(() => setArmed(false), [resetKey]);
  return [armed, setArmed];
}

const Kbd = ({ k }) => <kbd aria-hidden="true">{k}</kbd>;

function Header({ status, ride, act, settingsOpen, toggleSettings, devicesOpen, toggleDevices }) {
  const recording = ride.state === 'recording';
  const [col, txt] = STATUS[status.state] || ['--text-muted', () => status.state || 'Connecting…'];
  const hr = status.hr || {};
  const hrPill = HR_STATUS[hr.state];
  return (
    <header>
      <h1>X2Max <span>Live training</span></h1>
      <button className={'pills' + (devicesOpen ? ' on' : '')} onClick={toggleDevices}
              aria-expanded={devicesOpen} aria-controls="devices" title="Choose the trainer and heart-rate device">
        <span className="pill"><span className="dot" style={{ background: `var(${col})` }} />{txt(status)}</span>
        {hrPill && <span className="pill"><span className="dot" style={{ background: `var(${hrPill[0]})` }} />{hrPill[1](hr)}</span>}
        <span className="pills-act">Devices</span>
      </button>
      <div className="controls">
        {recording ? <>
          <button className="primary" onClick={act.lap} aria-keyshortcuts="L">Lap <Kbd k="L" /></button>
          <button className={act.finishArmed ? 'danger' : ''} onClick={act.finish} aria-keyshortcuts="F">
            {act.finishArmed ? 'Click again to finish' : <>Finish <Kbd k="F" /></>}</button>
        </> : <button className={act.startArmed ? 'danger' : 'start'} onClick={act.start} aria-keyshortcuts="S">
          {act.startArmed ? 'Click again to start' : <>{ride.state === 'finished' ? 'Start new ride' : 'Start'} <Kbd k="S" /></>}
        </button>}
        <button className={'quiet' + (settingsOpen ? ' on' : '')} onClick={toggleSettings}
                aria-expanded={settingsOpen} aria-controls="settings">Settings</button>
      </div>
    </header>
  );
}

// ------------------------------------------------------------------ settings (disclosure, not a modal)
function Settings({ ftp, setFtp, kg, setKg, strava, onCsv, canCsv, smooth, setSmooth, liveRate, setLiveRate }) {
  const [ftpDraft, setFtpDraft] = useState(String(ftp));
  const [ftpErr, setFtpErr] = useState(false);
  useEffect(() => setFtpDraft(String(ftp)), [ftp]);
  const commitFtp = () => {
    const v = Math.round(+ftpDraft);
    if (v >= 50 && v <= 600) { setFtp(v); setFtpErr(false); } else { setFtpErr(true); setFtpDraft(String(ftp)); }
  };
  return (
    <section className="settings" id="settings" aria-label="Settings">
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
      <div className="field">
        <label htmlFor="kg">Weight</label>
        <div className="inline">
          <input id="kg" type="number" inputMode="decimal" min="30" max="200" step="0.1" value={kg ?? ''}
                 onChange={e => { const v = +e.target.value; setKg(v >= 30 && v <= 200 ? v : null); }} /> kg
        </div>
        <p className="help">Used for W/kg. Stays in this browser.</p>
      </div>
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
        <span className="flabel">Strava</span>
        <StravaAccount strava={strava} />
      </div>
      <div className="field">
        <span className="flabel">This ride</span>
        <div className="inline"><button onClick={onCsv} disabled={!canCsv}>Export CSV</button></div>
        <p className="help">The logger also writes a CSV and a .FIT file to its ride folder.</p>
      </div>
      <div className="field">
        <span className="flabel">Logger</span>
        <StopLogger />
      </div>
      <div className="field wide">
        <span className="flabel">Tips</span>
        <p className="help">Garmin watch heart rate: turn on <b>Broadcast Heart Rate</b> on the watch.
          Close Zwift and the ThinkRider app first: the trainer and the watch accept one connection at a time.
          <span className="keys"> Keys: <Kbd k="S" /> start, <Kbd k="L" /> lap, <Kbd k="F" /> twice to finish.</span></p>
      </div>
    </section>
  );
}

function StopLogger() {
  const [armed, setArmed] = useArmed();
  return <>
    <div className="inline"><button className={armed ? 'danger' : ''} onClick={() => armed ? post('/quit') : setArmed(true)}>
      {armed ? 'Click again to stop' : 'Stop logger'}</button></div>
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
    return { dot: '--text-muted', name: choice.name || 'None', text: 'Not connected. Pick a device below.', off: true };
  if (s.state === 'connected' || s.state === 'demo')
    return { dot: '--good', name, text: 'Connected. Reconnects by itself next time.', on: true };
  if (s.state === 'reconnecting')
    return { dot: '--warning', name: name || ROLE[role].any, text: 'Connection lost, reconnecting…' };
  if (choice.mode === 'device') return { dot: '--warning', name, text: 'Looking for it…' };
  return { dot: '--warning', name: ROLE[role].any, text: 'Looking… or pick one below.' };
}

function Slot({ role, status, recording }) {
  const info = slotInfo(role, status);
  const choice = (status.devices || {})[role] || {};
  const confirm = role === 'trainer' && recording && info.on;      // dropping the trainer pauses the ride
  const [armed, setArmed] = useArmed(info.text);
  const off = () => confirm && !armed ? setArmed(true) : post(`/devices/off?role=${role}`);
  return (
    <div className="slot">
      <span className="flabel">{ROLE[role].title}</span>
      <div className="slot-dev"><span className="dot" style={{ background: `var(${info.dot})` }} /><b>{info.name}</b></div>
      <p className="help">{info.text}</p>
      <div className="inline">
        {info.off ? (choice.address && <button onClick={() => post(useUrl(role, choice))}>Connect {choice.name || 'again'}</button>)
          : <button className={armed ? 'danger' : ''} onClick={off}>{armed ? 'Click again (pauses the ride)' : 'Disconnect'}</button>}
      </div>
      {!info.on && <p className="help">{ROLE[role].tip}</p>}
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
  useEffect(() => { post('/devices/scan'); }, []);   // one short scan each time the panel opens
  const scanning = scan.state === 'scanning';
  const found = scan.found || [];
  const main = found.filter(d => d.kind !== 'other'), other = found.filter(d => d.kind === 'other');
  return (
    <section className="devices" id="devices" aria-label="Devices">
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
function Tile({ label, keyColor, value, unit, sub, className = '', badge, children }) {
  return (
    <div className={'tile ' + className}>
      <div className="label">{keyColor && <span className="key" style={{ background: `var(${keyColor})` }} />}{label}{badge}</div>
      <div className="value">{value}{unit && <span className="unit">{unit}</span>}</div>
      {sub !== undefined && <div className="sub">{sub || ' '}</div>}
      {children}
    </div>
  );
}

const avg3 = h => { const w = h.slice(-3); return w.length ? w.reduce((t, s) => t + (s.power_w || 0), 0) / w.length : null; };

// Recording: live ride.  Ready: live preview (nothing saved).  Finished: the ride's summary.
// Power shown live: the latest packet (instant) or the mean of the last `smooth` seconds of packets.
function livePower(now, recent, smooth) {
  if (!smooth) return now.power_w;
  const w = recent.filter(x => now.at - x.at < smooth * 1000);
  return w.length ? w.reduce((t, x) => t + x.p, 0) / w.length : now.power_w;
}

function Hero({ hist, st, ftp, preview, mode, now, recent, smooth }) {
  const done = mode === 'finished' && hist.length > 0;
  const fresh = now && Date.now() - now.at < FRESH_MS;
  const live = fresh ? [now] : mode === 'recording' ? hist : preview ? [preview] : [];
  const last = live[live.length - 1];
  const p = done ? st.avgP : fresh ? livePower(now, recent, smooth) : avg3(live);
  const zi = p > 0 ? zoneOf(p, ftp) : -1;
  const z = ZONES[zi];
  const zoneTxt = p > 0 ? <><b>{z.n} {z.name}</b> · {Math.round((p / ftp) * 100)}% FTP</> : null;
  const timeBadge = mode === 'recording' ? <span className="badge rec">REC</span>
                  : mode === 'finished' ? <span className="badge done">Saved</span>
                  : null;   // the strip above already says Preview
  return (
    <section className={'hero ' + mode}>
      <Tile className="power" label={done ? 'Avg power · ride' : smooth ? `Power · ${smooth} s` : 'Power'} keyColor="--power" value={r0(p)} unit="W"
            sub={done ? <>{zoneTxt}{last ? <span className="live-now"> · now {r0(avg3(live))} W</span> : null}</>
                      : !last ? '' : p > 0 ? zoneTxt : 'Not pedaling'}>
        <div className="zonebar" aria-hidden="true">
          {ZONES.map((zz, i) => <span key={zz.n} className={i === zi ? 'on' : ''} style={{ background: `var(--z${i + 1})` }} />)}
        </div>
      </Tile>
      <Tile className={'time ' + mode} label="Ride time" badge={timeBadge}
            value={mode === 'ready' ? '0:00' : fmtT(hist.length)}
            sub={mode === 'recording' ? `moving ${fmtT(st.moving)}` : mode === 'finished' ? `moving ${fmtT(st.moving)}` : 'Press Start to record'} />
      <Tile label={done ? 'Avg cadence' : 'Cadence'} keyColor="--cadence" unit="rpm"
            value={done ? r0(st.avgCad) : last ? r0(last.cadence_rpm) : '–'}
            sub={!done && mode === 'recording' && st.avgCad ? `avg ${Math.round(st.avgCad)}` : ''} />
      <Tile label={done ? 'Avg speed' : 'Speed'} unit="km/h"
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

function Stats({ hist, st, ftp, kg, more, setMore, mode }) {
  const done = mode === 'finished';
  const p3 = mode === 'recording' ? avg3(hist) || 0 : st.avgP || 0;
  let IF = null, tss = null;
  if (st.np) { IF = st.np / ftp; tss = ((hist.length * st.np * IF) / (ftp * 3600)) * 100; }
  return (
    <section className={'stats' + (more ? ' more' : '')}>
      <Tile label="Normalized power" value={r0(st.np)} unit="W" sub={st.np ? '' : 'after 30 s'} />
      {done ? <Tile label="Max power" value={r0(st.maxP)} unit="W" /> : <Tile label="Avg power" value={r0(st.avgP)} unit="W" />}
      <Tile label="Distance" value={(st.dist / 1000).toFixed(2)} unit="km" />
      {/* ~1 kJ of work ≈ 1 kcal burned (≈24 % gross efficiency) */}
      <Tile label="Energy" value={Math.round(st.kj)} unit="kJ" sub={`≈ ${Math.round(st.kj)} kcal`} />
      {more && <>
        {done ? <Tile label="Avg power" value={r0(st.avgP)} unit="W" /> : <Tile label="Max power" value={r0(st.maxP)} unit="W" />}
        <Tile label="Intensity factor" value={IF ? IF.toFixed(2) : '–'} sub="NP ÷ FTP" />
        <Tile label="TSS" value={tss === null ? '–' : tss < 10 ? tss.toFixed(1) : Math.round(tss)} sub="training stress" />
        <Tile label="W/kg" value={kg ? (p3 / kg).toFixed(2) : '–'} sub={kg ? `at ${kg} kg` : 'Set weight in Settings'} />
      </>}
      <button className="quiet more-btn" onClick={() => setMore(!more)} aria-expanded={more}>
        {more ? 'Fewer stats' : 'More stats'}</button>
    </section>
  );
}

// ------------------------------------------------------------------ charts
const CHARTS = [
  { key: 'power_w', color: '--power', fill: true, min: 0, floorMax: 300, ftpRef: true, title: 'Power (W) · dashed line = FTP', name: 'Power', unit: 'W', h: 170 },
  { key: 'cadence_rpm', color: '--cadence', min: 0, floorMax: 120, title: 'Cadence (rpm)', name: 'Cadence', unit: 'rpm', h: 100 },
  { key: 'heart_rate_bpm', color: '--hr', autoMin: true, floorMax: 160, title: 'Heart rate (bpm)', name: 'Heart rate', unit: 'bpm', h: 124, xaxis: true },
];

function niceStep(range, n) {
  const raw = range / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p;
}

// Whole ride until it is longer than the window, then the last `win` seconds.
function xRange(n, win) {
  if (win && n > win) return [n - win, n - 1];
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
      <canvas ref={cv} style={{ height: H }} onMouseMove={onMove} onMouseLeave={() => setHover(null, null)}
              role="img" aria-label={chartSummary(c, hist)} />
    </div>
  );
}

function chartSummary(c, hist) {
  const v = hist.map(s => s[c.key]).filter(nz);
  if (!v.length) return `${c.name}: no data yet`;
  const avg = Math.round(v.reduce((a, b) => a + b, 0) / v.length);
  return `${c.name} over ${fmtT(hist.length)}: now ${v[v.length - 1]} ${c.unit}, average ${avg}, max ${Math.max(...v)}`;
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

function Charts({ win, setWin, ...props }) {
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
}

function Laps({ hist, laps, ftp, recording }) {
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
}

// ------------------------------------------------------------------ Strava
// One-time: the keys of the rider's own Strava API app, saved by the logger in strava_config.json.
function StravaSetup({ onDone }) {
  const [cid, setCid] = useState('');
  const [sec, setSec] = useState('');
  const [err, setErr] = useState(null);
  const [busy, setBusy] = useState(false);
  const save = e => {
    e.preventDefault(); setBusy(true); setErr(null);
    fetch('/strava/setup', { method: 'POST', body: new URLSearchParams({ client_id: cid, client_secret: sec }) })
      .then(r => r.text().then(t => r.ok ? (setSec(''), onDone && onDone()) : setErr(t)))
      .catch(() => setErr('The logger is not reachable.'))
      .finally(() => setBusy(false));
  };
  return (
    <form className="strava-setup" onSubmit={save}>
      <p className="help">First time: create an app at <a href="https://www.strava.com/settings/api" target="_blank" rel="noreferrer">strava.com/settings/api</a> (any
        name and website, <b>Authorization Callback Domain</b>: <code>localhost</code>), then copy its keys here.</p>
      <label htmlFor="strava-id">Client ID</label>
      <input id="strava-id" inputMode="numeric" autoComplete="off" value={cid} onChange={e => setCid(e.target.value)} required />
      <label htmlFor="strava-secret">Client Secret</label>
      <input id="strava-secret" type="password" autoComplete="off" value={sec} onChange={e => setSec(e.target.value)}
             aria-invalid={!!err} aria-describedby="strava-err" required />
      <div className="inline"><button className="primary" disabled={busy || !cid || !sec}>Save keys</button></div>
      <p id="strava-err" className={'help' + (err ? ' err' : '')}>{err || 'Saved only on this computer, never uploaded.'}</p>
    </form>
  );
}

function StravaAccount({ strava }) {
  const [armed, setArmed] = useArmed(strava.connected);
  const [editKeys, setEditKeys] = useState(false);
  if (!strava.connected && (!strava.configured || editKeys))
    return <StravaSetup onDone={() => setEditKeys(false)} />;
  if (!strava.connected)
    return <>
      <div className="inline"><a className="btn strava" href="/strava/connect">Connect to Strava</a></div>
      <p className="help">Sign in on Strava once to allow uploads.{' '}
        <button className="link" onClick={() => setEditKeys(true)}>Change app keys</button></p>
    </>;
  return <>
    <div className="inline">
      <span className="acct"><span className="dot" style={{ background: 'var(--strava)' }} />{strava.athlete || 'Connected'}</span>
      <button className={armed ? 'danger' : ''} onClick={() => armed ? post('/strava/disconnect') : setArmed(true)}>
        {armed ? 'Click again to disconnect' : 'Disconnect'}</button>
    </div>
    <p className="help">Finished rides upload to this account with one click.</p>
  </>;
}

function StravaUpload({ strava }) {
  const up = strava.upload || {};
  const manual = <a className="btn" href="https://www.strava.com/upload/select" target="_blank" rel="noreferrer">
    Upload manually</a>;
  if (!strava.connected) return <a className="btn strava" href="/strava/connect">Connect to Strava</a>;
  if (up.state === 'uploading') return <span className="note">Uploading to Strava…</span>;
  if (up.state === 'done')
    return <a className="btn strava" href={up.url} target="_blank" rel="noreferrer">View on Strava</a>;
  return <>
    <button className="strava" onClick={() => post('/strava/upload')}>
      {up.state === 'error' ? 'Retry Strava upload' : 'Upload to Strava'}</button>
    {up.state === 'error' && <span className="note err">Strava: {up.error}</span>}
    {up.state === 'error' && manual}
  </>;
}

function StravaNotice() {
  const [msg, setMsg] = useState(() => new URLSearchParams(location.search).get('strava'));
  useEffect(() => { if (msg) history.replaceState(null, '', '/'); }, []); // eslint-disable-line
  if (!msg) return null;
  const ok = msg === 'connected';
  return <div className={'banner ' + (ok ? 'done' : 'err')} role="status">
    {ok ? 'Connected to Strava. Finished rides can now be uploaded with one click.'
        : `Strava connection failed (${msg.replace(/^error: /, '')}).`}
    <button onClick={() => setMsg(null)}>OK</button></div>;
}

// ------------------------------------------------------------------ ride strip: one band, same height in every state
function RideStrip({ ride, seconds, strava, startArmed, lapFlash, onDownload }) {
  const dir = ride.dir ? `${ride.dir}/` : 'the ride folder';
  let cls = 'ready', body;
  if (ride.state === 'recording') {
    cls = 'rec';
    body = <><span className="badge rec">REC</span>
      <span>Recording ride {ride.n || 1} · saved every second to <b>{dir}</b></span>
      {lapFlash ? <span className="flash">Lap {lapFlash} started</span> : null}</>;
  } else if (ride.state === 'finished' && ride.fit) {
    cls = 'done';
    body = <>
      <span className="badge done">Saved</span>
      <span className="what">Ride saved · {fmtT(seconds)}<small>{ride.fit} in {dir}</small></span>
      <span className="actions">
        <a className="btn primary" href="/ride.fit" download={ride.fit} onClick={onDownload}>Download .FIT</a>
        <StravaUpload strava={strava} />
        <a className="btn" href="https://connect.garmin.com/modern/import-data" target="_blank" rel="noreferrer">Garmin Connect import</a>
      </span>
      {startArmed && <span className="warn">This ride isn’t downloaded or uploaded yet. Starting again clears these buttons; the file stays in {dir}</span>}</>;
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

function App() {
  const [smooth, setSmooth] = useStored('powerSmooth', 0);
  const [liveRate, setLiveRate] = useStored('liveRate', 'auto');
  const touch = useMemo(() => window.matchMedia('(pointer: coarse)').matches, []);
  const rate = liveRate === 'saver' || (liveRate === 'auto' && touch) ? 2 : 0;
  const { hist, laps, status, online, version, preview, now, recent } = useLiveFeed(rate);
  const ride = status.ride || {};
  const strava = status.strava || {};
  const mode = ride.state === 'recording' ? 'recording' : ride.state === 'finished' ? 'finished' : 'ready';
  const [ftp, setFtp] = useStored('ftp', 200);
  const [kg, setKg] = useStored('kg', null);
  const [win, setWin] = useStored('win', 1200);
  const [more, setMore] = useStored('moreStats', false);
  const [downloaded, setDownloaded] = useStored('downloaded', null);   // .fit name last downloaded
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [devicesOpen, setDevicesOpen] = useState(false);
  const devChoice = (status.devices || {}).trainer;
  const askedDevices = useRef(false);
  useEffect(() => {      // open the device panel once when no trainer is remembered yet (or it was turned off)
    if (!devChoice || askedDevices.current) return;
    askedDevices.current = true;
    if (devChoice.mode !== 'device' && mode !== 'recording') setDevicesOpen(true);
  }, [devChoice]); // eslint-disable-line
  const [finishArmed, setFinishArmed] = useArmed(ride.state);
  const [startArmed, setStartArmed] = useArmed(ride.state);
  const [lapFlash, setLapFlash] = useState(0);

  const st = useMemo(() => stats(hist, ftp, null), [version, ftp]); // eslint-disable-line

  // the finished ride is "unsaved" until it was downloaded or uploaded from here
  const unsaved = mode === 'finished' && ride.fit && downloaded !== ride.fit && (strava.upload || {}).state !== 'done';

  useEffect(() => { if (mode === 'recording') { setSettingsOpen(false); setDevicesOpen(false); } }, [mode]);
  useEffect(() => {
    if (mode !== 'recording' || laps.length < 2) return;
    setLapFlash(laps.length);
    const t = setTimeout(() => setLapFlash(0), 3000);
    return () => clearTimeout(t);
  }, [laps.length]); // eslint-disable-line

  const act = {
    finishArmed, startArmed,
    lap: postLap,
    finish: () => finishArmed ? post('/finish') : setFinishArmed(true),
    start: () => unsaved && !startArmed ? setStartArmed(true) : post('/start'),
  };
  const actRef = useRef(act); actRef.current = act;
  const modeRef = useRef(mode); modeRef.current = mode;

  useEffect(() => {
    const k = e => {
      if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes(e.target.tagName)) return;
      const key = e.key.toLowerCase(), a = actRef.current, m = modeRef.current;
      if (key === 'l' && m === 'recording') a.lap();
      else if (key === 'f' && m === 'recording') a.finish();
      else if (key === 's' && m !== 'recording') a.start();
    };
    document.addEventListener('keydown', k);
    return () => document.removeEventListener('keydown', k);
  }, []);

  useEffect(() => { document.documentElement.dataset.ride = mode; }, [mode]);

  return (
    <div className="wrap">
      <Header status={status} ride={ride} act={act} settingsOpen={settingsOpen}
              toggleSettings={() => setSettingsOpen(o => !o)}
              devicesOpen={devicesOpen} toggleDevices={() => setDevicesOpen(o => !o)} />
      {devicesOpen && <Devices status={status} recording={mode === 'recording'} />}
      {settingsOpen && <Settings ftp={ftp} setFtp={setFtp} kg={kg} setKg={setKg} strava={strava} smooth={smooth} setSmooth={setSmooth} liveRate={liveRate} setLiveRate={setLiveRate}
                                 onCsv={() => exportCsv(hist)} canCsv={hist.length > 0} />}
      {!online && <div className="offline" role="alert">The dashboard lost contact with the logger.
        If it was stopped, start it again with <b>Start X2Max</b>. Retrying…</div>}
      <StravaNotice />
      <RideStrip ride={ride} seconds={hist.length} strava={strava} startArmed={startArmed} lapFlash={lapFlash}
                 onDownload={() => setDownloaded(ride.fit)} />
      <Hero hist={hist} st={st} ftp={ftp} preview={mode === 'recording' ? null : preview} mode={mode}
            now={now} recent={recent} smooth={smooth} />
      <Stats hist={hist} st={st} ftp={ftp} kg={kg} more={more} setMore={setMore} mode={mode} />
      <section className="main">
        <Charts hist={hist} laps={laps} ftp={ftp} win={win} setWin={setWin} version={version} />
        <div className="side">
          <TimeInZone st={st} ftp={ftp} />
          <Laps hist={hist} laps={laps} ftp={ftp} recording={mode === 'recording'} />
        </div>
      </section>
    </div>
  );
}

createRoot(document.getElementById('root')).render(<App />);
