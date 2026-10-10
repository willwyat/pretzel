import { Link } from "react-router-dom";
import { LightsSection } from "../components/LightsSection";
import { BulletinSection } from "../components/BulletinSection";
import { ChoresSection } from "../components/ChoresSection";
import { GamesSection } from "../components/GamesSection";
import { PretzelSection } from "../components/PretzelSection";
import { TvSection } from "../components/TvSection";
import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../lib/fetchJson";
import type { HomeRoomTab } from "../types/homeRoom";

const SUN_POLL_MS = 60_000;

function isWeatherPayload(data: unknown): data is {
  ok: true;
  time: { timezone: string; localDate: string };
  current: { temperatureC: number; condition: string };
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
  const current = d.current;
  if (typeof current !== "object" || current === null) return false;
  const c = current as Record<string, unknown>;
  if (typeof c.temperatureC !== "number" || !Number.isFinite(c.temperatureC))
    return false;
  if (typeof c.condition !== "string" || c.condition.length === 0) return false;
  const sun = d.sun;
  if (typeof sun !== "object" || sun === null) return false;
  const s = sun as Record<string, unknown>;
  if (s.mode !== "sunset" && s.mode !== "sunrise") return false;
  if (typeof s.iso !== "string") return false;
  return true;
}

function celsiusToFahrenheit(celsius: number): number {
  return Math.round((celsius * 9) / 5 + 32);
}

function formatSunTime(iso: string, timeZone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone,
  }).format(new Date(iso));
}

type HomePageProps = {
  activeRoom: HomeRoomTab;
};

export function HomePage({ activeRoom }: HomePageProps) {
  const [unit, setUnit] = useState<"C" | "F">("C");
  const [sunState, setSunState] = useState<
    | { status: "loading" }
    | { status: "error" }
    | {
        status: "ok";
        timezone: string;
        current: { temperatureC: number; condition: string };
        sun: { mode: "sunset" | "sunrise"; iso: string };
      }
  >({ status: "loading" });

  const loadSun = useCallback(async () => {
    const res = await fetchJson("/pretzel/weather");
    if (!res.ok || !isWeatherPayload(res.data)) {
      setSunState({ status: "error" });
      return;
    }
    const { time, current, sun } = res.data;
    setSunState({
      status: "ok",
      timezone: time.timezone,
      current,
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
        : sunState.status === "loading"
          ? "Sun times…"
          : "Sun times unavailable";
  const sunTimeFormatted =
    sunState.status === "ok"
      ? formatSunTime(sunState.sun.iso, sunState.timezone)
      : "00:00";
  const temperature =
    sunState.status === "ok"
      ? unit === "C"
        ? sunState.current.temperatureC
        : celsiusToFahrenheit(sunState.current.temperatureC)
      : null;

  return (
    <div className="py-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-end gap-4" aria-live="polite">
          <div className="pretzel-text-sun-block">
            <div className="pretzel-text-sun-title">{sunTitle}</div>
            <div className="pretzel-text-sun-time">{sunTimeFormatted}</div>
          </div>
          <div className="pretzel-text-sun-block">
            <div className="pretzel-text-sun-title">Outside temp</div>
            <button
              type="button"
              className="pretzel-text-sun-time"
              onClick={() => setUnit((current) => (current === "C" ? "F" : "C"))}
              aria-label={
                temperature === null
                  ? "Outside temperature unavailable"
                  : `Outside temperature ${temperature} degrees ${unit === "C" ? "Celsius" : "Fahrenheit"}`
              }
            >
              {temperature === null ? "--" : `${temperature}${unit}`}
            </button>
          </div>
        </div>
        <Link to="/settings" className="pretzel-btn-ghost flex-shrink-0">
          Settings
        </Link>
      </div>

      <div className="mt-4 flex flex-col gap-6">
        {activeRoom === "bedroom" ? <TvSection /> : null}
        {activeRoom === "pretzel" ? (
          <>
            <BulletinSection />
            <PretzelSection />
            <GamesSection />
            <ChoresSection />
          </>
        ) : null}
        {activeRoom === "lounge" ? (
          <LightsSection room="lounge" heading="Lounge lights" />
        ) : null}
        {activeRoom === "bedroom" ? (
          <LightsSection room="bedroom" heading="Bedroom lights" />
        ) : null}
      </div>
    </div>
  );
}
