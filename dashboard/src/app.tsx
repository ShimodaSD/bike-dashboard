// X2Max live dashboard (React). Talks to logger/thinkrider_logger.py:
//   GET  /events  Server-Sent Events: init, sample, preview, status, laps,
//                 live (instant numbers on every trainer packet; ?live=2 caps it at 2/s)
//   POST /lap     start a new lap
//   POST /start, /finish   begin / end a recorded ride
//   POST /devices/scan, /devices/use|search|off?role=trainer|hr   device panel
//   POST /control?on=1|0, /control/grade?pct=, /control/power?w=   trainer control (control/climb.jsx)
//   POST /ftp-test/start|cancel|delete   guided FTP test and its saved results (ftp/ftp.tsx)
//   POST /clear   empty the dashboard (files on disk stay)
//   POST /quit    stop the logger
//   GET  /ride.fit  the finished ride (or the ride so far)
//
// State comes from two external stores read with useSyncExternalStore: the logger's live feed
// (hooks/feed.js) and settings in localStorage (hooks/stored.js). Everything else is derived while
// rendering. Effects are kept for real outside systems only: feeding the uPlot charts, document key
// and focus handling, the device scan while that panel is open, and the trainer / audio.
import { memo, useState, useEffect, useRef, useMemo, useCallback, type CSSProperties, type ReactNode } from 'react';
import { WorkoutBand, WorkoutSettings, workoutAt } from './workout/workout';
import { ClimbBand, useWorkoutControl, controlKey } from './control/climb';
import { useLiveFeed, type LiveNow, type RecentPower } from './hooks/feed';
import { useStored } from './hooks/stored';
import { useArmed, useEvent } from './hooks/hooks';
import { ZONES, nz, fmtT, zoneOf, stats, bestPower, tssOf, fmtTss, avg3, livePower, type RideStats } from './util/ride';
import { Charts } from './charts/charts';
import { RideReview } from './review/review-panel';
import { FtpTestBand, FtpTestSettings, protocolWorkout, startFtpTest, type FtpTestSettingsProps } from './ftp/ftp';
import type { DeviceChoice, DeviceKind, DeviceRole, FoundDevice, HrState, HrStatus, LiveValues, RideState,
  RideStatus, Sample, ScanStatus, Status, TrainerState } from './types/feed';
import type { Workout } from './types/workout';
import type { WorkoutSettingsProps } from './workout/workout';

type Mode = RideState;                   // what the page shows: ready (preview), recording, finished
type Panel = 'devices' | 'settings';
type LiveRate = 'auto' | 'fast' | 'saver';
// Which Download / Send buttons were used, for which .fit
interface Sent { fit: string | null; to: string[] }

// ------------------------------------------------------------------ constants & helpers

const CSV_COLS: (keyof Sample)[] = ['t', 'timestamp_utc', 'lap', 'power_w', 'cadence_rpm', 'speed_kmh',
                  'heart_rate_bpm', 'distance_m', 'energy_kj', 'grade_pct'];

const r0 = (v: number | null | undefined) => (nz(v) ? Math.round(v) : '–');

// ------------------------------------------------------------------ live feed (SSE): hooks/feed.js
// Instant numbers older than this are ignored (trainer stopped sending).
const FRESH_MS = 2500;

const post = (path: string) => fetch(path, { method: 'POST' }).catch(() => {});
// Touch screens say "Tap", mice say "Click".
const PRESS = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches ? 'Tap' : 'Click';
const postLap = () => post('/lap');

// ------------------------------------------------------------------ header
// [dot colour, full label, short label for phones]
type PillRow<S> = [col: string, long: (s: S) => string, short: string];
const STATUS: Record<TrainerState, PillRow<Partial<Status>>> = {
  connected:    ['--good', s => `Trainer · ${s.device || 'connected'}`, 'Trainer'],
  demo:         ['--power', s => s.device ? `Demo · ${s.device.replace(/\s*\(demo\)$/i, '')}` : 'Demo · simulated data', 'Demo'],
  searching:    ['--warning', s => s.device ? `Looking for ${s.device}…` : 'Searching for trainer…', 'Searching…'],
  reconnecting: ['--warning', () => 'Trainer lost · reconnecting (timer paused)', 'Trainer lost'],
  starting:     ['--warning', () => 'Starting…', 'Starting…'],
  off:          ['--text-muted', () => 'Trainer search off', 'Trainer off'],
};

