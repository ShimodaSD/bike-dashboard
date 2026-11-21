// Time in each power zone: the side panel on the dashboard and in a reviewed ride file.
import { memo } from 'react';
import { ZONES, fmtT, type RideStats } from '../util/ride';

export const TimeInZone = memo(function TimeInZone({ st, ftp }: { st: RideStats; ftp: number }) {
  const tot = st.tiz.reduce((a, b) => a + b, 0) || 1, mx = Math.max(...st.tiz, 1);
  return (
    <div className="panel">
      <h2>Time in power zone</h2>
      <div className="tiz">
        {ZONES.map((z, i) => {
          const lo = Math.round(z.lo * ftp), hi = z.hi === Infinity ? null : Math.round(z.hi * ftp) - 1;
          return (
            <div className="r" key={z.n}>
              <span className="name">{z.n} {z.name}<small>{lo}{hi !== null ? '–' + hi : '+'} W</small></span>
              <span className="bar"><i style={{ width: `${(st.tiz[i] / mx) * 100}%`, background: `var(--z${i + 1})` }} /></span>
              <span className="v">{fmtT(st.tiz[i])} <span className="pct">{Math.round((st.tiz[i] / tot) * 100)}%</span></span>
            </div>
          );
        })}
      </div>
    </div>
  );
});
