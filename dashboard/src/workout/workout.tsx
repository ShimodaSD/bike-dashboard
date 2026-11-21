// Structured workouts: load a .zwo (Zwift), .erg or .mrc file, follow its steps during a
// recorded ride, and beep when power, cadence or heart rate stays off target for more than 7 s,
// at most once every 15 s.
// With Trainer control off the rider holds the target. With it on, a step's grade sets the
// trainer's climb, and in ERG mode a step's power target sets the trainer (control/climb.jsx).
// Heart-rate targets are an extra .zwo attribute (Zwift ignores it): HeartRate="140" (bpm) on
// a step, OnHeartRate / OffHeartRate on IntervalsT. Speed targets the same way: Speed="30" (km/h),
// OnSpeed / OffSpeed. Grade targets too: Grade="6" (%), OnGrade / OffGrade. See workouts/ for examples.
import { useEffect, useRef, useState, type ChangeEvent, type ReactNode } from 'react';
import type { SeriesKey } from '../types/feed';
import type { OffKind, PlanPoint, Segment, Workout, WorkoutAt } from '../types/workout';

const BEEP_GAP_MS = 15000;     // at most one beep every 15 s
const BEEP_AFTER_MS = 7000;    // only once off target for longer than this without a break
const GRACE_S = 8;             // no beep in the first seconds of a step (time to change effort)
const HR_GRACE_S = 30;         // heart rate needs longer to follow a new effort

// Segments: see types/workout.ts
export function parseWorkout(text: string, fileName: string): Workout {
  const ext = (fileName.split('.').pop() || '').toLowerCase();
  const segs = ext === 'zwo' ? parseZwo(text) : parseErg(text, ext === 'erg' ? 'w' : 'ftp');
  if (!segs.length) throw new Error('No workout steps found in this file.');
  const title = (ext === 'zwo' && new DOMParser().parseFromString(text, 'text/xml').querySelector('workout_file > name')?.textContent?.trim())
    || fileName.replace(/\.[^.]+$/, '');
  return { name: title, segs, total: segs.reduce((t, s) => t + s.dur, 0) };
}

function parseZwo(text: string): Segment[] {
  const doc = new DOMParser().parseFromString(text, 'text/xml');
  const w = doc.querySelector('workout');
  if (!w) throw new Error('This .zwo file has no <workout> section.');
  const num = (el: Element, a: string) => { const v = parseFloat(el.getAttribute(a) ?? ''); return Number.isFinite(v) ? v : null; };
  const segs: Segment[] = [];
  for (const el of Array.from(w.children)) {
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
      const name = ({ warmup: 'Warm-up', cooldown: 'Cool-down', ramp: 'Ramp' } as Record<string, string>)[tag] || 'Steady';
      segs.push({ dur, lo, hi, unit: 'ftp', cad, hr, spd, grade, name });
    }
  }
  return segs;
}

// .erg (watts) / .mrc (% FTP): "[COURSE DATA]" with "minutes  value" points joined by straight lines.
function parseErg(text: string, unit: Segment['unit']): Segment[] {
  const body = text.split(/\[COURSE DATA\]/i)[1];
  if (!body) throw new Error('No [COURSE DATA] section found.');
  const pts: [number, number][] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break;
    const [m, v] = line.trim().split(/\s+/).map(Number);
    if (Number.isFinite(m) && Number.isFinite(v)) pts.push([m * 60, unit === 'w' ? v : v / 100]);
  }
  const segs: Segment[] = [];
  for (let i = 1; i < pts.length; i++) {
    const [t0, p0] = pts[i - 1], [t1, p1] = pts[i];
    if (t1 > t0) segs.push({ dur: t1 - t0, lo: p0, hi: p1, unit, cad: null, name: p0 === p1 ? 'Steady' : 'Ramp' });
  }
  return segs;
}

function watts(v: number, unit: Segment['unit'], ftp: number): number;
function watts(v: number | null, unit: Segment['unit'], ftp: number): number | null;
function watts(v: number | null, unit: Segment['unit'], ftp: number) { return v == null ? null : unit === 'w' ? v : v * ftp; }

