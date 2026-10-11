"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const dgram = require("dgram");
const {
  parseWizLights,
  wizRequest,
  hsToRgb,
  rgbToHs,
  pilotToLight,
  stateToPilot,
} = require("./wiz");

test("parses WIZ_LIGHTS, defaulting to the lounge bulb", () => {
  assert.deepEqual(parseWizLights(undefined), [
    { ip: "192.168.1.182", label: "Onion", room: "Lounge" },
  ]);
  assert.deepEqual(parseWizLights(""), []);
  assert.deepEqual(
    parseWizLights("192.168.1.50:Desk:Bedroom, bad:Nope:Lounge,192.168.1.51"),
    [
      { ip: "192.168.1.50", label: "Desk", room: "Bedroom" },
      { ip: "192.168.1.51", label: "192.168.1.51", room: "" },
    ],
  );
});

test("converts between hue/saturation and RGB", () => {
  assert.deepEqual(hsToRgb(0, 1), { r: 255, g: 0, b: 0 });
  assert.deepEqual(hsToRgb(120, 1), { r: 0, g: 255, b: 0 });
  assert.deepEqual(hsToRgb(240, 1), { r: 0, g: 0, b: 255 });
  assert.deepEqual(hsToRgb(0, 0), { r: 255, g: 255, b: 255 });
  for (const hue of [0, 30, 60, 120, 180, 240, 270, 320]) {
    const { r, g, b } = hsToRgb(hue, 1);
    const back = rgbToHs(r, g, b);
    assert.ok(Math.abs(back.hue - hue) <= 1, `hue ${hue} → ${back.hue}`);
    assert.equal(back.saturation, 1);
  }
  assert.deepEqual(rgbToHs(0, 0, 0), { hue: 0, saturation: 0 });
});

test("maps a white getPilot reply to a LIFX-shaped light", () => {
  const cfg = { ip: "192.168.1.182", label: "Onion", room: "Lounge" };
  const light = pilotToLight(cfg, {
    mac: "9877d5b955f6",
    rssi: -51,
    state: true,
    sceneId: 11,
    temp: 2700,
    dimming: 100,
  });
  assert.equal(light.id, "192.168.1.182");
  assert.equal(light.uuid, "9877d5b955f6");
  assert.equal(light.provider, "wiz");
  assert.equal(light.connected, true);
  assert.equal(light.power, "on");
  assert.equal(light.brightness, 1);
  assert.deepEqual(light.color, { hue: 0, saturation: 0, kelvin: 2700 });
  assert.equal(light.group.name, "Lounge");
});

test("maps an RGB reply and an unreachable bulb", () => {
  const cfg = { ip: "192.168.1.182", label: "Onion", room: "Lounge" };
  const rgb = pilotToLight(cfg, { state: true, r: 0, g: 0, b: 255, dimming: 40 });
  assert.equal(rgb.color.hue, 240);
  assert.equal(rgb.color.saturation, 1);
  assert.equal(rgb.brightness, 0.4);

  const offline = pilotToLight(cfg, null);
  assert.equal(offline.connected, false);
  assert.equal(offline.power, "off");
  assert.equal(offline.color, undefined);
});

test("turns LIFX state bodies into setPilot params", () => {
  assert.deepEqual(stateToPilot({ power: "off", brightness: 0.5 }), { state: false });
  assert.deepEqual(stateToPilot({ power: "on" }), { state: true });
  assert.deepEqual(stateToPilot({ brightness: 0.5, duration: 0.3 }), { dimming: 50 });
  assert.deepEqual(stateToPilot({ brightness: 0 }), { dimming: 10 });
  assert.deepEqual(stateToPilot({ color: "kelvin:2700", duration: 0.5 }), { temp: 2700 });
  assert.deepEqual(stateToPilot({ color: "kelvin:1500" }), { temp: 2200 });
  assert.deepEqual(stateToPilot({ color: "hue:240 saturation:1.0" }), { r: 0, g: 0, b: 255 });
  assert.deepEqual(stateToPilot({ color: "hue:120" }), { r: 0, g: 255, b: 0 });
  assert.equal(stateToPilot({ duration: 1 }), null);
  assert.equal(stateToPilot(null), null);
});

test("wizRequest retries until a fake bulb answers", async (t) => {
  const bulb = dgram.createSocket("udp4");
  let seen = 0;
  bulb.on("message", (msg, rinfo) => {
    const req = JSON.parse(msg.toString());
    if (req.method !== "setPilot") return; // a bulb that never answers getPilot
    seen += 1;
    if (seen < 2) return; // drop the first packet
    const reply = { method: req.method, env: "pro", result: { success: true } };
    bulb.send(JSON.stringify(reply), rinfo.port, rinfo.address);
  });
  await new Promise((r) => bulb.bind(0, "127.0.0.1", r));
  t.after(() => bulb.close());

  const port = bulb.address().port;
  const result = await wizRequest(
    "127.0.0.1",
    { method: "setPilot", params: { state: true } },
    { timeoutMs: 100, attempts: 3, port },
  );
  assert.deepEqual(result, { success: true });
  assert.equal(seen, 2);

  await assert.rejects(
    wizRequest("127.0.0.1", { method: "getPilot", params: {} }, { timeoutMs: 50, attempts: 1, port }),
  );
});
