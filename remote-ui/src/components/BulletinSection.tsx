import { useCallback, useEffect, useState } from "react";
import { fetchJson } from "../lib/fetchJson";

const POLL_MS = 20_000;
const MAX_MESSAGE = 500;

type Note = {
  id: string;
  message: string;
  date: string;
  isSeen: boolean;
};

function isNote(value: unknown): value is Note {
  if (typeof value !== "object" || value === null) return false;
  const note = value as Record<string, unknown>;
  return (
    typeof note.id === "string" &&
    typeof note.message === "string" &&
    typeof note.date === "string" &&
    typeof note.isSeen === "boolean"
  );
}

function tone(id: string): "0" | "1" | "2" {
  let n = 0;
  for (let i = 0; i < id.length; i++) n = (n + id.charCodeAt(i)) % 3;
  return String(n) as "0" | "1" | "2";
}

function formatNoteDate(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(date);
}

export function BulletinSection() {
  const [notes, setNotes] = useState<Note[]>([]);
  const [draft, setDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [offline, setOffline] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetchJson("/pretzel/bulletin");
      const data = res.data as { notes?: unknown };
      if (!res.ok || !Array.isArray(data.notes) || !data.notes.every(isNote)) {
        setOffline(!res.ok && res.status === 0);
        setError("Could not load the board");
        return;
      }
      setOffline(false);
      setError(null);
      setNotes(data.notes);
    } catch {
      setOffline(true);
      setError("Could not reach Pretzel");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = setInterval(() => void load(), POLL_MS);
    return () => clearInterval(id);
  }, [load]);

  const addNote = () => {
    const message = draft.trim();
    if (!message || saving || offline) return;
    setSaving(true);
    setError(null);
    void fetchJson("/pretzel/bulletin", {
      method: "POST",
      body: JSON.stringify({ message }),
    })
      .then((res) => {
        const note = (res.data as { note?: unknown }).note;
        if (!res.ok || !isNote(note)) {
          const err = (res.data as { error?: unknown }).error;
          setError(typeof err === "string" ? err : "Could not add that note");
          return;
        }
        setDraft("");
        setNotes((prev) => [note, ...prev.filter((item) => item.id !== note.id)]);
      })
      .catch(() => setError("Could not reach Pretzel"))
      .finally(() => setSaving(false));
  };

  const removeNote = (id: string) => {
    const previous = notes;
    setNotes((prev) => prev.filter((note) => note.id !== id));
    void fetchJson(`/pretzel/bulletin/${encodeURIComponent(id)}`, {
      method: "DELETE",
    })
      .then((res) => {
        if (!res.ok) setNotes(previous);
      })
      .catch(() => setNotes(previous));
  };

  const setSeen = (note: Note, isSeen: boolean) => {
    setNotes((prev) =>
      prev.map((item) => (item.id === note.id ? { ...item, isSeen } : item)),
    );
    void fetchJson(`/pretzel/bulletin/${encodeURIComponent(note.id)}/seen`, {
      method: "POST",
      body: JSON.stringify({ isSeen }),
    })
      .then((res) => {
        if (!res.ok) {
          setNotes((prev) =>
            prev.map((item) =>
              item.id === note.id ? { ...item, isSeen: note.isSeen } : item,
            ),
          );
        }
      })
      .catch(() => {
        setNotes((prev) =>
          prev.map((item) =>
            item.id === note.id ? { ...item, isSeen: note.isSeen } : item,
          ),
        );
      });
  };

  return (
    <section className="pretzel-panel" aria-label="Bulletin">
      <div className="pretzel-panel__header">
        <div className="min-w-0">
          <h2 className="pretzel-text-panel-title">Bulletin</h2>
          <p className="pretzel-text-panel-muted">
            {loading ? "Loading…" : offline ? "Pretzel server offline" : "Notes for home"}
          </p>
        </div>
      </div>
      <div className="pretzel-panel__body flex flex-col gap-4">
        {error ? <p className="pretzel-text-alert text-sm">{error}</p> : null}
        {notes.length === 0 && !loading ? (
          <p className="pretzel-text-panel-muted text-sm">Nothing on the board.</p>
        ) : (
          <ul className="pretzel-board">
            {notes.map((note) => (
              <li
                key={note.id}
                className={`pretzel-note${note.isSeen ? " pretzel-note--seen" : ""}`}
                data-tone={tone(note.id)}
              >
                <button
                  type="button"
                  className="pretzel-note__remove"
                  aria-label="Remove note"
                  onClick={() => removeNote(note.id)}
                >
                  ×
                </button>
                <p className="pretzel-note__message">{note.message}</p>
                <div className="pretzel-note__meta">
                  <time dateTime={note.date}>{formatNoteDate(note.date)}</time>
                  <button
                    type="button"
                    className="pretzel-note__seen"
                    aria-pressed={note.isSeen}
                    onClick={() => setSeen(note, !note.isSeen)}
                  >
                    {note.isSeen ? "Seen" : "New"}
                  </button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <form
          className="flex flex-col gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            addNote();
          }}
        >
          <label htmlFor="bulletin-message" className="pretzel-text-panel-muted text-xs">
            New note
          </label>
          <textarea
            id="bulletin-message"
            value={draft}
            rows={2}
            maxLength={MAX_MESSAGE}
            disabled={offline || saving}
            placeholder={offline ? "Connect to Pretzel to leave a note…" : "Leave a note…"}
            onChange={(event) => setDraft(event.target.value.slice(0, MAX_MESSAGE))}
            className="pretzel-input min-h-[3.5rem] resize-y disabled:cursor-not-allowed disabled:opacity-50"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="pretzel-text-panel-subtle text-[11px] tabular-nums">
              {draft.length}/{MAX_MESSAGE}
            </span>
            <button
              type="submit"
              disabled={offline || saving || draft.trim().length === 0}
              className="pretzel-btn-secondary pretzel-key--accent px-3 py-1.5 text-xs disabled:cursor-not-allowed"
            >
              {saving ? "Adding…" : "Add"}
            </button>
          </div>
        </form>
      </div>
    </section>
  );
}
