import { createContext, useCallback, useContext, useEffect, useState } from "react";
import { fetchJson } from "../lib/fetchJson";
import { WEEKDAYS } from "../lib/routines";
import type {
  LightsAction,
  Routine,
  RoutineAction,
  RoutineStep,
  SonosAction,
  SonosFavorite,
  SonosPlayer,
  SpeakAction,
} from "../types/routines";

/** Sonos speakers and favorites (through Wyat), loaded once for every step's pickers. */
type SonosCatalog = {
  players: SonosPlayer[];
  favorites: SonosFavorite[];
  error: string | null;
};
const SonosCatalogContext = createContext<SonosCatalog>({ players: [], favorites: [], error: null });

async function loadSonosCatalog(): Promise<SonosCatalog> {
  try {
    const [p, f] = await Promise.all([fetchJson("/pretzel/sonos/players"), fetchJson("/pretzel/sonos/favorites")]);
    const players = (p.data as { players?: SonosPlayer[] }).players;
    const favorites = (f.data as { favorites?: SonosFavorite[] }).favorites;
    if (!p.ok || !f.ok || !Array.isArray(players) || !Array.isArray(favorites)) {
      const err = (p.data as { error?: string }).error ?? (f.data as { error?: string }).error;
      return { players: [], favorites: [], error: err ?? "Could not load Sonos speakers" };
    }
    return { players, favorites, error: null };
  } catch {
    return { players: [], favorites: [], error: "Could not reach Pretzel" };
  }
}

type FetchAdmin = (
  path: string,
  init?: RequestInit,
) => Promise<{ ok: boolean; status: number; data: unknown }>;

/** Room targets offered as toggles; other saved targets (light:…) are kept as they are. */
const ROOMS = ["Lounge", "Bedroom"];

const KELVINS: { value: number; label: string }[] = [
  { value: 2200, label: "2200K orange" },
  { value: 2700, label: "2700K warm" },
  { value: 3500, label: "3500K neutral" },
  { value: 4000, label: "4000K natural" },
  { value: 5000, label: "5000K cool" },
  { value: 6500, label: "6500K daylight" },
];

const FILL_INS = "{{time}} {{date}} {{sunrise}} {{sunset}} {{tempC}} {{condition}} {{rainNote}} {{chores}}";

function isRoutineList(data: unknown): data is { ok: true; routines: Routine[] } {
  if (typeof data !== "object" || data === null) return false;
  const d = data as Record<string, unknown>;
  return d.ok === true && Array.isArray(d.routines);
}

function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
}

function daysLabel(days: number[]): string {
  const sorted = [...days].sort((a, b) => a - b);
  if (sorted.length === 7) return "every day";
  if (sorted.join() === "0,1,2,3,4") return "weekdays";
  if (sorted.join() === "5,6") return "weekends";
  if (sorted.length === 0) return "no days";
  return sorted.map((d) => WEEKDAYS[d]).join(" ");
}

function whenLabel(r: Routine): string {
  if (r.anchor.type === "time") return r.anchor.time;
  const off = r.anchor.offsetMin;
  return off === 0
    ? r.anchor.event
    : `${r.anchor.event} ${off < 0 ? "−" : "+"} ${Math.abs(off)} min`;
}

const newLights = (): LightsAction => ({
  type: "lights",
  targets: ["all"],
  power: "on",
  brightness: 0.5,
  kelvin: 4000,
  fadeS: 60,
});
const newSpeak = (): SpeakAction => ({ type: "speak", text: "", style: "cheerful", sonos: "all" });
const newSonos = (): SonosAction => ({ type: "sonos", playerId: "", favoriteId: "", volume: 4, rampTo: 15, rampS: 600 });

