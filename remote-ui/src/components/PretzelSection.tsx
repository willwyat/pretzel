import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../lib/fetchJson";

export const PRETZEL_SPEAK_MAX_CHARS = 8000;

export function PretzelSection() {
  const [volume, setVolume] = useState(0);
  const [localVolume, setLocalVolume] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  /** Reachable on the network (do not infer from /pretzel/volume — that can 500 if ALSA fails). */
  const [offline, setOffline] = useState(false);
  const [volumeReadOk, setVolumeReadOk] = useState(false);
  const [speakText, setSpeakText] = useState("");
  const [speakSending, setSpeakSending] = useState(false);
  const [weatherSending, setWeatherSending] = useState(false);

  const fetchVolume = useCallback(async () => {
    setLoading(true);
    setVolumeReadOk(false);
    try {
      const statusRes = await fetchJson("/pretzel/status");
      if (!statusRes.ok) {
        setOffline(true);
        return;
      }
      setOffline(false);

      const res = await fetchJson("/pretzel/volume");
      const data = res.data as { volume?: number };
      if (!res.ok) {
        setVolumeReadOk(false);
        return;
      }
      setVolumeReadOk(true);
      if (typeof data.volume === "number" && Number.isFinite(data.volume)) {
        const v = Math.max(0, Math.min(100, data.volume));
        setVolume(v);
        setLocalVolume(v);
      }
    } catch {
      setOffline(true);
      setVolumeReadOk(false);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void fetchVolume();
  }, [fetchVolume]);

  const commitVolume = useCallback((val: number) => {
    const clamped = Math.max(0, Math.min(100, Math.round(val)));
    setVolume(clamped);
    setLocalVolume(clamped);
    void fetchJson("/pretzel/volume", {
      method: "POST",
      body: JSON.stringify({ volume: clamped, announce: true }),
    }).catch(() => {});
  }, []);

  const displayVol = dragging ? localVolume : volume;

  const statusDotClass = offline
    ? "bg-red-500"
    : !volumeReadOk
      ? "bg-amber-500"
      : "bg-emerald-500";
  const statusTitle = offline
    ? "Pretzel server offline"
    : !volumeReadOk
      ? "Connected — volume read failed (check ALSA / amixer on the Pi)"
      : "Connected";

  const handleSpeak = () => {
    const text = speakText.trim();
    if (!text || offline || speakSending) return;
    setSpeakSending(true);
    void fetchJson("/pretzel/speak", {
      method: "POST",
      body: JSON.stringify({ text }),
    })
      .then((res) => {
        if (res.ok) setSpeakText("");
      })
      .catch(() => {})
      .finally(() => setSpeakSending(false));
  };

  const handleWeatherSpeak = () => {
    if (offline || weatherSending) return;
    setWeatherSending(true);
    const at = new Date().toISOString();
    void fetchJson("/pretzel/weather", {
      method: "POST",
      body: JSON.stringify({ requestedAt: at }),
    })
      .catch(() => {})
      .finally(() => setWeatherSending(false));
  };

  return (
    <section className="pretzel-panel">
      <div className="pretzel-panel__header">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={`mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${statusDotClass}`}
            title={statusTitle}
            aria-hidden
          />
          <div className="min-w-0">
            <h2 className="pretzel-text-panel-title">Pi speaker</h2>
            <p className="pretzel-text-panel-muted">
              {loading
                ? "Loading…"
                : offline
                  ? "Pretzel server offline"
                  : !volumeReadOk
                    ? "Connected — could not read volume (ALSA)"
                    : "USB audio on Pretzel"}
            </p>
          </div>
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => void fetchVolume()}
            className="pretzel-btn-ghost"
          >
            Refresh
          </button>
        )}
      </div>

      <div className="pretzel-panel__body">
        <div className="flex items-center gap-2">
          <span className="pretzel-text-panel-muted text-sm opacity-70" aria-hidden>
            🔈
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={displayVol}
            disabled={offline || loading || !volumeReadOk}
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
            className="pretzel-range w-full"
          />
          <span className="pretzel-vol-pct">{displayVol}%</span>
        </div>
      </div>

      <div className="pretzel-panel__body pretzel-panel__block-bordered">
        <label
          htmlFor="pretzel-speak-text"
          className="pretzel-text-panel-muted mb-1.5 block text-xs font-medium"
        >
          Speak on Pretzel
        </label>
        <textarea
          id="pretzel-speak-text"
          value={speakText}
          onChange={(e) =>
            setSpeakText(e.target.value.slice(0, PRETZEL_SPEAK_MAX_CHARS))
          }
          disabled={offline || speakSending}
          rows={3}
          placeholder={
            offline
              ? "Connect to Pretzel to send speech…"
              : "Type something for OpenAI TTS on the Pi…"
          }
          className="pretzel-input mb-2 min-h-[4.5rem] resize-y disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="pretzel-text-panel-subtle text-[11px] tabular-nums">
            {speakText.length}/{PRETZEL_SPEAK_MAX_CHARS}
          </span>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={offline || weatherSending}
              onClick={handleWeatherSpeak}
              className="pretzel-btn-secondary px-3 py-1.5 text-xs disabled:cursor-not-allowed"
            >
              {weatherSending ? "Sending…" : "Weather"}
            </button>
            <button
              type="button"
              disabled={
                offline || speakSending || speakText.trim().length === 0
              }
              onClick={handleSpeak}
              className="pretzel-btn-secondary px-3 py-1.5 text-xs disabled:cursor-not-allowed"
            >
              {speakSending ? "Sending…" : "Speak"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
