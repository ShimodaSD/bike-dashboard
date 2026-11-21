// Climb feel, in the Trainer control band on Live: how hard a simulated climb is on the trainer.
//   Trainer difficulty  % of the road grade the trainer is sent (like Zwift's setting)
//   Rolling resistance  crr sent with every grade (tyres and surface)
//   Wind resistance     kg/m sent with every grade (air drag at speed)
// The logger keeps them (config/trainer.json), so they apply on every device and at once,
// also mid-climb. POST /control/sim?difficulty=&crr=&cw=
import { useRef, useState } from 'react';
import type { SimSettings } from '../types/feed';

export const SIM_DEFAULTS: SimSettings = { difficulty: 100, crr: 0.004, cw: 0.51 };
const DIFF_MIN = 0, DIFF_MAX = 150, DIFF_STEP = 5;
const DIFF_QUICK = [25, 50, 75, 100];
const CW_MIN = 0.1, CW_MAX = 1.5;
const CRR_PRESETS: [number, string][] = [
  [0.0025, 'Smooth track'], [0.004, 'Road'], [0.006, 'Rough road'], [0.008, 'Gravel'], [0.012, 'Trail'],
];
const DRAFT_MS = 1500;

const sendSim = (s: Partial<SimSettings>) =>
  fetch('/control/sim?' + new URLSearchParams(Object.entries(s).map(([k, v]) => [k, String(v)])), { method: 'POST' })
    .catch(() => {});
const sendDifficulty = (d: number) => sendSim({ difficulty: d });

const fmtPct = (g: number) => `${g < 0 ? '−' : ''}${Math.abs(g).toFixed(1).replace(/\.0$/, '')}`;

// The difficulty picked here shows at once (the draft) until the logger reports it back.
// − / + step 5 %; quick picks for the usual settings.
function Difficulty({ value }: { value: number }) {
  const [draft, setDraft] = useState<number | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  if (draft !== null && draft === value) setDraft(null);           // confirmed (adjusted while rendering)
  const v = draft ?? value;
  const pick = (n: number) => {
    const c = Math.min(DIFF_MAX, Math.max(DIFF_MIN, n));
    setDraft(c);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setDraft(null), DRAFT_MS);
    sendDifficulty(c);
  };
  return (
    <div className="feel-diff">
      <span className="feel-label" id="difficulty-label">Trainer difficulty</span>
      <div className="feel-step" role="group" aria-labelledby="difficulty-label">
        <button className="nudge" onClick={() => pick(v - DIFF_STEP)} disabled={v <= DIFF_MIN}
                aria-label="Trainer difficulty down">−</button>
        <output className="feel-val" aria-live="polite" aria-label="Trainer difficulty">{v} %</output>
        <button className="nudge" onClick={() => pick(v + DIFF_STEP)} disabled={v >= DIFF_MAX}
                aria-label="Trainer difficulty up">+</button>
      </div>
      <div className="feel-quicks" role="group" aria-label="Quick difficulty">
        {DIFF_QUICK.map(q => <button key={q} className={'feel-quick' + (q === v ? ' on' : '')} aria-pressed={q === v}
                                     onClick={() => pick(q)}>{q} %</button>)}
      </div>
      <p className="feel-help">
        {v === 100 ? 'The trainer gets the real grade.' : <>A 10 % climb feels like <b>{fmtPct(v / 10)} %</b>.</>}
        {' '}Lower makes climbs easier, like Zwift’s trainer difficulty.</p>
    </div>
  );
}

// Typed as text, committed on blur / Enter. Keyed by the saved value: a new value starts a fresh draft.
function WindField({ cw }: { cw: number }) {
  const [draft, setDraft] = useState(String(cw));
  const [err, setErr] = useState(false);
  const commit = () => {
    const t = draft.trim().replace(',', '.'), v = Math.round(+t * 100) / 100;
    if (t !== '' && v >= CW_MIN && v <= CW_MAX) { setErr(false); setDraft(String(v)); if (v !== cw) sendSim({ cw: v }); }
    else { setErr(true); setDraft(String(cw)); }
  };
  return (
    <div className="field">
      <label htmlFor="cw">Wind resistance</label>
      <div className="inline">
        <input id="cw" type="text" inputMode="decimal" value={draft} aria-invalid={err} aria-describedby="cw-help"
               onChange={e => { setDraft(e.target.value); setErr(false); }} onBlur={commit}
               onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} /> kg/m
      </div>
      <p id="cw-help" className={'help' + (err ? ' err' : '')}>
        {err ? `Wind resistance must be between ${CW_MIN} and ${CW_MAX} kg/m. Kept ${cw}.`
          : <>Air drag the trainer adds as your speed rises. <b>0.51</b> is what Zwift and most apps send.
              Lower makes fast, flat riding easier; it hardly changes a slow climb.</>}</p>
    </div>
  );
}

export function ClimbFeel({ sim }: { sim: SimSettings }) {
  const preset = CRR_PRESETS.some(([v]) => v === sim.crr);
  const isDefault = sim.difficulty === SIM_DEFAULTS.difficulty && sim.crr === SIM_DEFAULTS.crr && sim.cw === SIM_DEFAULTS.cw;
  return (
    <div className="feel" role="group" aria-label="Climb feel">
      <Difficulty value={sim.difficulty} />
      <details className="feel-more" open={sim.crr !== SIM_DEFAULTS.crr || sim.cw !== SIM_DEFAULTS.cw || undefined}>
        <summary>Rolling and wind resistance</summary>
        <div className="feel-adv">
          <div className="field">
            <label htmlFor="crr">Rolling resistance</label>
            <div className="inline">
              <select id="crr" value={sim.crr} aria-describedby="crr-help" onChange={e => sendSim({ crr: +e.target.value })}>
                {CRR_PRESETS.map(([v, name]) => <option key={v} value={v}>{name} ({v})</option>)}
                {!preset && <option value={sim.crr}>Custom ({sim.crr})</option>}
              </select>
            </div>
            <p id="crr-help" className="help">Tyres and surface. Road (0.004) is the usual value.</p>
          </div>
          <WindField key={sim.cw} cw={sim.cw} />
        </div>
        <p className="help">Sent to the trainer with every grade. Some trainers ignore these two and only use the grade.
          The logger remembers all three for your phone and computer.</p>
        <div className="inline">
          <button onClick={() => sendSim(SIM_DEFAULTS)} disabled={isDefault}>Reset climb feel</button>
        </div>
      </details>
    </div>
  );
}