function SonosFields({ action, onChange }: { action: SonosAction; onChange: (a: SonosAction) => void }) {
  const { players, favorites, error } = useContext(SonosCatalogContext);
  const set = (patch: Partial<SonosAction>) => onChange({ ...action, ...patch });
  const ramping = action.rampTo !== undefined;
  return (
    <div className="flex flex-col gap-2.5 text-xs">
      {error && <p className="pretzel-text-warn">{error}</p>}
      <label className="flex items-center gap-2">
        <span className="pretzel-text-panel-muted w-14">Speaker</span>
        <select
          className="pretzel-input w-auto min-w-0 flex-1 py-1"
          value={action.playerId}
          onChange={(e) => {
            const pl = players.find((x) => x.id === e.target.value);
            set({ playerId: e.target.value, playerName: pl?.name });
          }}
        >
          <option value="">Choose…</option>
          {players.map((pl) => (
            <option key={pl.id} value={pl.id}>
              {pl.name}
            </option>
          ))}
          {action.playerId && !players.some((x) => x.id === action.playerId) && (
            <option value={action.playerId}>{action.playerName ?? action.playerId}</option>
          )}
        </select>
      </label>
      <label className="flex items-center gap-2">
        <span className="pretzel-text-panel-muted w-14">Play</span>
        <select
          className="pretzel-input w-auto min-w-0 flex-1 py-1"
          value={action.favoriteId}
          onChange={(e) => {
            const fav = favorites.find((x) => x.id === e.target.value);
            set({ favoriteId: e.target.value, favoriteName: fav?.name });
          }}
        >
          <option value="">Choose a Sonos Favorite…</option>
          {favorites.map((f) => (
            <option key={`${f.householdId}:${f.id}`} value={f.id}>
              {f.name}
            </option>
          ))}
          {action.favoriteId && !favorites.some((x) => x.id === action.favoriteId) && (
            <option value={action.favoriteId}>{action.favoriteName ?? `Favorite ${action.favoriteId}`}</option>
          )}
        </select>
      </label>
      <p className="pretzel-text-panel-subtle">
        A Spotify playlist shows up here after “Add to My Sonos” in the Sonos app.
      </p>
      <div className="flex flex-wrap items-center gap-2">
        <span className="pretzel-text-panel-muted w-14">Volume</span>
        <input
          type="number"
          min={0}
          max={100}
          value={action.volume ?? ""}
          placeholder="keep"
          onChange={(e) => {
            const v = e.target.value === "" ? undefined : Math.max(0, Math.min(100, Math.round(Number(e.target.value))));
            set(v === undefined ? { volume: undefined, rampTo: undefined, rampS: undefined } : { volume: v });
          }}
          className="pretzel-input w-20 py-1"
          aria-label="Start volume"
        />
        {action.volume !== undefined && (
          <label className="flex items-center gap-1.5">
            <input
              type="checkbox"
              checked={ramping}
              onChange={(e) =>
                set(e.target.checked ? { rampTo: Math.min(100, (action.volume ?? 0) + 10), rampS: 600 } : { rampTo: undefined, rampS: undefined })
              }
            />
            <span className="pretzel-text-panel-body">then change to</span>
          </label>
        )}
        {ramping && (
          <input
            type="number"
            min={0}
            max={100}
            value={action.rampTo}
            onChange={(e) => set({ rampTo: Math.max(0, Math.min(100, Math.round(Number(e.target.value)))) })}
            className="pretzel-input w-20 py-1"
            aria-label="Volume to ramp to"
          />
        )}
      </div>
      {ramping && (
        <label className="flex items-center gap-2">
          <span className="pretzel-text-panel-muted w-14">Over</span>
          <input
            type="number"
            min={0}
            max={60}
            value={Math.round((action.rampS ?? 0) / 60)}
            onChange={(e) => set({ rampS: Math.max(0, Math.min(3600, Math.round(Number(e.target.value)) * 60)) })}
            className="pretzel-input w-20 py-1"
            aria-label="Ramp minutes"
          />
          <span className="pretzel-text-panel-subtle">min</span>
        </label>
      )}
      <label className="flex items-center gap-2">
        <input type="checkbox" checked={Boolean(action.shuffle)} onChange={(e) => set({ shuffle: e.target.checked || undefined })} />
        <span className="pretzel-text-panel-body">Shuffle</span>
      </label>
    </div>
  );
}

