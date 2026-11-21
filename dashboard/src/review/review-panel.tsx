// Ride review panel on the finished screen: the ride type and load up top, then a few notes on
// what went well and what to watch (review.ts works them out). Derived while rendering.
import { memo, useId } from 'react';
import type { Sample } from '../types/feed';
import type { Workout } from '../types/workout';
import type { RideStats } from '../util/ride';
import type { CoachStatus } from '../types/coach';
import { reviewRide, type Tone } from './review';
import { AskClaude } from './ask-claude';
import { rideSummary } from './summary';

const MARK: Record<Tone, string> = { good: '✓', info: '•', warn: '!' };
const TONE_LABEL: Record<Tone, string> = { good: 'Good', info: 'Note', warn: 'Watch' };

interface RideReviewProps {
  hist: Sample[]; st: RideStats; ftp: number; workout: Workout | null; woStart: number; ftpTest: boolean;
  coach?: CoachStatus;                              // the logger's Ask Claude support (undefined: hidden)
  laps?: number[]; source?: 'live' | 'file'; name?: string;
}
export const RideReview = memo(function RideReview({ hist, st, ftp, workout, woStart, ftpTest, coach, laps, source = 'live', name }: RideReviewProps) {
  const r = reviewRide({ hist, st, ftp, workout, woStart, ftpTest });
  const hid = useId();
  return (
    <section className="review panel" aria-labelledby={hid}>
      <div className="rv-head">
        <div className="rv-title">
          <h2 id={hid}>Ride review</h2>
          <p className="rv-kind">{r.tooShort ? 'Short ride' : r.kind}
            {!r.tooShort && r.tss !== null && <span className="rv-load">{r.load}</span>}</p>
        </div>
        {!r.tooShort && <dl className="rv-nums">
          <div><dt>Intensity</dt><dd>{r.IF !== null ? r.IF.toFixed(2) : '–'}</dd></div>
          <div><dt>TSS</dt><dd>{r.tss !== null ? Math.round(r.tss) : '–'}</dd></div>
          {r.workout && <div><dt>On target</dt><dd>{Math.round(r.workout.onPct)}<small>%</small></dd></div>}
          {r.decoupling !== null && <div><dt>HR drift</dt><dd>{r.decoupling.toFixed(1)}<small>%</small></dd></div>}
          {!r.workout && r.VI !== null && <div><dt>Variability</dt><dd>{r.VI.toFixed(2)}</dd></div>}
        </dl>}
      </div>
      <ul className="rv-notes">
        {r.notes.map(n => (
          <li key={n.id} className={n.tone}>
            <span className="rv-mark" role="img" aria-label={TONE_LABEL[n.tone]}>{MARK[n.tone]}</span>
            <span><b>{n.title}</b> {n.text}</span>
          </li>
        ))}
      </ul>
      <p className="rv-foot">Worked out on this computer from your FTP of {ftp} W{workout && !ftpTest ? ` and the workout ${workout.name}` : ''}.</p>
      {coach && !r.tooShort && <AskClaude key={`${source}:${name ?? ''}:${hist[0]?.timestamp_utc}:${hist.length}`} coach={coach}
                                          summary={() => rideSummary({ hist, st, ftp, review: r, laps, source, name })} />}
    </section>
  );
});
