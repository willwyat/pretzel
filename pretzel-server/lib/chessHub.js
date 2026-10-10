"use strict";

const { WebSocketServer } = require("ws");

const HEARTBEAT_MS = 30_000;

/** Client IP, honouring the X-Forwarded-For set by the remote-ui proxy. */
function clientIpOf(req) {
  const xff = req.headers["x-forwarded-for"];
  const first = typeof xff === "string" ? xff.split(",")[0].trim() : "";
  return (first || req.socket.remoteAddress || "").replace(/^::ffff:/, "");
}

/**
 * WebSocket front for ChessManager. Protocol (JSON frames):
 *   client → { type: "hello", clientId } first, then any of
 *            sit {name, color?, avatar?} | stand | move {from, to, promotion?} | resign |
 *            offerDraw | respondDraw {accept} | newGame | setTimeControl {id}
 *   server → { type: "state", state } after every change (per-client snapshot),
 *            { type: "error", error } when an action is refused.
 *
 * @param {import("./chess").ChessManager} manager
 * @returns {{ wss: WebSocketServer }} — route upgrades for /pretzel/chess/ws to `wss`.
 */
function createChessHub(manager) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 4096 });
  /** @type {Map<import("ws").WebSocket, { clientId: string | null, ip: string, alive: boolean }>} */
  const clients = new Map();

  const send = (ws, obj) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
  };
  const sendState = (ws, info) => send(ws, { type: "state", state: manager.snapshot(info.clientId) });

  manager.subscribe(() => {
    for (const [ws, info] of clients) if (info.clientId) sendState(ws, info);
  });

  const actions = {
    sit: (id, m, info) => manager.sit({ clientId: id, name: m.name, color: m.color, avatar: m.avatar, ip: info.ip }),
    stand: (id) => manager.stand({ clientId: id }),
    move: (id, m) => manager.move({ clientId: id, from: m.from, to: m.to, promotion: m.promotion }),
    resign: (id) => manager.resign({ clientId: id }),
    offerDraw: (id) => manager.offerDraw({ clientId: id }),
    respondDraw: (id, m) => manager.respondDraw({ clientId: id, accept: m.accept === true }),
    newGame: (id) => manager.newGame({ clientId: id }),
    setTimeControl: (id, m) => manager.setTimeControl({ clientId: id, id: m.id }),
  };

  wss.on("connection", (ws, req) => {
    const info = { clientId: null, ip: clientIpOf(req), alive: true };
    clients.set(ws, info);
    ws.on("pong", () => {
      info.alive = true;
    });

    ws.on("message", (data) => {
      let msg;
      try {
        msg = JSON.parse(String(data));
      } catch {
        return;
      }
      if (!msg || typeof msg.type !== "string") return;
      if (msg.type === "hello") {
        const id = msg.clientId;
        if (typeof id !== "string" || id.length < 8 || id.length > 64) return;
        info.clientId = id;
        manager.setConnected(id, true);
        sendState(ws, info);
        return;
      }
      const act = Object.hasOwn(actions, msg.type) ? actions[msg.type] : null;
      if (!info.clientId || !act) return;
      const r = act(info.clientId, msg, info);
      if (!r.ok) {
        send(ws, { type: "error", error: r.error });
        // Resync in case the client acted on a stale view.
        sendState(ws, info);
      }
    });

    ws.on("close", () => {
      clients.delete(ws);
      const id = info.clientId;
      if (id && ![...clients.values()].some((i) => i.clientId === id)) manager.setConnected(id, false);
    });
  });

  // Phones that sleep drop off without a close frame; ping them out.
  setInterval(() => {
    for (const [ws, info] of clients) {
      if (!info.alive) {
        ws.terminate();
        continue;
      }
      info.alive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS).unref();

  return { wss };
}

module.exports = { createChessHub };