function LightsFields({
  action,
  onChange,
}: {
  action: LightsAction;
  onChange: (a: LightsAction) => void;
}) {
  const set = (patch: Partial<LightsAction>) => onChange({ ...action, ...patch });
  const isAll = action.targets.includes("all");
  const toggleTarget = (t: string) => {
    if (t === "all") {
      set({ targets: isAll ? [] : ["all"] });
      return;
    }
    const without = action.targets.filter((x) => x !== t && x !== "all");
    set({ targets: action.targets.includes(t) ? without : [...without, t] });
  };
  const others = action.targets.filter((t) => t !== "all" && !ROOMS.some((r) => `room:${r}` === t));
  const off = action.power === "off";

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <span className="pretzel-text-panel-muted w-14 text-xs">Lights</span>
        {["all", ...ROOMS.map((r) => `room:${r}`)].map((t) => (
          <button
            key={t}
            type="button"
            aria-pressed={action.targets.includes(t)}
            onClick={() => toggleTarget(t)}
            className={`pretzel-btn-ghost pretzel-btn-ghost--sm${
              action.targets.includes(t) ? " pretzel-key--accent" : ""
            }`}
          >
            {t === "all" ? "All" : t.slice(5)}
          </button>
        ))}
        {others.map((t) => (
          <button
            key={t}
            type="button"
            title="Remove"
            onClick={() => toggleTarget(t)}
            className="pretzel-btn-ghost pretzel-btn-ghost--sm pretzel-key--accent"
          >
            {t.slice(t.indexOf(":") + 1)} ×
          </button>
        ))}
      </div>

      <label className="flex items-center gap-2 text-xs">
        <span className="pretzel-text-panel-muted w-14">Power</span>
        <select
          className="pretzel-input w-auto py-1"
          value={action.power ?? ""}
          onChange={(e) =>
            set({ power: e.target.value === "" ? undefined : (e.target.value as "on" | "off") })
          }
        >
          <option value="on">Turn on</option>
          <option value="off">Turn off</option>
          <option value="">Only change lights that are on</option>
        </select>
      </label>

      {!off && (
        <>
          <label className="flex items-center gap-2 text-xs">
            <span className="pretzel-text-panel-muted w-14">Level</span>
            <input
              type="checkbox"
              checked={action.brightness !== undefined}
              onChange={(e) => set({ brightness: e.target.checked ? 0.5 : undefined })}
              aria-label="Set brightness"
            />
            {action.brightness !== undefined ? (
              <>
                <input
                  type="range"
                  min={1}
                  max={100}
                  value={Math.round(action.brightness * 100)}
                  onChange={(e) => set({ brightness: Number(e.target.value) / 100 })}
                  className="pretzel-range pretzel-range--accent min-w-0 flex-1"
                  aria-label="Brightness"
                />
                <span className="pretzel-vol-pct">{Math.round(action.brightness * 100)}%</span>
              </>
            ) : (
              <span className="pretzel-text-panel-subtle">keep</span>
            )}
          </label>
          <label className="flex items-center gap-2 text-xs">
            <span className="pretzel-text-panel-muted w-14">Colour</span>
            <select
              className="pretzel-input w-auto py-1"
              value={action.kelvin ?? ""}
              onChange={(e) =>
                set({ kelvin: e.target.value === "" ? undefined : Number(e.target.value) })
              }
            >
              <option value="">Keep</option>
              {KELVINS.map((k) => (
                <option key={k.value} value={k.value}>
                  {k.label}
                </option>
              ))}
              {action.kelvin !== undefined && !KELVINS.some((k) => k.value === action.kelvin) && (
                <option value={action.kelvin}>{action.kelvin}K</option>
              )}
            </select>
          </label>
        </>
      )}

      <label className="flex items-center gap-2 text-xs">
        <span className="pretzel-text-panel-muted w-14">Fade</span>
        <input
          type="number"
          min={0}
          max={60}
          step={0.5}
          value={(action.fadeS ?? 0) / 60}
          onChange={(e) =>
            set({ fadeS: Math.max(0, Math.min(3600, Math.round(Number(e.target.value) * 60))) })
          }
          className="pretzel-input w-20 py-1"
          aria-label="Fade minutes"
        />
        <span className="pretzel-text-panel-subtle">min</span>
      </label>

      {action.power === "on" && (
        <label className="flex items-center gap-2 text-xs">
          <input
            type="checkbox"
            checked={Boolean(action.onlyIfOff)}
            onChange={(e) => set({ onlyIfOff: e.target.checked || undefined })}
          />
          <span className="pretzel-text-panel-body">Leave lights that are already on alone</span>
        </label>
      )}
    </div>
  );
}

