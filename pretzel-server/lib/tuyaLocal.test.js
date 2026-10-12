"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, writeFileSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const {
  loadTuyaLocalConfig,
  dpsToRows,
  codeToDp,
  createTuyaLocalClient,
  createTuyaClientWithFallback,
} = require("./tuyaLocal");

const DEVICE = {
  id: "eb1",
  key: "k",
  ip: "192.168.1.188",
  version: "3.5",
  mapping: { 1: { code: "switch_1" }, 9: { code: "countdown_1" } },
};

test("local config needs devices.json and a Python", () => {
  const env = { TUYA_LOCAL_DEVICES: "/d.json", TUYA_LOCAL_PYTHON: "/py" };
  assert.deepEqual(loadTuyaLocalConfig(env, () => true), {
    devicesFile: "/d.json",
    python: "/py",
  });
  assert.equal(loadTuyaLocalConfig(env, (p) => p !== "/py"), null);
});

test("maps local DPs to status codes and back", () => {
  assert.deepEqual(dpsToRows({ 1: true, 9: 0, 38: "on" }, DEVICE), [
    { code: "switch_1", value: true },
    { code: "countdown_1", value: 0 },
    { code: "dp_38", value: "on" },
  ]);
  assert.deepEqual(dpsToRows({ 1: false }, {}), [{ code: "switch_1", value: false }]);
  assert.equal(codeToDp("switch_1", DEVICE), "1");
  assert.equal(codeToDp("switch", {}), "1");
  assert.equal(codeToDp("child_lock", DEVICE), null);
});

test("local client runs tuya_local.py with the device and IP", async () => {
  const dir = mkdtempSync(join(tmpdir(), "tuya-"));
  const devicesFile = join(dir, "devices.json");
  writeFileSync(devicesFile, JSON.stringify([DEVICE, { id: "nokey" }]));
  const calls = [];
  const run = (py, args, opts, cb) => {
    calls.push(args.slice(1));
    cb(null, args[2] === "status" ? '{"dps": {"1": true}}\n' : '{"dps": {}}\n');
  };
  const client = createTuyaLocalClient(
    { devicesFile, python: "/py" },
    { run, ipFor: () => "192.168.1.200" },
  );
  assert.equal(client.has("eb1"), true);
  assert.equal(client.has("nokey"), false);
  assert.deepEqual(await client.getStatus("eb1"), [{ code: "switch_1", value: true }]);
  await client.sendCommands("eb1", [{ code: "switch_1", value: false }]);
  assert.deepEqual(calls, [
    [devicesFile, "status", "eb1", "192.168.1.200"],
    [devicesFile, "set", "eb1", "1", "false", "192.168.1.200"],
  ]);

  const failing = createTuyaLocalClient(
    { devicesFile, python: "/py" },
    { run: (py, args, opts, cb) => cb(null, '{"error": "Tuya 192.168.1.188: timeout"}') },
  );
  await assert.rejects(failing.getStatus("eb1"), /timeout/);
});

test("falls back to the cloud when local fails or does not know the device", async () => {
  const local = {
    has: (id) => id === "eb1",
    getStatus: async () => {
      throw new Error("timeout");
    },
  };
  const cloud = { getStatus: async (id) => [{ code: "switch_1", value: id === "eb1" }] };
  const client = createTuyaClientWithFallback(local, cloud);
  assert.deepEqual(await client.getStatus("eb1"), [{ code: "switch_1", value: true }]);
  assert.deepEqual(await client.getStatus("other"), [{ code: "switch_1", value: false }]);
  await assert.rejects(createTuyaClientWithFallback(local, null).getStatus("eb1"), /timeout/);
});
