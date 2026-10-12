import { useCallback, useEffect, useState } from "react";
import { type FetchJsonResult, fetchJson } from "../lib/fetchJson";
import { countdown, isUpcomingResponse } from "../lib/routines";
import type {
  RoutineCycle,
  UpcomingResponse,
  UpcomingRoutine,
  UpcomingStep,
} from "../types/routines";
import { Icon, type IconName } from "./Icon";

const POLL_MS = 60_000;
/** Re-render for countdowns between polls. */
const CLOCK_MS = 30_000;

type Status = { label: string; tone: "next" | "ok" | "alert" | "muted" | "moved" };

function routineStatus(r: UpcomingRoutine, isNext: boolean, now: number): Status | null {
  if (!r.enabled) return { label: "Off", tone: "muted" };
  if (r.skipped) return { label: "Skipped", tone: "muted" };
  const runs = r.steps.map((s) => s.run);
  if (runs.some((x) => x?.ok === false)) return { label: "Failed", tone: "alert" };
  if (r.past && runs.every((x) => x?.ok === true)) return { label: "Done", tone: "ok" };
  if (r.past && runs.some((x) => x === null)) return { label: "Missed", tone: "muted" };
  if (isNext) return { label: countdown(r.at, now), tone: "next" };
  if (r.override?.time) return { label: "Moved", tone: "moved" };
  return null;
}

function stepIcon(s: UpcomingStep): IconName | null {
  if (s.type === "speak") return "notifications_active";
  if (s.type === "lights") return s.power === "off" ? "light_off" : "lightbulb";
  return null;
}

/** One glyph per kind of action the routine runs, in order of first use. */
function actionIcons(r: UpcomingRoutine): IconName[] {
  const out: IconName[] = [];
  for (const s of r.steps) {
    const icon = stepIcon(s);
    if (icon && !out.includes(icon)) out.push(icon);
  }
  return out;
}

function weekdayLabel(cycle: RoutineCycle): string {
  // The cycle date is a calendar date; format it as one (UTC noon is inside it everywhere).
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "UTC",
    weekday: "short",
    month: "short",
    day: "numeric",
  }).format(new Date(`${cycle.date}T12:00:00Z`));
}

type RowProps = {
  routine: UpcomingRoutine;
  cycleDate: string;
  isNext: boolean;
  now: number;
  expanded: boolean;
  busy: boolean;
  onToggle: () => void;
  onAction: (fn: () => Promise<FetchJsonResult>) => void;
};