function SpeakSonosFields({ action, onChange }: { action: SpeakAction; onChange: (a: SpeakAction) => void }) {
  const { players, error } = useContext(SonosCatalogContext);
  const choice = action.sonos ?? "all";
  const mode = Array.isArray(choice) ? "some" : choice;
  const clipPlayers = players.filter((p) => p.audioClip);
  return (
    <div className="flex flex-col gap-2 text-xs">
      <label className="flex items-center gap-2">
        <span className="pretzel-text-panel-muted">Speakers</span>
        <select
          className="pretzel-input w-auto py-1"
          value={mode}
          onChange={(e) => {
            const v = e.target.value;
            onChange({
              ...action,
              sonos: v === "some" ? clipPlayers.slice(0, 1).map((p) => p.id) : (v as "all" | "none"),
            });
          }}
        >
          <option value="all">Pi + all Sonos</option>
          <option value="some" disabled={clipPlayers.length === 0 && mode !== "some"}>
            Pi + chosen Sonos
          </option>
          <option value="none">Pi only</option>
        </select>
      </label>
      {Array.isArray(choice) && (
        <div className="flex flex-wrap gap-1.5">
          {clipPlayers.map((p) => {
            const on = choice.includes(p.id);
            return (
              <button
                key={p.id}
                type="button"
                aria-pressed={on}
                onClick={() => {
                  const next = on ? choice.filter((x) => x !== p.id) : [...choice, p.id];
                  onChange({ ...action, sonos: next.length > 0 ? next : "none" });
                }}
                className={`pretzel-btn-ghost pretzel-btn-ghost--sm${on ? " pretzel-key--accent" : ""}`}
              >
                {p.name}
              </button>
            );
          })}
        </div>
      )}
      {mode !== "none" && (
        <label className="flex items-center gap-2">
          <span className="pretzel-text-panel-muted">Sonos volume</span>
          <input
            type="checkbox"
            checked={action.sonosVolume !== undefined}
            onChange={(e) => onChange({ ...action, sonosVolume: e.target.checked ? 30 : undefined })}
            aria-label="Set Sonos volume"
          />
          {action.sonosVolume !== undefined ? (
            <>
              <input
                type="range"
                min={0}
                max={100}
                value={action.sonosVolume}
                onChange={(e) => onChange({ ...action, sonosVolume: Number(e.target.value) })}
                className="pretzel-range pretzel-range--accent min-w-0 flex-1"
                aria-label="Sonos volume"
              />
              <span className="pretzel-vol-pct">{action.sonosVolume}</span>
            </>
          ) : (
            <span className="pretzel-text-panel-subtle">speaker's own</span>
          )}
        </label>
      )}
      {error && mode !== "none" && <p className="pretzel-text-warn">{error}</p>}
      <p className="pretzel-text-panel-subtle">
        Sonos lowers any music, says it, then carries on. Older speakers without clip support are skipped.
      </p>
    </div>
  );
}

function SpeakFields({ action, onChange }: { action: SpeakAction; onChange: (a: SpeakAction) => void }) {
  return (
    <div className="flex flex-col gap-2">
      <textarea
        rows={3}
        maxLength={1000}
        value={action.text}
        placeholder="What Pretzel says"
        onChange={(e) => onChange({ ...action, text: e.target.value })}
        className="pretzel-input"
        aria-label="Spoken text"
      />
      <p className="pretzel-text-panel-subtle text-xs">Fill-ins: {FILL_INS}</p>
      <SpeakSonosFields action={action} onChange={onChange} />
      <label className="flex items-center gap-2 text-xs">
        <span className="pretzel-text-panel-muted">Voice</span>
        <select
          className="pretzel-input w-auto py-1"
          value={action.style ?? "cheerful"}
          onChange={(e) => onChange({ ...action, style: e.target.value as "cheerful" | "plain" })}
        >
          <option value="cheerful">Cheerful (reminder voice)</option>
          <option value="plain">Plain</option>
        </select>
      </label>
    </div>
  );
}

