"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const express = require("express");
const { wyatApiBase, createWyatSonos, createSonosRouter } = require("./sonos");

const GROUP = "RINCON_74CA606F3D4701400:1026241249";

/** Fake fetch: routes are `"METHOD /path"` → [status, body]. Records calls. */
function fakeFetch(routes) {
  const calls = [];
  const impl = async (url, init) => {
    const path = new URL(url).pathname;
    const key = `${init.method} ${decodeURIComponent(path)}`;
    calls.push({ key, url, body: init.body });
    const hit = routes[key];
    if (!hit) return new Response("{}", { status: 404 });
    if (hit instanceof Error) throw hit;
    const [status, body] = hit;
    return new Response(body === undefined ? "" : JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    });
  };
  return { impl, calls };
}

async function withApp(routes, fn) {
  const fake = fakeFetch(routes);
  const app = express();
  app.use(express.json());
  app.use(
    "/pretzel/sonos",
    createSonosRouter(
      createWyatSonos({ baseUrl: "https://wyat.test/", fetchImpl: fake.impl }),
    ),
  );
  const server = app.listen(0);
  const base = `http://127.0.0.1:${server.address().port}/pretzel/sonos`;
  try {
    await fn(base, fake.calls);
  } finally {
    server.close();
  }
}

test("defaults the Wyat base URL and trims trailing slashes", () => {
  assert.equal(wyatApiBase(undefined), "https://api.wyat.ai");
  assert.equal(wyatApiBase("  "), "https://api.wyat.ai");
  assert.equal(wyatApiBase("http://localhost:3001/"), "http://localhost:3001");
});

test("lists groups across households", async () => {
  await withApp(
    {
      "GET /sonos/households": [200, { households: [{ id: "Sonos_a.b" }] }],
      "GET /sonos/households/Sonos_a.b/groups": [
        200,
        {
          groups: [
            { id: GROUP, name: "Living Room", playbackState: "PLAYBACK_STATE_PAUSED" },
          ],
        },
      ],
    },
    async (base, calls) => {
      const r = await fetch(`${base}/groups`);
      assert.equal(r.status, 200);
      assert.deepEqual(await r.json(), {
        groups: [
          {
            id: GROUP,
            name: "Living Room",
            playbackState: "PLAYBACK_STATE_PAUSED",
            householdId: "Sonos_a.b",
          },
        ],
      });
      assert.ok(calls.every((c) => c.url.startsWith("https://wyat.test/sonos/")));
    },
  );
});

test("combines playback, metadata and volume into one status", async () => {
  await withApp(
    {
      [`GET /sonos/groups/${GROUP}/playback`]: [
        200,
        { playbackState: "PLAYBACK_STATE_PLAYING" },
      ],
      [`GET /sonos/groups/${GROUP}/playback/metadata`]: [
        200,
        {
          container: { name: "Morning" },
          currentItem: { track: { name: "Song", artist: { name: "Band" } } },
        },
      ],
      [`GET /sonos/groups/${GROUP}/volume`]: [200, { volume: 23, muted: false }],
    },
    async (base) => {
      const r = await fetch(`${base}/groups/${encodeURIComponent(GROUP)}`);
      assert.deepEqual(await r.json(), {
        playbackState: "PLAYBACK_STATE_PLAYING",
        track: "Song",
        artist: "Band",
        source: "Morning",
        volume: 23,
        muted: false,
      });
    },
  );
});

test("status survives a metadata failure", async () => {
  await withApp(
    {
      [`GET /sonos/groups/${GROUP}/playback`]: [200, { playbackState: "PLAYBACK_STATE_IDLE" }],
      [`GET /sonos/groups/${GROUP}/playback/metadata`]: [502, { error: "nope" }],
      [`GET /sonos/groups/${GROUP}/volume`]: [200, { volume: 5 }],
    },
    async (base) => {
      const body = await (await fetch(`${base}/groups/${GROUP}`)).json();
      assert.equal(body.playbackState, "PLAYBACK_STATE_IDLE");
      assert.equal(body.track, null);
      assert.equal(body.volume, 5);
    },
  );
});

