import { useCallback, useEffect, useMemo, useState } from "react";
import { fetchJson } from "../lib/fetchJson";
import { lifxStatePath } from "../lib/lifxPaths";
import type { LifxRoom } from "../types/homeRoom";
import type { Light } from "../types/lifx";
import { LightCard } from "./LightCard";

function isLightArray(data: unknown): data is Light[] {
  return Array.isArray(data);
}

function lightMatchesLifxRoom(light: Light, room: LifxRoom): boolean {
  const g = light.group?.name?.trim().toLowerCase() ?? "";
  const loc = light.location?.name?.trim().toLowerCase() ?? "";
  return g === room || loc === room;
}

type LightsSectionProps = {
  room: LifxRoom;
  heading: string;
};

export function LightsSection({ room, heading }: LightsSectionProps) {
  const [lights, setLights] = useState<Light[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchLights = useCallback(async () => {
    setError(null);
    setLoading(true);
    try {
      const res = await fetchJson("/lifx/lights/all");
      if (!res.ok) {
        setOffline(false);
        const raw =
          res.data &&
          typeof res.data === "object" &&
          res.data !== null &&
          "error" in res.data &&
          typeof (res.data as { error: unknown }).error === "string"
            ? (res.data as { error: string }).error
            : null;
        setError(
          raw ??
            (res.status === 500
              ? "LIFX not configured on Pi (set LIFX_API_TOKEN)"
              : `Request failed (${res.status})`),
        );
        setLights([]);
        return;
      }
      if (!isLightArray(res.data)) {
        setOffline(false);
        setError("Unexpected response from Pi");
        setLights([]);
        return;
      }
      setOffline(false);
      setLights(res.data);
    } catch {
      setOffline(true);
      setLights([]);
      setError("Could not reach Pretzel");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchLights();
  }, [fetchLights]);

  const handleToggle = useCallback(async (light: Light) => {
    const newPower = light.power === "on" ? "off" : "on";
    try {
      const res = await fetchJson(lifxStatePath(light.id), {
        method: "PUT",
        body: JSON.stringify({ power: newPower }),
      });
      if (!res.ok) return;
      setLights((prev) =>
        prev.map((l) => (l.id === light.id ? { ...l, power: newPower } : l)),
      );
    } catch {
      /* resync on refresh */
    }
  }, []);

  const handleBrightness = useCallback(
    async (light: Light, brightness: number) => {
      try {
        await fetchJson(lifxStatePath(light.id), {
          method: "PUT",
          body: JSON.stringify({ brightness, duration: 0.3 }),
        });
        setLights((prev) =>
          prev.map((l) => (l.id === light.id ? { ...l, brightness } : l)),
        );
      } catch {
        /* resync on refresh */
      }
    },
    [],
  );

  const handleColor = useCallback(async (light: Light, color: string) => {
    try {
      await fetchJson(lifxStatePath(light.id), {
        method: "PUT",
        body: JSON.stringify({ color, duration: 0.5 }),
      });
      const hueMatch = color.match(/hue:(\d+)/);
      const satMatch = color.match(/saturation:([\d.]+)/);
      const kelvinMatch = color.match(/kelvin:(\d+)/);
      setLights((prev) =>
        prev.map((l) => {
          if (l.id !== light.id) return l;
          const baseColor = l.color ?? { hue: 0, saturation: 0, kelvin: 3500 };
          return {
            ...l,
            color: {
              hue: hueMatch ? Number(hueMatch[1]) : baseColor.hue,
              saturation: satMatch
                ? Number(satMatch[1])
                : hueMatch
                  ? 1
                  : kelvinMatch
                    ? 0
                    : baseColor.saturation,
              kelvin: kelvinMatch ? Number(kelvinMatch[1]) : baseColor.kelvin,
            },
          };
        }),
      );
    } catch {
      /* resync on refresh */
    }
  }, []);

  const lightsInRoom = useMemo(
    () => lights.filter((l) => lightMatchesLifxRoom(l, room)),
    [lights, room],
  );

  const lightGroups = useMemo(() => {
    return lightsInRoom.reduce<Record<string, Light[]>>((acc, light) => {
      const groupName = light.group?.name || "Ungrouped";
      if (!acc[groupName]) acc[groupName] = [];
      acc[groupName].push(light);
      return acc;
    }, {});
  }, [lightsInRoom]);

  const statusDot =
    offline || error
      ? "bg-red-500"
      : !loading
        ? "bg-emerald-500"
        : "bg-gray-500";

  return (
    <section className="pretzel-panel">
      <div className="pretzel-panel__header">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={`mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${statusDot}`}
            title={
              offline
                ? "Could not reach Pi"
                : error
                  ? "LIFX or configuration issue"
                  : "Connected"
            }
            aria-hidden
          />
          <div className="min-w-0">
            <h2 className="pretzel-text-panel-title">{heading}</h2>
            <p className="pretzel-text-panel-muted">
              {loading && lights.length === 0
                ? "Loading…"
                : offline
                  ? "Could not reach Pretzel"
                  : error
                    ? "See error below"
                    : lights.length === 0
                      ? "No lights in account"
                      : lightsInRoom.length === 0
                        ? `No lights in group or location “${room}” (names are case-insensitive)`
                        : `${lightsInRoom.length} light${lightsInRoom.length === 1 ? "" : "s"} in ${room}`}
            </p>
          </div>
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => {
              void fetchLights();
            }}
            className="pretzel-btn-ghost"
          >
            Refresh
          </button>
        )}
      </div>

      <div className="pretzel-panel__body">
        {error && (
          <div className="mb-4 rounded-lg border border-rose-800 bg-rose-950/50 px-3 py-2 text-sm text-rose-200">
            {error}
          </div>
        )}

        <div className="space-y-6">
          {Object.entries(lightGroups).map(([groupName, groupLights]) => (
            <div key={groupName} className="space-y-2">
              <h3 className="pretzel-text-group-label">{groupName}</h3>
              <div className="grid gap-3">
                {groupLights.map((light) => (
                  <LightCard
                    key={light.id}
                    light={light}
                    onToggle={handleToggle}
                    onBrightness={handleBrightness}
                    onColor={handleColor}
                  />
                ))}
              </div>
            </div>
          ))}
        </div>

        {!loading &&
          lights.length === 0 &&
          !error &&
          !offline && (
            <p className="py-8 text-center text-sm pretzel-text-panel-subtle">
              No lights found.
            </p>
          )}
        {!loading &&
          lights.length > 0 &&
          lightsInRoom.length === 0 &&
          !error &&
          !offline && (
            <p className="py-8 text-center text-sm pretzel-text-panel-subtle">
              No lights assigned to this room. In the LIFX app, use group or
              location names <span className="font-mono">Lounge</span> or{" "}
              <span className="font-mono">Bedroom</span> (case-insensitive).
            </p>
          )}
      </div>
    </section>
  );
}
