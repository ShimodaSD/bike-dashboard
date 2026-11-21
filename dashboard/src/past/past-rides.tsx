// Past rides page (#rides): load your last 10 bike rides from Garmin Connect, pick one, and get the
// Ride review (and Ask Claude) for it. The logger fetches the list and the ride's .fit through the
// Garmin Personal API (logger/garmin_rides.py); the .fit is read here like a chosen file. Or pick a
// file from this computer. Requests run from the click handlers; nothing is saved.
import { useRef, useState } from 'react';
import type { CoachStatus, GarminRide } from '../types/coach';
import { FileResult, ReviewFile, type Rider } from '../import/review-file';
import { parseFit, toRide, type RideFile } from '../import/ridefile';

export interface ListedRide extends GarminRide { id: number; distance_km: number | null; avg_hr: number | null }
type List = { state: 'idle' } | { state: 'loading' } | { state: 'error'; msg: string } | { state: 'done'; rides: ListedRide[] };
type Picked = { id: number; state: 'loading' } | { id: number; state: 'error'; msg: string } | { id: number; state: 'done'; ride: RideFile };

async function errorOf(res: Response) {
  const data = await res.json().catch(() => null) as { error?: string } | null;
  return data?.error || `The logger answered ${res.status}.`;
}

const fmtDay = (local: string | null) => {
  if (!local) return '';
  const d = new Date(local.replace(' ', 'T'));
  return Number.isNaN(+d) ? local : d.toLocaleString(undefined, { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
};

export function PastRides({ rider, coach }: { rider: Rider; coach?: CoachStatus }) {
  const [list, setList] = useState<List>({ state: 'idle' });
  const [picked, setPicked] = useState<Picked | null>(null);
  const resultRef = useRef<HTMLDivElement>(null);

  const load = (refresh: boolean) => {
    setList({ state: 'loading' });
    fetch(`/garmin/rides${refresh ? '?refresh=1' : ''}`)
      .then(async res => (res.ok ? setList({ state: 'done', rides: ((await res.json()) as { rides: ListedRide[] }).rides })
                                 : setList({ state: 'error', msg: await errorOf(res) })))
      .catch(() => setList({ state: 'error', msg: 'The dashboard lost contact with the logger.' }));
  };

  const pick = (r: ListedRide) => {
    setPicked({ id: r.id, state: 'loading' });
    const settle = (p: Picked) => setPicked(cur => (cur && cur.id === r.id ? p : cur));   // a later pick wins
    fetch(`/garmin/activity.fit?id=${r.id}`)
      .then(async res => {
        if (!res.ok) return settle({ id: r.id, state: 'error', msg: await errorOf(res) });
        const ride = toRide(r.name || `Garmin ${r.id}`, parseFit(await res.arrayBuffer()));
        settle({ id: r.id, state: 'done', ride });
        requestAnimationFrame(() => resultRef.current?.scrollIntoView?.({ block: 'start', behavior: 'smooth' }));
      })
      .catch((e: unknown) => settle({ id: r.id, state: 'error', msg: e instanceof Error ? e.message : 'The ride could not be read.' }));
  };

  return (
    <section className="past" aria-labelledby="past-h">
      <div className="past-head">
        <h2 id="past-h">Past rides</h2>
        <a className="btn quiet" href="#">Back to the live dashboard</a>
      </div>
      <div className="past-grid">
        <div className="panel past-list">
          <div className="pl-head">
            <h3>From Garmin Connect</h3>
            {coach?.garmin && list.state === 'done' && <button className="quiet" onClick={() => load(true)}>Refresh</button>}
          </div>
          {!coach ? <p className="help">Waiting for the logger…</p>
            : !coach.garmin ? <p className="help">Add <code>GARMIN_API_KEY</code> to the <code>.env</code> file and restart the logger to list
                your Garmin rides. Make the key at connect.garmin.com › Settings › Personal API key.</p>
            : list.state === 'idle' || list.state === 'loading'
              ? <button className="primary" onClick={() => load(false)} disabled={list.state === 'loading'}>
                  {list.state === 'loading' ? 'Loading your rides…' : 'Load my last 10 rides'}</button>
            : list.state === 'error'
              ? <><p className="note err" role="alert">{list.msg}</p><button onClick={() => load(true)}>Try again</button></>
            : !list.rides.length ? <p className="help">No bike rides on Garmin Connect in the last year.</p>
            : <ul className="pl-rides">
                {list.rides.map(r => {
                  const on = picked?.id === r.id;
                  return <li key={r.id}>
                    <button className={on ? 'on' : ''} aria-pressed={on} onClick={() => pick(r)}>
                      <span className="pl-name">{r.name || 'Ride'}<small>{fmtDay(r.date)}</small></span>
                      <span className="pl-nums">
                        {r.duration_min != null && <span>{r.duration_min} min</span>}
                        {r.distance_km ? <span>{r.distance_km} km</span> : null}
                        {r.np_w ? <span>NP {r.np_w} W</span> : null}
                        {r.tss ? <span>TSS {r.tss}</span> : null}
                      </span>
                    </button>
                  </li>;
                })}
              </ul>}
          <details className="pl-file">
            <summary>Or review a ride file from this computer</summary>
            <ReviewFile rider={rider} coach={coach} />
          </details>
        </div>
        <div className="past-result" ref={resultRef}>
          {!picked ? <p className="past-empty">Pick a ride to see its review.</p>
            : picked.state === 'loading' ? <p className="past-empty" role="status">Downloading the ride from Garmin…</p>
            : picked.state === 'error' ? <p className="note err" role="alert">{picked.msg}</p>
            : <div className="review-file"><FileResult ride={picked.ride} rider={rider} coach={coach} /></div>}
        </div>
      </div>
    </section>
  );
}
