// Structured workouts: load a .zwo (Zwift), .erg or .mrc file, follow its steps during a
// recorded ride, and beep when power, cadence or heart rate stays off target for more than 7 s,
// at most once every 15 s.
// With Trainer control off the rider holds the target. With it on, a step's grade sets the
// trainer's climb, and in ERG mode a step's power target sets the trainer (control/climb.jsx).
// Heart-rate targets are an extra .zwo attribute (Zwift ignores it): HeartRate="140" (bpm) on
// a step, OnHeartRate / OffHeartRate on IntervalsT. Speed targets the same way: Speed="30" (km/h),
// OnSpeed / OffSpeed. Grade targets too: Grade="6" (%), OnGrade / OffGrade. See workouts/ for examples.
import React, { useEffect, useRef } from 'react';

const BEEP_GAP_MS = 15000;     // at most one beep every 15 s
const BEEP_AFTER_MS = 7000;    // only once off target for longer than this without a break
const GRACE_S = 8;             // no beep in the first seconds of a step (time to change effort)
const HR_GRACE_S = 30;         // heart rate needs longer to follow a new effort

// Segment: { dur (s), lo, hi (power target at start / end), unit: 'ftp' (fraction) | 'w',
//            cad (rpm), hr (bpm), spd (km/h), grade (%), name }
export function parseWorkout(text, fileName) {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const segs = ext === 'zwo' ? parseZwo(text) : parseErg(text, ext === 'erg' ? 'w' : 'ftp');
  if (!segs.length) throw new Error('No workout steps found in this file.');
  const title = (ext === 'zwo' && new DOMParser().parseFromString(text, 'text/xml').querySelector('workout_file > name')?.textContent?.trim())
    || fileName.replace(/\.[^.]+$/, '');
  return { name: title, segs, total: segs.reduce((t, s) => t + s.dur, 0) };
}

function parseZwo(text) {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const w = doc.querySelector('workout');
  if (!w) throw new Error('This .zwo file has no <workout> section.');
  const num = (el, a) => { const v = parseFloat(el.getAttribute(a)); return Number.isFinite(v) ? v : null; };
  const segs = [];
  for (const el of w.children) {
    const tag = el.tagName.toLowerCase(), dur = num(el, 'Duration') || 0, cad = num(el, 'Cadence'), hr = num(el, 'HeartRate'), spd = num(el, 'Speed'), grade = num(el, 'Grade');
    if (tag === 'intervalst') {
      const on = num(el, 'OnDuration') || 0, off = num(el, 'OffDuration') || 0, n = num(el, 'Repeat') || 1;
      const onP = num(el, 'OnPower') ?? num(el, 'PowerOnHigh') ?? num(el, 'PowerOnLow');
      const offP = num(el, 'OffPower') ?? num(el, 'PowerOffHigh') ?? num(el, 'PowerOffLow');
      for (let i = 0; i < n; i++) {
        if (on) segs.push({ dur: on, lo: onP, hi: onP, unit: 'ftp', cad, hr: num(el, 'OnHeartRate'), spd: num(el, 'OnSpeed'), grade: num(el, 'OnGrade'), name: `Interval ${i + 1}/${n}` });
        if (off) segs.push({ dur: off, lo: offP, hi: offP, unit: 'ftp', cad: num(el, 'CadenceResting'), hr: num(el, 'OffHeartRate'), spd: num(el, 'OffSpeed'), grade: num(el, 'OffGrade'), name: 'Recovery' });
      }
    } else if (!dur) {
      continue;                                   // text events etc.
    } else if (tag === 'freeride' || tag === 'maxeffort') {
      segs.push({ dur, lo: null, hi: null, unit: 'ftp', cad, hr, spd, grade, name: tag === 'maxeffort' ? 'Max effort' : 'Free ride' });
    } else {
      const lo = num(el, 'PowerLow') ?? num(el, 'Power'), hi = num(el, 'PowerHigh') ?? lo;
      const name = { warmup: 'Warm-up', cooldown: 'Cool-down', ramp: 'Ramp' }[tag] || 'Steady';
      segs.push({ dur, lo, hi, unit: 'ftp', cad, hr, spd, grade, name });
    }
  }
  return segs;
}

