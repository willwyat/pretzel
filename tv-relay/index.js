const express = require("express");
const dgram = require("dgram");
const WebSocket = require("ws");

// LG TV on this LAN (inline; repo is private):
//   IPv4 192.168.1.186 /24, gateway 192.168.1.1, DNS 192.168.1.1
//   WOL MAC 30:34:DB:78:6A:06
//   IPv6 prefix /64 2600:4041:5896:d700::, gateway fe80::8e8b:5bff:fe62:193, DNS 2600:4041:5896:d700::1
const TV_IP = "192.168.1.186";
const TV_PORT = 3001;
const CLIENT_KEY = process.env.CLIENT_KEY || "";
/** Set to 1 while CLIENT_KEY is empty to force a new on-TV pairing prompt. */
const TV_FORCE_PAIRING =
  process.env.TV_FORCE_PAIRING === "1" ||
  process.env.TV_FORCE_PAIRING === "true";
const PORT = 3000;

// Registration manifest + signature from home-assistant-libs/aiowebostv handshake.py
// (matches signed block). Older minimal manifests get 401 on getPointerInputSocket.
const LG_TV_HANDSHAKE_SIGNATURE =
  "eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbm" +
  "ctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjCwXVvE2OOSpDZ58hR" +
  "+59aFNwYDyjQgKk3auukd7pcegmE2CzPCa0bJ0ZsRAcKkCTJrWo5iDzNhMBWRy" +
  "aMOv5zWSrthlf7G128qvIlpMT0YNY+n/FaOHE73uLrS/g7swl3/qH/BGFG2Hu4" +
  "RlL48eb3lLKqTt2xKHdCs6Cd4RMfJPYnzgvI4BNrFUKsjkcu+WD4OO2A27Pq1n" +
  "50cMchmcaXadJhGrOqH5YmHdOCj5NSHzJYrsW0HPlpuAx/ECMeIZYDh6RMqaFM" +
  "2DXzdKX9NmmyqzJ3o/0lkk/N97gfVRLW5hA29yeAwaCViZNCP8iC9aO0q9fQoj" +
  "oa7NQnAtw==";

const LG_TV_REGISTER_MANIFEST = {
  manifestVersion: 1,
  appVersion: "1.1",
  permissions: [
    "LAUNCH",
    "LAUNCH_WEBAPP",
    "APP_TO_APP",
    "CLOSE",
    "TEST_OPEN",
    "TEST_PROTECTED",
    "CONTROL_AUDIO",
    "CONTROL_DISPLAY",
    "CONTROL_INPUT_JOYSTICK",
    "CONTROL_INPUT_MEDIA_RECORDING",
    "CONTROL_INPUT_MEDIA_PLAYBACK",
    "CONTROL_INPUT_TV",
    "CONTROL_POWER",
    "CONTROL_TV_SCREEN",
    "READ_APP_STATUS",
    "READ_CURRENT_CHANNEL",
    "READ_INPUT_DEVICE_LIST",
    "READ_NETWORK_STATE",
    "READ_RUNNING_APPS",
    "READ_TV_CHANNEL_LIST",
    "WRITE_NOTIFICATION_TOAST",
    "READ_POWER_STATE",
    "READ_COUNTRY_INFO",
    "CONTROL_INPUT_TEXT",
    "CONTROL_MOUSE_AND_KEYBOARD",
    "READ_INSTALLED_APPS",
    "READ_SETTINGS",
  ],
  signatures: [{ signatureVersion: 1, signature: LG_TV_HANDSHAKE_SIGNATURE }],
  signed: {
    appId: "com.lge.test",
    created: "20140509",
    localizedAppNames: {
      "": "LG Remote App",
      "ko-KR": "리모컨 앱",
      "zxx-XX": "ЛГ Rэмotэ AПП",
    },
    localizedVendorNames: { "": "LG Electronics" },
    permissions: [
      "TEST_SECURE",
      "CONTROL_INPUT_TEXT",
      "CONTROL_MOUSE_AND_KEYBOARD",
      "READ_INSTALLED_APPS",
      "READ_LGE_SDX",
      "READ_NOTIFICATIONS",
      "SEARCH",
      "WRITE_SETTINGS",
      "WRITE_NOTIFICATION_ALERT",
      "CONTROL_POWER",
      "READ_CURRENT_CHANNEL",
      "READ_RUNNING_APPS",
      "READ_UPDATE_INFO",
      "UPDATE_FROM_REMOTE_APP",
      "READ_LGE_TV_INPUT_EVENTS",
      "READ_TV_CURRENT_TIME",
    ],
    serial: "2f930e2d2cfe083771f68e4fe7bb07",
    vendorId: "com.lge",
  },
};
/** Wake-on-LAN target; env overrides default below. */
const TV_WOL_MAC = (
  process.env.TV_WOL_MAC ||
  process.env.TV_MAC ||
  "30:34:DB:78:6A:06"
).trim();
const TV_WOL_BROADCAST = (
  process.env.TV_WOL_BROADCAST || "255.255.255.255"
).trim();