// Where the ride is in the workout after `t` seconds.
export function workoutAt(wo: Workout, t: number, ftp: number): WorkoutAt | null {
  let start = 0;
  for (let i = 0; i < wo.segs.length; i++) {
    const s = wo.segs[i];
    if (t < start + s.dur) {
      const into = t - start, f = s.dur ? into / s.dur : 0;
      const lo = watts(s.lo, s.unit, ftp), hi = watts(s.hi, s.unit, ftp);
      return { i, s, into, left: s.dur - into, target: lo == null ? null : lo + (hi! - lo) * f, next: wo.segs[i + 1] };
    }
    start += s.dur;
  }
  return null;                                     // finished
}

// Off target: power outside ±max(10 W, 7 %), cadence ±8 rpm, heart rate ±5 bpm, speed ±2 km/h.
export const powerTol = (w: number) => Math.max(10, w * 0.07);
export const CAD_TOL = 8;
export const HR_TOL = 5;
export const SPEED_TOL = 2;

// The plan for the charts: [{ t0, t1, a, b }] with a/b the target at t0/t1 (watts or rpm).
export function plannedLine(wo: Workout, ftp: number, key: SeriesKey): PlanPoint[] {
  const out: PlanPoint[] = [];
  let t = 0;
  for (const s of wo.segs) {
    if (key === 'power_w' && s.lo != null) out.push({ t0: t, t1: t + s.dur, a: watts(s.lo, s.unit, ftp), b: watts(s.hi!, s.unit, ftp) });
    if (key === 'cadence_rpm' && s.cad) out.push({ t0: t, t1: t + s.dur, a: s.cad, b: s.cad });
    if (key === 'heart_rate_bpm' && s.hr) out.push({ t0: t, t1: t + s.dur, a: s.hr, b: s.hr });
    if (key === 'speed_kmh' && s.spd) out.push({ t0: t, t1: t + s.dur, a: s.spd, b: s.spd });
    t += s.dur;
  }
  return out;
}

type Reading = number | null | undefined;

// What the workout expects right now, one entry per live tile (Hero in app.tsx), with how the
// reading compares: low / high (same tolerances as the beep), ok, or wait (the step's first
// seconds, no reading yet, or the ride is paused). Only the targets the step has are set.
export type TargetState = 'low' | 'high' | 'ok' | 'wait';
export interface TileTarget { v: number; unit: string; state: TargetState }
export interface TileTargets {
  power_w?: TileTarget; cadence_rpm?: TileTarget; heart_rate_bpm?: TileTarget; speed_kmh?: TileTarget;
  grade?: number;                                  // %, shown with the power target
}
export function tileTargets(at: WorkoutAt | null, power: Reading, cadence: Reading, hr: Reading, speed: Reading,
                            paused = false): TileTargets {
  if (!at) return {};
  const one = (target: number, v: Reading, tol: number, unit: string, grace = GRACE_S): TileTarget => ({
    v: target, unit,
    state: paused || v == null || at.into < grace ? 'wait' : v < target - tol ? 'low' : v > target + tol ? 'high' : 'ok',
  });
  const out: TileTargets = {};
  if (at.target != null) out.power_w = one(at.target, power, powerTol(at.target), 'W');
  if (at.s.cad) out.cadence_rpm = one(at.s.cad, cadence, CAD_TOL, 'rpm');
  if (at.s.hr) out.heart_rate_bpm = one(at.s.hr, hr, HR_TOL, 'bpm', HR_GRACE_S);
  if (at.s.spd) out.speed_kmh = one(at.s.spd, speed, SPEED_TOL, 'km/h');
  if (at.s.grade != null) out.grade = at.s.grade;
  return out;
}

export function offTarget(at: WorkoutAt | null, power: Reading, cadence: Reading, hr: Reading, speed: Reading): OffKind | null {
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

// The beep rule. Called on every change of the live numbers (and once a second while recording):
// beep once the rider has been off target for more than 7 s without a break, then at most every
// 15 s. Back on target (or a new step's grace time) resets the 7 s. `c` is updated in place.
export interface BeepClock { offSince: number | null; lastBeep: number }
export function beepDue(c: BeepClock, off: OffKind | null, now: number, sound: boolean): boolean {
  if (!off) { c.offSince = null; return false; }
  if (c.offSince === null) c.offSince = now;
  if (!sound || now - c.offSince <= BEEP_AFTER_MS) return false;
  if (now - c.lastBeep < BEEP_GAP_MS) return false;
  c.lastBeep = now;
  return true;
}

declare global { interface Window { webkitAudioContext?: typeof AudioContext } }

let ctx: AudioContext | undefined;
function unlockAudio() {
  try {
    ctx = ctx || new (window.AudioContext || window.webkitAudioContext!)();
    if (ctx.state === 'suspended') ctx.resume();
  } catch (e) { /* no audio available */ }
}
if (typeof document !== 'undefined')                // any tap or key (e.g. Start) unlocks sound
  for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, unlockAudio, { capture: true });

