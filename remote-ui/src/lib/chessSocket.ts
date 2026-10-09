import { useCallback, useEffect, useRef, useState } from "react";

export type Color = "white" | "black";

export type LegalMove = {
  from: string;
  to: string;
  promotion: string | null;
  san: string;
};

export type MoveRecord = {
  san: string;
  from: string;
  to: string;
  color: Color;
  at: number;
  clock: number | null;
};

export type TimeControl = { id: string; label: string; baseMs: number; incMs: number };

export type ChessState = {
  id: string;
  status: "waiting" | "active" | "over";
  result: string | null;
  reason: string | null;
  fen: string;
  turn: Color;
  inCheck: boolean;
  legalMoves: LegalMove[];
  moves: MoveRecord[];
  lastMove: { from: string; to: string } | null;
  players: Record<Color, { name: string; connected: boolean } | null>;
  you: Color | null;
  timeControl: string;
  timeControls: TimeControl[];
  clocks: Record<Color, number>;
  clockRunning: boolean;
  serverNow: number;
  drawOffer: Color | null;
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

function clientId(): string {
  try {
    let id = localStorage.getItem("pretzel_chess_client");
    if (!id || id.length < 8) {
      id = (crypto.randomUUID?.() ?? `c${Date.now()}${Math.random().toString(36).slice(2)}`);
      localStorage.setItem("pretzel_chess_client", id);
    }
    return id;
  } catch {
    return `c${Date.now()}${Math.random().toString(36).slice(2)}`;
  }
}

/** Live connection to the Pi's chess referee. Reconnects with backoff. */
export function useChess() {
  const [state, setState] = useState<ChessState | null>(null);
  const [connected, setConnected] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** serverNow - Date.now() at the moment the state arrived */
  const [receivedAt, setReceivedAt] = useState(0);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    let closed = false;
    let retry = 0;
    let timer: number | undefined;
    const id = clientId();

    const open = () => {
      const proto = location.protocol === "https:" ? "wss:" : "ws:";
      const ws = new WebSocket(`${proto}//${location.host}/pretzel/chess/ws`);
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
            setReceivedAt(Date.now());
            setError(null);
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

  return { state, connected, error, clearError: () => setError(null), receivedAt, send };
}