// TV_IP is the WebSocket target only. HTTP routes (e.g. POST /tv/power/on) are served
// by *this* relay on PORT — not by the TV. Use this Pi's IP or 127.0.0.1 for curl/tests.

function parseMac(macStr) {
  const hex = macStr.replace(/[:-]/g, "").toLowerCase();
  if (!/^[0-9a-f]{12}$/.test(hex)) return null;
  return hex;
}

function sendWakeOnLan(macHex) {
  const macBuf = Buffer.from(macHex, "hex");
  const body = Buffer.alloc(6 + 16 * 6);
  body.fill(0xff, 0, 6);
  for (let i = 6; i < body.length; i += 6) macBuf.copy(body, i);
  const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
  return new Promise((resolve, reject) => {
    socket.once("error", (e) => {
      try {
        socket.close();
      } catch {}
      reject(e);
    });
    // Bind before setBroadcast — unbound sockets can throw EBADF on Linux (Node dgram).
    socket.bind(0, "0.0.0.0", () => {
      try {
        socket.setBroadcast(true);
      } catch (e) {
        socket.close();
        reject(e);
        return;
      }
      socket.send(body, 0, body.length, 9, TV_WOL_BROADCAST, (err) => {
        socket.close();
        if (err) reject(err);
        else resolve();
      });
    });
  });
}

const app = express();
app.use(express.json());

let ws = null;
let inputWs = null;
let pendingRequests = new Map();
let msgId = 1;
let inputRetryTimer = null;
/** Set when pointer input setup fails; omitted from /tv/status when null. */
let lastInputSocketError = null;

function scheduleInputSocketRetry(ms = 4000) {
  if (inputRetryTimer) clearTimeout(inputRetryTimer);
  inputRetryTimer = setTimeout(() => {
    inputRetryTimer = null;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    if (inputWs && inputWs.readyState === WebSocket.OPEN) return;
    if (inputWs && inputWs.readyState === WebSocket.CONNECTING) return;
    connectInputSocket();
  }, ms);
}

function sendKey(keyName) {
  return new Promise((resolve, reject) => {
    if (!inputWs || inputWs.readyState !== WebSocket.OPEN) {
      return reject(new Error("Input socket not connected"));
    }
    inputWs.send(`type:button\nname:${keyName}\n\n`);
    resolve({ ok: true });
  });
}

function send(uri, payload = {}) {
  return new Promise((resolve, reject) => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      return reject(new Error("Not connected to TV"));
    }
    const id = `msg_${msgId++}`;
    pendingRequests.set(id, { resolve, reject });
    ws.send(
      JSON.stringify({
        type: "request",
        id,
        uri,
        payload,
        "client-key": CLIENT_KEY,
      }),
    );
    setTimeout(() => {
      if (pendingRequests.has(id)) {
        pendingRequests.delete(id);
        reject(new Error("Timeout"));
      }
    }, 5000);
  });
}

/**
 * getPointerInputSocket often returns a full ws:// URL (port 3000); sometimes a host path.
 * Do not coerce ws→wss — the pointer endpoint may be plain ws on another port.
 */
