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
const PORT = 3000;
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

async function connectInputSocket() {
  try {
    const r = await send(
      "ssap://com.webos.service.networkinput/getPointerInputSocket",
    );
    const socketPath = r?.payload?.socketPath;
    if (!socketPath) return console.error("No input socket path");
    const url = `wss://${TV_IP}${socketPath}`;
    inputWs = new WebSocket(url, { rejectUnauthorized: false });
    inputWs.on("open", () => console.log("Input socket connected"));
    inputWs.on("error", (e) => console.error("Input socket error:", e.message));
    inputWs.on("close", () => console.log("Input socket closed"));
  } catch (e) {
    console.error("Failed to connect input socket:", e.message);
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
          forcePairing: false,
          pairingType: "PROMPT",
          "client-key": CLIENT_KEY,
          manifest: {
            manifestVersion: 1,
            appVersion: "1.1",
            signed: {
              created: "20140509",
              appId: "com.lge.test",
              vendorId: "com.lge",
              localizedAppNames: { "": "LG Remote App" },
              localizedVendorNames: { "": "LG Electronics" },
              permissions: [
                "TEST_SECURE",
                "CONTROL_INPUT_JOYSTICK",
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
            },
            permissions: [
              "LAUNCH",
              "LAUNCH_WEBAPP",
              "APP_TO_APP",
              "CLOSE",
              "TEST_OPEN",
              "TEST_PROTECTED",
              "MANAGER_READ",
              "MANAGER_WRITE",
              "MONITOR",
              "MONITOR_PROTECTED",
              "WRITE_SETTINGS",
              "WRITE_NOTIFICATION_ALERT",
              "CONTROL_AUDIO",
              "CONTROL_DISPLAY",
              "CONTROL_INPUT_JOYSTICK",
              "CONTROL_INPUT_MEDIA_RECORDING",
              "CONTROL_INPUT_MEDIA_PLAYBACK",
              "CONTROL_INPUT_TV",
              "CONTROL_POWER",
              "READ_APP_STATUS",
              "READ_CURRENT_CHANNEL",
              "READ_INPUT_DEVICE_LIST",
              "READ_NETWORK_STATE",
              "READ_RUNNING_APPS",
              "READ_TV_CHANNEL_LIST",
              "WRITE_NOTIFICATION_MESSAGE",
              "READ_POWER_STATE",
              "READ_COUNTRY_INFO",
            ],
            signatures: [
              {
                signatureVersion: 1,
                signature:
                  "eyJhbGdvcml0aG0iOiJSU0EtU0hBMjU2Iiwia2V5SWQiOiJ0ZXN0LXNpZ25pbmctY2VydCIsInNpZ25hdHVyZVZlcnNpb24iOjF9.hrVRgjM186TQxDpGSd6Q5j7HGKN6WHYA7qdFbGJAcKQ7aRFQUPMq0s5DKRmRWuVz5c0H2aaH3q3yrEWMTCnDQ==",
              },
            ],
          },
        },
      }),
    );
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data);
      console.log("TV:", JSON.stringify(msg));
      if (msg.type === "registered") setTimeout(connectInputSocket, 1000);
      if (msg.id && pendingRequests.has(msg.id)) {
        const { resolve } = pendingRequests.get(msg.id);
        pendingRequests.delete(msg.id);
        resolve(msg);
      }
    } catch {}
  });

  ws.on("close", () => {
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

app.post("/tv/button", async (req, res) => {
  const { button } = req.body;
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

app.get("/tv/status", (req, res) => {
  res.json({
    connected: ws?.readyState === WebSocket.OPEN,
    inputConnected: inputWs?.readyState === WebSocket.OPEN,
  });
});

connect();
app.listen(PORT, "0.0.0.0", () => {
  console.log(
    `TV relay listening on ${PORT} (not pretzel-server :3001). Test: curl -sS -X POST http://127.0.0.1:${PORT}/tv/power/on`,
  );
});
