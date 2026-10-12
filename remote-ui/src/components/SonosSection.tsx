import { useCallback, useEffect, useState, type CSSProperties } from "react";
import { fetchJson } from "../lib/fetchJson";
import { LedRefresh } from "./LedRefresh";
import { VuMeter } from "./VuMeter";

/** Track and play state change on their own; re-read them while the tab is open. */
const STATUS_POLL_MS = 15_000;

type SonosGroup = {
  id: string;
  name: string;
  playbackState: string | null;
};

type GroupStatus = {
  playbackState: string | null;
  track: string | null;
  artist: string | null;
  source: string | null;
  volume: number | null;
  muted: boolean;
};

function errorOf(data: unknown, fallback: string): string {
  return data &&
    typeof data === "object" &&
    "error" in data &&
    typeof (data as { error: unknown }).error === "string"
    ? (data as { error: string }).error
    : fallback;
}

const groupPath = (id: string) =>
  `/pretzel/sonos/groups/${encodeURIComponent(id)}`;

function SonosGroupCard({ group }: { group: SonosGroup }) {
  const [status, setStatus] = useState<GroupStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [localVolume, setLocalVolume] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async () => {
    try {
      const res = await fetchJson(groupPath(group.id));
      if (!res.ok) {
        setError(errorOf(res.data, `Sonos request failed (${res.status})`));
        return;
      }
      setError(null);
      setStatus(res.data as GroupStatus);
    } catch {
      setError("Could not reach Pretzel");
    }
  }, [group.id]);

  useEffect(() => {
    void loadStatus();
    const id = setInterval(() => {
      if (document.visibilityState === "visible") void loadStatus();
    }, STATUS_POLL_MS);
    return () => clearInterval(id);
  }, [loadStatus]);

  // Keep the fader on the speaker's level unless the user is holding it.
  useEffect(() => {
    if (!dragging && status?.volume != null) setLocalVolume(status.volume);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status?.volume]);

  const isPlaying = status?.playbackState === "PLAYBACK_STATE_PLAYING";

  const togglePlay = async () => {
    if (busy || !status) return;
    setBusy(true);
    const command = isPlaying ? "pause" : "play";
    try {
      const res = await fetchJson(`${groupPath(group.id)}/${command}`, {
        method: "POST",
      });
      if (!res.ok) {
        setError(errorOf(res.data, `Could not ${command}`));
        return;
      }
      setError(null);
      setStatus((s) =>
        s
          ? {
              ...s,
              playbackState: isPlaying
                ? "PLAYBACK_STATE_PAUSED"
                : "PLAYBACK_STATE_PLAYING",
            }
          : s,
      );
    } catch {
      setError("Could not reach Pretzel");
    } finally {
      setBusy(false);
    }
  };

  const commitVolume = async (value: number) => {
    const volume = Math.max(0, Math.min(100, Math.round(value)));
    setStatus((s) => (s ? { ...s, volume } : s));
    try {
      const res = await fetchJson(`${groupPath(group.id)}/volume`, {
        method: "POST",
        body: JSON.stringify({ volume }),
      });
      if (!res.ok) setError(errorOf(res.data, "Could not set volume"));
    } catch {
      setError("Could not reach Pretzel");
    }
  };

  const endDrag = () => {
    if (!dragging) return;
    setDragging(false);
    void commitVolume(localVolume);
  };

  const ready = status !== null;
  const shownVolume = dragging ? localVolume : (status?.volume ?? 0);
  const nowPlaying =
    status?.track ??
    status?.source ??
    (!ready ? "Loading…" : isPlaying ? "Playing" : "Paused");
  const subline = status?.track ? status.artist : null;

  return (
    // Sits straight on the panel plate: name, track lamp and transport in one
    // row, then the meter and fader. No inner card.
    <div className="space-y-2.5">
      <div className="flex items-center gap-3">
        <div className="min-w-0 flex-1">
          <div className="flex items-baseline gap-2">
            <h3 className="pretzel-text-card-name flex-shrink-0">{group.name}</h3>
            {subline && (
              <p className="pretzel-text-panel-muted min-w-0 truncate text-xs">
                {subline}
              </p>
            )}
          </div>
          <p className="pretzel-readout mt-1.5 block truncate">{nowPlaying}</p>
        </div>
        <button
          type="button"
          disabled={!ready || busy}
          onClick={() => void togglePlay()}
          title={isPlaying ? "Pause" : "Play"}
          aria-label={`${group.name} ${isPlaying ? "pause" : "play"}`}
          className={`pretzel-btn-icon flex h-12 w-12 flex-shrink-0 items-center justify-center ${
            isPlaying ? "pretzel-key--accent" : ""
          }`}
        >
          {isPlaying ? (
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z" />
            </svg>
          ) : (
            <svg className="h-5 w-5" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
              <path d="M8 5v14l11-7z" />
            </svg>
          )}
        </button>
      </div>

      <VuMeter value={ready && isPlaying && !status.muted ? shownVolume : 0} />
      <div className="flex items-center gap-3">
        <span className="pretzel-text-group-label" aria-hidden>
          Vol
        </span>
        <input
          type="range"
          min={0}
          max={100}
          value={shownVolume}
          disabled={!ready}
          aria-label={`${group.name} volume`}
          onChange={(e) => {
            setLocalVolume(Number(e.target.value));
            setDragging(true);
          }}
          onPointerUp={endDrag}
          onPointerCancel={endDrag}
          onKeyUp={endDrag}
          onBlur={endDrag}
          className="pretzel-range w-full"
          style={{ "--fill": `${shownVolume}%` } as CSSProperties}
        />
        <span className="pretzel-vol-pct">
          {status?.muted ? "MUTE" : `${shownVolume}%`}
        </span>
      </div>

      {error && <p className="pretzel-text-alert text-sm">{error}</p>}
    </div>
  );
}

export function SonosSection() {
  const [groups, setGroups] = useState<SonosGroup[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Bumped by Refresh so each card re-mounts and re-reads its status. */
  const [generation, setGeneration] = useState(0);

  const loadGroups = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson("/pretzel/sonos/groups");
      if (!res.ok) {
        setGroups([]);
        setError(errorOf(res.data, `Sonos request failed (${res.status})`));
        return;
      }
      const data = res.data as { groups?: SonosGroup[] };
      setGroups(Array.isArray(data.groups) ? data.groups : []);
      setError(null);
      setGeneration((g) => g + 1);
    } catch {
      setGroups([]);
      setError("Could not reach Pretzel");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadGroups();
  }, [loadGroups]);

  const led = loading
    ? "pretzel-led--warn"
    : error
      ? "pretzel-led--off"
      : "pretzel-led--ok";

  return (
    <section className="pretzel-panel">
      <div className="pretzel-panel__header">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <LedRefresh
            ledClass={led}
            status={loading ? "Loading…" : (error ?? "Connected")}
            disabled={loading}
            onRefresh={() => void loadGroups()}
          />
          <h2 className="pretzel-text-panel-title min-w-0">Sonos</h2>
        </div>
      </div>

      <div className="pretzel-panel__body">
        {error && <p className="pretzel-text-alert text-sm">{error}</p>}
        {groups.map((g, i) => (
          <div
            key={`${g.id}:${generation}`}
            className={i > 0 ? "pretzel-panel__block-bordered" : ""}
          >
            <SonosGroupCard group={g} />
          </div>
        ))}
        {!loading && !error && groups.length === 0 && (
          <p className="py-8 text-center text-sm pretzel-text-panel-subtle">
            No Sonos groups found.
          </p>
        )}
      </div>
    </section>
  );
}
