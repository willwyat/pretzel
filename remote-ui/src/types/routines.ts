/** Shapes from pretzel-server's /pretzel/routines routes (see lib/routines.js there). */

export type LightsAction = {
  type: "lights";
  /** `all`, `room:<name>` or `light:<LIFX id or WiZ IP>`. */
  targets: string[];
  /** Missing: lights that are off stay off. */
  power?: "on" | "off";
  brightness?: number;
  kelvin?: number;
  fadeS?: number;
  onlyIfOff?: boolean;
};

export type SpeakAction = {
  type: "speak";
  text: string;
  /** Sonos speakers that also say it: every clip-capable one, none (Pi only), or chosen player ids. */
  sonos?: "all" | "none" | string[];
  sonosVolume?: number;
};

export type SonosAction = {
  type: "sonos";
  playerId: string;
  playerName?: string;
  favoriteId: string;
  favoriteName?: string;
  /** Volume to start at (set before playback). */
  volume?: number;
  /** Raise or lower to this over `rampS` seconds. */
  rampTo?: number;
  rampS?: number;
  shuffle?: boolean;
};

export type RoutineAction = LightsAction | SpeakAction | SonosAction;

export type SonosPlayer = { id: string; name: string; householdId: string; audioClip: boolean };
export type SonosFavorite = { id: string; name: string; householdId: string };

export type RoutineAnchor =
  | { type: "time"; time: string }
  | { type: "sun"; event: "sunrise" | "sunset"; offsetMin: number };

export type RoutineStep = { offsetMin: number; action: RoutineAction };

export type Routine = {
  id: string;
  name: string;
  enabled: boolean;
  /** 0 = Monday … 6 = Sunday, of the cycle the routine belongs to. */
  days: number[];
  anchor: RoutineAnchor;
  steps: RoutineStep[];
  updatedAt?: string | null;
};

export type StepRun = { ok: boolean | null; error: string | null; finishedAt: string | null };

export type UpcomingStep = {
  idx: number;
  at: string;
  time: string;
  summary: string;
  run: StepRun | null;
};

export type RoutineOverride = { skip?: boolean; time?: string; setAt?: string };

export type UpcomingRoutine = {
  id: string;
  name: string;
  enabled: boolean;
  at: string;
  time: string;
  /** Where the time came from, e.g. "sunset 18:22 − 60 min". */
  source: string;
  skipped: boolean;
  override: RoutineOverride | null;
  past: boolean;
  steps: UpcomingStep[];
};

export type RoutineCycle = {
  /** Cycle date: runs 04:00 that day to 04:00 the next. */
  date: string;
  start: string;
  sunrise: string | null;
  sunset: string | null;
  routines: UpcomingRoutine[];
};

export type UpcomingResponse = {
  ok: true;
  now: string;
  tz: string;
  cycleDate: string;
  /** The next routine that will run, in whichever cycle it falls. */
  next: { id: string; cycleDate: string; at: string } | null;
  cycles: RoutineCycle[];
};

export type LightNextChange = {
  at: string;
  time: string;
  routineId: string;
  routineName: string;
  power: "on" | "off" | null;
  brightness: number | null;
  kelvin: number | null;
  onlyIfOff: boolean;
  summary: string;
};

export type LightsNextResponse = {
  ok: true;
  tz: string;
  now: string;
  lights: Record<string, LightNextChange>;
};
