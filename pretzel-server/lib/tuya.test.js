"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const {
  parseTuyaSwitches,
  loadTuyaConfig,
  signRequest,
  createTuyaClient,
  switchFromStatus,
  switchToLight,
  setTuyaSwitch,
} = require("./tuya");

test("parses TUYA_SWITCHES", () => {
  assert.deepEqual(parseTuyaSwitches(undefined), []);
  assert.deepEqual(
    parseTuyaSwitches("eb12ab:Fan:Bedroom:192.168.1.188, bad id:x:y, eb34cd"),
    [
      { id: "eb12ab", label: "Fan", room: "Bedroom", ip: "192.168.1.188" },
      { id: "eb34cd", label: "eb34cd", room: "", ip: null },
    ],
  );
});

test("config needs client id and secret; API base defaults to US", () => {
  assert.equal(loadTuyaConfig({}), null);
  assert.deepEqual(loadTuyaConfig({ TUYA_CLIENT_ID: "a", TUYA_CLIENT_SECRET: "b" }), {
    clientId: "a",
    clientSecret: "b",
    apiBase: "https://openapi.tuyaus.com",
  });
  assert.equal(
    loadTuyaConfig({ TUYA_CLIENT_ID: "a", TUYA_CLIENT_SECRET: "b", TUYA_API_BASE: "https://x/" })
      .apiBase,
    "https://x",
  );
});

test("signs like Tuya's documented token example", () => {
  // Same string-to-sign layout as wyat-ai's tuya.rs (empty-body SHA-256, blank
  // Signature-Headers line); HMAC computed independently here.
  const crypto = require("crypto");
  const args = {
    clientId: "cid",
    clientSecret: "secret",
    t: "1588925778000",
    nonce: "n",
    method: "GET",
    path: "/v1.0/token?grant_type=1",
  };
  const expected = crypto
    .createHmac("sha256", "secret")
    .update(
      "cid1588925778000nGET\ne3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855\n\n/v1.0/token?grant_type=1",
    )
    .digest("hex")
    .toUpperCase();
  assert.equal(signRequest(args), expected);
});

test("reads the switch datapoint from status", () => {
  assert.deepEqual(switchFromStatus([{ code: "switch_1", value: true }]), {
    code: "switch_1",
    on: true,
  });
  assert.deepEqual(switchFromStatus([{ code: "countdown_1", value: 0 }, { code: "switch", value: false }]), {
    code: "switch",
    on: false,
  });
  assert.equal(switchFromStatus(null), null);
  const cfg = { id: "d1", label: "Fan", room: "Bedroom" };
  const light = switchToLight(cfg, [{ code: "switch_1", value: true }]);
  assert.equal(light.power, "on");
  assert.equal(light.connected, true);
  assert.equal(light.provider, "tuya");
  assert.equal(light.group.name, "Bedroom");
  assert.equal(switchToLight(cfg, null).connected, false);
});

test("client fetches a token once, then sends commands with it", async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    const path = new URL(url).pathname;
    const result = path === "/v1.0/token"
      ? { access_token: "tok", expire_time: 7200 }
      : path.endsWith("/status")
        ? [{ code: "switch", value: false }]
        : true;
    return { ok: true, json: async () => ({ success: true, result }) };
  };
  const client = createTuyaClient(
    { clientId: "cid", clientSecret: "s", apiBase: "https://api" },
    { fetchImpl },
  );
  const sent = await setTuyaSwitch(client, { id: "d1" }, { power: "on" });
  assert.deepEqual(sent, { code: "switch", value: true });
  assert.deepEqual(
    calls.map((c) => `${c.init.method} ${c.url}`),
    [
      "GET https://api/v1.0/token?grant_type=1",
      "GET https://api/v1.0/devices/d1/status",
      "POST https://api/v1.0/devices/d1/commands",
    ],
  );
  assert.equal(calls[0].init.headers.access_token, "");
  assert.equal(calls[2].init.headers.access_token, "tok");
  assert.deepEqual(JSON.parse(calls[2].init.body), {
    commands: [{ code: "switch", value: true }],
  });
  assert.equal(await setTuyaSwitch(client, { id: "d1" }, { brightness: 1 }), null);
});