// .erg (watts) / .mrc (% FTP): "[COURSE DATA]" with "minutes  value" points joined by straight lines.
function parseErg(text, unit) {
  const body = text.split(/\[COURSE DATA\]/i)[1];
  if (!body) throw new Error('No [COURSE DATA] section found.');
  const pts = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const [m, v] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(m) && Number.isFinite(v)) pts.push([m * 60, unit === 'w' ? v : v / 100]);
  }
  const segs = [];
  for (let i = 1; i < pts.length; i++) {
    const [t0, p0] = pts[i - 1], [t1, p1] = pts[i];
    if (t1 > t0) segs.push({ dur: t1 - t0, lo: p0, hi: p1, unit, cad: null, name: p0 === p1 ? 'Steady' : 'Ramp' });
  }
  return segs;
}

const watts = (v, unit, ftp) => (v == null ? null : unit === 'w' ? v : v * ftp);

// Where the ride is in the workout after `t` seconds.
export function workoutAt(wo, t, ftp) {
  let start = 0;
  for (let i = 0; i < wo.segs.length; i++) {
    const s = wo.segs[i];
    if (t < start + s.dur) {
      const into = t - start, f = s.dur ? into / s.dur : 0;
      const lo = watts(s.lo, s.unit, ftp), hi = watts(s.hi, s.unit, ftp);
      return { i, s, into, left: s.dur - into, target: lo == null ? null : lo + (hi - lo) * f, next: wo.segs[i + 1] };
    }
    start += s.dur;
  }
  return null;                                     // finished
}

// Off target: power outside ±max(10 W, 7 %), cadence ±8 rpm, heart rate ±5 bpm, speed ±2 km/h.
export const powerTol = w => Math.max(10, w * 0.07);
export const CAD_TOL = 8;
export const HR_TOL = 5;
export const SPEED_TOL = 2;

// The plan for the charts: [{ t0, t1, a, b }] with a/b the target at t0/t1 (watts or rpm).
export function plannedLine(wo, ftp, key) {
  const out = [];
  let t = 0;
  for (const s of wo.segs) {
    if (key === 'power_w' && s.lo != null) out.push({ t0: t, t1: t + s.dur, a: watts(s.lo, s.unit, ftp), b: watts(s.hi, s.unit, ftp) });
    if (key === 'cadence_rpm' && s.cad) out.push({ t0: t, t1: t + s.dur, a: s.cad, b: s.cad });
    if (key === 'heart_rate_bpm' && s.hr) out.push({ t0: t, t1: t + s.dur, a: s.hr, b: s.hr });
    if (key === 'speed_kmh' && s.spd) out.push({ t0: t, t1: t + s.dur, a: s.spd, b: s.spd });
    t += s.dur;
  }
  return out;
}

export function offTarget(at, power, cadence, hr, speed) {
  if (!at || at.into < GRACE_S) return null;
  if (at.target != null && power != null) {
    const tol = powerTol(at.target);
    if (power < at.target - tol) return 'low';
    if (power > at.target + tol) return 'high';
  }
  if (at.s.cad && cadence != null) {
    if (cadence < at.s.cad - CAD_TOL) return 'cad-low';
    if (cadence > at.s.cad + CAD_TOL) return 'cad-high';
  }
  if (at.s.spd && speed != null) {
    if (speed < at.s.spd - SPEED_TOL) return 'spd-low';
    if (speed > at.s.spd + SPEED_TOL) return 'spd-high';
  }
  if (at.s.hr && hr != null && at.into >= HR_GRACE_S) {
    if (hr < at.s.hr - HR_TOL) return 'hr-low';
    if (hr > at.s.hr + HR_TOL) return 'hr-high';
  }
  return null;
}

let ctx;
function unlockAudio() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { /* no audio available */ }
}
if (typeof document !== 'undefined')                // any tap or key (e.g. Start) unlocks sound
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true });

export function beep(kind) {
  try {
    unlockAudio();
    const low = kind.endsWith('low');
    // too low: two rising beeps; too high: one falling beep
    const tones = low ? [[660, 0], [880, 0.18]] : [[880, 0], [520, 0.18]];
    for (const [f, d] of tones) {
      const o = ctx.createOscillator(), g = ctx.createGain(), t = ctx.currentTime + d;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(ctx.destination); o.start(t); o.stop(t + 0.16);
    }
  } catch (e) { /* no audio available */ }
}

const fmt = s => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const MSG = { low: 'Too low', high: 'Too high', 'cad-low': 'Cadence too low', 'cad-high': 'Cadence too high',
              'hr-low': 'Heart rate too low', 'hr-high': 'Heart rate too high',
              'spd-low': 'Speed too low', 'spd-high': 'Speed too high' };

