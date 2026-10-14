/** Routine edits and skips change each light's next scheduled step; tell the lights panel right away. */
export const ROUTINES_CHANGED_EVENT = "pretzel:routines-changed";

export function notifyRoutinesChanged(): void {
  window.dispatchEvent(new Event(ROUTINES_CHANGED_EVENT));
}

/** Call after any request; announces a successful write to /pretzel/routines. */
export function notifyIfRoutinesWrite(
  url: string,
  init: RequestInit | undefined,
  ok: boolean,
): void {
  const method = (init?.method ?? "GET").toUpperCase();
  if (ok && method !== "GET" && url.startsWith("/pretzel/routines")) {
    notifyRoutinesChanged();
  }
}
