"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, readFileSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const {
  DEFAULT_ROUTINES,
  validateRoutine,
  cycleDateOf,
  resolveAnchor,
  describeAction,
  targetsLight,
  RoutineStore,
  RoutineEngine,
} = require("./routines");
const { localToUtc, hmInTz } = require("./tztime");

const TZ = "America/New_York";
const GEO = { tz: TZ, lat: 40.71, lon: -74.01 };
const at = (ymd, hm) => localToUtc(ymd, hm, TZ);

function setup(t, { routines, now } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "routines-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  if (routines) writeFileSync(join(dir, "routines.json"), JSON.stringify({ routines }));
  const clock = { now: now ?? at("2026-10-12", "08:00") };
  const calls = [];
  const fail = new Set();
  const handler = (type) => async (a) => {
    calls.push({ type, a, at: clock.now });
    if (fail.has(type)) throw new Error(`${type} broke`);
    return "done";
  };
  const store = new RoutineStore(dir);
  const engine = new RoutineEngine({
    store,
    ...GEO,
    actions: { lights: handler("lights"), speak: handler("speak") },
    now: () => clock.now,
  });
  return { dir, clock, calls, fail, store, engine };
}

const routine = (over = {}) => ({
  id: "r",
  name: "R",
  enabled: true,
  days: [0, 1, 2, 3, 4, 5, 6],
  anchor: { type: "time", time: "09:00" },
  steps: [{ offsetMin: 0, action: { type: "speak", text: "hi" } }],
  ...over,
});

test("the default routines are valid and cover the household day", () => {
  for (const r of DEFAULT_ROUTINES) assert.equal(validateRoutine(r), null, r.id);
  assert.deepEqual(
    DEFAULT_ROUTINES.map((r) => r.id),
    ["wake-up", "noon", "afternoon", "sunset", "wind-down", "sleep"],
  );
});

test("validation rejects bad input", () => {
  assert.match(validateRoutine(routine({ id: "Bad Id" })), /id/);
  assert.match(validateRoutine(routine({ days: [7] })), /days/);
  assert.match(validateRoutine(routine({ days: [1, 1] })), /days/);
  assert.match(validateRoutine(routine({ anchor: { type: "time", time: "9:00" } })), /HH:MM/);
  assert.match(validateRoutine(routine({ anchor: { type: "sun", event: "noon", offsetMin: 0 } })), /sunrise or sunset/);
  assert.match(validateRoutine(routine({ steps: [] })), /steps/);
  assert.match(
    validateRoutine(routine({ steps: [{ offsetMin: 0, action: { type: "lights", targets: ["kitchen"], power: "on" } }] })),
    /target/,
  );
  assert.match(
    validateRoutine(routine({ steps: [{ offsetMin: 0, action: { type: "lights", targets: ["all"] } }] })),
    /power, brightness or kelvin/,
  );
  assert.match(validateRoutine(routine({ steps: [{ offsetMin: 0, action: { type: "speak", text: " " } }] })), /text/);
  assert.match(validateRoutine(routine({ steps: [{ offsetMin: 0, action: { type: "tv" } }] })), /lights or speak/);
});

test("cycles run 04:00 to 04:00", () => {
  assert.equal(cycleDateOf(at("2026-10-13", "01:00"), TZ), "2026-10-12");
  assert.equal(cycleDateOf(at("2026-10-13", "03:59"), TZ), "2026-10-12");
  assert.equal(cycleDateOf(at("2026-10-13", "04:00"), TZ), "2026-10-13");
});

test("anchors before 04:00 land on the next calendar day; weekdays follow the cycle", () => {
  const sleep = routine({ anchor: { type: "time", time: "01:00" }, days: [6] }); // Sundays
  // Sunday 18 Oct's cycle ends with Monday 19 Oct 01:00.
  assert.equal(resolveAnchor(sleep, "2026-10-18", GEO).at, at("2026-10-19", "01:00"));
  assert.equal(resolveAnchor(sleep, "2026-10-19", GEO), null);
});

