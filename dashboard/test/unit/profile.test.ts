// W/kg and levels on Coggan's power profile (Allen & Coggan, Training and Racing with a Power Meter).
import { describe, expect, it } from 'vitest';
import { levelOf, peaksOf, shortLevel, wkgOf } from '../../src/util/profile';

describe('levelOf', () => {
  it("men's FT bands: each band's last row is its lower bound", () => {
    expect(levelOf('ft', 6.4, 'm')).toBe('World class');
    expect(levelOf('ft', 5.60, 'm')).toBe('World class');
    expect(levelOf('ft', 5.59, 'm')).toBe('Exceptional');
    expect(levelOf('ft', 4.0, 'm')).toBe('Very good (Cat 2)');
    expect(levelOf('ft', 3.5, 'm')).toBe('Good (Cat 3)');
    expect(levelOf('ft', 2.31, 'm')).toBe('Fair (Cat 5)');
    expect(levelOf('ft', 2.3, 'm')).toBe('Untrained');
    expect(levelOf('ft', 0.5, 'm')).toBe('Untrained');
  });

  it("women's table is its own", () => {
    expect(levelOf('ft', 3.5, 'f')).toBe('Very good (Cat 2)');
    expect(levelOf('5s', 13.6, 'f')).toBe('Very good (Cat 2)');
    expect(levelOf('5s', 13.6, 'm')).toBe('Moderate (Cat 4)');
  });

  it('each duration has its own scale', () => {
    expect(levelOf('5s', 20, 'm')).toBe('Excellent (Cat 1)');
    expect(levelOf('1min', 8.5, 'm')).toBe('Very good (Cat 2)');
    expect(levelOf('5min', 4.2, 'm')).toBe('Good (Cat 3)');
  });
});

describe('peaksOf', () => {
  const best = (sec: number) => (sec <= 300 ? 400 : sec === 1200 ? 280 : null);
  it('W/kg and level per peak; the 20 min rated as FTP from 95% of it', () => {
    const p = peaksOf(best, 70, 'm');
    expect(p.map(x => x.label)).toEqual(['5 s', '1 min', '5 min', '20 min']);
    expect(p[2].wkg).toBeCloseTo(400 / 70, 5);
    expect(p[2].level).toBe('Excellent (Cat 1)');          // 5.71 W/kg for 5 min (≥ 5.43)
    expect(p[3].level).toBe('Good (Cat 3)');               // 280 × 0.95 / 70 = 3.80 (≥ 3.38, < 4.00)
  });
  it('no weight: watts only, no level', () => {
    expect(peaksOf(best, null, 'm')[0]).toMatchObject({ w: 400, wkg: null, level: null });
  });
});

it('helpers', () => {
  expect(wkgOf(250, null)).toBeNull();
  expect(wkgOf(null, 70)).toBeNull();
  expect(shortLevel('Good (Cat 3)')).toBe('Cat 3');
  expect(shortLevel('World class')).toBe('World class');
});