export function beep(kind: string) {
  try {
    unlockAudio();
    const low = kind.endsWith('low');
    // too low: two rising beeps; too high: one falling beep
    const tones = low ? [[660, 0], [880, 0.18]] : [[880, 0], [520, 0.18]];
    for (const [f, d] of tones) {
      const o = ctx!.createOscillator(), g = ctx!.createGain(), t = ctx!.currentTime + d;
      o.frequency.value = f; o.type = 'sine';
      g.gain.setValueAtTime(0.0001, t);
      g.gain.exponentialRampToValueAtTime(0.4, t + 0.02);
      g.gain.exponentialRampToValueAtTime(0.0001, t + 0.15);
      o.connect(g).connect(ctx!.destination); o.start(t); o.stop(t + 0.16);
    }
  } catch (e) { /* no audio available */ }
}

const fmt = (s: number) => { s = Math.max(0, Math.ceil(s)); return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`; };
const MSG: Record<OffKind, string> = { low: 'Too low', high: 'Too high', 'cad-low': 'Cadence too low', 'cad-high': 'Cadence too high',
              'hr-low': 'Heart rate too low', 'hr-high': 'Heart rate too high',
              'spd-low': 'Speed too low', 'spd-high': 'Speed too high' };

function segText(s: Segment, ftp: number) {
  const parts: string[] = [];
  if (s.lo != null) {
    const lo = Math.round(watts(s.lo, s.unit, ftp)), hi = Math.round(watts(s.hi!, s.unit, ftp));
    parts.push(`${lo === hi ? lo : `${lo}→${hi}`} W`);
  }
  if (s.grade != null) parts.push(`${s.grade} % grade`);
  if (s.spd) parts.push(`${s.spd} km/h`);
  if (s.hr) parts.push(`${s.hr} bpm`);
  if (s.cad) parts.push(`${s.cad} rpm`);
  return parts.join(' · ') || s.name;
}

// What is off, for the band and the popup: actual, target and unit.
interface OffDetail { v: Reading; target: number; unit: string; what: string }
function offDetail(off: OffKind, at: WorkoutAt, power: Reading, cadence: Reading, hr: Reading, speed: Reading): OffDetail {
  if (off.startsWith('spd')) return { v: speed, target: at.s.spd!, unit: 'km/h', what: 'Speed' };
  if (off.startsWith('cad')) return { v: cadence, target: at.s.cad!, unit: 'rpm', what: 'Cadence' };
  if (off.startsWith('hr')) return { v: hr, target: at.s.hr!, unit: 'bpm', what: 'Heart rate' };
  return { v: power, target: at.target!, unit: 'W', what: 'Power' };
}
const signed = (n: number) => `${n > 0 ? '+' : ''}${n}`;

// Profile of the whole workout: power if the file has power targets, else grade (a climb profile),
// else speed, heart rate, cadence.
type ProfileKey = 'p' | 'grade' | 'spd' | 'hr' | 'cad';
interface Profile { v: (s: Segment, end?: boolean) => number; free: (s: Segment) => boolean }
function profileOf(wo: Workout, ftp: number): Profile {
  const has = (k: ProfileKey) => wo.segs.some(s => (k === 'p' ? s.lo != null : k === 'grade' ? s.grade != null : s[k]));
  const k: ProfileKey = has('p') ? 'p' : has('grade') ? 'grade' : has('spd') ? 'spd' : has('hr') ? 'hr' : 'cad';
  if (k === 'grade') return { v: s => (s.grade == null ? 0.5 : Math.max(s.grade, 0) + 1), free: s => s.grade == null };
  const v = (s: Segment, end?: boolean) => (k === 'p' ? watts((end ? s.hi : s.lo) ?? 0.5, s.unit, ftp) : s[k] || 0);
  return { v, free: s => (k === 'p' ? s.lo == null : !s[k]) };
}

const hasTarget = (s: Segment) => s.lo != null || s.grade != null || !!s.spd || !!s.hr || !!s.cad;

// The step's targets: the first one big, the others small beside it.
function targetText(at: WorkoutAt): ReactNode {
  const { lo } = at.s;
  const ftp = at.target != null && at.s.unit === 'ftp' && lo ? at.target / lo : null;
  const all = [
    at.target != null && [`${Math.round(at.target)} W`, ftp && lo && lo === at.s.hi ? ` ${Math.round(lo * 100)}% FTP` : ''],
    at.s.grade != null && [`${at.s.grade} %`, ' grade'],
    at.s.spd && [`${at.s.spd} km/h`, ''],
    at.s.hr && [`${at.s.hr} bpm`, ''],
    at.s.cad && [`${at.s.cad} rpm`, ''],
  ].filter((x): x is [string, string] => Boolean(x));
  if (!all.length) return at.s.note || 'No target';
  return <>{all[0][0]}<small>{all[0][1]}</small>{all.slice(1).map(([v, x]) => <small key={v}> · {v}{x}</small>)}</>;
}

// Workout band: current step, target, time left, on/off target, and a small profile of the whole workout.
interface WorkoutBandProps {
  wo: Workout; t: number; mode: 'ready' | 'recording' | 'finished'; ftp: number;
  power: Reading; cadence: Reading; hr: Reading; speed: Reading; sound: boolean;
  paused?: boolean;                                 // ride paused: the step waits, no off target, no beep
  onRemove?: () => void;                            // no Remove button without it (FTP test)
}
export function WorkoutBand({ wo, t, mode, ftp, power, cadence, hr, speed, sound, paused = false, onRemove }: WorkoutBandProps) {
  const at = mode === 'ready' ? workoutAt(wo, 0, ftp) : workoutAt(wo, t, ftp);
  const off = mode === 'recording' && !paused ? offTarget(at, power, cadence, hr, speed) : null;
  const d = off && at ? offDetail(off, at, power, cadence, hr, speed) : null;   // offTarget is null without a step
  // Sound is an outside system: the effect checks on each change (every packet / second) how long
  // the rider has been off target. Back on target resets the clock.
  const clock = useRef<BeepClock>({ offSince: null, lastBeep: 0 });
  useEffect(() => {
    if (beepDue(clock.current, off, Date.now(), sound)) beep(off!);
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
        {onRemove && <button className="quiet" onClick={onRemove}>Remove</button>}
      </div>
      {done || !at ? <div className="wo-now"><b>Workout complete.</b> Keep riding or press Finish.</div> : (
        <div className="wo-now">
          <span className="wo-step">Step {at.i + 1}/{wo.segs.length} · {at.s.name}</span>
          <span className="wo-target">{targetText(at)}</span>
          <span className="wo-left">{fmt(at.left)} left</span>
          <span className={'wo-state ' + (paused ? 'paused' : off ? 'bad' : 'ok')} role="status">
            {mode === 'ready' ? 'Starts when you press Start'
              : paused ? 'Paused · carries on when you resume'
              : off ? `${MSG[off]}${d && d.v != null ? ` · ${signed(Math.round(d.v - d.target))} ${d.unit}` : ''}`
              : !hasTarget(at.s) ? 'Your pace'
              : at.into < (at.s.hr && at.target == null ? HR_GRACE_S : GRACE_S) ? 'Get to the target' : 'On target'}</span>
          {at.next && <span className="wo-next">Next: {segText(at.next, ftp)} for {fmt(at.next.dur)}</span>}
        </div>)}
      {off && d && <OffPopup off={off} d={d} />}
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
const POP: Record<OffKind, [string, string]> = {
  low: ['Push harder', '↑'], high: ['Ease off', '↓'],
  'cad-low': ['Pedal faster', '↑'], 'cad-high': ['Pedal slower', '↓'],
  'hr-low': ['Push harder', '↑'], 'hr-high': ['Ease off', '↓'],
  'spd-low': ['Go faster', '↑'], 'spd-high': ['Slow down', '↓'],
};
function OffPopup({ off, d }: { off: OffKind; d: OffDetail }) {
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
export interface WorkoutSettingsProps {
  wo: Workout | null; setWo: (wo: Workout | null) => void; sound: boolean; setSound: (on: boolean) => void;
}
export function WorkoutSettings({ wo, setWo, sound, setSound }: WorkoutSettingsProps) {
  const [err, setErr] = useState<string | null>(null);
  const load = async (e: ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (!f) return;
    unlockAudio();                                // phones only allow sound after a tap
    try { setWo(parseWorkout(await f.text(), f.name)); setErr(null); }
    catch (x) { setErr((x as Error).message || 'Could not read this file.'); }
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