test("sun anchors use the computed sunset plus the offset", () => {
  const r = routine({ anchor: { type: "sun", event: "sunset", offsetMin: -60 } });
  const a = resolveAnchor(r, "2026-10-12", GEO);
  assert.equal(hmInTz(a.at, TZ), "17:22");
  assert.equal(a.source, "sunset 18:22 − 60 min");
});

test("one-off changes move or skip a single cycle", () => {
  const r = routine();
  const moved = resolveAnchor(r, "2026-10-12", GEO, { time: "07:30" });
  assert.equal(moved.at, at("2026-10-12", "07:30"));
  assert.match(moved.source, /moved to 07:30 \(usually 09:00\)/);
  assert.equal(resolveAnchor(r, "2026-10-12", GEO, { skip: true }).skipped, true);
});

test("a due step runs once and is logged", async (t) => {
  const { clock, calls, engine, store } = setup(t, { routines: [routine()] });
  clock.now = at("2026-10-12", "09:00") + 10_000;
  await engine.tick();
  await engine.tick();
  assert.equal(calls.length, 1);
  assert.equal(store.runs.length, 1);
  assert.equal(store.runs[0].key, "r|2026-10-12|0");
  assert.equal(store.runs[0].ok, true);
  // The log survives a restart, so a new engine doesn't run it again.
  const again = setup(t, { routines: [routine()], now: clock.now });
  writeFileSync(join(again.dir, "routine-runs.json"), JSON.stringify(store.runs));
  again.store.load();
  await again.engine.tick();
  assert.equal(again.calls.length, 0);
});

test("missed steps catch up for 5 minutes, then are dropped", async (t) => {
  const a = setup(t, { routines: [routine()], now: at("2026-10-12", "09:04") });
  await a.engine.tick();
  assert.equal(a.calls.length, 1);
  const b = setup(t, { routines: [routine()], now: at("2026-10-12", "09:06") });
  await b.engine.tick();
  assert.equal(b.calls.length, 0);
});

test("steps run in offset order and failures are recorded", async (t) => {
  const r = routine({
    steps: [
      { offsetMin: 0, action: { type: "speak", text: "second" } },
      { offsetMin: -1, action: { type: "lights", targets: ["all"], power: "on" } },
    ],
  });
  const { clock, calls, fail, engine, store } = setup(t, { routines: [r] });
  fail.add("lights");
  clock.now = at("2026-10-12", "09:00");
  await engine.tick();
  assert.deepEqual(calls.map((c) => c.type), ["lights", "speak"]);
  assert.equal(store.runs[0].ok, false);
  assert.equal(store.runs[0].error, "lights broke");
  assert.equal(store.runs[1].ok, true);
});

test("disabled routines, other weekdays and skipped cycles don't run", async (t) => {
  const routines = [
    routine({ id: "off", enabled: false }),
    routine({ id: "weekend", days: [5, 6] }), // 12 Oct is a Monday
    routine({ id: "skipme" }),
  ];
  const { clock, calls, engine } = setup(t, { routines });
  assert.equal(engine.setOverride("skipme", "2026-10-12", { skip: true }).ok, true);
  clock.now = at("2026-10-12", "09:00");
  await engine.tick();
  assert.equal(calls.length, 0);
});

test("saving or moving a routine never fires steps that were already due", async (t) => {
  const { clock, calls, engine } = setup(t, { routines: [routine()] });
  clock.now = at("2026-10-12", "09:02");
  engine.saveRoutine(routine());
  await engine.tick();
  assert.equal(calls.length, 0);
  // Moving the next cycle to an earlier time that has already passed does nothing either.
  const { clock: c2, calls: calls2, engine: e2 } = setup(t, { routines: [routine({ anchor: { type: "time", time: "10:00" } })] });
  c2.now = at("2026-10-12", "09:02");
  e2.setOverride("r", "2026-10-12", { time: "09:00" });
  await e2.tick();
  assert.equal(calls2.length, 0);
  c2.now = at("2026-10-12", "10:00");
  await e2.tick();
  assert.equal(calls2.length, 0, "the usual 10:00 no longer applies");
});

