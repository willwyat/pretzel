/**
 * Stable per-browser id for the game sockets, so a reconnect keeps your seat.
 * Chess keeps it in localStorage (one player per browser); Tetris uses
 * sessionStorage so two tabs on one machine can play each other.
 */
export function clientId(key: string, storage: "local" | "session" = "local"): string {
  try {
    const store = storage === "local" ? localStorage : sessionStorage;
    let id = store.getItem(key);
    if (!id || id.length < 8) {
      id = (crypto.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(36).slice(2)}`);
      store.setItem(key, id);
    }
    return id;
  } catch {
    return `c${Date.now()}${Math.random().toString(36).slice(2)}`;
  }
}
