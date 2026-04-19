export interface ChoreScheduleSlot {
  days: string[];
  time: string;
}

/** Schedule is either an array of slots or the literal "every-reminder". */
export type ChoreSchedule = ChoreScheduleSlot[] | "every-reminder";

/** Chore definition as returned by GET /pretzel/chores (includes computed status). */
export interface Chore {
  id: string;
  name: string;
  durationMinutes?: number;
  durationSeconds?: number;
  schedule: ChoreSchedule;
  createdAt: string;
  /** Computed: slotsExpected - completionCount. 0 = up to date. */
  missed: number;
  /** Computed: pending chore. */
  pending: boolean;
  lastCompletedAt: string | null;
  completionCount: number;
  /** The most recent slot activation time (for "due since X" display). */
  activeSlot?: string | null;
  /** The next upcoming slot activation time. */
  nextSlot?: string | null;
}

/** Duration in seconds, normalized from either durationMinutes or durationSeconds. */
export function choreDurationSeconds(chore: Chore): number {
  if (chore.durationSeconds != null) return chore.durationSeconds;
  if (chore.durationMinutes != null) return chore.durationMinutes * 60;
  return 0;
}

export function formatDurationLabel(sec: number): string {
  if (sec < 60) return `${sec}s`;
  const m = Math.round(sec / 60);
  return `${m}m`;
}
