import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "../lib/fetchJson";
import { lightStatePath } from "../lib/lifxPaths";
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

type ProviderResult = {
  lights: Light[];
  error: string | null;
  /** The request itself failed (Pi unreachable), as opposed to an error reply. */
  unreachable: boolean;
};

async function loadLights(
  url: string,
  provider: "lifx" | "wiz",
): Promise<ProviderResult> {
  const name = provider === "lifx" ? "LIFX" : "WiZ";
  try {
    const res = await fetchJson(url);
    if (!res.ok) {
      const raw =
        res.data &&
        typeof res.data === "object" &&
        res.data !== null &&
        "error" in res.data &&
        typeof (res.data as { error: unknown }).error === "string"
          ? (res.data as { error: string }).error
          : null;
      return {
        lights: [],
        error:
          raw ??
          (provider === "lifx" && res.status === 500
            ? "LIFX not configured on Pi (set LIFX_API_TOKEN)"
            : `${name} request failed (${res.status})`),
        unreachable: false,
      };
    }
    if (!isLightArray(res.data)) {
      return {
        lights: [],
        error: `Unexpected ${name} response from Pi`,
        unreachable: false,
      };
    }
    return {
      lights: res.data.map((l) => ({ ...l, provider })),
      error: null,
      unreachable: false,
    };
  } catch {
    return { lights: [], error: null, unreachable: true };
  }
}

type LightsSectionProps = {
  room: LifxRoom;
  heading: string;
};

export function LightsSection({ room, heading }: LightsSectionProps) {
  const [lights, setLights] = useState<Light[]>([]);
  const [loading, setLoading] = useState(true);
  /** Any request in flight, including refreshes; drives the flashing LED. */
  const [fetching, setFetching] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Avoid stale closure in fetchLights (useCallback []); used for initial vs refetch loading UX */
  const lightsCountRef = useRef(0);
  lightsCountRef.current = lights.length;

  const fetchLights = useCallback(async () => {
    setError(null);
    setFetching(true);
    if (lightsCountRef.current === 0) {
      setLoading(true);
    }
    try {
      // One provider failing (e.g. no LIFX token) must not
      // hide the other's lights.
      const results = await Promise.all([
        loadLights("/lifx/lights/all", "lifx"),
        loadLights("/pretzel/wiz/lights", "wiz"),
      ]);
      if (results.every((r) => r.unreachable)) {
        setOffline(true);
        setLights([]);
        setError("Could not reach Pretzel");
        return;
      }
      setOffline(false);
      setLights(results.flatMap((r) => r.lights));
      const errors = results.flatMap((r) => (r.error ? [r.error] : []));
      setError(errors.length > 0 ? errors.join(" · ") : null);
    } finally {
      setLoading(false);
      setFetching(false);
    }
  }, []);

  useEffect(() => {
    void fetchLights();
  }, [fetchLights]);

  const handleToggle = useCallback(async (light: Light) => {
    const newPower = light.power === "on" ? "off" : "on";
    try {
      const res = await fetchJson(lightStatePath(light), {
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
        await fetchJson(lightStatePath(light), {
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
      await fetchJson(lightStatePath(light), {
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

  const statusDot = fetching
    ? "pretzel-led--loading"
    : offline || error
      ? "pretzel-led--off"
      : "pretzel-led--ok";

  return (
    <section className="pretzel-panel">
      <div className="pretzel-panel__header">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span
            className={`pretzel-led ${statusDot}`}
            title={
              fetching
                ? "Loading…"
                : offline
                  ? "Could not reach Pi"
                  : error
                    ? "Light provider or configuration issue"
                    : "Connected"
            }
            aria-hidden
          />
          <h2 className="pretzel-text-panel-title min-w-0">{heading}</h2>
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
          <div className="pretzel-well pretzel-text-alert mb-4 text-sm">
            {error}
          </div>
        )}

        <div className="space-y-6">
          {Object.entries(lightGroups).map(([groupName, groupLights]) => (
            <div key={groupName} className="space-y-2">
              {/* The panel heading already names the room; only label groups
                  when a room contains several. */}
              {Object.keys(lightGroups).length > 1 && (
                <h3 className="pretzel-text-group-label">{groupName}</h3>
              )}
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

        {!loading && lights.length === 0 && !error && !offline && (
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
              <span className="font-mono">Bedroom</span> (case-insensitive);
              WiZ bulbs take their room from{" "}
              <span className="font-mono">WIZ_LIGHTS</span> on the Pi.
            </p>
          )}
      </div>
    </section>
  );
}
