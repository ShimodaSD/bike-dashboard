// Trainer control: simulate a climb (grade) or hold a power (ERG) on the X2Max over FTMS.
// Off by default. The logger puts the grade back to 0 % on Finish, when the trainer drops and
// when it stops, and turns control off if another app (Zwift…) takes the trainer.
//   POST /control?on=1|0      turn control on / off
//   POST /control/grade?pct=  simulate this grade (Climb mode)
//   POST /control/power?w=    hold this power (ERG mode)
//   POST /control/sim?difficulty=&crr=&cw=   climb feel (Settings, control/climb-feel.tsx)
// status.control = { enabled, state, mode: 'sim'|'erg', grade, trainer_grade, sim, power_w, msg,
//                    supports, power_range }
import { useEffect, useRef, useState, useCallback, type ReactNode } from 'react';
import { useEvent } from '../hooks/hooks';
import type { ControlState, ControlStatus } from '../types/feed';
import type { WorkoutAt } from '../types/workout';

const post = (path: string) => fetch(path, { method: 'POST' }).catch(() => {});
export const GRADE_MIN = -5, GRADE_MAX = 15, GRADE_STEP = 0.5;
const QUICK = [0, 3, 6, 10];
const ERG_PCT = [0.55, 0.75, 0.9, 1.05];       // quick ERG targets, fraction of FTP

export const sendGrade = (pct: number) => post(`/control/grade?pct=${pct}`);
export const sendPower = (w: number) => post(`/control/power?w=${Math.round(w)}`);
export const fmtGrade = (g: number) => `${g > 0 ? '' : g < 0 ? '−' : ''}${Math.abs(g).toFixed(1)}`;

const STATE_TXT: Record<ControlState, string> = {
  off: 'Off',
  connecting: 'Taking control…',
  on: 'On',
  waiting: 'Waiting for the trainer',
  lost: 'Off · control lost',
  error: 'Off · error',
  unsupported: 'Not available',
};

// Sends at most every `gap` ms while a slider is dragged, and always the last value.
// A send still pending when the dial goes away (control off, Climb <-> ERG) is dropped, so a
// late grade can't flip the trainer back to the other mode.
export function useThrottled(fn: (v: number) => void, gap = 150) {
  const last = useRef(0), timer = useRef<ReturnType<typeof setTimeout>>(), pending = useRef(0);
  useEffect(() => () => clearTimeout(timer.current), []);
  return useCallback((v: number) => {
    pending.current = v;
    const wait = gap - (Date.now() - last.current);
    if (wait <= 0) { last.current = Date.now(); fn(v); return; }
    clearTimeout(timer.current);
    timer.current = setTimeout(() => { last.current = Date.now(); fn(pending.current); }, wait);
  }, [fn, gap]);
}

// One number shown big, with − / + beside it, quick picks and a slider underneath.
// The number picked here shows at once (the draft) until the logger reports it back.
const DRAFT_MS = 1500;
interface DialProps {
  label: string; value: number; unit: string; fmt: (v: number) => ReactNode;
  min: number; max: number; step: number; quick: number[]; quickLabel: (v: number) => string;
  onSet: (v: number) => void;
}
function Dial({ label, value, unit, fmt, min, max, step, quick, quickLabel, onSet }: DialProps) {
  const [draft, setDraft] = useState<number | null>(null);       // value picked here, not yet confirmed
  const draftTimer = useRef<ReturnType<typeof setTimeout>>();
  const send = useThrottled(onSet);
  // the logger confirmed it: drop the draft (adjusted while rendering)
  if (draft !== null && Math.abs(draft - value) < step / 2) setDraft(null);
  // set from the handlers; the logger may round or refuse, so show its value again after a while
  const pick = (n: number) => {
    setDraft(n);
    clearTimeout(draftTimer.current);
    draftTimer.current = setTimeout(() => setDraft(null), DRAFT_MS);
  };
  const v = draft ?? value;
  const nudge = (d: number) => { const n = Math.min(max, Math.max(min, v + d)); pick(n); onSet(n); };
  return (
    <div className="dial">
      <div className="dial-now">
        <button className="nudge" onClick={() => nudge(-step)} disabled={v <= min} aria-label={`${label} down`}>−</button>
        <output className="dial-value" aria-live="polite" aria-label={label}>{fmt(v)}<span className="unit">{unit}</span></output>
        <button className="nudge" onClick={() => nudge(step)} disabled={v >= max} aria-label={`${label} up`}>+</button>
      </div>
      <div className="dial-quick" role="group" aria-label={`Quick ${label.toLowerCase()}`}>
        {quick.map(q => <button key={q} className={Math.abs(q - v) < step / 2 ? 'on' : ''}
                                onClick={() => { pick(q); onSet(q); }}>{quickLabel(q)}</button>)}
      </div>
      <input type="range" min={min} max={max} step={step} value={v} aria-label={label}
             onChange={e => { const n = +e.target.value; pick(n); send(n); }} />
    </div>
  );
}