function segText(s, ftp) {
  const parts = [];
  if (s.lo != null) {
    const lo = Math.round(watts(s.lo, s.unit, ftp)), hi = Math.round(watts(s.hi, s.unit, ftp));
    parts.push(`${lo === hi ? lo : `${lo}→${hi}`} W`);
  }
  if (s.grade != null) parts.push(`${s.grade} % grade`);
  if (s.spd) parts.push(`${s.spd} km/h`);
  if (s.hr) parts.push(`${s.hr} bpm`);
  if (s.cad) parts.push(`${s.cad} rpm`);
  return parts.join(' · ') || s.name;
}

// What is off, for the band and the popup: actual, target and unit.
function offDetail(off, at, power, cadence, hr, speed) {
  if (off.startsWith('spd')) return { v: speed, target: at.s.spd, unit: 'km/h', what: 'Speed' };
  if (off.startsWith('cad')) return { v: cadence, target: at.s.cad, unit: 'rpm', what: 'Cadence' };
  if (off.startsWith('hr')) return { v: hr, target: at.s.hr, unit: 'bpm', what: 'Heart rate' };
  return { v: power, target: at.target, unit: 'W', what: 'Power' };
}
const signed = n => `${n > 0 ? '+' : ''}${n}`;

// Profile of the whole workout: power if the file has power targets, else grade (a climb profile),
// else speed, heart rate, cadence.
function profileOf(wo, ftp) {
  const has = k => wo.segs.some(s => (k === 'p' ? s.lo != null : k === 'grade' ? s.grade != null : s[k]));
  const k = has('p') ? 'p' : has('grade') ? 'grade' : has('spd') ? 'spd' : has('hr') ? 'hr' : 'cad';
  if (k === 'grade') return { v: s => (s.grade == null ? 0.5 : Math.max(s.grade, 0) + 1), free: s => s.grade == null };
  const v = (s, end) => (k === 'p' ? watts((end ? s.hi : s.lo) ?? 0.5, s.unit, ftp) : s[k] || 0);
  return { v, free: s => (k === 'p' ? s.lo == null : !s[k]) };
}

// The step's targets: the first one big, the others small beside it.
function targetText(at) {
  const ftp = at.target != null && at.s.unit === 'ftp' && at.s.lo ? at.target / at.s.lo : null;
  const all = [
    at.target != null && [`${Math.round(at.target)} W`, ftp && at.s.lo === at.s.hi ? ` ${Math.round(at.s.lo * 100)}% FTP` : ''],
    at.s.grade != null && [`${at.s.grade} %`, ' grade'],
    at.s.spd && [`${at.s.spd} km/h`, ''],
    at.s.hr && [`${at.s.hr} bpm`, ''],
    at.s.cad && [`${at.s.cad} rpm`, ''],
  ].filter(Boolean);
  if (!all.length) return 'No target';
  return <>{all[0][0]}<small>{all[0][1]}</small>{all.slice(1).map(([v, x]) => <small key={v}> · {v}{x}</small>)}</>;
}