function pointerInputWebSocketUrl(socketPathRaw, tvIp, mainWssPort) {
  if (!socketPathRaw || typeof socketPathRaw !== "string") return null;
  const s = socketPathRaw.trim();
  if (/^wss?:\/\//i.test(s)) return s;
  const path = s.startsWith("/") ? s : `/${s}`;
  return `wss://${tvIp}:${mainWssPort}${path}`;
}

async function connectInputSocket() {
  if (!ws || ws.readyState !== WebSocket.OPEN) {
    lastInputSocketError = "Main TV WebSocket not open";
    return;
  }
  if (
    inputWs &&
    (inputWs.readyState === WebSocket.CONNECTING ||
      inputWs.readyState === WebSocket.OPEN)
  ) {
    return;
  }
  if (inputWs) {
    try {
      inputWs.removeAllListeners();
      inputWs.close();
    } catch {}
    inputWs = null;
  }
  try {
    lastInputSocketError = null;
    const r = await send(
      "ssap://com.webos.service.networkinput/getPointerInputSocket",
    );
    const socketPath = r?.payload?.socketPath;
    if (!socketPath) {
      const detail = r?.payload
        ? JSON.stringify(r.payload).slice(0, 500)
        : JSON.stringify(r).slice(0, 500);
      lastInputSocketError = `getPointerInputSocket: no socketPath. payload=${detail}`;
      console.error("No input socket path", JSON.stringify(r));
      scheduleInputSocketRetry(5000);
      return;
    }
    const url = pointerInputWebSocketUrl(socketPath, TV_IP, TV_PORT);
    if (!url) {
      lastInputSocketError = "getPointerInputSocket: invalid socketPath";
      scheduleInputSocketRetry(5000);
      return;
    }
    inputWs = new WebSocket(url, { rejectUnauthorized: false });
    inputWs.on("open", () => {
      console.log("Input socket connected");
      lastInputSocketError = null;
    });
    inputWs.on("error", (e) => {
      console.error("Input socket error:", e.message);
      lastInputSocketError = e.message;
    });
    inputWs.on("close", () => {
      console.log("Input socket closed");
      inputWs = null;
      scheduleInputSocketRetry(3000);
    });
  } catch (e) {
    lastInputSocketError = e.message;
    console.error("Failed to connect input socket:", e.message);
    scheduleInputSocketRetry(5000);
  }
}

function connect() {
  ws = new WebSocket(`wss://${TV_IP}:${TV_PORT}`, {
    rejectUnauthorized: false,
  });

  ws.on("open", () => {
    console.log("Connected to TV");
    ws.send(
      JSON.stringify({
        type: "register",
        id: "reg0",
        payload: {
          forcePairing: TV_FORCE_PAIRING,
          pairingType: "PROMPT",
          "client-key": CLIENT_KEY,
          manifest: LG_TV_REGISTER_MANIFEST,
        },
      }),
    );
    // If we never see type "registered" (firmware quirks), still try input after main socket is up.
    setTimeout(() => {
      if (
        ws?.readyState === WebSocket.OPEN &&
        (!inputWs || inputWs.readyState !== WebSocket.OPEN)
      ) {
        connectInputSocket();
      }
    }, 5000);
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      console.log("TV:", JSON.stringify(msg));
      if (msg.type === "registered") {
        const pairedKey = msg.payload?.["client-key"];
        if (pairedKey && (TV_FORCE_PAIRING || !CLIENT_KEY)) {
          console.log(
            "tv-relay: add CLIENT_KEY to tv-relay.service Environment:",
            pairedKey,
          );
        }
        setTimeout(connectInputSocket, 1000);
      }
      if (msg.id && pendingRequests.has(msg.id)) {
        const { resolve, reject } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        if (msg.type === "error") {
          reject(
            new Error(
              typeof msg.error === "string"
                ? msg.error
                : msg.message || "TV returned type:error",
            ),
          );
        } else if (
          msg.payload &&
          Object.prototype.hasOwnProperty.call(msg.payload, "returnValue") &&
          msg.payload.returnValue === false
        ) {
          reject(
            new Error(
              msg.payload.errorText ||
                msg.payload.errorCode ||
                "TV denied request (returnValue: false)",
            ),
          );
        } else {
          resolve(msg);
        }
      }
    } catch {}
  });

  ws.on("close", () => {
    if (inputRetryTimer) {
      clearTimeout(inputRetryTimer);
      inputRetryTimer = null;
    }
    console.log("TV disconnected, reconnecting in 5s...");
    inputWs = null;
    setTimeout(connect, 5000);
  });

  ws.on("error", (err) => console.error("WS error:", err.message));
}

