"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, rmSync, writeFileSync, utimesSync, readdirSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { ClipStore, lanBaseUrl } = require("./clips");

test("the LAN URL prefers PRETZEL_LAN_URL, then a private IPv4 address", () => {
  const ifaces = {
    lo: [{ family: "IPv4", internal: true, address: "127.0.0.1" }],
    tailscale0: [{ family: "IPv4", internal: false, address: "100.101.1.2" }],
    wlan0: [
      { family: "IPv6", internal: false, address: "fe80::1" },
      { family: "IPv4", internal: false, address: "192.168.1.20" },
    ],
  };
  assert.equal(lanBaseUrl(3001, {}, ifaces), "http://192.168.1.20:3001");
  assert.equal(lanBaseUrl(3001, { PRETZEL_LAN_URL: "http://pretzel.lan:3001/" }, ifaces), "http://pretzel.lan:3001");
  assert.equal(lanBaseUrl(3001, {}, { tailscale0: ifaces.tailscale0 }), null);
});

test("clips are rendered to files, served by name only, and pruned", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "clips-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let now = Date.now();
  const store = new ClipStore({
    dir,
    render: async (text, _instructions, out) => writeFileSync(out, `mp3:${text}`),
    now: () => now,
  });
  const clip = await store.create("hello", "");
  assert.match(clip.name, /^[a-f0-9]{16}\.mp3$/);
  assert.equal(store.pathFor(clip.name), clip.path);
  assert.equal(store.pathFor("../routines.json"), null);
  assert.equal(store.pathFor("0000000000000000.mp3"), null);

  // An hour later the old clip is pruned when the next one is made.
  const old = new Date(now - 2 * 3600_000);
  utimesSync(clip.path, old, old);
  await store.create("again", "");
  assert.equal(readdirSync(dir).length, 1);

  const empty = new ClipStore({ dir, render: async (_t, _i, out) => writeFileSync(out, "") });
  await assert.rejects(empty.create("x", ""), /empty/);
});
