// Ask Claude: an optional coach's evaluation under the Ride review. Nothing is sent until the
// rider presses the button; then the ride summary (review/summary.ts) goes to the logger, which
// adds recent Garmin rides and asks Claude (logger/coach.py). The request runs from the click
// handler; the parent keys this component by ride, so a new ride starts fresh.
import { useState } from 'react';
import type { CoachResult, CoachStatus, CoachVerdict } from '../types/coach';
import type { RideSummary } from './summary';

type Ask = { state: 'idle' } | { state: 'asking' } | { state: 'error'; msg: string } | { state: 'done'; res: CoachResult };

const VERDICT: Record<CoachVerdict, string> = { great: 'Great ride', good: 'Good ride', mixed: 'Mixed ride', tough: 'Tough ride' };

async function askCoach(summary: RideSummary): Promise<CoachResult> {
  let res: Response;
  try {
    res = await fetch('/coach', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(summary) });
  } catch {
    throw new Error('The dashboard lost contact with the logger.');
  }
  const data = await res.json().catch(() => null) as (CoachResult & { error?: string }) | null;
  if (!res.ok || !data || data.error || !data.review) throw new Error(data?.error || `The logger answered ${res.status}.`);
  return data;
}

export function AskClaude({ coach, summary }: { coach: CoachStatus; summary: () => RideSummary }) {
  const [ask, setAsk] = useState<Ask>({ state: 'idle' });
  const go = () => {
    setAsk({ state: 'asking' });
    askCoach(summary()).then(res => setAsk({ state: 'done', res }), (e: unknown) =>
      setAsk({ state: 'error', msg: e instanceof Error ? e.message : 'Something went wrong.' }));
  };

  if (!coach.claude)
    return <p className="ac-setup">Want a coach's take? Add <code>ANTHROPIC_API_KEY</code> to the <code>.env</code> file
      and restart the logger to ask Claude about your rides.</p>;

  if (ask.state === 'done') return <CoachCard res={ask.res} garmin={coach.garmin} />;

  const what = coach.garmin ? 'this ride\'s summary and your recent Garmin activities, sleep and HRV' : 'this ride\'s summary';
  return (
    <div className="ac-ask">
      <button className="primary" onClick={go} disabled={ask.state === 'asking'} aria-busy={ask.state === 'asking'}>
        {ask.state === 'asking' ? 'Asking Claude…' : ask.state === 'error' ? 'Try again' : 'Ask Claude for a coach\'s review'}</button>
      <span className="ac-what">{ask.state === 'asking' ? 'Usually under a minute.' : `Sends ${what} to Anthropic. Nothing else leaves this computer.`}</span>
      {ask.state === 'error' && <p className="note err" role="alert">{ask.msg}</p>}
    </div>
  );
}

function CoachCard({ res, garmin }: { res: CoachResult; garmin: boolean }) {
  const { review: c } = res;
  const rides = res.recent.length;
  return (
    <div className="coach" role="region" aria-label="Claude's review" aria-live="polite">
      <div className="co-head">
        <span className={'co-verdict ' + c.verdict}>{VERDICT[c.verdict] ?? c.verdict}</span>
        <p className="co-headline">{c.headline}</p>
      </div>
      <div className="co-grid">
        {c.went_well.length > 0 && <div><h3>Went well</h3><ul>{c.went_well.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        {c.to_improve.length > 0 && <div><h3>To work on</h3><ul>{c.to_improve.map((t, i) => <li key={i}>{t}</li>)}</ul></div>}
        <div><h3>Training load</h3><p>{c.load}</p></div>
        <div className="co-next"><h3>Next session</h3><p>{c.next_session}</p></div>
      </div>
      <p className="rv-foot">Written by Claude from this ride{rides ? ` and your last ${rides} Garmin ${rides === 1 ? 'activity' : 'activities'}` : ''}.
        {!rides && garmin && res.garmin_note ? ` Garmin: ${res.garmin_note}` : ''} It can be wrong: check it against how you felt.</p>
    </div>
  );
}