test("forwards play, pause and volume", async () => {
  await withApp(
    {
      [`POST /sonos/groups/${GROUP}/playback/play`]: [200, { status: "ok" }],
      [`POST /sonos/groups/${GROUP}/playback/pause`]: [200, { status: "ok" }],
      [`POST /sonos/groups/${GROUP}/volume`]: [200, { status: "ok" }],
    },
    async (base, calls) => {
      const post = (path, body) =>
        fetch(`${base}/groups/${GROUP}${path}`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      assert.equal((await post("/play")).status, 200);
      assert.equal((await post("/pause")).status, 200);
      const v = await post("/volume", { volume: 40 });
      assert.deepEqual(await v.json(), { ok: true, volume: 40 });
      assert.equal(calls.at(-1).body, JSON.stringify({ volume: 40 }));
    },
  );
});

test("rejects bad volumes and ids without calling Wyat", async () => {
  await withApp({}, async (base, calls) => {
    for (const volume of [-1, 101, 2.5, "10", undefined]) {
      const r = await fetch(`${base}/groups/${GROUP}/volume`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ volume }),
      });
      assert.equal(r.status, 400, `volume ${volume}`);
    }
    const r = await fetch(`${base}/groups/${encodeURIComponent("a/../b")}`);
    assert.equal(r.status, 400);
    assert.equal(calls.length, 0);
  });
});

test("explains Wyat refusing the Pi and passes Wyat errors through", async () => {
  await withApp(
    { "GET /sonos/households": [401, undefined] },
    async (base) => {
      const r = await fetch(`${base}/groups`);
      assert.equal(r.status, 401);
      assert.match((await r.json()).error, /HOME_PUBLIC_IP/);
    },
  );
  await withApp(
    {
      "GET /sonos/households": [
        401,
        { error: "No Sonos tokens found. Please authenticate first via /sonos/auth" },
      ],
    },
    async (base) => {
      const r = await fetch(`${base}/groups`);
      assert.match((await r.json()).error, /No Sonos tokens/);
    },
  );
  await withApp(
    { "GET /sonos/households": new TypeError("fetch failed") },
    async (base) => {
      const r = await fetch(`${base}/groups`);
      assert.equal(r.status, 502);
      assert.match((await r.json()).error, /Could not reach Wyat/);
    },
  );
});

test("lists speakers with clip support, and favorites, for the routine editor", async () => {
  await withApp(
    {
      "GET /sonos/households": [200, { households: [{ id: "HH1" }] }],
      "GET /sonos/households/HH1/groups": [
        200,
        {
          groups: [],
          players: [
            { id: "RINCON_A", name: "Bedroom", capabilities: ["PLAYBACK", "AUDIO_CLIP"] },
            { id: "RINCON_B", name: "Play:1", capabilities: ["PLAYBACK"] },
          ],
        },
      ],
      "GET /sonos/households/HH1/favorites": [200, { items: [{ id: "4", name: "Morning" }] }],
    },
    async (base) => {
      const players = await (await fetch(`${base}/players`)).json();
      assert.deepEqual(players.players, [
        { id: "RINCON_A", name: "Bedroom", householdId: "HH1", audioClip: true },
        { id: "RINCON_B", name: "Play:1", householdId: "HH1", audioClip: false },
      ]);
      const favs = await (await fetch(`${base}/favorites`)).json();
      assert.deepEqual(favs.favorites, [{ id: "4", name: "Morning", householdId: "HH1" }]);
    },
  );
});

test("plays a favorite and an audio clip by player id", async () => {
  const fake = fakeFetch({
    "POST /sonos/players/RINCON_A/favorites": [200, { status: "ok", groupId: GROUP }],
    "POST /sonos/players/RINCON_A/audio-clip": [200, { status: "ok" }],
  });
  const client = createWyatSonos({ baseUrl: "https://wyat.test", fetchImpl: fake.impl });
  assert.equal(await client.playFavoriteOnPlayer("RINCON_A", { favoriteId: "4", volume: 4 }), GROUP);
  assert.deepEqual(JSON.parse(fake.calls[0].body), { favoriteId: "4", shuffle: false, volume: 4 });
  await client.audioClip("RINCON_A", { streamUrl: "http://192.168.1.20:3001/pretzel/clips/a.mp3", name: "Noon" });
  assert.deepEqual(JSON.parse(fake.calls[1].body), {
    streamUrl: "http://192.168.1.20:3001/pretzel/clips/a.mp3",
    name: "Noon",
  });
});
