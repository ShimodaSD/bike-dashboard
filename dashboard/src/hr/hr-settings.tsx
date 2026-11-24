// Settings → Heart rate zones: pick the method, set max HR or LTHR, then move any zone's edge by hand.
// Drafts live in each input until blur / Enter; a key on the input resets the draft when the saved
// value changes (no effect copies props into state).
import { useState, type CSSProperties } from 'react';
import { HR_MAX, HR_METHODS, HR_MIN, hrRange, hrZoneColor, hrZones, refOf, type HrMethod, type HrSettings } from './zones';

interface Props { hr: HrSettings; setHr: (v: HrSettings) => void }

export function HrZonesSettings({ hr, setHr }: Props) {
  const m = HR_METHODS[hr.method], ref = refOf(hr), zones = hrZones(hr);
  const setRef = (v: number | null) => setHr({ ...hr, [hr.method === 'max' ? 'max' : 'lthr']: v, lows: null });
  const setLow = (i: number, v: number) => {
    const lows = zones!.slice(1).map(z => z.lo);
    lows[i] = v;
    setHr({ ...hr, lows });
  };
  return (
    <section className="settings" aria-labelledby="set-hr">
      <h3 id="set-hr">Heart rate zones</h3>
      <div className="field">
        <label htmlFor="hr-method">Zones from</label>
        <div className="inline">
          <select id="hr-method" value={hr.method} onChange={e => setHr({ ...hr, method: e.target.value as HrMethod, lows: null })}>
            {(Object.keys(HR_METHODS) as HrMethod[]).map(k => <option key={k} value={k}>{HR_METHODS[k].label}</option>)}
          </select>
        </div>
        <p className="help">{hr.method === 'max'
          ? 'Percent of your highest heart rate, the same 5 zones as a Garmin watch.'
          : "Percent of the heart rate you can hold for about an hour: Joe Friel's cycling zones."}</p>
      </div>
      <RefField key={`${hr.method}:${ref ?? ''}`} label={m.refLong} value={ref} onSave={setRef} method={hr.method} />
      <div className="field wide">
        <span className="flabel">Zones</span>
        {zones ? <>
          <ol className="hrz" aria-label="Heart rate zones">
            {zones.map((z, i) => (
              <li key={z.n} style={{ '--zc': hrZoneColor(i, zones) } as CSSProperties}>
                <span className="hrz-n">{z.n}</span>
                <span className="hrz-name">{z.name}</span>
                {i === 0 ? <span className="hrz-from">from 0</span>
                  : <LowField key={`${i}:${z.lo}`} zone={z.n} value={z.lo} min={zones[i - 1].lo + 1}
                              max={i + 1 < zones.length ? zones[i + 1].lo - 1 : 250} onSave={v => setLow(i - 1, v)} />}
                <span className="hrz-range">{hrRange(z)} bpm</span>
              </li>
            ))}
          </ol>
          <div className="inline">
            {hr.lows && <button onClick={() => setHr({ ...hr, lows: null })}>Reset to calculated</button>}
          </div>
          <p className="help">{hr.lows ? `Edges set by hand. Changing the ${m.ref} or the method goes back to the calculated zones.`
            : `Calculated from your ${m.ref}. Change any zone's first bpm to fit your own test or lab zones.`}
            {' '}Used on the Heart rate tile and for time in heart-rate zone.</p>
        </> : <p className="help">Set your {m.refLong.toLowerCase()} to see the zones.</p>}
      </div>
    </section>
  );
}

function RefField({ label, value, onSave, method }: { label: string; value: number | null; onSave: (v: number | null) => void; method: HrMethod }) {
  const [draft, setDraft] = useState(value == null ? '' : String(value));
  const [err, setErr] = useState(false);
  const commit = () => {
    const t = draft.trim();
    if (!t) { onSave(null); return; }
    const v = Math.round(+t);
    if (v >= HR_MIN && v <= HR_MAX) { onSave(v); setErr(false); setDraft(String(v)); }
    else { setErr(true); setDraft(value == null ? '' : String(value)); }
  };
  return (
    <div className="field">
      <label htmlFor="hr-ref">{label}</label>
      <div className="inline">
        <input id="hr-ref" type="number" inputMode="numeric" min={HR_MIN} max={HR_MAX} step="1" value={draft} aria-invalid={err}
               onChange={e => { setDraft(e.target.value); setErr(false); }} onBlur={commit}
               onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} /> bpm
      </div>
      <p className={'help' + (err ? ' err' : '')}>
        {err ? `Must be between ${HR_MIN} and ${HR_MAX} bpm.`
          : method === 'max' ? 'The highest heart rate you have seen in a hard all-out effort.'
          : 'About your average heart rate over the last 20 min of a 30 min all-out effort.'}</p>
    </div>
  );
}

function LowField({ zone, value, min, max, onSave }: { zone: string; value: number; min: number; max: number; onSave: (v: number) => void }) {
  const [draft, setDraft] = useState(String(value));
  const [err, setErr] = useState(false);
  const commit = () => {
    const v = Math.round(+draft);
    if (v === value) { setDraft(String(value)); return; }
    if (draft.trim() && v >= min && v <= max) { onSave(v); setErr(false); }
    else { setErr(true); setDraft(String(value)); }
  };
  return (
    <span className="hrz-from">
      from <input type="number" inputMode="numeric" step="1" min={min} max={max} value={draft} aria-label={`${zone} starts at (bpm)`}
                  aria-invalid={err} title={err ? `Between ${min} and ${max} bpm` : undefined}
                  onChange={e => { setDraft(e.target.value); setErr(false); }} onBlur={commit}
                  onKeyDown={e => e.key === 'Enter' && e.currentTarget.blur()} />
      {err && <small className="err" role="alert">{min}–{max}</small>}
    </span>
  );
}
