"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { createLights, createSpeaker, interpolate } = require("./routineActions");

const WIZ = [
  { ip: "10.0.0.5", label: "Onion", room: "Lounge" },
  { ip: "10.0.0.6", label: "Desk", room: "Bedroom" },
];

function fakeLights({ lifx = [], wizState = {}, lifxStatus = 200, noToken = false } = {}) {
  const lifxCalls = [];
  const wizCalls = [];
  const pilots = { "10.0.0.5": { state: false }, "10.0.0.6": { state: true, dimming: 80 }, ...wizState };
  const fetchImpl = async (url, init = {}) => {
    lifxCalls.push({ url, method: init.method ?? "GET", body: init.body ? JSON.parse(init.body) : null });
    if (lifxStatus !== 200) return { ok: false, status: lifxStatus, text: async () => "nope", json: async () => ({}) };
    if (url.endsWith("/lights/all")) return { ok: true, json: async () => lifx };
    const body = JSON.parse(init.body);
    return {
      ok: true,
      json: async () => ({ results: body.states.map(() => ({ results: [{ id: "a", status: "ok" }] })) }),
    };
  };
  const wizRequest = async (ip, msg) => {
    wizCalls.push({ ip, ...msg });
    if (pilots[ip] === "down") throw new Error("timed out");
    if (msg.method === "getPilot") return pilots[ip];
    return { success: true };
  };
  const getWizLight = async (cfg) => {
    const p = pilots[cfg.ip];
    return {
      id: cfg.ip,
      label: cfg.label,
      group: { name: cfg.room },
      connected: p !== "down",
      power: p !== "down" && p.state ? "on" : "off",
    };
  };
  const lights = createLights({
    wizLights: WIZ,
    getWizLight,
    wizRequest,
    lifxToken: () => (noToken ? null : "tok"),
    lifxBase: "https://lifx.test/v1",
    fetchImpl,
    sleepImpl: async () => {},
  });
  return { lights, lifxCalls, wizCalls };
}

const tick = () => new Promise((r) => setImmediate(r));

test("room targets become a LIFX group selector plus the WiZ bulbs in that room", async () => {
  const { lights, lifxCalls, wizCalls } = fakeLights();
  const note = await lights.apply({ type: "lights", targets: ["room:Bedroom"], power: "on", brightness: 0.5, kelvin: 4000 });
  assert.equal(note, "2 lights");
  assert.deepEqual(lifxCalls[0].body.states, [
    { selector: "group:Bedroom", power: "on", brightness: 0.5, color: "kelvin:4000", duration: 0 },
  ]);
  assert.deepEqual(wizCalls.at(-1), { ip: "10.0.0.6", method: "setPilot", params: { state: true, dimming: 50, temp: 4000 } });
  assert.ok(!wizCalls.some((c) => c.ip === "10.0.0.5"));
});

test("power off doesn't send brightness or colour to LIFX", async () => {
  const { lights, lifxCalls } = fakeLights();
  await lights.apply({ type: "lights", targets: ["all"], power: "off", brightness: 0.3, kelvin: 2200, fadeS: 60 });
  assert.deepEqual(lifxCalls[0].body.states, [{ selector: "all", power: "off", duration: 60 }]);
});

test("WiZ fades are stepped and end where they should", async () => {
  const { lights, wizCalls } = fakeLights();
  await lights.apply({ type: "lights", targets: ["light:10.0.0.6"], brightness: 0.1, kelvin: 2200, fadeS: 60 });
  for (let i = 0; i < 50; i += 1) await tick();
  const sets = wizCalls.filter((c) => c.method === "setPilot").map((c) => c.params);
  assert.deepEqual(sets[0], { state: true, dimming: 80, temp: 2200 });
  assert.equal(sets.length, 31);
  assert.deepEqual(sets.at(-1), { state: true, dimming: 10 });
  const dims = sets.map((s) => s.dimming);
  assert.ok(dims.every((d, i) => i === 0 || d <= dims[i - 1]), "monotonic");
});

test("fading off ends with the bulb off", async () => {
  const { lights, wizCalls } = fakeLights();
  await lights.apply({ type: "lights", targets: ["light:10.0.0.6"], power: "off", fadeS: 10 });
  for (let i = 0; i < 50; i += 1) await tick();
  assert.deepEqual(wizCalls.at(-1).params, { state: false });
});

