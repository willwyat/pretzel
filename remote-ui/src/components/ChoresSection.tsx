import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { fetchJson } from "../lib/fetchJson";
import {
  type Chore,
  choreDurationSeconds,
  formatDurationLabel,
} from "../types/chores";

const NY_TZ = "America/New_York";

const nyTimeFmt = new Intl.DateTimeFormat("en-US", {
  timeZone: NY_TZ,
  hour: "numeric",
  minute: "2-digit",
  hour12: true,
});

function isChoresResponse(data: unknown): data is { ok: true; chores: Chore[] } {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.ok === true && Array.isArray(d.chores);
}

function completedInLast24h(chore: Chore): boolean {
  if (!chore.lastCompletedAt) return false;
  const t = new Date(chore.lastCompletedAt).getTime();
  return Date.now() - t < 24 * 60 * 60 * 1000;
}

type UiMode = "idle" | "sprint-setup" | "sprint-active";

type SprintSplit =
  | { kind: "active"; active: Chore; inChoreMs: number }
  | { kind: "done" };

function splitSprintElapsed(
  queue: Chore[],
  completed: Set<string>,
  elapsedMs: number,
): SprintSplit {
  let t = 0;
  for (const c of queue) {
    if (completed.has(c.id)) continue;
    const d = choreDurationSeconds(c) * 1000;
    if (elapsedMs < t + d) {
      return { kind: "active", active: c, inChoreMs: elapsedMs - t };
    }
    t += d;
  }
  return { kind: "done" };
}

/** Wall-clock ms remaining in the sprint from current elapsed position. */
function remainingWorkMs(
  queue: Chore[],
  completed: Set<string>,
  elapsedMs: number,
): number {
  const split = splitSprintElapsed(queue, completed, elapsedMs);
  if (split.kind === "done") return 0;
  let total = 0;
  let seen = false;
  for (const c of queue) {
    if (completed.has(c.id)) continue;
    const d = choreDurationSeconds(c) * 1000;
    if (!seen) {
      total += d - split.inChoreMs;
      seen = true;
    } else {
      total += d;
    }
  }
  return Math.max(0, total);
}

