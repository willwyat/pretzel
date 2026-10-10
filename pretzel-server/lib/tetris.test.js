"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { TetrisManager } = require("./tetris");

/** Manual clock + timer queue so countdown and grace periods run on demand. */
function fakeTimers() {
  let t = 1000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => t,
    setTimer: (fn, ms) => {
      const id = nextId++;
      timers.set(id, { fn, at: t + ms });
      return id;
    },
    clearTimer: (id) => timers.delete(id),
    advance(ms) {
      t += ms;
      for (const [id, tm] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (tm.at <= t && timers.has(id)) {
          timers.delete(id);
          tm.fn();
        }
      }
    },
  };
}

function setup() {
  const clock = fakeTimers();
  let seed = 41;
  const m = new TetrisManager({ ...clock, newSeed: () => ++seed });
  return { m, clock };
}

function startMatch() {
  const ctx = setup();
  ctx.m.join({ clientId: "alice-0001", name: "Alice" });
  ctx.m.join({ clientId: "bobby-0002", name: "Bob" });
  ctx.clock.advance(3000);
  return ctx;
}

test("two joins start a countdown with a seed, then go active", () => {
  const { m, clock } = setup();
  assert.ok(m.join({ clientId: "alice-0001", name: "Alice" }).ok);
  assert.equal(m.status, "waiting");
  assert.ok(m.join({ clientId: "bobby-0002", name: "Bob" }).ok);
  assert.equal(m.status, "countdown");
  assert.equal(m.seed, 42);
  assert.ok(m.matchId);
  clock.advance(2999);
  assert.equal(m.status, "countdown");
  clock.advance(1);
  assert.equal(m.status, "active");
  assert.equal(m.snapshot("bobby-0002").you, 1);
});

test("a third client cannot take a seat", () => {
  const { m } = startMatch();
  const r = m.join({ clientId: "carol-0003", name: "Carol" });
  assert.equal(r.ok, false);
  assert.equal(m.snapshot("carol-0003").you, null);
});

test("first top-out wins; later top-outs and stale matchIds are ignored", () => {
  const { m } = startMatch();
  const id = m.matchId;
  assert.equal(m.topOut({ clientId: "alice-0001", matchId: "stale" }).ok, false);
  assert.equal(m.status, "active");
  assert.ok(m.topOut({ clientId: "alice-0001", matchId: id }).ok);
  assert.equal(m.status, "over");
  assert.equal(m.winner, 1);
  assert.equal(m.topOut({ clientId: "bobby-0002", matchId: id }).ok, false);
  assert.equal(m.winner, 1);
});

test("attack routes to the opponent and validates the count", () => {
  const { m } = startMatch();
  const id = m.matchId;
  assert.deepEqual(m.attack({ clientId: "alice-0001", matchId: id, lines: 4 }), { ok: true, toClientId: "bobby-0002" });
  assert.equal(m.attack({ clientId: "alice-0001", matchId: id, lines: 0 }).ok, false);
  assert.equal(m.attack({ clientId: "alice-0001", matchId: id, lines: 2.5 }).ok, false);
  assert.equal(m.attack({ clientId: "carol-0003", matchId: id, lines: 1 }).ok, false);
});

test("disconnect forfeits after the grace period; reconnect cancels it", () => {
  const { m, clock } = startMatch();
  m.setConnected("alice-0001", false);
  clock.advance(4000);
  m.setConnected("alice-0001", true);
  clock.advance(5000);
  assert.equal(m.status, "active");

  m.setConnected("alice-0001", false);
  clock.advance(5000);
  assert.equal(m.status, "over");
  assert.equal(m.winner, 1);
  assert.equal(m.reason, "disconnected");
  assert.equal(m.seats[0], null);
  assert.deepEqual(m.snapshot("bobby-0002").matchNames, ["Alice", "Bob"]);
});

test("leaving mid-match forfeits and frees the seat", () => {
  const { m } = startMatch();
  assert.ok(m.leave({ clientId: "bobby-0002" }).ok);
  assert.equal(m.status, "over");
  assert.equal(m.winner, 0);
  assert.equal(m.reason, "left the game");
  assert.equal(m.seats[1], null);
});

test("rematch starts only when both players are ready, with a new seed", () => {
  const { m, clock } = startMatch();
  const first = { id: m.matchId, seed: m.seed };
  m.topOut({ clientId: "bobby-0002", matchId: first.id });
  assert.ok(m.ready({ clientId: "alice-0001" }).ok);
  assert.equal(m.status, "over");
  assert.ok(m.ready({ clientId: "bobby-0002" }).ok);
  assert.equal(m.status, "countdown");
  assert.notEqual(m.matchId, first.id);
  assert.notEqual(m.seed, first.seed);
  clock.advance(3000);
  assert.equal(m.status, "active");
  // A board from the previous match is not relayed.
  assert.equal(m.boardSeat({ clientId: "alice-0001", matchId: first.id }), null);
  assert.equal(m.boardSeat({ clientId: "alice-0001", matchId: m.matchId }), 0);
});

test("a newcomer after a finished match does not inherit its result", () => {
  const { m } = startMatch();
  m.topOut({ clientId: "alice-0001", matchId: m.matchId });
  m.leave({ clientId: "alice-0001" });
  // Bob played the last match, so the result stays for him.
  assert.equal(m.status, "over");
  assert.equal(m.snapshot("bobby-0002").playedLast, true);
  m.join({ clientId: "carol-0003", name: "Carol" });
  assert.equal(m.snapshot("carol-0003").playedLast, false);
  assert.equal(m.boardSeat({ clientId: "carol-0003", matchId: m.matchId }), null);
  // Bob presses Play again; Carol is already ready.
  m.ready({ clientId: "bobby-0002" });
  assert.equal(m.status, "countdown");
  assert.equal(m.snapshot("carol-0003").playedLast, true);
});

test("when everyone from a finished match has left, the lobby resets", () => {
  const { m } = startMatch();
  m.topOut({ clientId: "alice-0001", matchId: m.matchId });
  m.leave({ clientId: "alice-0001" });
  m.leave({ clientId: "bobby-0002" });
  assert.equal(m.status, "waiting");
  assert.equal(m.matchId, null);
  assert.equal(m.winner, null);
  m.join({ clientId: "carol-0003", name: "Carol" });
  assert.equal(m.status, "waiting");
  assert.equal(m.snapshot("carol-0003").you, 0);
});

test("a newcomer seated during an old result starts fresh if the old player leaves", () => {
  const { m } = startMatch();
  m.topOut({ clientId: "alice-0001", matchId: m.matchId });
  m.leave({ clientId: "alice-0001" });
  m.join({ clientId: "carol-0003", name: "Carol" });
  m.leave({ clientId: "bobby-0002" });
  assert.equal(m.status, "waiting");
  assert.equal(m.matchId, null);
  assert.equal(m.seats[0].ready, true);
});
