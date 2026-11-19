// FTP test: a guided 20-minute test run by the logger (logger/ftp_test.py).
//   POST /ftp-test/start?ftp=   start a ride with the test (ftp = the FTP the targets use now)
//   POST /ftp-test/cancel       stop the test, keep riding
//   POST /ftp-test/delete?id=   remove a saved result
// status.ftp = { test, results, protocol, factor }. The logger works out the result when the
// 20 minutes end and saves it in config/ftp_tests.json, so every browser sees the history.
// FTP itself stays a setting of this browser: a result changes it only when you press Use.
import { useState } from 'react';
import { useArmed } from '../hooks/hooks';
import { fmtT } from '../util/ride';
import type { FtpResult, FtpStatus, FtpStep, FtpTestRun, RideState, Sample } from '../types/feed';
import type { Workout } from '../types/workout';

const post = (path: string) => fetch(path, { method: 'POST' }).catch(() => {});
const PRESS = typeof window !== 'undefined' && window.matchMedia('(hover: none)').matches ? 'Tap' : 'Click';

export const startFtpTest = (ftp: number) => post(`/ftp-test/start?ftp=${Math.round(ftp)}`);
export const cancelFtpTest = () => post('/ftp-test/cancel');
export const deleteFtpResult = (id: string) => post(`/ftp-test/delete?id=${encodeURIComponent(id)}`);

// The protocol as a workout, so the workout band, its beeps and the chart targets follow it.
export function protocolWorkout(steps: FtpStep[]): Workout {
  return {
    name: 'FTP test',
    segs: steps.map(s => ({ dur: s.dur, lo: s.lo, hi: s.hi, unit: 'ftp' as const, cad: null, name: s.name,
                            ...(s.lo == null ? { note: 'All out' } : {}) })),
    total: steps.reduce((t, s) => t + s.dur, 0),
  };
}

// Start / end of the 20 minutes, in seconds from the start of the test.
export function testWindow(steps: FtpStep[]): { start: number; end: number } {
  let t = 0;
  for (const s of steps) {
    if (s.test) return { start: t, end: t + s.dur };
    t += s.dur;
  }
  return { start: t, end: t };
}

export const totalMinutes = (steps: FtpStep[]) => Math.round(steps.reduce((t, s) => t + s.dur, 0) / 60);

// Where the ride is in the test: before the 20 minutes (seconds to go), in them (average so
// far and the FTP it gives) or past them.
export type TestProgress =
  | { phase: 'before'; until: number }
  | { phase: 'test'; into: number; left: number; avg: number | null; ftp: number | null }
  | { phase: 'after' };
export function testProgress(hist: Sample[], run: FtpTestRun, steps: FtpStep[], factor: number): TestProgress {
  const { start, end } = testWindow(steps);
  const t = hist.length - run.t0;
  if (t < start) return { phase: 'before', until: start - t };
  if (t >= end || run.state === 'done') return { phase: 'after' };
  const a = hist.slice(run.t0 + start, run.t0 + t);
  const avg = a.length ? a.reduce((s, x) => s + (x.power_w || 0), 0) / a.length : null;
  return { phase: 'test', into: t - start, left: end - t, avg, ftp: avg ? Math.round(avg * factor) : null };
}

export const fmtDate = (iso: string) => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
};
const signed = (n: number) => `${n > 0 ? '+' : n < 0 ? '−' : '±'}${Math.abs(n)}`;

