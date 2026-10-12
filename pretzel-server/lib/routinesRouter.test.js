"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { mkdtempSync, rmSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { RoutineStore, RoutineEngine } = require("./routines");
const { createRoutinesRouter } = require("./routinesRouter");
const { localToUtc } = require("./tztime");

const TZ = "America/New_York";

async function serve(t) {
  const dir = mkdtempSync(join(tmpdir(), "routines-http-"));
  const ran = [];
  const engine = new RoutineEngine({
    store: new RoutineStore(dir),
    tz: TZ,
    lat: 40.71,
    lon: -74.01,
    actions: { lights: async (a) => ran.push(a), speak: async (a) => ran.push(a) },
    now: () => localToUtc("2026-10-12", "10:00", TZ),
  });
  const app = express();
  app.use(express.json());
  app.use(
    "/pretzel/routines",
    createRoutinesRouter({
      engine,
      listLights: async () => [{ id: "globe", room: "Bedroom" }],
      requirePasscode: (req, res, next) =>
        req.headers["x-pretzel-settings-passcode"] === "pw" ? next() : res.status(403).json({ ok: false }),
    }),
  );
  const server = app.listen(0);
  t.after(() => {
    server.close();
    rmSync(dir, { recursive: true, force: true });
  });
  const base = `http://127.0.0.1:${server.address().port}/pretzel/routines`;
  const call = async (path, { method = "GET", body, pass } = {}) => {
    const r = await fetch(base + path, {
      method,
      headers: {
        ...(body ? { "Content-Type": "application/json" } : {}),
        ...(pass ? { "X-Pretzel-Settings-Passcode": pass } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: r.status, data: await r.json() };
  };
  return { call, ran };
}

test("schedule, one-off changes and light hints are open on the LAN", async (t) => {
  const { call } = await serve(t);
  const up = await call("/upcoming");
  assert.equal(up.status, 200);
  assert.equal(up.data.next.id, "noon");

  const skip = await call("/wake-up/override/2026-10-13", { method: "PUT", body: { skip: true } });
  assert.equal(skip.status, 200);
  const after = await call("/upcoming");
  assert.equal(after.data.cycles[1].routines.find((r) => r.id === "wake-up").skipped, true);
  assert.equal((await call("/wake-up/override/2026-10-13", { method: "DELETE" })).status, 200);

  const bad = await call("/wake-up/override/2026-10-13", { method: "PUT", body: {} });
  assert.equal(bad.status, 400);

  const lights = await call("/lights-next");
  assert.equal(lights.data.lights.globe.routineId, "wind-down");
});

test("editing routines needs the passcode", async (t) => {
  const { call } = await serve(t);
  const body = {
    name: "Wake Up",
    enabled: true,
    days: [0, 1, 2, 3, 4],
    anchor: { type: "time", time: "07:30" },
    steps: [{ offsetMin: 0, action: { type: "lights", targets: ["room:Bedroom"], power: "on" } }],
  };
  assert.equal((await call("/wake-up", { method: "PUT", body })).status, 403);
  const ok = await call("/wake-up", { method: "PUT", body, pass: "pw" });
  assert.equal(ok.status, 200);
  assert.equal(ok.data.routine.anchor.time, "07:30");
  const invalid = await call("/wake-up", { method: "PUT", body: { ...body, days: [9] }, pass: "pw" });
  assert.equal(invalid.status, 400);
  assert.equal((await call("/wake-up", { method: "DELETE" })).status, 403);
  assert.equal((await call("/wake-up", { method: "DELETE", pass: "pw" })).status, 200);
  assert.equal((await call("/wake-up", { method: "DELETE", pass: "pw" })).status, 404);
});

test("run now starts the routine and logs it", async (t) => {
  const { call, ran } = await serve(t);
  assert.equal((await call("/noon/run", { method: "POST" })).status, 202);
  await new Promise((r) => setTimeout(r, 20));
  assert.equal(ran.length, 1);
  const runs = await call("/runs");
  assert.equal(runs.data.runs[0].routineId, "noon");
  assert.equal((await call("/nope/run", { method: "POST" })).status, 404);
});