test("a moved cycle runs at its new time", async (t) => {
  const { clock, calls, engine } = setup(t, { routines: [routine()] });
  clock.now = at("2026-10-11", "21:00");
  assert.equal(engine.setOverride("r", "2026-10-12", { time: "07:30" }).ok, true);
  clock.now = at("2026-10-12", "07:30");
  await engine.tick();
  assert.equal(calls.length, 1);
});

test("one-off changes are limited to the current and next 7 cycles", (t) => {
  const { engine } = setup(t, { routines: [routine()] });
  assert.equal(engine.setOverride("r", "2026-10-11", { skip: true }).status, 400);
  assert.equal(engine.setOverride("r", "2026-10-20", { skip: true }).status, 400);
  assert.equal(engine.setOverride("r", "2026-10-19", { skip: true }).ok, true);
  assert.equal(engine.setOverride("nope", "2026-10-12", { skip: true }).status, 404);
  assert.equal(engine.setOverride("r", "2026-10-12", { time: "25:00" }).status, 400);
  assert.equal(engine.clearOverride("r", "2026-10-19"), true);
  assert.equal(engine.clearOverride("r", "2026-10-19"), false);
});

test("upcoming lists two cycles in time order with the next routine", (t) => {
  const { engine } = setup(t, { now: at("2026-10-12", "10:00") });
  const up = engine.upcoming();
  assert.equal(up.cycleDate, "2026-10-12");
  assert.equal(up.cycles.length, 2);
  const today = up.cycles[0];
  assert.deepEqual(
    today.routines.map((r) => `${r.id}@${r.time}`),
    ["wake-up@09:00", "noon@12:00", "afternoon@15:00", "sunset@17:22", "wind-down@00:00", "sleep@01:00"],
  );
  assert.equal(today.sunset, "18:22");
  assert.equal(today.routines[0].past, true);
  assert.equal(up.next, "noon");
});

test("each light gets its next scheduled change", (t) => {
  const { engine } = setup(t, { now: at("2026-10-12", "10:00") });
  const next = engine.nextForLights([
    { id: "globe", room: "Bedroom" },
    { id: "tripod", room: "Lounge" },
    { id: "lamp", room: "Kitchen" },
  ]);
  assert.equal(next.globe.routineId, "wind-down");
  assert.equal(next.globe.time, "00:00");
  assert.equal(next.tripod.routineId, "sunset");
  assert.equal(next.tripod.onlyIfOff, true);
  assert.equal(next.lamp.routineId, "wind-down", "all-lights steps reach every room");
});

test("routines persist and invalid saved entries are skipped", (t) => {
  const { dir, engine } = setup(t);
  const res = engine.saveRoutine({ ...routine(), id: "extra", extraField: 1 });
  assert.equal(res.ok, true);
  assert.equal(res.routine.extraField, undefined);
  const saved = JSON.parse(readFileSync(join(dir, "routines.json"), "utf8")).routines;
  assert.equal(saved.length, DEFAULT_ROUTINES.length + 1);
  writeFileSync(join(dir, "routines.json"), JSON.stringify({ routines: [routine(), { id: "broken" }] }));
  const store = new RoutineStore(dir);
  assert.deepEqual(store.routines.map((r) => r.id), ["r"]);
});

test("run now runs every step and logs it as manual", async (t) => {
  const { calls, engine, store } = setup(t);
  await engine.runNow("wake-up");
  assert.equal(calls.length, 1);
  assert.equal(store.runs[0].manual, true);
  assert.equal(await engine.runNow("nope"), null);
});

test("describes actions and matches light targets", () => {
  assert.equal(
    describeAction({ type: "lights", targets: ["room:Bedroom"], power: "on", brightness: 0.5, kelvin: 4000, fadeS: 60 }),
    "Bedroom lights on · 50% · 4000K · 1 min fade",
  );
  assert.equal(describeAction({ type: "lights", targets: ["all"], power: "off" }), "All lights off");
  assert.equal(describeAction({ type: "speak", text: "Hi" }), "Speak: “Hi”");
  assert.ok(targetsLight(["room:lounge"], { id: "x", room: "Lounge" }));
  assert.ok(targetsLight(["light:x"], { id: "x", room: "" }));
  assert.ok(!targetsLight(["room:Bedroom"], { id: "x", room: "Lounge" }));
});
