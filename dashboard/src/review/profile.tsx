// Power profile in the Ride review: the ride's best 5 s, 1 min, 5 min and 20 min in watts and
// W/kg, each rated on Coggan's power profile, plus average and normalized W/kg. Without a
// weight it shows the watts and says where to set one. Derived while rendering.
import type { Sample } from '../types/feed';
import { bestPower, type RideStats } from '../util/ride';
import { fmtWkg, peaksOf, shortLevel, wkgOf, type ProfileSex } from '../util/profile';

export type KgFrom = 'ride' | 'file' | 'settings';
const FROM: Record<KgFrom, string> = {
  ride: 'saved with this ride', file: 'from the ride file', settings: 'your weight in Settings',
};

interface PowerProfileProps { hist: Sample[]; st: RideStats; kg: number | null; kgFrom: KgFrom; sex: ProfileSex }
export function PowerProfile({ hist, st, kg, kgFrom, sex }: PowerProfileProps) {
  const peaks = peaksOf(sec => bestPower(hist, sec), kg, sex).filter(p => p.w);
  if (!peaks.length) return null;
  return (
    <div className="rv-profile">
      <h3>Power profile{kg ? <small> at {kg} kg, {FROM[kgFrom]}</small> : null}</h3>
      <dl className="pp-peaks">
        {peaks.map(p => (
          <div key={p.sec}>
            <dt>Best {p.label}</dt>
            <dd>{kg ? <>{fmtWkg(p.wkg)}<small> W/kg</small></> : <>{Math.round(p.w!)}<small> W</small></>}</dd>
            <dd className="pp-sub">{kg ? `${Math.round(p.w!)} W` : ''}{p.level ? <> · <span title={p.level}>{shortLevel(p.level)}</span></> : null}</dd>
          </div>
        ))}
        {kg && st.avgP ? <div>
          <dt>Normalized</dt>
          <dd>{fmtWkg(wkgOf(st.np, kg))}<small> W/kg</small></dd>
          <dd className="pp-sub">avg {fmtWkg(wkgOf(st.avgP, kg))} · {(st.kj / kg).toFixed(1)} kJ/kg</dd>
        </div> : null}
      </dl>
      <p className="rv-foot">{kg
        ? <>Levels from Coggan&apos;s power profile ({sex === 'f' ? "women's" : "men's"} table); the 20 min is rated as FTP from 95% of it.</>
        : 'Set your weight in Settings to see W/kg and your level on Coggan’s power profile.'}</p>
    </div>
  );
}