// Workout band: current step, target, time left, on/off target, and a small profile of the whole workout.
export function WorkoutBand({ wo, t, mode, ftp, power, cadence, hr, speed, sound, onRemove }) {
  const at = mode === 'ready' ? workoutAt(wo, 0, ftp) : workoutAt(wo, t, ftp);
  const off = mode === 'recording' ? offTarget(at, power, cadence, hr, speed) : null;
  const d = off ? offDetail(off, at, power, cadence, hr, speed) : null;
  // Sound is an outside system: the effect checks on each change (every packet / second) how long
  // the rider has been off target. Back on target resets the clock.
  const lastBeep = useRef(0), offSince = useRef(null);
  useEffect(() => {
    if (!off) { offSince.current = null; return; }
    const n = Date.now();
    if (offSince.current === null) offSince.current = n;
    if (!sound || n - offSince.current <= BEEP_AFTER_MS) return;
    if (n - lastBeep.current >= BEEP_GAP_MS) { lastBeep.current = n; beep(off); }
  }, [off, t, sound, power, cadence, hr, speed]);

  const prof = profileOf(wo, ftp);
  const max = Math.max(...wo.segs.map(s => Math.max(prof.v(s), prof.v(s, true))), 1);
  let x = 0;
  const done = !at && mode !== 'ready';
  return (
    <section className={'workout' + (off ? ' off' : '')} aria-label="Workout">
      <div className="wo-head">
        <span className="wo-name">{wo.name}</span>
        <span className="wo-meta">{fmt(Math.min(mode === 'ready' ? 0 : t, wo.total))} / {fmt(wo.total)}</span>
        <button className="quiet" onClick={onRemove}>Remove</button>
      </div>
      {done ? <div className="wo-now"><b>Workout complete.</b> Keep riding or press Finish.</div> : (
        <div className="wo-now">
          <span className="wo-step">Step {at.i + 1}/{wo.segs.length} · {at.s.name}</span>
          <span className="wo-target">{targetText(at)}</span>
          <span className="wo-left">{fmt(at.left)} left</span>
          <span className={'wo-state ' + (off ? 'bad' : 'ok')} role="status">
            {mode === 'ready' ? 'Starts when you press Start'
              : off ? `${MSG[off]}${d.v != null ? ` · ${signed(Math.round(d.v - d.target))} ${d.unit}` : ''}`
              : at.into < (at.s.hr && at.target == null ? HR_GRACE_S : GRACE_S) ? 'Get to the target' : 'On target'}</span>
          {at.next && <span className="wo-next">Next: {segText(at.next, ftp)} for {fmt(at.next.dur)}</span>}
        </div>)}
      {off && <OffPopup off={off} d={d} />}
      <svg className="wo-profile" viewBox={`0 0 ${wo.total} 100`} preserveAspectRatio="none" aria-hidden="true">
        {wo.segs.map((s, i) => {
          const y0 = 100 - (prof.v(s) / max) * 92, y1 = 100 - (prof.v(s, true) / max) * 92;
          const p = <polygon key={i} points={`${x},100 ${x},${y0} ${x + s.dur},${y1} ${x + s.dur},100`}
                             className={at && i === at.i ? 'cur' : prof.free(s) ? 'free' : ''} />;
          x += s.dur;
          return p;
        })}
        {mode !== 'ready' && <line x1={Math.min(t, wo.total)} x2={Math.min(t, wo.total)} y1="0" y2="100" vectorEffect="non-scaling-stroke" />}
      </svg>
    </section>
  );
}

// Big popup while off target, readable from the bike. It closes by itself once back on target.
const POP = {
  low: ['Push harder', '↑'], high: ['Ease off', '↓'],
  'cad-low': ['Pedal faster', '↑'], 'cad-high': ['Pedal slower', '↓'],
  'hr-low': ['Push harder', '↑'], 'hr-high': ['Ease off', '↓'],
  'spd-low': ['Go faster', '↑'], 'spd-high': ['Slow down', '↓'],
};
function OffPopup({ off, d }) {
  const [title, arrow] = POP[off];
  return (
    <div className={'wo-pop ' + (off.endsWith('low') ? 'low' : 'high')} role="alert">
      <span className="wo-pop-arrow" aria-hidden="true">{arrow}</span>
      <div>
        <div className="wo-pop-title">{title}</div>
        <div className="wo-pop-sub">
          {d.what} {d.v != null ? Math.round(d.v) : '–'} · target {Math.round(d.target)} {d.unit}
          {d.v != null && <b> ({signed(Math.round(d.v - d.target))} {d.unit})</b>}
        </div>
      </div>
    </div>
  );
}

// Settings field: load / remove a workout, sound on/off, test sound.
export function WorkoutSettings({ wo, setWo, sound, setSound }) {
  const [err, setErr] = React.useState(null);
  const load = async e => {
    const f = e.target.files[0];
    e.target.value = '';
    if (!f) return;
    unlockAudio();                                // phones only allow sound after a tap
    try { setWo(parseWorkout(await f.text(), f.name)); setErr(null); }
    catch (x) { setErr(x.message || 'Could not read this file.'); }
  };
  return <>
    <div className="inline">
      <label className="btn filebtn">{wo ? 'Load another' : 'Load workout'}
        <input type="file" accept=".zwo,.erg,.mrc" onChange={load} /></label>
      {wo && <button onClick={() => setWo(null)}>Remove</button>}
    </div>
    <div className="inline check">
      <label><input type="checkbox" checked={sound} onChange={e => setSound(e.target.checked)} /> Beep when off target</label>
      <button className="quiet" onClick={() => beep('low')}>Test sound</button>
    </div>
    <p className={'help' + (err ? ' err' : '')}>{err || (wo
      ? <><b>{wo.name}</b> · {wo.segs.length} steps · {fmt(wo.total)}. Starts with the ride.</>
      : <>Zwift .zwo, .erg or .mrc file. Beeps when power, cadence, heart rate or speed stays off target for more than 7 s, at most once every 15 s. Steps with a grade climb on their own when <b>Trainer control</b> is on.</>)}</p>
  </>;
}
