import { useCallback, useEffect, useRef, useState } from "react";
import { clientId } from "./clientId";

export type Color = "white" | "black";

export type LegalMove = { from: string; to: string; promotion: string | null };

export type MoveRecord = {
  san: string;
  from: string;
  to: string;
  color: Color;
  at: number;
  clock: number | null;
};

export type TimeControl = { id: string; label: string; baseMs: number; incMs: number };

/** Per-client snapshot pushed by pretzel-server (see pretzel-server/lib/chess.js `snapshot`). */
export type ChessState = {
  id: string;
  status: "waiting" | "active" | "over";
  result: string | null;
  reason: string | null;
  fen: string;
  turn: Color;
  inCheck: boolean;
  /** Only filled for the player whose turn it is. */
  legalMoves: LegalMove[];
  moves: MoveRecord[];
  lastMove: { from: string; to: string } | null;
  players: Record<Color, { name: string; connected: boolean } | null>;
  you: Color | null;
  timeControl: string;
  timeControls: TimeControl[];
  clocks: Record<Color, number>;
  clockRunning: boolean;
  drawOffer: Color | null;
  /** What this client may do right now; the server owns the rules. */
  can: {
    sit: Record<Color, boolean>;
    stand: boolean;
    setTimeControl: boolean;
    resign: boolean;
    offerDraw: boolean;
    newGame: boolean;
  };
};

export type ClientMessage =
  | { type: "sit"; name: string; color?: Color }
  | { type: "stand" }
  | { type: "move"; from: string; to: string; promotion?: string }
  | { type: "resign" }
  | { type: "offerDraw" }
  | { type: "respondDraw"; accept: boolean }
  | { type: "newGame" }
  | { type: "setTimeControl"; id: string };

/**
 * Live connection to the Pi's chess referee. Reconnects with backoff, and right
 * away when a sleeping phone comes back to the foreground.
 */
export function useChess() {
  const [state, setState] = useState<ChessState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Local Date.now() when `state` arrived; clocks count down from there. */
  const receivedAt = useRef(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let disposed = false;
    let retry = 0;
    let timer: number | undefined;
    const id = clientId("pretzel_chess_client");

    const open = () => {
      window.clearTimeout(timer);
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/pretzel/chess/ws`);
      wsRef.current = ws;
      ws.onopen = () => {
        retry = 0;
        setConnected(true);
        ws.send(JSON.stringify({ type: "hello", clientId: id }));
      };
      ws.onmessage = (ev) => {
        let msg: { type?: string; state?: ChessState; error?: string };
        try {
          msg = JSON.parse(String(ev.data));
        } catch {
          return;
        }
        if (msg.type === "state" && msg.state) {
          receivedAt.current = Date.now();
          setState(msg.state);
        } else if (msg.type === "error") {
          setError(String(msg.error));
        }
      };
      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        setConnected(false);
        if (disposed) return;
        retry += 1;
        timer = window.setTimeout(open, Math.min(8000, 400 * 2 ** retry));
      };
    };

    const onVisible = () => {
      if (document.visibilityState === "visible" && !wsRef.current) open();
    };
    document.addEventListener("visibilitychange", onVisible);
    open();
    return () => {
      disposed = true;
      document.removeEventListener("visibilitychange", onVisible);
      window.clearTimeout(timer);
      const ws = wsRef.current;
      wsRef.current = null;
      ws?.close();
    };
  }, []);

  const send = useCallback((m: ClientMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(m));
    else setError("Not connected to Pretzel. Reconnecting…");
  }, []);

  const clearError = useCallback(() => setError(null), []);

  return { state, connected, error, clearError, receivedAt, send };
}