function StepFields({
  step,
  index,
  count,
  onChange,
  onRemove,
}: {
  step: RoutineStep;
  index: number;
  count: number;
  onChange: (s: RoutineStep) => void;
  onRemove: () => void;
}) {
  const setAction = (action: RoutineAction) => onChange({ ...step, action });
  return (
    <div className="pretzel-well flex flex-col gap-2.5">
      <div className="flex flex-wrap items-center gap-2 text-xs">
        <span className="pretzel-text-group-label whitespace-nowrap">Step {index + 1}</span>
        <select
          className="pretzel-input w-auto py-1"
          value={step.action.type}
          onChange={(e) =>
            setAction(e.target.value === "speak" ? newSpeak() : e.target.value === "sonos" ? newSonos() : newLights())
          }
          aria-label="Step type"
        >
          <option value="lights">Lights</option>
          <option value="speak">Speak</option>
          <option value="sonos">Sonos music</option>
        </select>
        <input
          type="number"
          min={-240}
          max={240}
          value={step.offsetMin}
          onChange={(e) => onChange({ ...step, offsetMin: Math.round(Number(e.target.value)) || 0 })}
          className="pretzel-input w-14 py-1"
          aria-label="Minutes from the routine time"
        />
        <span className="pretzel-text-panel-subtle">min</span>
        {count > 1 && (
          <button type="button" onClick={onRemove} className="pretzel-btn-ghost pretzel-btn-ghost--sm ml-auto">
            Remove
          </button>
        )}
      </div>
      {step.action.type === "lights" ? (
        <LightsFields action={step.action} onChange={setAction} />
      ) : step.action.type === "speak" ? (
        <SpeakFields action={step.action} onChange={setAction} />
      ) : (
        <SonosFields action={step.action} onChange={setAction} />
      )}
    </div>
  );
}