export function ChoresSection() {
  const [chores, setChores] = useState<Chore[]>([]);
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [mode, setMode] = useState<UiMode>("idle");
  const [expandedDone, setExpandedDone] = useState(false);

  const [setupOrder, setSetupOrder] = useState<string[]>([]);
  const [setupSelected, setSetupSelected] = useState<Record<string, boolean>>(
    {},
  );

  const [sprintQueue, setSprintQueue] = useState<Chore[]>([]);
  const [sprintCompleted, setSprintCompleted] = useState<Set<string>>(
    () => new Set(),
  );
  const sprintStartedAtRef = useRef(0);
  const pausedAccumMsRef = useRef(0);
  const pauseSinceRef = useRef<number | null>(null);
  const [paused, setPaused] = useState(false);
  const [tick, setTick] = useState(0);
  const wakeRef = useRef<WakeLockSentinel | null>(null);
  const [wakeHeld, setWakeHeld] = useState(false);
  const [pausedEndMs, setPausedEndMs] = useState<number | null>(null);

  const sprintQueueRef = useRef(sprintQueue);
  sprintQueueRef.current = sprintQueue;
  const sprintCompletedRef = useRef(sprintCompleted);
  sprintCompletedRef.current = sprintCompleted;

  const loadChores = useCallback(async () => {
    setLoading(true);
    try {
      const [statusRes, choresRes] = await Promise.all([
        fetchJson("/pretzel/status"),
        fetchJson("/pretzel/chores"),
      ]);
      if (!statusRes.ok) {
        setOffline(true);
        setChores([]);
        return;
      }
      setOffline(false);
      if (!choresRes.ok || !isChoresResponse(choresRes.data)) {
        setChores([]);
        return;
      }
      setChores(choresRes.data.chores);
    } catch {
      setOffline(true);
      setChores([]);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadChores();
  }, [loadChores]);

  const pendingChores = useMemo(
    () => chores.filter((c) => c.pending),
    [chores],
  );

  const recentlyCompleted = useMemo(
    () => chores.filter((c) => completedInLast24h(c)),
    [chores],
  );

  const statusDotClass = offline
    ? "pretzel-led--off"
    : loading
      ? "pretzel-led--warn"
      : "pretzel-led--ok";
  const statusTitle = offline
    ? "Pretzel server offline"
    : loading
      ? "Loading…"
      : "Connected";

  const enterSprintSetup = () => {
    const ids = pendingChores.map((c) => c.id);
    const sel: Record<string, boolean> = {};
    for (const id of ids) sel[id] = true;
    setSetupOrder(ids);
    setSetupSelected(sel);
    setMode("sprint-setup");
  };

  const moveSetup = (id: string, dir: -1 | 1) => {
    setSetupOrder((prev) => {
      const i = prev.indexOf(id);
      if (i < 0) return prev;
      const j = i + dir;
      if (j < 0 || j >= prev.length) return prev;
      const next = [...prev];
      [next[i], next[j]] = [next[j], next[i]];
      return next;
    });
  };

  const startSprint = () => {
    const queue = setupOrder
      .filter((id) => setupSelected[id])
      .map((id) => chores.find((c) => c.id === id))
      .filter((c): c is Chore => Boolean(c));
    if (queue.length === 0) return;
    setSprintQueue(queue);
    setSprintCompleted(new Set());
    sprintStartedAtRef.current = Date.now();
    pausedAccumMsRef.current = 0;
    pauseSinceRef.current = null;
    setPaused(false);
    setMode("sprint-active");
  };

  const cancelSprintSetup = () => setMode("idle");

  const stopSprint = useCallback(() => {
    void wakeRef.current?.release();
    wakeRef.current = null;
    setWakeHeld(false);
    setPausedEndMs(null);
    setMode("idle");
    void loadChores();
  }, [loadChores]);

  useEffect(() => {
    if (mode !== "sprint-active") return;
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      if (paused) return;
      const now = Date.now();
      const pauseExtra = pauseSinceRef.current
        ? now - pauseSinceRef.current
        : 0;
      const elapsed =
        now -
        sprintStartedAtRef.current -
        pausedAccumMsRef.current -
        pauseExtra;
      const queue = sprintQueueRef.current;
      const done = new Set(sprintCompletedRef.current);
      const split = splitSprintElapsed(queue, done, elapsed);
      if (split.kind === "done") {
        stopSprint();
        return;
      }
      const durMs = choreDurationSeconds(split.active) * 1000;
      if (durMs > 0 && split.inChoreMs >= durMs && !done.has(split.active.id)) {
        done.add(split.active.id);
        sprintCompletedRef.current = done;
        setSprintCompleted(new Set(done));
        void fetchJson(
          `/pretzel/chores/${encodeURIComponent(split.active.id)}/complete`,
          { method: "POST" },
        ).then(() => {
          void loadChores();
        });
      }
    }, 1000);
    return () => window.clearInterval(id);
  }, [mode, paused, loadChores, stopSprint]);

  useEffect(() => {
    if (mode !== "sprint-active") {
      void wakeRef.current?.release();
      wakeRef.current = null;
      setWakeHeld(false);
      return;
    }
    if (!("wakeLock" in navigator)) return;
    void navigator.wakeLock
      .request("screen")
      .then((w) => {
        wakeRef.current = w;
        setWakeHeld(true);
      })
      .catch(() => setWakeHeld(false));
    return () => {
      void wakeRef.current?.release();
      wakeRef.current = null;
      setWakeHeld(false);
    };
  }, [mode]);

  const sprintEndTimeLabel = useMemo(() => {
    if (mode !== "sprint-active") return "";
    if (paused && pausedEndMs != null) {
      return nyTimeFmt.format(new Date(pausedEndMs));
    }
    const now = Date.now();
    const pauseExtra = pauseSinceRef.current
      ? now - pauseSinceRef.current
      : 0;
    const elapsed =
      now -
      sprintStartedAtRef.current -
      pausedAccumMsRef.current -
      pauseExtra;
    const rem = remainingWorkMs(sprintQueue, sprintCompleted, elapsed);
    return nyTimeFmt.format(new Date(Date.now() + rem));
  }, [mode, sprintQueue, sprintCompleted, paused, pausedEndMs, tick]);

  const sprintSplit = useMemo((): SprintSplit | null => {
    if (mode !== "sprint-active") return null;
    const now = Date.now();
    const pauseExtra = pauseSinceRef.current
      ? now - pauseSinceRef.current
      : 0;
    const elapsed =
      now -
      sprintStartedAtRef.current -
      pausedAccumMsRef.current -
      pauseExtra;
    return splitSprintElapsed(sprintQueue, sprintCompleted, elapsed);
  }, [mode, sprintQueue, sprintCompleted, paused, tick]);

  const completeChore = async (id: string) => {
    const res = await fetchJson(
      `/pretzel/chores/${encodeURIComponent(id)}/complete`,
      { method: "POST" },
    );
    if (res.ok) void loadChores();
  };

  const uncompleteChore = async (id: string) => {
    const res = await fetchJson(
      `/pretzel/chores/${encodeURIComponent(id)}/uncomplete`,
      { method: "POST" },
    );
    if (res.ok) void loadChores();
  };

  const togglePause = () => {
    if (!paused) {
      const now = Date.now();
      const elapsed =
        now -
        sprintStartedAtRef.current -
        pausedAccumMsRef.current;
      const rem = remainingWorkMs(
        sprintQueueRef.current,
        sprintCompletedRef.current,
        elapsed,
      );
      setPausedEndMs(now + rem);
      pauseSinceRef.current = Date.now();
      setPaused(true);
    } else {
      if (pauseSinceRef.current) {
        pausedAccumMsRef.current += Date.now() - pauseSinceRef.current;
      }
      pauseSinceRef.current = null;
      setPaused(false);
      setPausedEndMs(null);
    }
  };

  if (mode === "sprint-active") {
    const split = sprintSplit;
    const active = split?.kind === "active" ? split.active : null;
    const inChoreMs = split?.kind === "active" ? split.inChoreMs : 0;
    const activeDur = active ? choreDurationSeconds(active) * 1000 : 1;
    const barPct = active
      ? Math.min(100, Math.round((inChoreMs / activeDur) * 100))
      : 0;

    return (
      <div className="pretzel-vfd-screen fixed inset-0 z-50 flex flex-col">
        <div className="flex flex-1 flex-col px-4 pb-8 pt-[max(1rem,env(safe-area-inset-top))]">
          <div className="mb-6 text-center">
            <div className="pretzel-vfd-label mb-2">
              End time
            </div>
            <div className="flex items-center justify-center gap-2">
              <span className="pretzel-readout pretzel-readout--xl">
                {sprintEndTimeLabel}
              </span>
              {wakeHeld ? (
                <span
                  className="pretzel-vfd-label text-lg"
                  title="Screen wake lock on"
                  aria-hidden
                >
                  🔒
                </span>
              ) : null}
            </div>
            <button
              type="button"
              className="pretzel-btn-ghost mx-auto mt-4"
              onClick={togglePause}
            >
              {paused ? "Resume" : "Pause"}
            </button>
          </div>

          <div className="flex flex-1 flex-col gap-2 overflow-y-auto">
            {sprintQueue.map((c) => {
              const done = sprintCompleted.has(c.id);
              const isActive = active?.id === c.id;
              return (
                <div
                  key={c.id}
                  className={`pretzel-vfd-row ${
                    isActive
                      ? "pretzel-vfd-row--active"
                      : done
                        ? "pretzel-vfd-row--done"
                        : ""
                  }`}
                >
                  {isActive ? (
                    <div
                      className="pretzel-vfd-bar pointer-events-none absolute inset-y-0 left-0 transition-[width] duration-1000 ease-linear"
                      style={{ width: `${barPct}%` }}
                    />
                  ) : null}
                  <div className="relative flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={done}
                      onChange={(e) => {
                        if (e.target.checked) {
                          setSprintCompleted((prev) => {
                            const n = new Set(prev);
                            n.add(c.id);
                            sprintCompletedRef.current = n;
                            return n;
                          });
                          void completeChore(c.id);
                        } else {
                          setSprintCompleted((prev) => {
                            const n = new Set(prev);
                            n.delete(c.id);
                            sprintCompletedRef.current = n;
                            return n;
                          });
                          void uncompleteChore(c.id);
                        }
                      }}
                      className="h-5 w-5 shrink-0"
                    />
                    <span className="min-w-0 flex-1 font-medium">{c.name}</span>
                    {isActive ? (
                      <span className="pretzel-readout shrink-0 text-sm">
                        {Math.max(
                          0,
                          Math.ceil((activeDur - inChoreMs) / 1000),
                        )}
                        s
                      </span>
                    ) : (
                      <span className="pretzel-vfd-label shrink-0">
                        {formatDurationLabel(choreDurationSeconds(c))}
                      </span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-6 flex justify-center">
            <button
              type="button"
              className="pretzel-btn-icon pretzel-key--danger h-16 w-16 rounded-full"
              title="Stop sprint"
              onClick={stopSprint}
            >
              <span className="block h-4 w-4 rounded-sm bg-current" />
            </button>
          </div>
        </div>
      </div>
    );
  }

  if (mode === "sprint-setup") {
    return (
      <section className="pretzel-panel mt-6">
        <div className="pretzel-panel__header">
          <h2 className="pretzel-text-panel-title">Sprint setup</h2>
        </div>
        <div className="pretzel-panel__body space-y-3">
          <p className="pretzel-text-panel-muted text-sm">
            Reorder with arrows, uncheck to skip. End time uses America/New_York.
          </p>
          <ul className="space-y-2">
            {setupOrder.map((id) => {
              const c = chores.find((x) => x.id === id);
              if (!c) return null;
              const sel = setupSelected[id] !== false;
              return (
                <li
                  key={id}
                  className="pretzel-well pretzel-well--row flex items-center gap-2"
                >
                  <input
                    type="checkbox"
                    checked={sel}
                    onChange={(e) =>
                      setSetupSelected((s) => ({ ...s, [id]: e.target.checked }))
                    }
                    className="h-4 w-4"
                  />
                  <span className="min-w-0 flex-1 text-sm font-medium">
                    {c.name}
                  </span>
                  <span className="pretzel-text-panel-muted text-xs">
                    {formatDurationLabel(choreDurationSeconds(c))}
                  </span>
                  <div className="flex flex-col gap-0.5">
                    <button
                      type="button"
                      className="pretzel-btn-ghost px-1 py-0 text-xs"
                      aria-label="Move up"
                      onClick={() => moveSetup(id, -1)}
                    >
                      ↑
                    </button>
                    <button
                      type="button"
                      className="pretzel-btn-ghost px-1 py-0 text-xs"
                      aria-label="Move down"
                      onClick={() => moveSetup(id, 1)}
                    >
                      ↓
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
          <div className="flex flex-wrap gap-2 pt-2">
            <button
              type="button"
              className="pretzel-btn-secondary"
              onClick={cancelSprintSetup}
            >
              Cancel
            </button>
            <button
              type="button"
              className="pretzel-btn-secondary pretzel-key--accent px-5"
              onClick={startSprint}
            >
              Start
            </button>
          </div>
        </div>
      </section>
    );
  }

  return (
    <section className="pretzel-panel mt-6">
      <div className="pretzel-panel__header">
        <div className="flex min-w-0 flex-1 items-start gap-3">
          <span
            className={`pretzel-led mt-1.5 ${statusDotClass}`}
            title={statusTitle}
            aria-hidden
          />
          <div className="min-w-0">
            <h2 className="pretzel-text-panel-title">Chores</h2>
            <p className="pretzel-text-panel-muted">
              {loading
                ? "Loading…"
                : offline
                  ? "Pretzel server offline"
                  : `${pendingChores.length} pending`}
            </p>
          </div>
        </div>
        <button
          type="button"
          className="pretzel-btn-ghost pretzel-btn-ghost--sm flex-shrink-0"
          onClick={() => void loadChores()}
        >
          Refresh
        </button>
      </div>
      <div className="pretzel-panel__body space-y-3">
        {pendingChores.length > 0 ? (
          <button
            type="button"
            className="pretzel-btn-secondary pretzel-key--accent w-full"
            onClick={enterSprintSetup}
          >
            Start sprint
          </button>
        ) : null}

        <ul className="space-y-2">
          {[...chores]
            .sort((a, b) => {
              const pa = a.pending ? 0 : 1;
              const pb = b.pending ? 0 : 1;
              return pa - pb || a.name.localeCompare(b.name);
            })
            .map((c) => (
              <li
                key={c.id}
                className={`flex items-center gap-3 ${
                  c.pending
                    ? "pretzel-well pretzel-well--row"
                    : "px-3 py-2 opacity-60"
                }`}
              >
                <input
                  type="checkbox"
                  checked={!c.pending}
                  disabled={!c.pending}
                  onChange={(e) => {
                    if (c.pending && e.target.checked) void completeChore(c.id);
                  }}
                  className="h-5 w-5 shrink-0"
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate font-medium">{c.name}</span>
                    {c.missed > 1 ? (
                      <span className="pretzel-tag--alert">
                        Overdue ×{c.missed}
                      </span>
                    ) : null}
                  </div>
                  {c.activeSlot && c.pending ? (
                    <p className="pretzel-text-panel-muted text-xs">
                      Due since {nyTimeFmt.format(new Date(c.activeSlot))} NY
                    </p>
                  ) : null}
                </div>
                <span className="pretzel-text-panel-muted shrink-0 text-sm tabular-nums">
                  {formatDurationLabel(choreDurationSeconds(c))}
                </span>
              </li>
            ))}
        </ul>

        {recentlyCompleted.length > 0 ? (
          <div className="pretzel-panel__block-bordered pt-3">
            <button
              type="button"
              className="pretzel-text-panel-muted mb-2 flex w-full items-center justify-between text-left text-sm"
              onClick={() => setExpandedDone((e) => !e)}
            >
              <span>Completed (24h)</span>
              <span>{expandedDone ? "▼" : "▶"}</span>
            </button>
            {expandedDone ? (
              <ul className="space-y-1">
                {recentlyCompleted.map((c) => (
                  <li
                    key={c.id}
                    className="flex items-center justify-between gap-2 text-sm opacity-80"
                  >
                    <span className="truncate">{c.name}</span>
                    <button
                      type="button"
                      className="pretzel-text-alert shrink-0 text-xs underline"
                      onClick={() => void uncompleteChore(c.id)}
                    >
                      Undo
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
      </div>
    </section>
  );
}
