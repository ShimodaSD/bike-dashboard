// The ride timeline's time window: what part of the ride and the workout the charts show.
import { describe, expect, it } from 'vitest';
import { xRange } from '../../src/charts/charts';

describe('chart window', () => {
  it('no workout: the whole ride, then the last window', () => {
    expect(xRange(30, 1200)).toEqual([0, 59]);
    expect(xRange(2000, 1200)).toEqual([800, 1999]);
    expect(xRange(500, 0)).toEqual([0, 499]);
  });

  it('a workout early in the ride: the ride so far plus the next 5 min, not an empty 20 min', () => {
    expect(xRange(120, 1200, 1080)).toEqual([0, 419]);
    expect(xRange(10, 1200, 1080)).toEqual([0, 309]);
    expect(xRange(30, 1200, 60)).toEqual([0, 89]);                  // never far past the end of a short plan
  });

  it('later on: the window slides, with the next minutes in view', () => {
    expect(xRange(1000, 1200, 3600)).toEqual([100, 1299]);
    expect(xRange(200, 300, 3600)).toEqual([0, 299]);
    expect(xRange(400, 300, 3600)).toEqual([200, 499]);
  });

  it('whole ride with a workout: the whole plan', () => {
    expect(xRange(100, 0, 1800)).toEqual([0, 1800]);
  });
});