// Routes
app.post("/tv/power/off", async (req, res) => {
  try {
    const r = await send("ssap://system/turnOff");
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tv/power/on", async (req, res) => {
  const macHex = parseMac(TV_WOL_MAC);
  let wolSent = false;
  let turnOnRequested = false;
  const warnings = [];

  if (macHex) {
    try {
      await sendWakeOnLan(macHex);
      wolSent = true;
    } catch (e) {
      warnings.push(`wol: ${e.message}`);
    }
  }

  if (ws?.readyState === WebSocket.OPEN) {
    try {
      await send("ssap://system/turnOn");
      turnOnRequested = true;
    } catch (e) {
      warnings.push(`turnOn: ${e.message}`);
    }
  }

  if (wolSent || turnOnRequested) {
    return res.json({
      ok: true,
      wolSent,
      turnOnRequested,
      ...(warnings.length ? { warnings } : {}),
    });
  }

  res.status(503).json({
    ok: false,
    error: macHex
      ? warnings.join("; ") || "Power on failed"
      : "TV is unreachable and Wake-on-LAN is not configured. Set TV_WOL_MAC (or TV_MAC) for the TV Ethernet/Wi-Fi MAC on this host.",
  });
});

app.get("/tv/volume", async (req, res) => {
  try {
    const r = await send("ssap://audio/getVolume");
    res.json(r.payload);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tv/volume", async (req, res) => {
  const { volume } = req.body;
  try {
    const r = await send("ssap://audio/setVolume", { volume });
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tv/mute", async (req, res) => {
  const { mute } = req.body;
  try {
    const r = await send("ssap://audio/setMute", { mute });
    res.json({ ok: true, result: r });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tv/home", async (req, res) => {
  try {
    const r = await sendKey("HOME");
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tv/back", async (req, res) => {
  try {
    const r = await sendKey("BACK");
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// Quick Settings / Q Settings (Magic Remote); not necessarily full "All Settings" tree.
app.post("/tv/settings", async (req, res) => {
  try {
    const r = await sendKey("MENU");
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

for (const [path, key] of [
  ["/tv/up", "UP"],
  ["/tv/down", "DOWN"],
  ["/tv/left", "LEFT"],
  ["/tv/right", "RIGHT"],
  ["/tv/enter", "ENTER"],
]) {
  app.post(path, async (req, res) => {
    try {
      res.json(await sendKey(key));
    } catch (e) {
      res.status(500).json({ error: e.message });
    }
  });
}

app.post("/tv/button", async (req, res) => {
  const body =
    req.body && typeof req.body === "object" && !Array.isArray(req.body)
      ? req.body
      : {};
  const { button } = body;
  if (button === undefined || button === null || button === "") {
    return res.status(400).json({
      error: "Missing button in JSON body",
      hint: `curl -sS -X POST http://127.0.0.1:${PORT}/tv/button -H 'Content-Type: application/json' -d '{"button":"ENTER"}'`,
    });
  }
  const allowed = [
    "UP",
    "DOWN",
    "LEFT",
    "RIGHT",
    "ENTER",
    "BACK",
    "HOME",
    "EXIT",
    "MENU",
    "QMENU",
    "SETTINGS",
  ];
  if (!allowed.includes(button)) {
    return res
      .status(400)
      .json({ error: `Invalid button. Allowed: ${allowed.join(", ")}` });
  }
  const keyName = button === "SETTINGS" ? "MENU" : button;
  try {
    const r = await sendKey(keyName);
    res.json(r);
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// app.all so POST (and other non-GET) always hit this handler — avoids Express’s HTML "Cannot POST".
app.all("/tv/status", async (req, res) => {
  if (req.method !== "GET") {
    return res
      .status(405)
      .set("Allow", "GET")
      .json({
        error: "Use GET /tv/status",
        hint: `curl -sS http://127.0.0.1:${PORT}/tv/status`,
      });
  }
  const socketConnected = ws?.readyState === WebSocket.OPEN;
  const inputOk = inputWs?.readyState === WebSocket.OPEN;
  const base = {
    connected: socketConnected,
    inputConnected: inputOk,
    ...(lastInputSocketError != null && lastInputSocketError !== ""
      ? { lastInputSocketError }
      : {}),
  };
  // Main WS can stay open in standby / quick-start; "connected" alone is not "TV is on".
  if (!socketConnected) {
    return res.json({ ...base, screenOn: false });
  }
  try {
    const r = await send(
      "ssap://com.webos.service.tvpower/power/getPowerState",
      {},
    );
    const state = r?.payload?.state;
    const powerState = typeof state === "string" ? state : undefined;
    const screenOn = powerState === "Active";
    return res.json({
      ...base,
      ...(powerState !== undefined ? { powerState } : {}),
      screenOn,
    });
  } catch (e) {
    // Omit screenOn so clients fall back to socket-only semantics (older firmware / errors).
    return res.json(base);
  }
});

connect();
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `TV relay listening on ${PORT} (not pretzel-server :3001). Status: curl -sS http://127.0.0.1:${PORT}/tv/status | D-pad+OK: POST /tv/up|down|left|right|enter | Other keys: POST /tv/button -H 'Content-Type: application/json' -d '{\"button\":\"ENTER\"}' | Power on: curl -sS -X POST http://127.0.0.1:${PORT}/tv/power/on`,
  );
});