// Separate heart-rate device (Garmin watch broadcasting HR, chest strap ...)
const HR_STATUS: Record<HrState, PillRow<Partial<HrStatus>>> = {
  connected:    ['--good', h => `HR · ${h.device || 'connected'}`, 'HR'],
  searching:    ['--warning', h => h.device ? `HR · looking for ${h.device}` : 'HR · looking for watch or strap', 'HR…'],
  reconnecting: ['--warning', h => `HR · ${h.device || 'device'} lost, reconnecting`, 'HR lost'],
  off:          ['--text-muted', () => 'HR · off', 'HR off'],
};
const Pill = ({ col, long, short }: { col: string; long: string; short: string }) => (
  <span className="pill"><span className="dot" style={{ background: `var(${col})` }} />
    <span className="long">{long}</span><span className="short" aria-hidden="true">{short}</span></span>);

// Buttons that need a second press: useArmed in hooks/hooks.js.
// Armed look: red fill plus a bar that drains over the 4 s, so the timeout is visible.
const armedCls = (armed: boolean, base = '') => (armed ? `${base} danger armed`.trim() : base);

// Sprint b logo: an italic b whose stem is the tallest bar of a rising chart and whose bowl is a wheel.
const Logo = () => (
  <svg className="logo" viewBox="0 36 212 184" aria-hidden="true" focusable="false">
    <g transform="translate(26 0) skewX(-12)">
      <rect x="20" y="168" width="22" height="48" rx="11" fill="var(--power)" />
      <rect x="54" y="128" width="22" height="88" rx="11" fill="var(--power)" />
      <rect x="88" y="40" width="24" height="176" rx="12" fill="var(--text-primary)" />
      <circle cx="158" cy="160" r="46" fill="none" stroke="var(--text-primary)" strokeWidth="24" />
      <circle cx="158" cy="160" r="12" fill="var(--hr)" />
    </g>
  </svg>
);

const Kbd = ({ k }: { k: string }) => <kbd aria-hidden="true">{k}</kbd>;

