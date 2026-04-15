import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../lib/fetchJson";

interface TvStatusBody {
  connected?: boolean;
  inputConnected?: boolean;
  /** From tv-relay + LG getPowerState; omitted if query failed (fall back to socket only). */
  screenOn?: boolean;
  powerState?: string;
}

interface TvVolumeBody {
  volumeStatus?: {
    volume?: number;
    muteStatus?: boolean;
    maxVolume?: number;
  };
}

export function TvSection() {
  const [relayOffline, setRelayOffline] = useState(false);
  /** Main control WebSocket to TV (can stay open in LG standby). */
  const [connected, setConnected] = useState(false);
  /** LG getPowerState; undefined = relay omitted field (use socket-only fallback). */
  const [screenTvOn, setScreenTvOn] = useState<boolean | undefined>(undefined);
  const [inputConnected, setInputConnected] = useState(false);
  const [volume, setVolume] = useState(0);
  const [maxVolume, setMaxVolume] = useState(100);
  const [muted, setMuted] = useState(false);
  const [localVolume, setLocalVolume] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [powerOffArmed, setPowerOffArmed] = useState(false);
  const [turningOff, setTurningOff] = useState(false);
  const [turningOn, setTurningOn] = useState(false);
  const armedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const syncPollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearSyncPoll = useCallback(() => {
    if (syncPollTimerRef.current != null) {
      clearTimeout(syncPollTimerRef.current);
      syncPollTimerRef.current = null;
    }
  }, []);

  type TvFetchSnapshot = {
    tvOn: boolean;
    relayReachable: boolean;
    socketConnected: boolean;
  };

  const fetchAll = useCallback(
    async (opts?: { quiet?: boolean }): Promise<TvFetchSnapshot> => {
      const quiet = opts?.quiet ?? false;
      if (!quiet) setLoading(true);
      try {
        const [statusRes, volRes] = await Promise.all([
          fetchJson("/tv/status"),
          fetchJson("/tv/volume"),
        ]);
        // Status answers "is the relay up + is the TV socket open?". Volume uses the TV
        // socket and returns 500 when disconnected — that must not imply relay offline.
        if (!statusRes.ok) {
          setRelayOffline(true);
          setConnected(false);
          setScreenTvOn(undefined);
          return {
            tvOn: false,
            relayReachable: false,
            socketConnected: false,
          };
        }
        const status = statusRes.data as TvStatusBody;
        setRelayOffline(false);
        const isConnected = !!status.connected;
        setConnected(isConnected);
        setInputConnected(!!status.inputConnected);
        const explicitScreen =
          typeof status.screenOn === "boolean" ? status.screenOn : undefined;
        setScreenTvOn(explicitScreen);
        const tvOn =
          isConnected && (explicitScreen !== undefined ? explicitScreen : true);
        if (volRes.ok) {
          const volJson = volRes.data as TvVolumeBody;
          const vs = volJson.volumeStatus;
          if (vs && typeof vs.volume === "number") {
            setVolume(vs.volume);
            setLocalVolume(vs.volume);
            setMuted(!!vs.muteStatus);
            if (typeof vs.maxVolume === "number" && vs.maxVolume > 0) {
              setMaxVolume(vs.maxVolume);
            }
          }
        }
        return {
          tvOn,
          relayReachable: true,
          socketConnected: isConnected,
        };
      } catch {
        setRelayOffline(true);
        setConnected(false);
        setScreenTvOn(undefined);
        return {
          tvOn: false,
          relayReachable: false,
          socketConnected: false,
        };
      } finally {
        if (!quiet) setLoading(false);
      }
    },
    [],
  );

  const startSyncPoll = useCallback(
    (
      until: (s: TvFetchSnapshot) => boolean,
      maxMs: number,
      intervalMs: number,
    ) => {
      clearSyncPoll();
      const deadline = Date.now() + maxMs;
      const tick = async () => {
        const snap = await fetchAll({ quiet: true });
        if (until(snap) || Date.now() >= deadline) {
          clearSyncPoll();
          return;
        }
        syncPollTimerRef.current = setTimeout(() => void tick(), intervalMs);
      };
      syncPollTimerRef.current = setTimeout(() => void tick(), intervalMs);
    },
    [clearSyncPoll, fetchAll],
  );

  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);

  useEffect(() => () => clearSyncPoll(), [clearSyncPoll]);

  useEffect(() => {
    if (!powerOffArmed) return;
    armedTimerRef.current = setTimeout(() => setPowerOffArmed(false), 5000);
    return () => {
      if (armedTimerRef.current) clearTimeout(armedTimerRef.current);
    };
  }, [powerOffArmed]);

  /** Picture / interactive on (LG getPowerState Active), not just WebSocket up. */
  const tvOn =
    connected && (typeof screenTvOn === "boolean" ? screenTvOn : true);

  const controlsDisabled =
    relayOffline || !tvOn || loading || turningOff;
  const remoteDisabled =
    relayOffline || !tvOn || loading || turningOff || turningOn;

  const remoteBtnClass =
    "flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-gray-600 text-gray-300 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40";

  const remoteWideBtnClass =
    "flex min-h-9 flex-1 items-center justify-center rounded-lg border border-gray-600 px-2 py-1.5 text-[11px] font-medium text-gray-200 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40";

  const sendRemote = useCallback(
    (path: string) => {
      if (remoteDisabled) return;
      void fetchJson(path, { method: "POST" }).catch(() => {});
    },
    [remoteDisabled],
  );

  const commitVolume = useCallback(
    (val: number) => {
      const clamped = Math.max(0, Math.min(maxVolume, Math.round(val)));
      setVolume(clamped);
      setLocalVolume(clamped);
      void fetchJson("/tv/volume", {
        method: "POST",
        body: JSON.stringify({ volume: clamped }),
      }).catch(() => {});
      void fetchJson("/pretzel/volume", {
        method: "POST",
        body: JSON.stringify({ volume: clamped, announce: true }),
      }).catch(() => {});
    },
    [maxVolume],
  );

  const toggleMute = () => {
    if (controlsDisabled) return;
    const next = !muted;
    setMuted(next);
    void fetchJson("/tv/mute", {
      method: "POST",
      body: JSON.stringify({ mute: next }),
    })
      .then((r) => {
        if (!r.ok) setMuted(!next);
      })
      .catch(() => {
        setMuted(!next);
      });
  };

  const handlePowerOffClick = () => {
    if (relayOffline || loading || turningOff) return;
    if (!connected && !powerOffArmed) return;
    if (!powerOffArmed) {
      setPowerOffArmed(true);
      return;
    }
    setPowerOffArmed(false);
    clearSyncPoll();
    setTurningOff(true);
    void fetchJson("/tv/power/off", { method: "POST" })
      .then(async (r) => {
        setTurningOff(false);
        const snap = await fetchAll();
        if (!r.ok || !snap.relayReachable || !snap.tvOn) return;
        startSyncPoll(
          (s) =>
            !s.tvOn || !s.socketConnected || !s.relayReachable,
          45_000,
          1_500,
        );
      })
      .catch(async () => {
        setTurningOff(false);
        await fetchAll();
      });
  };

  const handlePowerOnClick = () => {
    if (relayOffline || loading || turningOn || tvOn) return;
    clearSyncPoll();
    setTurningOn(true);
    void fetchJson("/tv/power/on", { method: "POST" })
      .then(async (r) => {
        setTurningOn(false);
        const snap = await fetchAll();
        if (!r.ok || !snap.relayReachable || snap.tvOn) return;
        startSyncPoll(
          (s) => s.tvOn || !s.relayReachable,
          120_000,
          2_500,
        );
      })
      .catch(async () => {
        setTurningOn(false);
        await fetchAll();
      });
  };

  const displayVol = dragging ? localVolume : volume;
  const safeVol = Math.min(Math.max(0, displayVol), maxVolume);
  const pctLabel =
    maxVolume > 0 ? Math.round((safeVol / maxVolume) * 100) : safeVol;

  const statusDotClass = relayOffline
    ? "bg-red-500"
    : !connected
      ? "bg-red-500"
      : tvOn
        ? "bg-emerald-500"
        : "bg-amber-500";

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900">
      <div className="flex items-start justify-between gap-3 border-b border-gray-700 p-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={`mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${statusDotClass}`}
            title={
              relayOffline
                ? "Relay offline"
                : !connected
                  ? "Not connected"
                  : tvOn
                    ? "On (Active)"
                    : "Standby (socket up, screen not Active)"
            }
            aria-hidden
          />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-100">LG TV</h2>
            {loading ? (
              <p className="text-xs text-gray-400">Loading…</p>
            ) : relayOffline ? (
              <p className="text-xs text-gray-500">TV relay offline</p>
            ) : !connected ? (
              <p className="text-xs text-gray-500">TV not connected</p>
            ) : !tvOn ? (
              <p className="text-xs text-gray-500">TV standby</p>
            ) : (
              <p className="text-xs text-gray-400">
                {inputConnected ? "Source connected" : "No source"}
              </p>
            )}
          </div>
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => void fetchAll()}
            className="flex-shrink-0 rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800"
          >
            Refresh
          </button>
        )}
      </div>

      <div className="p-4">
        <div className="flex items-center gap-2">
          <svg
            className="h-3.5 w-3.5 flex-shrink-0 text-gray-400"
            fill="none"
            viewBox="0 0 24 24"
            strokeWidth={1.5}
            stroke="currentColor"
            aria-hidden
          >
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              d="M19.114 5.636a9 9 0 0 1 0 12.728M16.463 8.288a5.25 5.25 0 0 1 0 7.424M6.75 8.25l4.72-4.72a.75.75 0 0 1 1.28.53v15.88a.75.75 0 0 1-1.28.53l-4.72-4.72H4.51c-.88 0-1.704-.507-1.938-1.354A9.009 9.009 0 0 1 2.25 12c0-.83.112-1.633.322-2.396C2.806 8.756 3.63 8.25 4.51 8.25H6.75Z"
            />
          </svg>
          <input
            type="range"
            min={0}
            max={maxVolume}
            value={safeVol}
            disabled={controlsDisabled}
            onChange={(e) => {
              setLocalVolume(Number(e.target.value));
              setDragging(true);
            }}
            onMouseUp={() => {
              setDragging(false);
              commitVolume(localVolume);
            }}
            onTouchEnd={() => {
              setDragging(false);
              commitVolume(localVolume);
            }}
            className="h-1.5 min-w-0 flex-1 cursor-pointer appearance-none rounded-full bg-gray-700 accent-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="w-8 text-right text-[11px] tabular-nums text-gray-400">
            {pctLabel}%
          </span>
          <button
            type="button"
            disabled={controlsDisabled}
            onClick={toggleMute}
            className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg border border-gray-600 text-gray-400 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            title={muted ? "Unmute" : "Mute"}
          >
            {muted ? "🔇" : "🔈"}
          </button>
        </div>

        {tvOn && (
          <div className="mt-4 border-t border-gray-700 pt-4">
            <p className="mb-2 text-[10px] font-medium uppercase tracking-wide text-gray-500">
              Remote
            </p>
            <div
              className="mx-auto flex w-fit flex-col items-center gap-1"
              aria-label="TV directional pad"
            >
              <button
                type="button"
                disabled={remoteDisabled}
                title="Up"
                className={remoteBtnClass}
                onClick={() => sendRemote("/tv/up")}
              >
                ▲
              </button>
              <div className="flex items-center gap-1">
                <button
                  type="button"
                  disabled={remoteDisabled}
                  title="Left"
                  className={remoteBtnClass}
                  onClick={() => sendRemote("/tv/left")}
                >
                  ◀
                </button>
                <button
                  type="button"
                  disabled={remoteDisabled}
                  title="OK / Enter"
                  className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg border border-gray-500 bg-gray-800 text-[10px] font-semibold text-gray-100 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-40"
                  onClick={() => sendRemote("/tv/enter")}
                >
                  OK
                </button>
                <button
                  type="button"
                  disabled={remoteDisabled}
                  title="Right"
                  className={remoteBtnClass}
                  onClick={() => sendRemote("/tv/right")}
                >
                  ▶
                </button>
              </div>
              <button
                type="button"
                disabled={remoteDisabled}
                title="Down"
                className={remoteBtnClass}
                onClick={() => sendRemote("/tv/down")}
              >
                ▼
              </button>
            </div>
            <div className="mt-3 flex gap-2">
              <button
                type="button"
                disabled={remoteDisabled}
                title="Back"
                className={remoteWideBtnClass}
                onClick={() => sendRemote("/tv/back")}
              >
                Back
              </button>
              <button
                type="button"
                disabled={remoteDisabled}
                title="Home"
                className={remoteWideBtnClass}
                onClick={() => sendRemote("/tv/home")}
              >
                Home
              </button>
              <button
                type="button"
                disabled={remoteDisabled}
                title="Quick settings"
                className={remoteWideBtnClass}
                onClick={() => sendRemote("/tv/settings")}
              >
                Settings
              </button>
            </div>
          </div>
        )}

        <div className="mt-4 flex flex-wrap items-center justify-end gap-2 border-t border-gray-700 pt-4">
          {!tvOn && (
            <>
              {turningOn ? (
                <span className="text-xs text-gray-400">Waking TV…</span>
              ) : (
                <button
                  type="button"
                  disabled={relayOffline || loading || turningOn}
                  onClick={handlePowerOnClick}
                  title="Wake-on-LAN and/or network turn-on (configure TV_WOL_MAC on the Pi)"
                  className="rounded-lg border border-blue-700 bg-blue-900/40 px-3 py-1.5 text-xs font-medium text-blue-100 transition hover:bg-blue-900/60 disabled:cursor-not-allowed disabled:opacity-50"
                >
                  Power on
                </button>
              )}
            </>
          )}
          {connected && (
            <>
              {turningOff ? (
                <span className="text-xs text-gray-400">Turning off…</span>
              ) : (
                <button
                  type="button"
                  disabled={relayOffline || loading || turningOff}
                  onClick={handlePowerOffClick}
                  className={`rounded-lg border px-3 py-1.5 text-xs font-medium transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    powerOffArmed
                      ? "border-amber-600 bg-amber-950/50 text-amber-200"
                      : "border-gray-600 text-gray-400 hover:bg-gray-800"
                  }`}
                >
                  {powerOffArmed ? "Confirm power off" : "Power off"}
                </button>
              )}
            </>
          )}
        </div>
      </div>
    </section>
  );
}