export function ClimbBand({ ctl, ftp, follow }: { ctl: ControlStatus; ftp: number; follow: string | null }) {
  const on = ctl.enabled;
  const live = on && ctl.state === 'on';
  const erg = ctl.mode === 'erg';
  const [lo, hi] = ctl.power_range || [50, 1000];
  // quick ERG targets from FTP, kept inside the trainer's range (two can land on its limit: show it once)
  const ergQuick = [...new Set(ERG_PCT.map(p => Math.min(hi, Math.max(lo, Math.round((ftp * p) / 5) * 5))))];
  const canErg = !ctl.supports || ctl.supports.erg !== false;
  const stateCls = live ? 'ok' : ['lost', 'error', 'unsupported'].includes(ctl.state) ? 'bad' : on ? 'wait' : '';
  return (
    <section className={'climb' + (on ? ' on' : '')} aria-label="Trainer control">
      <div className="climb-head">
        <button role="switch" aria-checked={on} className={'switch' + (on ? ' on' : '')}
                disabled={ctl.state === 'unsupported'}
                onClick={() => post(`/control?on=${on ? 0 : 1}`)}>
          <span className="knob" aria-hidden="true" />Trainer control
        </button>
        <span className={'climb-state ' + stateCls}>{STATE_TXT[ctl.state] || ctl.state}</span>
        {on && <div className="seg" role="group" aria-label="Control mode">
          <button className={!erg ? 'on' : ''} aria-pressed={!erg} onClick={() => sendGrade(ctl.grade || 0)}>Climb</button>
          <button className={erg ? 'on' : ''} aria-pressed={erg} disabled={!canErg}
                  title={canErg ? 'The trainer holds a power, whatever your cadence' : 'This trainer has no ERG mode'}
                  onClick={() => sendPower(ctl.power_w || Math.round(ftp * 0.75 / 5) * 5)}>ERG</button>
        </div>}
        {!on && !ctl.msg && <span className="climb-help">Simulate climbs: the trainer gets harder or easier, like a hill in Zwift.</span>}
        {ctl.msg && <span className="climb-msg" role="alert">{ctl.msg}</span>}
      </div>
      {on && (erg
        ? <Dial label="Target power" value={ctl.power_w} unit="W" fmt={w => Math.round(w)} min={lo} max={Math.min(hi, 600)}
                step={5} quick={ergQuick} quickLabel={w => `${w} W`} onSet={sendPower} />
        : <Dial label="Grade" value={ctl.grade} unit="%" fmt={fmtGrade} min={GRADE_MIN} max={GRADE_MAX}
                step={GRADE_STEP} quick={QUICK} quickLabel={g => `${g} %`} onSet={sendGrade} />)}
      {on && <p className="climb-foot">
        {follow ? <>{follow} </> : null}
        {!erg && ctl.sim.difficulty !== 100 && <>Trainer difficulty {ctl.sim.difficulty} %:
          it feels like {fmtGrade(ctl.trainer_grade)} %. </>}
        Back to 0 % when you finish or the trainer disconnects.<span className="keys"> Keys: <kbd>−</kbd> <kbd>+</kbd></span></p>}
    </section>
  );
}

// Workout steps with a grade (Grade="6" in a .zwo) set the trainer when the step starts, and in
// ERG mode steps with a power target set the power. Changing it by hand holds until the next step.
// In ERG a step without a power target (free ride, max effort, the FTP test's hard efforts) hands
// the trainer back to Climb at the step's grade or 0 %, so the rider sets the power; the next step
// with a power target goes back to ERG (`freed`).
// The command is worked out while rendering; the effect only sends it to the trainer when it changes.
interface Command { key: string; send: () => void; freed?: boolean }
function workoutCommand(ctl: ControlStatus | undefined, at: WorkoutAt | null, recording: boolean, freed: boolean): Command | null {
  if (!recording || !ctl || !ctl.enabled || ctl.state !== 'on' || !at) return null;
  if ((ctl.mode === 'erg' || freed) && at.target != null) {
    const w = Math.round(at.target / 5) * 5;            // ramps: a new target every 5 W
    return { key: `${at.i}:p${w}`, send: () => sendPower(w), freed: false };
  }
  const grade = at.s.grade;
  if (ctl.mode === 'erg' && at.target == null) return { key: `${at.i}:free`, send: () => sendGrade(grade ?? 0), freed: true };
  if (grade != null) return { key: `${at.i}:g${grade}`, send: () => sendGrade(grade) };
  return null;
}

export function useWorkoutControl({ ctl, at, recording }: { ctl: ControlStatus | undefined; at: WorkoutAt | null; recording: boolean }) {
  const [freed, setFreed] = useState(false);            // the workout took the trainer out of ERG
  if (freed && (!recording || !ctl || !ctl.enabled)) setFreed(false);
  const cmd = workoutCommand(ctl, at, recording, freed);
  const key = cmd ? cmd.key : null;
  const send = useEvent(() => {
    if (!cmd) return;
    cmd.send();
    if (cmd.freed !== undefined) setFreed(cmd.freed);
  });
  useEffect(() => { if (key) send(); }, [key, send]);
}

// + / − keys: grade ±0.5 % (or ERG ±5 W) while control is on. Called from the app's key listener.
export function controlKey(e: KeyboardEvent, c: ControlStatus | undefined) {
  if (!c || !c.enabled || c.state !== 'on') return;
  const d = e.key === '+' || e.key === '=' ? 1 : e.key === '-' || e.key === '_' ? -1 : 0;
  if (!d) return;
  e.preventDefault();
  if (c.mode === 'erg') sendPower(c.power_w + d * 5);
  else sendGrade(Math.min(GRADE_MAX, Math.max(GRADE_MIN, c.grade + d * GRADE_STEP)));
}
