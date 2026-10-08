import { useCallback, useEffect, useRef, useState } from "react";
import { fetchJson } from "../lib/fetchJson";
import { VuMeter } from "./VuMeter";

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
  const [powerError, setPowerError] = useState<string | null>(null);
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

  /** Styling-only: show D-pad chrome from `remote-ui/.env` (`DEV_MODE=true`); never send TV actions. */
  const remoteUiDevMode = __REMOTE_UI_DEV_MODE__;
  const showTvRemoteChrome = tvOn || remoteUiDevMode;

  const controlsDisabled =
    relayOffline || !tvOn || loading || turningOff || remoteUiDevMode;
  const remoteDisabled =
    relayOffline ||
    !tvOn ||
    loading ||
    turningOff ||
    turningOn ||
    remoteUiDevMode;

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
          (s) => !s.tvOn || !s.socketConnected || !s.relayReachable,
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
    setPowerError(null);
    setTurningOn(true);
    void fetchJson("/tv/power/on", { method: "POST" })
      .then(async (r) => {
        setTurningOn(false);
        if (!r.ok) {
          const err = (r.data as { error?: unknown }).error;
          setPowerError(
            typeof err === "string" && err
              ? err
              : `Power on failed (${r.status})`,
          );
        }
        const snap = await fetchAll();
        if (!r.ok || !snap.relayReachable || snap.tvOn) return;
        startSyncPoll((s) => s.tvOn || !s.relayReachable, 120_000, 2_500);
      })
      .catch(async () => {
        setTurningOn(false);
        setPowerError("Could not reach the TV relay");
        await fetchAll();
      });
  };

  useEffect(() => {
    if (tvOn) setPowerError(null);
  }, [tvOn]);

  const powerKeyDisabled =
    relayOffline || loading || turningOn || turningOff || remoteUiDevMode;
  const powerLabel = turningOn
    ? "Waking…"
    : turningOff
      ? "Off…"
      : powerOffArmed
        ? "Confirm off"
        : "Power";
  const powerLedClass =
    relayOffline || loading || remoteUiDevMode
      ? ""
      : tvOn
        ? "pretzel-power-led--on"
        : turningOn
          ? "pretzel-power-led--standby"
          : "pretzel-power-led--standby pretzel-power-led--pulse";

  const safeVol = Math.min(Math.max(0, volume), maxVolume);
  const pctLabel =
    maxVolume > 0 ? Math.round((safeVol / maxVolume) * 100) : safeVol;

  const statusDotClass = relayOffline
    ? "pretzel-led--off"
    : !connected
      ? "pretzel-led--off"
      : tvOn
        ? "pretzel-led--ok"
        : "pretzel-led--warn";

  return (
    <section className="pretzel-panel">
      <div className="pretzel-panel__header">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={`pretzel-led mt-1.5 ${statusDotClass}`}
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
            {remoteUiDevMode && (
              <p className="pretzel-text-panel-subtle">
                Remote layout preview (DEV_MODE) — TV controls disabled
              </p>
            )}
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
        <div className="flex flex-shrink-0 items-center gap-2">
          <button
            type="button"
            disabled={powerKeyDisabled}
            onClick={tvOn ? handlePowerOffClick : handlePowerOnClick}
            title={
              tvOn
                ? powerOffArmed
                  ? "Tap again to turn the TV off"
                  : "Turn TV off"
                : "Turn TV on (Wake-on-LAN / network)"
            }
            className={`pretzel-btn-ghost gap-1.5 ${powerOffArmed ? "pretzel-key--danger" : ""}`}
          >
            <span className={`pretzel-power-led ${powerLedClass}`} aria-hidden />
            {powerLabel}
          </button>
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
      </div>
      {powerError && (
        <p className="pretzel-text-alert px-5 pt-3 text-xs" role="alert">
          {powerError}
        </p>
      )}

      <div className="pretzel-panel__body">
        {!loading && (
          <>
            <div className="flex flex-wrap items-start justify-center gap-8">
              {/* Volume controls */}
              <div
                className="flex flex-col items-center gap-1.5"
                aria-label="TV volume"
              >
                <button
                  type="button"
                  disabled={controlsDisabled || pctLabel >= 100}
                  title="Volume up 1%"
                  className="pretzel-btn-icon flex h-14 min-w-32 items-center justify-center text-xl font-semibold leading-none"
                  onClick={() => bumpVolumeByPercent(1)}
                >
                  +
                </button>
                <div className="flex w-full min-w-32 flex-col items-center justify-center gap-2 py-0.5">
                  <span className="pretzel-readout pretzel-readout--lg min-w-[4.5rem] text-center">
                    {pctLabel}%
                  </span>
                  <div className="w-full">
                    <VuMeter value={tvOn ? pctLabel : 0} />
                  </div>
                </div>
                <button
                  type="button"
                  disabled={controlsDisabled || pctLabel <= 0}
                  title="Volume down 1%"
                  className="pretzel-btn-icon flex h-14 min-w-32 items-center justify-center text-xl font-semibold leading-none"
                  onClick={() => bumpVolumeByPercent(-1)}
                >
                  −
                </button>
                <button
                  type="button"
                  disabled={controlsDisabled}
                  onClick={toggleMute}
                  className="pretzel-btn-icon mt-1 h-14 min-w-32"
                  title={muted ? "Unmute" : "Mute"}
                >
                  {muted ? "🔇" : "🔈"}
                </button>
              </div>
              {/* Navigation controls */}
              <div className="flex-1">
                {showTvRemoteChrome ? (
                  <div
                    className="pretzel-tv-dpad"
                    aria-label="TV directional pad"
                  >
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
                      ⏯
                    </button>
                  </div>
                ) : (
                  <div className="pretzel-well flex h-48 items-center justify-center text-center">
                    <p className="pretzel-text-panel-muted text-sm">
                      {relayOffline
                        ? "TV relay offline"
                        : turningOn
                          ? "Waking TV…"
                          : "TV is off — press POWER"}
                    </p>
                  </div>
                )}
                {showTvRemoteChrome && (
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
            </div>
          </>
        )}
      </div>
    </section>
  );
}