function RoutineRow({ routine: r, cycleDate, isNext, now, expanded, busy, onToggle, onAction }: RowProps) {
  const [moveTo, setMoveTo] = useState(r.override?.time ?? r.time);
  useEffect(() => setMoveTo(r.override?.time ?? r.time), [r.override?.time, r.time]);

  const status = routineStatus(r, isNext, now);
  const overridePath = `/pretzel/routines/${encodeURIComponent(r.id)}/override/${cycleDate}`;
  const editable = !r.past && r.enabled;

  return (
    <li
      className={`pretzel-sched-row${isNext ? " pretzel-sched-row--next" : ""}${
        r.past || r.skipped || !r.enabled ? " pretzel-sched-row--dim" : ""
      }`}
    >
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        aria-expanded={expanded}
        onClick={onToggle}
      >
        <span className="pretzel-text-card-name min-w-0 flex-1 truncate">{r.name}</span>
        {/* One lamp: what the routine does, then when it runs. */}
        <span className="pretzel-readout pretzel-sched-time">
          {actionIcons(r).map((icon) => (
            <Icon key={icon} name={icon} className="pretzel-sched-time__icon" />
          ))}
          <span className={`pretzel-sched-time__clock${r.skipped ? " line-through" : ""}`}>
            {r.time}
          </span>
        </span>
      </button>

      {expanded && (
        <div className="mt-3 flex flex-col gap-3">
          {(status || r.source !== r.time) && (
            <div className="flex items-center gap-2">
              {status && (
                <span className={`pretzel-sched-tag pretzel-sched-tag--${status.tone}`}>
                  {status.label}
                </span>
              )}
              {/* A plain clock time is already on the lamp; show where other times come from. */}
              {r.source !== r.time && (
                <span className="pretzel-text-panel-subtle min-w-0 truncate text-xs">{r.source}</span>
              )}
            </div>
          )}
          <ul className="flex flex-col gap-1.5">
            {r.steps.map((s) => (
              <li key={s.idx} className="flex items-start gap-2 text-xs">
                <span className="pretzel-text-panel-muted w-10 shrink-0 font-mono">{s.time}</span>
                <span className="pretzel-text-panel-body min-w-0 flex-1">
                  {s.summary}
                  {s.run?.ok === false && s.run.error ? (
                    <span className="pretzel-text-alert block">{s.run.error}</span>
                  ) : null}
                </span>
                {s.run?.ok === true && <span className="pretzel-text-panel-muted">✓</span>}
              </li>
            ))}
          </ul>

          <div className="flex flex-wrap items-center gap-2">
            {editable && !r.skipped && (
              <button
                type="button"
                disabled={busy}
                className="pretzel-btn-ghost pretzel-btn-ghost--sm"
                onClick={() =>
                  onAction(() =>
                    fetchJson(overridePath, { method: "PUT", body: JSON.stringify({ skip: true }) }),
                  )
                }
              >
                Skip once
              </button>
            )}
            {editable && (
              <span className="flex items-center gap-1.5">
                <input
                  type="time"
                  value={moveTo}
                  aria-label={`Move ${r.name} this once`}
                  onChange={(e) => setMoveTo(e.target.value)}
                  className="pretzel-input w-32 py-1"
                />
                <button
                  type="button"
                  disabled={busy || !/^\d{2}:\d{2}$/.test(moveTo) || moveTo === r.time}
                  className="pretzel-btn-ghost pretzel-btn-ghost--sm"
                  onClick={() =>
                    onAction(() =>
                      fetchJson(overridePath, { method: "PUT", body: JSON.stringify({ time: moveTo }) }),
                    )
                  }
                >
                  Move once
                </button>
              </span>
            )}
            {r.override && !r.past && (
              <button
                type="button"
                disabled={busy}
                className="pretzel-btn-ghost pretzel-btn-ghost--sm"
                onClick={() => onAction(() => fetchJson(overridePath, { method: "DELETE" }))}
              >
                {r.skipped ? "Undo skip" : "Back to usual time"}
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              className="pretzel-btn-ghost pretzel-btn-ghost--sm ml-auto"
              onClick={() => {
                if (!window.confirm(`Run ${r.name} now?`)) return;
                onAction(() =>
                  fetchJson(`/pretzel/routines/${encodeURIComponent(r.id)}/run`, { method: "POST" }),
                );
              }}
            >
              Run now
            </button>
          </div>
        </div>
      )}
    </li>
  );
}

export function RoutinesSection() {
  const [data, setData] = useState<UpcomingResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<0 | 1>(0);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  const load = useCallback(async () => {
    try {
      const res = await fetchJson("/pretzel/routines/upcoming");
      if (!res.ok || !isUpcomingResponse(res.data)) {
        setError("Could not load routines");
        return;
      }
      setError(null);
      setData(res.data);
    } catch {
      setError("Could not reach Pretzel");
    } finally {
      setLoading(false);
      setNow(Date.now());
    }
  }, []);

  useEffect(() => {
    void load();
    const poll = setInterval(() => void load(), POLL_MS);
    const clock = setInterval(() => setNow(Date.now()), CLOCK_MS);
    return () => {
      clearInterval(poll);
      clearInterval(clock);
    };
  }, [load]);

  const act = useCallback(
    (fn: () => Promise<FetchJsonResult>) => {
      setBusy(true);
      void fn()
        .then((res) => {
          if (!res.ok) {
            const body = res.data as { error?: unknown };
            setError(typeof body.error === "string" ? body.error : `Failed (${res.status})`);
          }
        })
        .catch(() => setError("Could not reach Pretzel"))
        // "Run now" works in the background; give it a moment before refreshing.
        .finally(() => setTimeout(() => void load().finally(() => setBusy(false)), 600));
    },
    [load],
  );

  const cycle = data?.cycles[view];
  const led = loading ? "pretzel-led--loading" : error ? "pretzel-led--off" : "pretzel-led--ok";

  return (
    <section className="pretzel-panel" aria-label="Routines">
      <div className="pretzel-panel__header">
        <div className="flex min-w-0 flex-1 items-center gap-3">
          <span className={`pretzel-led ${led}`} aria-hidden />
          <div className="min-w-0">
            <h2 className="pretzel-text-panel-title">Routines</h2>
          </div>
        </div>
        {data && (
          <div className="flex gap-1" role="tablist" aria-label="Which day">
            {data.cycles.map((c, i) => (
              <button
                key={c.date}
                type="button"
                role="tab"
                aria-selected={view === i}
                onClick={() => {
                  setView(i as 0 | 1);
                  setExpanded(null);
                }}
                className={`pretzel-btn-ghost pretzel-btn-ghost--sm${view === i ? " pretzel-key--accent" : ""}`}
                title={weekdayLabel(c)}
              >
                {i === 0 ? "Today" : "Tomorrow"}
              </button>
            ))}
          </div>
        )}
      </div>

      <div className="pretzel-panel__body flex flex-col gap-3">
        {error && <p className="pretzel-text-alert text-sm">{error}</p>}
        {cycle && data && (
          <>
            {cycle.routines.length === 0 ? (
              <p className="pretzel-text-panel-muted text-sm">No routines on {weekdayLabel(cycle)}.</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {cycle.routines.map((r) => (
                  <RoutineRow
                    key={r.id}
                    routine={r}
                    cycleDate={cycle.date}
                    isNext={data.next?.id === r.id && data.next.cycleDate === cycle.date}
                    now={now}
                    expanded={expanded === r.id}
                    busy={busy}
                    onToggle={() => setExpanded((cur) => (cur === r.id ? null : r.id))}
                    onAction={act}
                  />
                ))}
              </ul>
            )}
            <p className="pretzel-text-panel-subtle text-xs">
              {weekdayLabel(cycle)}
              {cycle.sunrise ? ` · Sunrise ${cycle.sunrise}` : ""}
              {cycle.sunset ? ` · Sunset ${cycle.sunset}` : ""}
              {" · Pi clock "}
              {new Intl.DateTimeFormat("en-GB", {
                timeZone: data.tz,
                hour: "2-digit",
                minute: "2-digit",
              }).format(new Date(data.now))}
            </p>
          </>
        )}
      </div>
    </section>
  );
}
