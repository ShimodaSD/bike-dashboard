// Time in each power zone and in each heart-rate zone: side panels on the dashboard and in a reviewed ride file.
import { memo } from 'react';
import { ZONES, fmtT, type RideStats } from '../util/ride';
import { hrRange, hrZoneColor, type HrZone } from '../hr/zones';

interface Row { key: string; name: string; range: string; color: string; s: number }

function ZoneBars({ title, rows }: { title: string; rows: Row[] }) {
  const tot = rows.reduce((a, r) => a + r.s, 0) || 1, mx = Math.max(...rows.map(r => r.s), 1);
  return (
    <div className="panel">
      <h2>{title}</h2>
      <div className="tiz">
        {rows.map(r => (
          <div className="r" key={r.key}>
            <span className="name">{r.name}<small>{r.range}</small></span>
            <span className="bar"><i style={{ width: `${(r.s / mx) * 100}%`, background: r.color }} /></span>
            <span className="v">{fmtT(r.s)} <span className="pct">{Math.round((r.s / tot) * 100)}%</span></span>
          </div>
        ))}
      </div>
    </div>
  );
}

export const TimeInZone = memo(function TimeInZone({ st, ftp }: { st: RideStats; ftp: number }) {
  return <ZoneBars title="Time in power zone" rows={ZONES.map((z, i) => {
    const lo = Math.round(z.lo * ftp), hi = z.hi === Infinity ? null : Math.round(z.hi * ftp) - 1;
    return { key: z.n, name: `${z.n} ${z.name}`, range: `${lo}${hi !== null ? '–' + hi : '+'} W`, color: `var(--z${i + 1})`, s: st.tiz[i] };
  })} />;
});

// tiz: seconds per zone from timeInHrZones (hr/zones.ts). Hidden by the caller when the ride has no heart rate.
export const TimeInHrZone = memo(function TimeInHrZone({ zones, tiz }: { zones: HrZone[]; tiz: number[] }) {
  return <ZoneBars title="Time in heart-rate zone" rows={zones.map((z, i) => (
    { key: z.n, name: `${z.n} ${z.name}`, range: `${hrRange(z)} bpm`, color: hrZoneColor(i, zones), s: tiz[i] ?? 0 }))} />;
});
