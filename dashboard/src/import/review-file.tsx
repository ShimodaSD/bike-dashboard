// Review a ride you already did: pick a .fit / .tcx / .gpx / .csv file and get the same Ride review
// as the finished screen, with its numbers and time in zone. The file is read in the browser
// (import/ridefile.ts); nothing is uploaded or saved, and the live ride is not touched.
import { useState, type ChangeEvent } from 'react';
import { RideReview } from '../review/review-panel';
import { TimeInZone } from '../review/zones';
import { bestPower, fmtT, stats } from '../util/ride';
import { readRideFile, type RideFile } from './ridefile';

export const RIDE_FILE_TYPES = '.fit,.tcx,.gpx,.csv';

type Loaded = { state: 'idle' } | { state: 'reading'; name: string } | { state: 'error'; msg: string } | { state: 'done'; ride: RideFile };

const r0 = (v: number | null | undefined) => (v == null ? '–' : Math.round(v));
const fmtWhen = (d: Date | null) => d ? d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }) : '';

export function ReviewFile({ ftp }: { ftp: number }) {
  const [loaded, setLoaded] = useState<Loaded>({ state: 'idle' });
  const onFile = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';                                   // the same file again re-reads it
    if (!file) return;
    setLoaded({ state: 'reading', name: file.name });
    readRideFile(file).then(
      ride => setLoaded(ride.hist.length ? { state: 'done', ride } : { state: 'error', msg: 'No ride data found in this file.' }),
      (err: unknown) => setLoaded({ state: 'error', msg: err instanceof Error ? err.message : 'This file could not be read.' }));
  };
  const ride = loaded.state === 'done' ? loaded.ride : null;
  return (
    <section className="review-file">
      <p className="help">Pick a ride you already did: a <b>.fit</b> from this logger, Garmin, Wahoo or Zwift
        (Strava: <i>Export original</i>), a <b>.tcx</b> or <b>.gpx</b>, or a ride CSV from this logger.
        It is read on this computer only. Nothing is uploaded or saved, and the ride on the dashboard isn't changed.</p>
      <div className="inline">
        <label className={'btn' + (ride ? '' : ' primary')}>
          <input type="file" accept={RIDE_FILE_TYPES} onChange={onFile} className="sr-only" />
          {ride ? 'Choose another file' : 'Choose a ride file'}</label>
        {loaded.state === 'reading' && <span className="note" role="status">Reading {loaded.name}…</span>}
      </div>
      {loaded.state === 'error' && <p className="note err" role="alert">{loaded.msg}</p>}
      {ride && <FileResult ride={ride} ftp={ftp} />}
    </section>
  );
}

function FileResult({ ride, ftp }: { ride: RideFile; ftp: number }) {
  const { hist } = ride;
  const st = stats(hist, ftp, null);
  const b20 = bestPower(hist, 1200);
  return <>
    <div className="rf-head">
      <b>{ride.name}</b>
      <span>{fmtWhen(ride.start)} · {fmtT(hist.length)} · {(st.dist / 1000).toFixed(1)} km</span>
    </div>
    {!ride.hasPower ? <p className="note err" role="alert">This file has no power data, so there is nothing to evaluate:
      the review works from power and your FTP.{ride.hasHr && st.avgHr ? ` Average heart rate ${Math.round(st.avgHr)} bpm, max ${st.maxHr}.` : ''}</p>
    : <>
      <dl className="rf-nums">
        <div><dt>Avg power</dt><dd>{r0(st.avgP)}<small> W</small></dd></div>
        <div><dt>Normalized</dt><dd>{r0(st.np)}<small> W</small></dd></div>
        <div><dt>{b20 ? 'Best 20 min' : 'Max power'}</dt><dd>{r0(b20 ?? st.maxP)}<small> W</small></dd></div>
        <div><dt>Avg heart rate</dt><dd>{r0(st.avgHr)}{st.avgHr ? <small> bpm</small> : null}</dd></div>
        <div><dt>Avg cadence</dt><dd>{r0(st.avgCad)}{st.avgCad ? <small> rpm</small> : null}</dd></div>
        <div><dt>Energy</dt><dd>{Math.round(st.kj)}<small> kJ</small></dd></div>
      </dl>
      <RideReview hist={hist} st={st} ftp={ftp} workout={null} woStart={0} ftpTest={false} />
      <TimeInZone st={st} ftp={ftp} />
    </>}
  </>;
}
