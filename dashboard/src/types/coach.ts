// Optional Claude evaluation of a ride (logger/coach.py, POST /coach).

// status.coach: what the logger can do (ANTHROPIC_API_KEY / Garmin set up in .env)
export interface CoachStatus {
  claude: boolean;
  garmin: boolean;
  model: string;
}

export type CoachVerdict = 'great' | 'good' | 'mixed' | 'tough';

export interface CoachReview {
  headline: string;
  verdict: CoachVerdict;
  went_well: string[];
  to_improve: string[];
  load: string;
  next_session: string;
}

// One recent Garmin activity, as coach.py sends it back (the ones Claude saw).
export interface GarminRide {
  date: string | null;
  name: string | null;
  type: string;
  cycling: boolean;
  duration_min: number | null;
  tss: number | null;
  np_w: number | null;
}

export interface CoachResult {
  review: CoachReview;
  recent: GarminRide[];
  garmin_note: string | null;
  model: string;
}
