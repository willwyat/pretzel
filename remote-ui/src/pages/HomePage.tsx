import { Link } from "react-router-dom";
import { LightsSection } from "../components/LightsSection";
import { PretzelSection } from "../components/PretzelSection";
import { TvSection } from "../components/TvSection";
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../lib/fetchJson";

const SUN_POLL_MS = 60_000;

function isWeatherSunPayload(data: unknown): data is {
  ok: true;
  time: { timezone: string; localDate: string };
  sun: { mode: "sunset" | "sunrise"; iso: string };
} {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  if (d.ok !== true) return false;
  const time = d.time;
  if (typeof time !== "object" || time === null) return false;
  const t = time as Record<string, unknown>;
  if (typeof t.timezone !== "string" || typeof t.localDate !== "string")
    return false;
  const sun = d.sun;
  if (typeof sun !== "object" || sun === null) return false;
  const s = sun as Record<string, unknown>;
  if (s.mode !== "sunset" && s.mode !== "sunrise") return false;
  if (typeof s.iso !== "string") return false;
  return true;
}

function formatSunClock(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

function eventYmdInTz(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(new Date(iso));
}

function dayQualifier(
  eventIso: string,
  timeZone: string,
  localDate: string,
): string {
  const ymd = eventYmdInTz(eventIso, timeZone);
  if (ymd === localDate) return "today";
  return "tomorrow";
}

export function HomePage() {
  const [sunState, setSunState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | {
        status: "ok";
        timezone: string;
        localDate: string;
        sun: { mode: "sunset" | "sunrise"; iso: string };
      }
  >({ status: "loading" });

  const loadSun = useCallback(async () => {
    const res = await fetchJson("/pretzel/weather");
    if (!res.ok || !isWeatherSunPayload(res.data)) {
      setSunState({ status: "error" });
      return;
    }
    const { time, sun } = res.data;
    setSunState({
      status: "ok",
      timezone: time.timezone,
      localDate: time.localDate,
      sun,
    });
  }, []);

  useEffect(() => {
    void loadSun();
    const id = setInterval(() => void loadSun(), SUN_POLL_MS);
    return () => clearInterval(id);
  }, [loadSun]);

  const sunTitle =
    sunState.status === "ok" && sunState.sun.mode === "sunset"
      ? "Sunset"
      : sunState.status === "ok" && sunState.sun.mode === "sunrise"
        ? "Sunrise"
        : null;
  const sunTimeFormatted =
    sunState.status === "ok"
      ? formatSunClock(sunState.sun.iso, sunState.timezone)
      : null;
  const sunDay =
    sunState.status === "ok"
      ? dayQualifier(sunState.sun.iso, sunState.timezone, sunState.localDate)
      : null;

  return (
    <div className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div
            className="min-h-[2.75rem] text-sm text-[#444]"
            aria-live="polite"
          >
            {sunState.status === "loading" ? (
              <span className="text-gray-500">Sun times…</span>
            ) : sunState.status === "error" ? (
              <span className="text-gray-500">Sun times unavailable</span>
            ) : (
              <>
                <div className="font-semibold text-[#222]">{sunTitle}</div>
                <div className="tabular-nums text-base text-[#333]">
                  {sunTimeFormatted}
                  {sunDay ? (
                    <span className="ml-1.5 font-normal text-gray-500">
                      {sunDay}
                    </span>
                  ) : null}
                </div>
              </>
            )}
          </div>
        </div>
        <Link
          to="/settings"
          className="flex-shrink-0 rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800"
        >
          Settings
        </Link>
      </div>

      <div className="flex flex-col gap-6">
        <TvSection />
        <PretzelSection />
        <LightsSection />
      </div>
    </div>
  );
}
