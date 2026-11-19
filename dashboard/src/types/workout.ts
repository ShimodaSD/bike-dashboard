// Structured workouts (workout/workout.tsx), as parsed from a .zwo, .erg or .mrc file.

// One step. lo / hi: power target at its start / end, as a fraction of FTP ('ftp') or in watts ('w');
// null for free ride. .erg / .mrc files only have power, so the other targets are left out.
export interface Segment {
  dur: number;                       // s
  lo: number | null;
  hi: number | null;
  unit: 'ftp' | 'w';
  cad: number | null;                // rpm
  hr?: number | null;                // bpm
  spd?: number | null;               // km/h
  grade?: number | null;             // %
  note?: string;                     // shown instead of "No target" (FTP test: "All out")
  name: string;
}

export interface Workout {
  name: string;
  segs: Segment[];
  total: number;                     // s
}

// Where the ride is in the workout.
export interface WorkoutAt {
  i: number;                         // step index
  s: Segment;
  into: number;                      // s into the step
  left: number;                      // s left in the step
  target: number | null;             // power target now, W
  next: Segment | undefined;
}

// A planned stretch on a chart: target a at t0, b at t1 (W, rpm, bpm or km/h).
export interface PlanPoint {
  t0: number;
  t1: number;
  a: number;
  b: number;
}

export type OffKind = 'low' | 'high' | 'cad-low' | 'cad-high' | 'hr-low' | 'hr-high' | 'spd-low' | 'spd-high';