// ------------------------------------------------------------------ band above the workout while a test is on
interface FtpTestBandProps {
  ftpStatus: FtpStatus; hist: Sample[]; mode: RideState; ftp: number; setFtp: (v: number) => void;
}
export function FtpTestBand({ ftpStatus, hist, mode, ftp, setFtp }: FtpTestBandProps) {
  const run = ftpStatus.test!;
  const [stopArmed, pressStop] = useArmed(run.state);
  // "Keep" hides the new-FTP question for this result (a new result asks again)
  const [kept, setKept] = useState<string | null>(null);
  const res = run.result;

  if (run.state === 'stopped')
    return <section className="ftptest stopped" aria-label="FTP test">
      <span className="badge">FTP test</span>
      <span>Stopped before the 20 minutes ended, so no FTP was saved. <b>Resume ride</b> to carry on.</span>
    </section>;

  if (run.state === 'done')
    return <section className="ftptest done" aria-label="FTP test" aria-live="polite">
      <span className="badge done">FTP test</span>
      {!res ? <span>No power in the 20 minutes, so no FTP was saved.</span>
        : <>
          <span className="ft-result">
            <span className="ft-label">{ftp === res.ftp ? 'Your FTP' : 'New FTP'}</span>
            <b className="ft-big">{res.ftp}<small> W</small></b>
            <span className="ft-sub">95 % of {Math.round(res.avg_w)} W for 20 min
              {res.ftp_before ? <> · {signed(res.ftp - res.ftp_before)} W from {res.ftp_before} W</> : null}</span>
          </span>
          {ftp === res.ftp
            ? <span className="ft-note">Saved. Power zones and targets use {res.ftp} W now.</span>
            : kept === res.id
              ? <span className="ft-note">Saved in the test history. FTP kept at {ftp} W.</span>
              : <span className="ft-actions">
                  <button className="primary" onClick={() => setFtp(res.ftp)}>Use {res.ftp} W</button>
                  <button onClick={() => setKept(res.id)}>Keep {ftp} W</button>
                </span>}
        </>}
      {mode === 'recording' && <span className="ft-hint">Cool down easy, then Finish.</span>}
    </section>;

  const p = testProgress(hist, run, ftpStatus.protocol, ftpStatus.factor);
  return <section className={'ftptest ' + p.phase} aria-label="FTP test">
    <span className="badge">FTP test</span>
    {p.phase === 'before' && <span className="ft-msg">
      The 20 minutes start in <b>{fmtT(p.until)}</b>. Follow the steps below; the 5 min hard effort is as hard as you can hold.</span>}
    {p.phase === 'test' && <>
      <span className="ft-stat"><span className="ft-label">20 min avg</span><b>{p.avg == null ? '–' : Math.round(p.avg)}<small> W</small></b></span>
      <span className="ft-stat"><span className="ft-label">FTP so far</span><b>{p.ftp ?? '–'}<small> W</small></b></span>
      <span className="ft-stat"><span className="ft-label">Left</span><b>{fmtT(p.left)}</b></span>
      <span className="ft-msg">Even pace, as hard as you can hold for the whole 20 minutes.</span>
    </>}
    {p.phase === 'after' && <span className="ft-msg">Working out your FTP…</span>}
    <button className={'quiet ft-stop' + (stopArmed ? ' danger armed' : '')} onClick={() => pressStop(cancelFtpTest)}>
      {stopArmed ? `${PRESS} again to stop the test` : 'Stop test'}</button>
  </section>;
}

// ------------------------------------------------------------------ Settings: start a test, saved results
export interface FtpTestSettingsProps {
  ftpStatus: FtpStatus | undefined; ftp: number; setFtp: (v: number) => void;
  recording: boolean; startArmed: boolean; onStart: () => void;
}
const SHOW = 4;
export function FtpTestSettings({ ftpStatus, ftp, setFtp, recording, startArmed, onStart }: FtpTestSettingsProps) {
  const [all, setAll] = useState(false);
  const results = ftpStatus?.results || [];
  const shown = all ? results : results.slice(0, SHOW);
  const mins = ftpStatus ? totalMinutes(ftpStatus.protocol) : 55;
  return <>
    <div className="inline">
      <button className={startArmed ? 'danger armed' : 'primary'} onClick={onStart} disabled={recording || !ftpStatus}>
        {startArmed ? `${PRESS} again to start` : 'Start FTP test'}</button>
    </div>
    <p className="help">{recording ? 'Finish the ride first. The test is a ride of its own.'
      : startArmed ? 'Starting clears the finished ride from the screen. Its files stay in the ride folder.'
      : <>About {mins} min: warm-up, 5 min hard, easy, then <b>20 min as hard as you can hold</b>. FTP = 95 % of the 20 min average. Starts recording.</>}</p>
    {results.length > 0 && <ul className="ftp-history" aria-label="FTP test results">
      {shown.map(r => <FtpRow key={r.id} r={r} inUse={r.ftp === ftp} onUse={() => setFtp(r.ftp)} />)}
    </ul>}
    {results.length > SHOW && <button className="quiet" onClick={() => setAll(a => !a)} aria-expanded={all}>
      {all ? 'Show fewer' : `Show all ${results.length} tests`}</button>}
  </>;
}

function FtpRow({ r, inUse, onUse }: { r: FtpResult; inUse: boolean; onUse: () => void }) {
  const [armed, press] = useArmed();
  return <li>
    <span className="fh-when">{fmtDate(r.date)}</span>
    <span className="fh-ftp"><b>{r.ftp} W</b><small>20 min {Math.round(r.avg_w)} W{r.avg_hr ? ` · ${r.avg_hr} bpm` : ''}</small></span>
    <span className="fh-act">
      {inUse ? <span className="badge done">In use</span>
        : <button onClick={onUse} aria-label={`Use ${r.ftp} W as FTP`}>Use</button>}
      <button className={'quiet' + (armed ? ' danger armed' : '')} onClick={() => press(() => deleteFtpResult(r.id))}
              aria-label={armed ? undefined : `Delete the test from ${fmtDate(r.date)}`}>
        {armed ? `${PRESS} again` : 'Delete'}</button>
    </span>
  </li>;
}