interface Actions { finishArmed: boolean; startArmed: boolean; lap: () => void; finish: () => void; start: () => void }
interface HeaderProps {
  status: Partial<Status>; ride: Partial<RideStatus>; act: Actions; panel: Panel | null; toggle: (p: Panel) => void;
}
export function Header({ status, ride, act, panel, toggle }: HeaderProps) {
  const settingsOpen = panel === 'settings', devicesOpen = panel === 'devices';
  const recording = ride.state === 'recording';
  const [col, txt, short] = (status.state && STATUS[status.state]) || ['--text-muted', () => status.state || 'Connecting…', 'Connecting…'];
  const hr: Partial<HrStatus> = status.hr || {};
  const hrPill = hr.state && HR_STATUS[hr.state];
  return (
    <header>
      <h1><Logo />Bike <span>Live training</span></h1>
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
function Drawer({ id, title, onClose, children }: { id: string; title: string; onClose: () => void; children: ReactNode }) {
  const ref = useRef<HTMLElement>(null);
  const close = useEvent(onClose);
  useEffect(() => {      // focus moves in while open and back out on close; Esc works anywhere on the page
    const back = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const k = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
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
function FtpField({ ftp, setFtp }: { ftp: number; setFtp: (v: number) => void }) {
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

function WeightField({ kg, setKg }: { kg: number | null; setKg: (v: number | null) => void }) {
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

interface SettingsProps {
  ftp: number; setFtp: (v: number) => void; kg: number | null; setKg: (v: number | null) => void;
  onCsv: () => void; canCsv: boolean; smooth: number; setSmooth: (v: number) => void;
  liveRate: LiveRate; setLiveRate: (v: LiveRate) => void; recording: boolean; workout: WorkoutSettingsProps;
  ftpTest?: FtpTestSettingsProps;
}
export function Settings({ ftp, setFtp, kg, setKg, onCsv, canCsv, smooth, setSmooth, liveRate, setLiveRate, recording, workout, ftpTest }: SettingsProps) {
  return (
    <section className="settings">
      <FtpField key={ftp} ftp={ftp} setFtp={setFtp} />
      {ftpTest && <div className="field">
        <span className="flabel">FTP test</span>
        <FtpTestSettings {...ftpTest} />
      </div>}
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
          <select id="liverate" value={liveRate} onChange={e => setLiveRate(e.target.value as LiveRate)}>
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
function ClearData({ recording }: { recording: boolean }) {
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
const ROLE: Record<DeviceRole, { title: string; any: string; tip: ReactNode }> = {
  trainer: { title: 'Trainer', any: 'Any smart trainer',
             tip: 'Pedal to wake the trainer. Close Zwift and the ThinkRider app first: it takes one connection at a time.' },
  hr:      { title: 'Heart rate', any: 'Any heart-rate broadcast',
             tip: <>On the Forerunner turn on <b>Broadcast Heart Rate</b> (hold UP › Settings › Sensors &amp; Accessories › Wrist Heart Rate).</> },
};
const KIND: Record<DeviceKind, string> = { trainer: 'Smart trainer', hr: 'Heart-rate broadcast', other: 'Other device' };
const useUrl = (role: DeviceRole, d: FoundDevice) => `/devices/use?role=${role}&address=${encodeURIComponent(d.address)}&name=${encodeURIComponent(d.name || '')}`;

function Bars({ rssi }: { rssi: number | null }) {
  const n = rssi == null ? 0 : rssi >= -65 ? 3 : rssi >= -80 ? 2 : 1;
  const word = ['Unknown', 'Weak', 'Good', 'Strong'][n];
  return <span className="bars" role="img" aria-label={`Signal ${word}`} title={rssi == null ? word : `${word} signal (${rssi} dBm)`}>
    {[1, 2, 3].map(i => <i key={i} className={i <= n ? 'on' : ''} />)}</span>;
}

interface SlotInfo { dot: string; name: string | null | undefined; text: string; off?: boolean; on?: boolean }
function slotInfo(role: DeviceRole, status: Partial<Status>): SlotInfo {
  const s: { state?: TrainerState | HrState; device?: string | null } = role === 'trainer' ? status : (status.hr || {});
  const choice: DeviceChoice = status.devices?.[role] || { mode: 'auto' };
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

function Slot({ role, status, recording }: { role: DeviceRole; status: Partial<Status>; recording: boolean }) {
  const info = slotInfo(role, status);
  const choice: Partial<DeviceChoice> = status.devices?.[role] || {};
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

const ROLES: DeviceRole[] = ['trainer', 'hr'];
function DeviceRow({ d, choice }: { d: FoundDevice; choice: Partial<Record<DeviceRole, DeviceChoice>> }) {
  const inUse = ROLES.find(r => (choice[r] || {}).mode !== 'off' && (choice[r] || {}).address === d.address);
  const roles = d.kind === 'other' ? ROLES : [d.kind];
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

export function Devices({ status, recording }: { status: Partial<Status>; recording: boolean }) {
  const scan: Partial<ScanStatus> = status.scan || {};
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
interface TileProps {
  label: ReactNode; keyColor?: string; value: ReactNode; unit?: string; sub?: ReactNode;
  className?: string; badge?: ReactNode; style?: CSSProperties; children?: ReactNode;
}
function Tile({ label, keyColor, value, unit, sub, className = '', badge, style, children }: TileProps) {
  return (
    <div className={'tile ' + className} style={style}>
      <div className="label">{keyColor && <span className="key" style={{ background: `var(${keyColor})` }} />}{label}{badge}</div>
      <div className="value">{value}{unit && <span className="unit">{unit}</span>}</div>
      {sub !== undefined && <div className="sub">{sub || ' '}</div>}
      {children}
    </div>
  );
}

// Recording: live ride.  Ready: live preview (nothing saved).  Finished: the ride's summary.
interface HeroProps {
  hist: Sample[]; laps: number[]; st: RideStats; ftp: number; preview: LiveValues | null; mode: Mode;
  now: LiveNow | null; recent: RecentPower[]; smooth: number;
}
function Hero({ hist, laps, st, ftp, preview, mode, now, recent, smooth }: HeroProps) {
  const done = mode === 'finished' && hist.length > 0;
  const fresh = now && Date.now() - now.at < FRESH_MS;
  const live: LiveValues[] = fresh ? [now] : mode === 'recording' ? hist : preview ? [preview] : [];
  const last = live[live.length - 1];
  const p = done ? st.avgP : fresh ? livePower(now, recent, smooth) : avg3(live);
  const zi = p != null && p > 0 ? zoneOf(p, ftp) : -1;
  const z = ZONES[zi];
  const zoneTxt = p != null && p > 0 ? <><b className="zn">{z.n}</b><span className="zrest"><b>{z.name}</b> · {Math.round((p / ftp) * 100)}% FTP</span></> : null;
  // current lap at a glance: number, time and average power so far
  const lapStart = laps[laps.length - 1] || 0, lapRows = hist.slice(lapStart);
  const lapAvg = lapRows.length ? lapRows.reduce((t, s) => t + (s.power_w || 0), 0) / lapRows.length : null;
  const timeBadge = mode === 'recording' ? <span className="badge rec">REC</span>
                  : mode === 'finished' ? <span className="badge done">Finished</span>
                  : null;   // the strip above already says Preview
  return (
    <section className={'hero ' + mode}>
      <Tile className={'power' + (zi >= 0 ? ' zoned' : '')} style={zi >= 0 ? ({ '--zc': `var(--z${zi + 1})` } as CSSProperties) : undefined} label={done ? 'Avg power · ride' : smooth ? `Power · ${smooth} s` : 'Power'} keyColor="--power" value={r0(p)} unit="W"
            sub={done ? <>{zoneTxt}{last ? <span className="live-now">now {r0(avg3(live))} W</span> : null}</>
                      : !last ? '' : p != null && p > 0 ? zoneTxt : 'Not pedaling'}>
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

interface StatsProps {
  hist: Sample[]; st: RideStats; ftp: number; kg: number | null; more: boolean; setMore: (v: boolean) => void; mode: Mode;
}
const Stats = memo(function Stats({ hist, st, ftp, kg, more, setMore, mode }: StatsProps) {
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

// ------------------------------------------------------------------ side panels
const TimeInZone = memo(function TimeInZone({ st, ftp }: { st: RideStats; ftp: number }) {
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

interface LapsProps {
  hist: Sample[]; laps: number[]; ftp: number; recording: boolean;
  version: number;                                  // not read: a new second re-renders the memo (see Charts)
}
const Laps = memo(function Laps({ hist, laps, ftp, recording }: LapsProps) {
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
            {!hist.length ? <tr><td colSpan={7} className="empty">Laps appear here once you press Start.</td></tr> :
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
interface SendToProps {
  ride: Partial<RideStatus>; href?: string; label: string; className?: string; used: boolean; onDownload: () => void;
}
function SendTo({ ride, href, label, className = '', used, onDownload }: SendToProps) {
  return <a className={'btn ' + (used ? 'used' : className)} href="/ride.fit" download={ride.fit ?? undefined}
            aria-label={used ? `${label} (done)` : undefined}
            onClick={() => { onDownload(); if (href) window.open(href, '_blank', 'noopener'); }}>{used && <Check />}{label}</a>;
}

// ------------------------------------------------------------------ ride strip: one band, same height in every state
interface RideStripProps {
  ride: Partial<RideStatus>; seconds: number; startArmed: boolean; lapFlash: number; sent: Sent;
  onDownload: (...to: string[]) => void;
  onFtpTest?: () => void;                           // Start FTP test (ready state)
  ftpTest?: boolean;                                // this ride is an FTP test
}
export function RideStrip({ ride, seconds, startArmed, lapFlash, sent, onDownload, onFtpTest, ftpTest }: RideStripProps) {
  const dir = ride.dir ? `${ride.dir}/` : 'the ride folder';
  let cls = 'ready', body: ReactNode;
  if (ride.state === 'recording') {
    cls = 'rec';
    body = <><span className="badge rec">REC</span>
      <span>Recording {ftpTest ? 'FTP test' : 'ride'} {ride.n || 1} · saved every second to <b>{dir}</b></span>
      {lapFlash ? <span className="flash">Lap {lapFlash} started</span> : null}</>;
  } else if (ride.state === 'finished' && ride.fit) {
    cls = 'done';
    const used: string[] = sent.fit === ride.fit ? sent.to : [];
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
      <span>Live numbers only. Nothing is saved until you press <b>Start</b>.</span>
      {onFtpTest && <button className="ftp-start" onClick={onFtpTest}>Start FTP test</button>}</>;
  }
  return <div className={'strip ' + cls} role="status" aria-live="polite">{body}</div>;
}

// ------------------------------------------------------------------ app
function exportCsv(hist: Sample[]) {
  const csv = [CSV_COLS.join(',')].concat(hist.map(s => CSV_COLS.map(c => s[c] ?? '').join(','))).join('\n');
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'x2max_ride.csv'; a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

// Phones and tablets get the battery-saver live rate by default. Read once, like PRESS.
const TOUCH = typeof window !== 'undefined' && window.matchMedia('(pointer: coarse)').matches;
const NOT_SENT: Sent = { fit: null, to: [] };
const LAP_FLASH_S = 3;                               // "Lap N started" for the lap's first seconds

export function App() {
  const [smooth, setSmooth] = useStored('powerSmooth', 0);
  const [liveRate, setLiveRate] = useStored<LiveRate>('liveRate', 'auto');
  const rate = liveRate === 'saver' || (liveRate === 'auto' && TOUCH) ? 2 : 0;
  const { hist, laps, status, online, version, preview, now, recent } = useLiveFeed(rate);
  const ride: Partial<RideStatus> = status.ride || {};
  const mode: Mode = ride.state === 'recording' ? 'recording' : ride.state === 'finished' ? 'finished' : 'ready';
  const [ftp, setFtp] = useStored('ftp', 200);    // FTP and weight stay in this browser
  const [kg, setKg] = useStored<number | null>('kg', null);
  const [win, setWin] = useStored('win', 1200);
  const [more, setMore] = useStored('moreStats', false);
  const [wo, setWo] = useStored<Workout | null>('workout', null);
  const [woSound, setWoSound] = useStored('workoutSound', true);
  const [sent, setSent] = useStored<Sent | null>('sent', NOT_SENT);   // which buttons were used for which .fit

  const [panel, setPanel] = useState<Panel | null>(null);
  const toggle = (p: Panel) => setPanel(o => (o === p ? null : p));
  const closePanel = useCallback(() => setPanel(null), []);
  // Adjusted while rendering, when the logger's answer arrives (no effect, no extra paint):
  // open the device panel once when no trainer is remembered yet (or it was turned off) ...
  const devChoice = status.devices?.trainer;
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
  const [testArmed, pressTest] = useArmed(ride.state);
  const lapStart = laps[laps.length - 1] || 0;
  const lapFlash = mode === 'recording' && laps.length > 1 && hist.length - lapStart < LAP_FLASH_S ? laps.length : 0;

  const st = useMemo(() => stats(hist, ftp, null), [version, ftp]); // eslint-disable-line react-hooks/exhaustive-deps -- hist grows in place

  // the finished ride is "unsaved" until its .FIT was downloaded from here
  const unsaved = mode === 'finished' && ride.fit && !(sent && sent.fit === ride.fit && sent.to.length);
  // Send to… also downloads the file, so it marks Download .FIT as done too
  const markSent = (...to: string[]) => setSent(s => ({ fit: ride.fit ?? null, to: [...new Set([...(s && s.fit === ride.fit ? s.to : []), ...to])] }));

  // The ride state on <html> (for CSS), and back to the top when a ride finishes.
  const lastMode = useRef(mode);
  useEffect(() => {
    document.documentElement.dataset.ride = mode;
    if (lastMode.current === 'recording' && mode === 'finished') window.scrollTo({ top: 0 });
    lastMode.current = mode;
  }, [mode]);

  const act: Actions = {
    finishArmed, startArmed,
    lap: postLap,
    finish: () => pressFinish(() => post('/finish')),
    start: () => unsaved ? pressStart(() => post('/start')) : post('/start'),
  };
  // FTP test: the logger runs it as a ride; while it is on, its steps replace the loaded workout.
  const ftpStatus = status.ftp;
  const ftpRun = ftpStatus?.test ?? null;
  const startTest = () => unsaved ? pressTest(() => startFtpTest(ftp)) : startFtpTest(ftp);
  const testWo = useMemo(() => (ftpStatus ? protocolWorkout(ftpStatus.protocol) : null), [ftpStatus?.protocol]); // eslint-disable-line react-hooks/exhaustive-deps
  const testing = !!ftpRun && mode === 'recording';
  const activeWo = testing ? testWo : wo;

  // trainer control: climb / ERG, workout steps drive it while recording
  const ctl = status.control;
  const woAt = activeWo && mode === 'recording' ? workoutAt(activeWo, Math.max(0, hist.length - (testing ? ftpRun?.t0 ?? 0 : 0)), ftp) : null;
  useWorkoutControl({ ctl, at: woAt, recording: mode === 'recording' });
  const woDrives = testing && ctl && ctl.mode === 'erg' ? 'The FTP test sets the power at each step and lets you set it in the hard efforts.'
                 : activeWo && activeWo.segs.some(s => s.grade != null) ? 'Workout steps with a grade set it when they start.'
                 : activeWo && ctl && ctl.mode === 'erg' ? 'The workout sets the power at each step.' : null;
  const showCtl = ctl && (status.connected || ctl.enabled || ctl.msg);

  // Keys: S start, L lap, F finish, − / + grade or ERG power. One document listener for the
  // app's lifetime; useEvent lets it see the current ride and control state.
  const onKey = useEvent((e: KeyboardEvent) => {
    if (e.metaKey || e.ctrlKey || e.altKey || ['INPUT', 'SELECT', 'TEXTAREA'].includes((e.target as HTMLElement).tagName)) return;
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
                                 workout={{ wo, setWo, sound: woSound, setSound: setWoSound }}
                                 ftpTest={{ ftpStatus, ftp, setFtp, recording: mode === 'recording', startArmed: testArmed, onStart: startTest }} /></Drawer>}
      {!online && <div className="offline" role="alert">The dashboard lost contact with the logger.
        If it was stopped, start it again with <b>Start X2Max</b>. Retrying…</div>}
      <RideStrip ride={ride} seconds={hist.length} startArmed={startArmed} lapFlash={lapFlash}
                 sent={sent || NOT_SENT} onDownload={markSent} ftpTest={testing}
                 onFtpTest={ftpStatus && online ? startTest : undefined} />
      {ftpStatus && ftpRun && mode !== 'ready' && <FtpTestBand ftpStatus={ftpStatus} hist={hist} mode={mode} ftp={ftp} setFtp={setFtp} />}
      {showCtl && <ClimbBand ctl={ctl} ftp={ftp} follow={woDrives} />}
      {activeWo && mode !== 'finished' ? <WorkoutBand wo={activeWo} t={Math.max(0, hist.length - (testing ? ftpRun?.t0 ?? 0 : 0))} mode={mode} ftp={ftp} sound={woSound}
                            onRemove={testing ? undefined : () => setWo(null)}
                            power={fresh ? livePower(now, recent, 3) : last ? avg3(hist) : null}
                            cadence={fresh ? now.cadence_rpm : last ? last.cadence_rpm : null}
                            hr={fresh ? now.heart_rate_bpm : last ? last.heart_rate_bpm : null}
                            speed={fresh ? now.speed_kmh : last ? last.speed_kmh : null} /> : null}
      {mode === 'finished' && hist.length > 0 && <RideReview hist={hist} st={st} ftp={ftp} workout={wo} woStart={0} ftpTest={!!ftpRun} />}
      <Hero hist={hist} laps={laps} st={st} ftp={ftp} preview={mode === 'recording' ? null : preview} mode={mode}
            now={now} recent={recent} smooth={smooth} />
      <Stats hist={hist} st={st} ftp={ftp} kg={kg} more={more} setMore={setMore} mode={mode} />
      <section className="main">
        <Charts hist={hist} laps={laps} ftp={ftp} win={win} setWin={setWin} version={version}
                workout={testing || (ftpRun && mode === 'finished') ? testWo : wo} />
        <div className="side">
          <TimeInZone st={st} ftp={ftp} />
          <Laps hist={hist} laps={laps} ftp={ftp} recording={mode === 'recording'} version={version} />
        </div>
      </section>
    </div>
  );
}

