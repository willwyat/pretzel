import type {
  LightNextChange,
  LightsNextResponse,
  UpcomingResponse,
} from "../types/routines";

export function isUpcomingResponse(data: unknown): data is UpcomingResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.ok === true && typeof d.tz === "string" && Array.isArray(d.cycles);
}

export function isLightsNextResponse(data: unknown): data is LightsNextResponse {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return (
    d.ok === true &&
    typeof d.tz === "string" &&
    typeof d.lights === "object" &&
    d.lights !== null
  );
}

function ymdIn(iso: string | number, tz: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

/**
 * "" for today, "tonight" for the small hours after this midnight, "tomorrow",
 * or a short weekday, relative to `now` in `tz`.
 */
export function dayWord(iso: string, tz: string, now: number = Date.now()): string {
  const day = ymdIn(iso, tz);
  const today = ymdIn(now, tz);
  if (day === today) return "";
  if (day === ymdIn(now + 864e5, tz)) {
    const hour = Number(
      new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", hourCycle: "h23" }).format(
        new Date(iso),
      ),
    );
    return hour < 4 ? "tonight" : "tomorrow";
  }
  return new Intl.DateTimeFormat("en-US", { timeZone: tz, weekday: "short" }).format(
    new Date(iso),
  );
}

/** "in 2h 05m", "in 12 min", "now". */
export function countdown(iso: string, now: number = Date.now()): string {
  const mins = Math.round((Date.parse(iso) - now) / 60_000);
  if (mins <= 0) return "now";
  if (mins < 60) return `in ${mins} min`;
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  return `in ${h}h ${String(m).padStart(2, "0")}m`;
}

/** Short state a scheduled lights step will set, e.g. "on 50% 4000K", "dim 10%", "off". */
export function lightChangeLabel(c: LightNextChange): string {
  if (c.power === "off") return "off";
  const parts: string[] = [c.power === "on" ? "on" : "dim"];
  if (c.brightness !== null) parts.push(`${Math.round(c.brightness * 100)}%`);
  if (c.kelvin !== null) parts.push(`${c.kelvin}K`);
  if (c.onlyIfOff) parts.push("if off");
  return parts.join(" ");
}

/** "Mon" … "Sun", index 0 = Monday like the server. */
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
