// Heart-rate zones: max HR (Garmin's 5 zones) and LTHR (Friel's 7 cycling zones), hand-set edges.
import { describe, expect, it } from 'vitest';
import { HR_DEFAULT, hrRange, hrZoneOf, hrZones, timeInHrZones } from '../../src/hr/zones';
import type { Sample } from '../../src/types/feed';

describe('hrZones', () => {
  it('is null until the max HR / LTHR is set', () => {
    expect(hrZones(HR_DEFAULT)).toBeNull();
    expect(hrZones({ ...HR_DEFAULT, method: 'lthr', max: 190 })).toBeNull();
  });

  it('max HR: 60 / 70 / 80 / 90 %', () => {
    const z = hrZones({ ...HR_DEFAULT, max: 190 })!;
    expect(z.map(hrRange)).toEqual(['< 114', '114–132', '133–151', '152–170', '171+']);
  });

  it("LTHR: Friel's cycling zones", () => {
    const z = hrZones({ ...HR_DEFAULT, method: 'lthr', lthr: 170 })!;
    expect(z.map(x => x.n)).toEqual(['Z1', 'Z2', 'Z3', 'Z4', 'Z5a', 'Z5b', 'Z5c']);
    expect(z.map(hrRange)).toEqual(['< 138', '138–152', '153–159', '160–169', '170–174', '175–179', '180+']);
  });

  it('hand-set edges win, unless they no longer rise', () => {
    expect(hrZones({ ...HR_DEFAULT, max: 190, lows: [110, 130, 150, 170] })!.map(z => z.lo)).toEqual([0, 110, 130, 150, 170]);
    expect(hrZones({ ...HR_DEFAULT, max: 190, lows: [110, 100, 150, 170] })!.map(z => z.lo)).toEqual([0, 114, 133, 152, 171]);
    expect(hrZones({ ...HR_DEFAULT, max: 190, lows: [110, 130] })![1].lo).toBe(114);
  });
});

describe('hrZoneOf / timeInHrZones', () => {
  const z = hrZones({ ...HR_DEFAULT, max: 190 })!;
  it('puts a bpm in its zone, edges included', () => {
    expect([60, 113, 114, 151, 152, 171, 230].map(b => hrZoneOf(b, z))).toEqual([0, 0, 1, 2, 3, 4, 4]);
  });
  it('counts every second with a reading, coasting too', () => {
    const s = (hr: number | null, p = 0) => ({ heart_rate_bpm: hr, power_w: p } as Sample);
    expect(timeInHrZones([s(100), s(120, 150), s(null, 200), s(0), s(175)], z)).toEqual([1, 1, 0, 0, 1]);
  });
});