test("without power, WiZ bulbs that are off stay off", async () => {
  const { lights, wizCalls } = fakeLights({ noToken: true });
  const note = await lights.apply({ type: "lights", targets: ["room:Lounge"], brightness: 0.1 });
  assert.equal(note, "0 lights");
  assert.ok(!wizCalls.some((c) => c.method === "setPilot"));
});

test("onlyIfOff only touches lights that are off", async () => {
  const lifx = [
    { id: "aa", label: "Tripod", group: { name: "Lounge" }, connected: true, power: "on" },
    { id: "bb", label: "Floor", group: { name: "Lounge" }, connected: true, power: "off" },
    { id: "cc", label: "Globe", group: { name: "Bedroom" }, connected: true, power: "off" },
  ];
  const { lights, lifxCalls, wizCalls } = fakeLights({ lifx });
  const note = await lights.apply({ type: "lights", targets: ["room:Lounge"], power: "on", brightness: 1, onlyIfOff: true });
  assert.equal(note, "2 lights");
  assert.deepEqual(lifxCalls.at(-1).body.states.map((s) => s.selector), ["id:bb"]);
  assert.ok(wizCalls.some((c) => c.ip === "10.0.0.5" && c.method === "setPilot"));
});

test("onlyIfOff does nothing when the lights are already on", async () => {
  const lifx = [{ id: "aa", label: "Tripod", group: { name: "Lounge" }, connected: true, power: "on" }];
  const { lights } = fakeLights({ lifx, wizState: { "10.0.0.5": { state: true, dimming: 50 } } });
  assert.equal(
    await lights.apply({ type: "lights", targets: ["room:Lounge"], power: "on", onlyIfOff: true }),
    "all target lights already on",
  );
});

test("onlyIfOff skips the step when light state can't be read", async () => {
  const { lights, lifxCalls } = fakeLights({ lifxStatus: 500 });
  await assert.rejects(
    lights.apply({ type: "lights", targets: ["room:Lounge"], power: "on", onlyIfOff: true }),
    /skipped: couldn't read light state/,
  );
  assert.ok(lifxCalls.every((c) => c.method === "GET"));
});

test("a step fails only when no light changed", async () => {
  const { lights } = fakeLights({ lifxStatus: 500, wizState: { "10.0.0.5": "down", "10.0.0.6": "down" } });
  await assert.rejects(lights.apply({ type: "lights", targets: ["all"], power: "on" }), /LIFX API 500.*WiZ Onion.*WiZ Desk/);
  const partial = fakeLights({ lifxStatus: 500 });
  const note = await partial.lights.apply({ type: "lights", targets: ["all"], power: "on" });
  assert.match(note, /^2 lights; LIFX API 500/);
});

test("speak fills in its text and counts toward chores", async () => {
  const said = [];
  let fires = 0;
  const speaker = createSpeaker({
    speak: async (text, style) => said.push({ text, style }),
    weather: {
      todayLabel: () => "Monday, October 12th",
      fetchWeather: async () => ({}),
      buildWeatherContext: () => ({ tempC: 18, condition: "sunny", rainNote: "", sunClause: "" }),
    },
    sunToday: () => ({ sunrise: "07:04", sunset: "18:22" }),
    choresManager: { onReminderFired: () => (fires += 1), pendingSummaryShort: () => "Laundry is due." },
    tz: "America/New_York",
    now: () => new Date("2026-10-12T16:00:00Z"),
  });
  await speaker.apply({ type: "speak", text: "It's {{time}}, {{tempC}} degrees. {{chores}} Sunset {{sunset}}.{{nope}}" });
  assert.deepEqual(said, [{ text: "It's 12:00 PM, 18 degrees. Laundry is due. Sunset 18:22.", style: "cheerful" }]);
  assert.equal(fires, 1);
});

test("speak failures reach the run log", async () => {
  const speaker = createSpeaker({
    speak: async () => {
      throw new Error("speak.sh exited 1");
    },
    weather: { todayLabel: () => "" },
    sunToday: () => ({}),
    choresManager: { onReminderFired: () => {} },
    tz: "America/New_York",
  });
  await assert.rejects(speaker.apply({ type: "speak", text: "hi", style: "plain" }), /exited 1/);
});

test("interpolate leaves no gaps for empty fill-ins", () => {
  assert.equal(interpolate("A {{x}} B  {{y}}", { x: "" }), "A B");
});
