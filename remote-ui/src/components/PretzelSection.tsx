import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../lib/fetchJson";

export const PRETZEL_SPEAK_MAX_CHARS = 8000;

export function PretzelSection() {
  const [volume, setVolume] = useState(0);
  const [localVolume, setLocalVolume] = useState(0);
  const [dragging, setDragging] = useState(false);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [speakText, setSpeakText] = useState("");
  const [speakSending, setSpeakSending] = useState(false);
  const [weatherSending, setWeatherSending] = useState(false);

  const fetchVolume = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetchJson("/pretzel/volume");
      const data = res.data as { volume?: number };
      if (!res.ok) {
        setOffline(true);
        return;
      }
      setOffline(false);
      if (typeof data.volume === "number" && Number.isFinite(data.volume)) {
        const v = Math.max(0, Math.min(100, data.volume));
        setVolume(v);
        setLocalVolume(v);
      }
    } catch {
      setOffline(true);
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
    <section className="rounded-xl border border-gray-700 bg-gray-900">
      <div className="flex items-start justify-between gap-3 border-b border-gray-700 p-4">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={`mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${
              offline ? "bg-red-500" : "bg-emerald-500"
            }`}
            title={offline ? "Pretzel server offline" : "Connected"}
            aria-hidden
          />
          <div className="min-w-0">
            <h2 className="text-base font-semibold text-gray-100">Pi speaker</h2>
            <p className="text-xs text-gray-400">
              {loading
                ? "Loading…"
                : offline
                  ? "Pretzel server offline"
                  : "USB audio on Pretzel"}
            </p>
          </div>
        </div>
        {!loading && (
          <button
            type="button"
            onClick={() => void fetchVolume()}
            className="flex-shrink-0 rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800"
          >
            Refresh
          </button>
        )}
      </div>

      <div className="border-t border-gray-700 p-4">
        <div className="flex items-center gap-2">
          <span className="text-sm opacity-70" aria-hidden>
            🔈
          </span>
          <input
            type="range"
            min={0}
            max={100}
            value={displayVol}
            disabled={offline || loading}
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
            className="h-1.5 w-full cursor-pointer appearance-none rounded-full bg-gray-700 accent-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
          />
          <span className="w-8 text-right text-[11px] tabular-nums text-gray-400">
            {displayVol}%
          </span>
        </div>
      </div>

      <div className="border-t border-gray-700 p-4">
        <label
          htmlFor="pretzel-speak-text"
          className="mb-1.5 block text-xs font-medium text-gray-400"
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
          className="mb-2 w-full resize-y rounded-lg border border-gray-600 bg-gray-950 px-3 py-2 text-sm text-gray-100 placeholder:text-gray-500 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500 disabled:cursor-not-allowed disabled:opacity-50"
        />
        <div className="flex items-center justify-between gap-2">
          <span className="text-[11px] tabular-nums text-gray-500">
            {speakText.length}/{PRETZEL_SPEAK_MAX_CHARS}
          </span>
          <div className="flex flex-shrink-0 items-center gap-2">
            <button
              type="button"
              disabled={offline || weatherSending}
              onClick={handleWeatherSpeak}
              className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-200 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {weatherSending ? "Sending…" : "Weather"}
            </button>
            <button
              type="button"
              disabled={
                offline || speakSending || speakText.trim().length === 0
              }
              onClick={handleSpeak}
              className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-1.5 text-xs font-medium text-gray-200 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
            >
              {speakSending ? "Sending…" : "Speak"}
            </button>
          </div>
        </div>
      </div>
    </section>
  );
}
