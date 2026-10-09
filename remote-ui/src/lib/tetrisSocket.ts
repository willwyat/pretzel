import { useCallback, useEffect, useRef, useState } from "react";
import { clientId } from "./clientId";

export type TetrisStatus = "waiting" | "countdown" | "active" | "over";

export type TetrisState = {
  status: TetrisStatus;
  matchId: string | null;
  seed: number | null;
  /** Server time the match goes live (end of countdown). */
  startsAt: number | null;
  serverNow: number;
  winner: 0 | 1 | null;
  reason: string | null;
  /** Names when the current/last match started. */
  matchNames: [string, string] | null;
  players: ({ name: string; connected: boolean; ready: boolean } | null)[];
  you: 0 | 1 | null;
};

export type ClientMessage =
  | { type: "join"; name: string }
  | { type: "leave" }
  | { type: "ready" }
  | { type: "topout"; matchId: string }
  | { type: "forfeit"; matchId: string; reason: string }
  | { type: "board"; matchId: string; cells: string }
  | { type: "attack"; matchId: string; lines: number };

/** Per-match messages that the game loop consumes directly (no React state). */
export type TetrisEvent =
  | { type: "board"; matchId: string; seat: 0 | 1; cells: string }
  | { type: "garbage"; matchId: string; lines: number };

/** Live connection to the Pi's Tetris match-maker. Reconnects with backoff. */
export function useTetris() {
  const [state, setState] = useState<TetrisState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** serverNow - Date.now() when the last state arrived. */
  const [clockOffset, setClockOffset] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);
  const listeners = useRef(new Set<(e: TetrisEvent) => void>());

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    const id = clientId("pretzel_tetris_client", "session");

    const open = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/pretzel/tetris/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        ws.send(JSON.stringify({ type: "hello", clientId: id }));
      };
      ws.onmessage = (ev) => {
        try {
          const msg = JSON.parse(String(ev.data));
          if (msg.type === "state") {
            setState(msg.state);
            setClockOffset(msg.state.serverNow - Date.now());
            setError(null);
          } else if (msg.type === "board" || msg.type === "garbage") {
            for (const fn of listeners.current) fn(msg as TetrisEvent);
          } else if (msg.type === "error") {
            setError(String(msg.error));
          }
        } catch {
          /* ignore malformed frames */
        }
      };
      ws.onclose = () => {
        setConnected(false);
        if (closed) return;
        retry += 1;
        timer = window.setTimeout(open, Math.min(8000, 500 * 2 ** retry));
      };
    };
    open();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      wsRef.current?.close();
    };
  }, []);

  const send = useCallback((m: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
  }, []);

  const subscribe = useCallback((fn: (e: TetrisEvent) => void) => {
    listeners.current.add(fn);
    return () => {
      listeners.current.delete(fn);
    };
  }, []);

  return { state, connected, error, clearError: () => setError(null), clockOffset, send, subscribe };
}