function RoutineCard({
  routine,
  isNew,
  takenIds,
  fetchAdmin,
  onSaved,
  onDeleted,
}: {
  routine: Routine;
  isNew: boolean;
  /** Ids already in use, so a new routine never replaces one. */
  takenIds: string[];
  fetchAdmin: FetchAdmin;
  onSaved: (r: Routine) => void;
  onDeleted: () => void;
}) {
  const [open, setOpen] = useState(isNew);
  const [draft, setDraft] = useState<Routine>(routine);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dirty = JSON.stringify(draft) !== JSON.stringify(routine);

  useEffect(() => setDraft(routine), [routine]);

  const set = (patch: Partial<Routine>) => setDraft((d) => ({ ...d, ...patch }));

  const save = async () => {
    const id = isNew ? slugify(draft.name) : draft.id;
    if (!id) {
      setError("Give it a name");
      return;
    }
    if (isNew && takenIds.includes(id)) {
      setError("A routine with that name already exists");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const { updatedAt: _ignored, ...body } = { ...draft, id };
      const res = await fetchAdmin(`/pretzel/routines/${encodeURIComponent(id)}`, {
        method: "PUT",
        body: JSON.stringify(body),
      });
      const data = res.data as { routine?: Routine; error?: string };
      if (!res.ok || !data.routine) {
        setError(data.error || `Save failed (${res.status})`);
        return;
      }
      onSaved(data.routine);
      if (isNew) setOpen(false);
    } catch {
      setError("Could not reach Pretzel");
    } finally {
      setBusy(false);
    }
  };

  const remove = async () => {
    if (isNew) {
      onDeleted();
      return;
    }
    if (!window.confirm(`Delete ${routine.name}?`)) return;
    setBusy(true);
    try {
      const res = await fetchAdmin(`/pretzel/routines/${encodeURIComponent(routine.id)}`, {
        method: "DELETE",
      });
      if (res.ok) onDeleted();
      else setError(`Delete failed (${res.status})`);
    } catch {
      setError("Could not reach Pretzel");
    } finally {
      setBusy(false);
    }
  };

  const anchorKind = draft.anchor.type === "time" ? "time" : draft.anchor.event;

  return (
    <div className="pretzel-nested-card">
      <button
        type="button"
        className="flex w-full items-center gap-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <span className={`pretzel-led ${draft.enabled ? "pretzel-led--ok" : ""}`} aria-hidden />
        <span className="min-w-0 flex-1">
          <span className="pretzel-text-card-name block truncate">{draft.name || "New routine"}</span>
          <span className="pretzel-text-panel-subtle block truncate text-xs">
            {whenLabel(draft)} · {daysLabel(draft.days)} · {draft.steps.length} step
            {draft.steps.length === 1 ? "" : "s"}
            {dirty ? " · unsaved" : ""}
          </span>
        </span>
        <span className="pretzel-text-panel-muted text-xs">{open ? "▲" : "▼"}</span>
      </button>

      {open && (
        <div className="mt-3 flex flex-col gap-3">
          <div className="flex items-center gap-2">
            <input
              value={draft.name}
              maxLength={40}
              onChange={(e) => set({ name: e.target.value })}
              className="pretzel-input"
              aria-label="Name"
              placeholder="Name"
            />
            <label className="flex shrink-0 items-center gap-1.5 text-xs">
              <input
                type="checkbox"
                checked={draft.enabled}
                onChange={(e) => set({ enabled: e.target.checked })}
              />
              <span className="pretzel-text-panel-body">On</span>
            </label>
          </div>

          <div className="flex flex-wrap items-center gap-2 text-xs">
            <span className="pretzel-text-panel-muted w-14">When</span>
            <select
              className="pretzel-input w-auto py-1"
              value={anchorKind}
              onChange={(e) => {
                const v = e.target.value;
                set({
                  anchor:
                    v === "time"
                      ? { type: "time", time: "09:00" }
                      : { type: "sun", event: v as "sunrise" | "sunset", offsetMin: 0 },
                });
              }}
              aria-label="Anchor"
            >
              <option value="time">At a time</option>
              <option value="sunrise">Around sunrise</option>
              <option value="sunset">Around sunset</option>
            </select>
            {draft.anchor.type === "time" ? (
              <input
                type="time"
                value={draft.anchor.time}
                onChange={(e) => e.target.value && set({ anchor: { type: "time", time: e.target.value } })}
                className="pretzel-input w-32 py-1"
                aria-label="Time"
              />
            ) : (
              <>
                <input
                  type="number"
                  min={-180}
                  max={180}
                  value={draft.anchor.offsetMin}
                  onChange={(e) =>
                    draft.anchor.type === "sun" &&
                    set({
                      anchor: { ...draft.anchor, offsetMin: Math.round(Number(e.target.value)) || 0 },
                    })
                  }
                  className="pretzel-input w-20 py-1"
                  aria-label="Minutes from the sun event"
                />
                <span className="pretzel-text-panel-subtle">min (negative = before)</span>
              </>
            )}
          </div>
          {draft.anchor.type === "time" && /^0[0-3]:/.test(draft.anchor.time) && (
            <p className="pretzel-text-panel-subtle text-xs">
              Before 04:00 counts as the night before: on the days below, this runs after midnight.
            </p>
          )}

          <div className="flex flex-wrap items-center gap-1">
            <span className="pretzel-text-panel-muted w-14 text-xs">Days</span>
            {WEEKDAYS.map((label, d) => {
              const on = draft.days.includes(d);
              return (
                <button
                  key={label}
                  type="button"
                  aria-pressed={on}
                  onClick={() =>
                    set({ days: on ? draft.days.filter((x) => x !== d) : [...draft.days, d].sort() })
                  }
                  className={`pretzel-btn-ghost pretzel-btn-ghost--sm${on ? " pretzel-key--accent" : ""}`}
                >
                  {label}
                </button>
              );
            })}
          </div>

          {draft.steps.map((step, i) => (
            <StepFields
              key={i}
              step={step}
              index={i}
              count={draft.steps.length}
              onChange={(s) => set({ steps: draft.steps.map((x, j) => (j === i ? s : x)) })}
              onRemove={() => set({ steps: draft.steps.filter((_, j) => j !== i) })}
            />
          ))}
          {draft.steps.length < 10 && (
            <div className="flex gap-2">
              <button
                type="button"
                className="pretzel-btn-ghost pretzel-btn-ghost--sm"
                onClick={() => set({ steps: [...draft.steps, { offsetMin: 0, action: newLights() }] })}
              >
                + Lights step
              </button>
              <button
                type="button"
                className="pretzel-btn-ghost pretzel-btn-ghost--sm"
                onClick={() => set({ steps: [...draft.steps, { offsetMin: 0, action: newSpeak() }] })}
              >
                + Speak step
              </button>
              <button
                type="button"
                className="pretzel-btn-ghost pretzel-btn-ghost--sm"
                onClick={() => set({ steps: [...draft.steps, { offsetMin: 0, action: newSonos() }] })}
              >
                + Sonos music
              </button>
            </div>
          )}

          {error && <p className="pretzel-text-alert text-sm">{error}</p>}
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={busy || (!dirty && !isNew)}
              onClick={() => void save()}
              className="pretzel-btn-secondary pretzel-key--accent px-5"
            >
              {busy ? "Saving…" : "Save"}
            </button>
            {dirty && !isNew && (
              <button type="button" disabled={busy} onClick={() => setDraft(routine)} className="pretzel-btn-secondary">
                Undo changes
              </button>
            )}
            <button
              type="button"
              disabled={busy}
              onClick={() => void remove()}
              className="pretzel-btn-secondary pretzel-key--danger ml-auto"
            >
              {isNew ? "Discard" : "Delete"}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

/** Operator editor for routines: times, days, steps, spoken text. Saves need the passcode. */
export function RoutinesEditor({ fetchAdmin }: { fetchAdmin: FetchAdmin }) {
  const [routines, setRoutines] = useState<Routine[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Routine[]>([]);
  const [sonosCatalog, setSonosCatalog] = useState<SonosCatalog>({ players: [], favorites: [], error: null });

  const load = useCallback(async () => {
    try {
      const res = await fetchJson("/pretzel/routines");
      if (!res.ok || !isRoutineList(res.data)) {
        setError("Could not load routines");
        return;
      }
      setError(null);
      setRoutines(res.data.routines);
    } catch {
      setError("Could not reach Pretzel");
    }
  }, []);

  useEffect(() => {
    void load();
    void loadSonosCatalog().then(setSonosCatalog);
  }, [load]);

  const addDraft = () =>
    setDrafts((d) => [
      ...d,
      {
        id: `new-${Date.now()}`,
        name: "",
        enabled: true,
        days: [0, 1, 2, 3, 4, 5, 6],
        anchor: { type: "time", time: "09:00" },
        steps: [{ offsetMin: 0, action: newLights() }],
      },
    ]);

  return (
    <section className="pretzel-panel mt-6" aria-label="Routines editor">
      <div className="pretzel-panel__header">
        <div>
          <h2 className="pretzel-text-panel-title">Routines</h2>
          <p className="pretzel-text-panel-subtle mt-1">
            Times, days, lights and what Pretzel says. One-off skips are on the Pretzel tab.
          </p>
        </div>
      </div>
      <SonosCatalogContext.Provider value={sonosCatalog}>
      <div className="pretzel-panel__body flex flex-col gap-3">
        {error && <p className="pretzel-text-alert text-sm">{error}</p>}
        {routines?.map((r) => (
          <RoutineCard
            key={r.id}
            routine={r}
            isNew={false}
            takenIds={[]}
            fetchAdmin={fetchAdmin}
            onSaved={(saved) => setRoutines((list) => list?.map((x) => (x.id === saved.id ? saved : x)) ?? null)}
            onDeleted={() => setRoutines((list) => list?.filter((x) => x.id !== r.id) ?? null)}
          />
        ))}
        {drafts.map((d) => (
          <RoutineCard
            key={d.id}
            routine={d}
            isNew
            takenIds={routines?.map((x) => x.id) ?? []}
            fetchAdmin={fetchAdmin}
            onSaved={(saved) => {
              setDrafts((list) => list.filter((x) => x.id !== d.id));
              setRoutines((list) => [...(list ?? []).filter((x) => x.id !== saved.id), saved]);
            }}
            onDeleted={() => setDrafts((list) => list.filter((x) => x.id !== d.id))}
          />
        ))}
        <button type="button" onClick={addDraft} className="pretzel-btn-secondary self-start">
          + New routine
        </button>
      </div>
      </SonosCatalogContext.Provider>
    </section>
  );
}
