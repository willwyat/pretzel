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

function DpadChevron({ className }: { className?: string }) {
  return (
    <svg
      className={className}
      width={26}
      height={26}
      viewBox="0 0 24 24"
      aria-hidden
    >
      <path
        d="M6 14 12 8l6 6"
        fill="none"
        stroke="currentColor"
        strokeWidth="2.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
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

  const bumpVolumeByPercent = useCallback(
    (delta: number) => {
      if (controlsDisabled || maxVolume <= 0) return;
      const currentPct = (volume / maxVolume) * 100;
      const nextPct = Math.max(0, Math.min(100, currentPct + delta));
      const nextVol = Math.round((nextPct / 100) * maxVolume);
      commitVolume(nextVol);
    },
    [controlsDisabled, maxVolume, volume, commitVolume],
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

  const safeVol = Math.min(Math.max(0, volume), maxVolume);
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
    <section className="pretzel-panel">
      <div className="pretzel-panel__header">
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
            <h2 className="pretzel-text-panel-title">LG TV</h2>
            {loading ? (
              <p className="pretzel-text-panel-muted">Loading…</p>
            ) : relayOffline ? (
              <p className="pretzel-text-panel-subtle">TV relay offline</p>
            ) : !connected ? (
              <p className="pretzel-text-panel-subtle">TV not connected</p>
            ) : !tvOn ? (
              <p className="pretzel-text-panel-subtle">TV standby</p>
            ) : (
              <p className="pretzel-text-panel-muted">
                {inputConnected ? "Source connected" : "No source"}
              </p>
            )}
          </div>
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => void fetchAll()}
            className="pretzel-btn-ghost"
          >
            Refresh
          </button>
        )}
      </div>

      <div className="pretzel-panel__body">
        {!loading && (
          <div className="pretzel-panel__divider-t">
            <p className="pretzel-remote-label">Remote</p>
            <div className="flex flex-wrap items-start justify-center gap-8">
              <div
                className="flex flex-col items-center gap-1.5"
                aria-label="TV volume"
              >
                <button
                  type="button"
                  disabled={controlsDisabled || pctLabel >= 100}
                  title="Volume up 1%"
                  className="pretzel-btn-icon flex h-10 w-10 items-center justify-center text-lg font-semibold leading-none"
                  onClick={() => bumpVolumeByPercent(1)}
                >
                  +
                </button>
                <div className="flex min-h-[2.25rem] flex-col items-center justify-center py-0.5">
                  <span className="pretzel-text-panel-title text-xl font-semibold tabular-nums">
                    {pctLabel}
                  </span>
                  <span className="pretzel-text-panel-muted text-[10px] font-medium uppercase tracking-wide">
                    %
                  </span>
                </div>
                <button
                  type="button"
                  disabled={controlsDisabled || pctLabel <= 0}
                  title="Volume down 1%"
                  className="pretzel-btn-icon flex h-10 w-10 items-center justify-center text-lg font-semibold leading-none"
                  onClick={() => bumpVolumeByPercent(-1)}
                >
                  −
                </button>
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={toggleMute}
                  className="pretzel-btn-icon mt-1 h-9 w-9"
                  title={muted ? "Unmute" : "Mute"}
                >
                  {muted ? "🔇" : "🔈"}
                </button>
              </div>
              {tvOn ? (
                <div className="pretzel-tv-dpad" aria-label="TV directional pad">
              <button
                type="button"
                disabled={remoteDisabled}
                title="Up"
                className="pretzel-tv-dpad__wedge pretzel-tv-dpad__wedge--up"
                onClick={() => sendRemote("/tv/up")}
              >
                <DpadChevron className="shrink-0" />
              </button>
              <button
                type="button"
                disabled={remoteDisabled}
                title="Right"
                className="pretzel-tv-dpad__wedge pretzel-tv-dpad__wedge--right"
                onClick={() => sendRemote("/tv/right")}
              >
                <DpadChevron className="shrink-0 rotate-90" />
              </button>
              <button
                type="button"
                disabled={remoteDisabled}
                title="Down"
                className="pretzel-tv-dpad__wedge pretzel-tv-dpad__wedge--down"
                onClick={() => sendRemote("/tv/down")}
              >
                <DpadChevron className="shrink-0 rotate-180" />
              </button>
              <button
                type="button"
                disabled={remoteDisabled}
                title="Left"
                className="pretzel-tv-dpad__wedge pretzel-tv-dpad__wedge--left"
                onClick={() => sendRemote("/tv/left")}
              >
                <DpadChevron className="shrink-0 -rotate-90" />
              </button>
              <button
                type="button"
                disabled={remoteDisabled}
                title="OK / Enter"
                className="pretzel-tv-dpad__ok"
                onClick={() => sendRemote("/tv/enter")}
              >
                OK
              </button>
                </div>
              ) : null}
            </div>
            {tvOn && (
              <div className="mt-3 flex flex-wrap justify-center gap-2">
                <button
                  type="button"
                  disabled={remoteDisabled}
                  title="Back"
                  className="pretzel-btn-icon-wide"
                  onClick={() => sendRemote("/tv/back")}
                >
                  Back
                </button>
                <button
                  type="button"
                  disabled={remoteDisabled}
                  title="Home"
                  className="pretzel-btn-icon-wide"
                  onClick={() => sendRemote("/tv/home")}
                >
                  Home
                </button>
                <button
                  type="button"
                  disabled={remoteDisabled}
                  title="Quick settings"
                  className="pretzel-btn-icon-wide"
                  onClick={() => sendRemote("/tv/settings")}
                >
                  Settings
                </button>
              </div>
            )}
          </div>
        )}

        <div className="pretzel-panel__divider-t flex flex-wrap items-center justify-end gap-2">
          {!tvOn && (
            <>
              {turningOn ? (
                <span className="pretzel-text-panel-muted">Waking TV…</span>
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
                <span className="pretzel-text-panel-muted">Turning off…</span>
              ) : (
                <button
                  type="button"
                  disabled={relayOffline || loading || turningOff}
                  onClick={handlePowerOffClick}
                  className={`pretzel-btn-ghost px-3 py-1.5 transition disabled:cursor-not-allowed disabled:opacity-50 ${
                    powerOffArmed
                      ? "border-amber-600 bg-amber-950/50 text-amber-200 hover:bg-amber-950/60"
                      : ""
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
