"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { mkdtempSync, readFileSync } = require("fs");
const { tmpdir } = require("os");
const { join } = require("path");
const { ChessManager, ABANDON_MS } = require("./chess");

const W = "white-client";
const B = "black-client";
const S = "spectator-1";

function setup({ seat = true } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "chess-"));
  const clock = { t: 1_000_000 };
  const m = new ChessManager({ dataDir: dir, now: () => clock.t });
  if (seat) {
    assert.ok(m.sit({ clientId: W, name: "Wendy", color: "white" }).ok);
    assert.ok(m.sit({ clientId: B, name: "Bob" }).ok);
  }
  return { m, dir, clock };
}

/** Play space-separated "e2e4 e7e5 …" moves alternating White/Black. */
function play(m, line) {
  for (const mv of line.split(/\s+/).filter(Boolean)) {
    const id = m.snapshot(null).turn === "white" ? W : B;
    const r = m.move({ clientId: id, from: mv.slice(0, 2), to: mv.slice(2, 4), promotion: mv[4] });
    assert.ok(r.ok, `${mv}: ${r.error}`);
  }
}

test("seating, turn order and legality", () => {
  const { m } = setup();
  assert.equal(m.snapshot(W).you, "white");
  assert.equal(m.snapshot(B).you, "black");
  assert.equal(m.snapshot(W).status, "active");
  assert.equal(m.sit({ clientId: S, name: "Sam" }).ok, false);
  assert.equal(m.move({ clientId: B, from: "e7", to: "e5" }).error, "Not your turn.");
  assert.equal(m.move({ clientId: S, from: "e2", to: "e4" }).error, "You are not a player.");
  assert.equal(m.move({ clientId: W, from: "e2", to: "e5" }).error, "Illegal move.");
  assert.equal(m.move({ clientId: W, from: { x: 1 }, to: "e4" }).error, "Illegal move.");
  // Legal moves are only sent to the side to move.
  assert.equal(m.snapshot(W).legalMoves.length, 20);
  assert.equal(m.snapshot(B).legalMoves.length, 0);
  assert.equal(m.snapshot(S).legalMoves.length, 0);
});

test("fool's mate is archived with PGN", () => {
  const { m, dir } = setup();
  play(m, "f2f3 e7e5 g2g4 d8h4");
  const s = m.snapshot(S);
  assert.equal(s.status, "over");
  assert.equal(s.result, "0-1");
  assert.equal(s.reason, "checkmate");
  const games = JSON.parse(readFileSync(join(dir, "chess-games.json"), "utf8"));
  assert.equal(games.length, 1);
  assert.match(games[0].pgn, /1\. f3 e5 2\. g4 Qh4# 0-1/);
  const replay = m.getGame(games[0].id);
  assert.equal(replay.fens.length, 5);
  assert.equal(replay.whiteIp, undefined);
});

test("castling both sides; castling through check is refused", () => {
  const { m } = setup();
  play(m, "e2e4 e7e5 g1f3 b8c6 f1c4 d7d6 e1g1 c8g4 d2d3 d8d7 b1c3 e8c8");
  const board = m.snapshot(S).fen.split(" ")[0].split("/");
  assert.equal(board[0], "2kr1bnr");
  assert.equal(board[7], "R1BQ1RK1");

  const t = setup();
  t.m.chess.load("k4r2/8/8/8/8/8/8/4K2R w K - 0 1"); // f1 attacked
  assert.equal(t.m.move({ clientId: W, from: "e1", to: "g1" }).error, "Illegal move.");
  t.m.chess.load("k7/8/8/8/8/8/8/4K2R w K - 0 1");
  assert.ok(t.m.move({ clientId: W, from: "e1", to: "g1" }).ok);
});

test("en passant and promotion", () => {
  const { m } = setup();
  play(m, "e2e4 a7a6 e4e5 d7d5 e5d6");
  assert.match(m.snapshot(S).moves.at(-1).san, /exd6/);
  play(m, "a6a5 d6c7 a5a4 c7b8q");
  assert.equal(m.snapshot(S).moves.at(-1).san, "cxb8=Q");
  assert.equal(m.move({ clientId: B, from: "a4", to: "a3", promotion: "k" }).error, "Illegal move.");
});

test("avatars: kept per seat, never shared, invalid values ignored", () => {
  const { m } = setup({ seat: false });
  assert.ok(m.sit({ clientId: W, name: "Wendy", color: "white", avatar: 3 }).ok);
  assert.equal(m.sit({ clientId: B, name: "Bob", avatar: 3 }).error, "Your opponent has that character.");
  assert.ok(m.sit({ clientId: B, name: "Bob", avatar: 99 }).ok);
  assert.equal(m.snapshot(S).players.black.avatar, null);
  assert.ok(m.sit({ clientId: B, name: "Bob", avatar: 5 }).ok); // re-sit changes it
  assert.equal(m.sit({ clientId: B, name: "Bob", avatar: 3 }).error, "Your opponent has that character.");
  assert.ok(m.sit({ clientId: B, name: "Bobby" }).ok); // re-sit without one keeps it
  const s = m.snapshot(S);
  assert.equal(s.players.white.avatar, 3);
  assert.deepEqual(s.players.black, { name: "Bobby", connected: true, avatar: 5 });
  // Avatars follow the players into the rematch, colours swapped.
  play(m, "e2e4");
  assert.ok(m.resign({ clientId: B }).ok);
  assert.ok(m.newGame({ clientId: W }).ok);
  const r = m.snapshot(S);
  assert.equal(r.players.white.avatar, 5);
  assert.equal(r.players.black.avatar, 3);
});

test("move records carry the captured piece and promotion", () => {
  const { m } = setup();
  play(m, "e2e4 d7d5 e4d5 d8d5");
  const moves = m.snapshot(S).moves;
  assert.equal(moves[2].captured, "p");
  assert.equal(moves[3].captured, "p");
  assert.equal(moves[0].captured, null);
  play(m, "b1c3 d5a2 a1a2");
  assert.equal(m.snapshot(S).moves.at(-1).captured, "q");
  assert.equal(m.snapshot(S).moves.at(-1).promotion, null);
});

test("stalemate and threefold repetition end the game", () => {
  // Fastest known stalemate (Sam Loyd, 10 moves).
  const a = setup();
  play(a.m, "e2e3 a7a5 d1h5 a8a6 h5a5 h7h5 h2h4 a6h6 a5c7 f7f6 c7d7 e8f7 d7b7 d8d3 b7b8 d3h7 b8c8 f7g6 c8e6");
  assert.equal(a.m.snapshot(S).reason, "stalemate");

  const b = setup();
  play(b.m, "g1f3 g8f6 f3g1 f6g8 g1f3 g8f6 f3g1 f6g8");
  assert.equal(b.m.snapshot(S).reason, "threefold repetition");
  assert.equal(b.m.snapshot(S).result, "1/2-1/2");
});

test("clocks: start after White's first move, increment, flag fall broadcasts", async () => {
  const { m, clock } = setup();
  assert.ok(m.setTimeControl({ clientId: W, id: "15+10" }).ok);
  play(m, "e2e4");
  assert.equal(m.snapshot(S).clocks.white, 900_000); // no charge for the first move
  clock.t += 5_000;
  play(m, "e7e5");
  assert.equal(m.snapshot(S).clocks.black, 905_000);
  assert.equal(m.setTimeControl({ clientId: W, id: "5+0" }).ok, false);
  assert.equal(setup().m.setTimeControl({ clientId: W, id: "__proto__" }).ok, false);

  // Flag fall from the timer must notify listeners on its own.
  let emits = 0;
  m.subscribe(() => emits++);
  clock.t += 900_000;
  m._checkFlag() && m._emit();
  assert.equal(m.snapshot(S).status, "over");
  assert.equal(m.snapshot(S).result, "0-1");
  assert.equal(m.snapshot(S).reason, "timeout");
  assert.equal(emits, 1);
});

test("flag fall against a lone king is a draw", () => {
  const { m, clock } = setup();
  m.setTimeControl({ clientId: W, id: "5+0" });
  play(m, "e2e4");
  // Black is on move and flags, but White has only a king left to mate with.
  m.chess.load("4k3/4p3/8/8/8/8/8/4K3 b - - 0 1");
  clock.t += 400_000;
  assert.ok(m._checkFlag());
  assert.equal(m.snapshot(S).result, "1/2-1/2");
});

test("draw offers: own move keeps it, opponent move declines it", () => {
  const { m } = setup();
  play(m, "e2e4");
  assert.equal(m.offerDraw({ clientId: B }).ok, true);
  play(m, "e7e5"); // offerer moves: still pending
  assert.equal(m.snapshot(W).drawOffer, "black");
  play(m, "g1f3"); // opponent moves instead of answering: declined
  assert.equal(m.snapshot(W).drawOffer, null);
  m.offerDraw({ clientId: B });
  assert.equal(m.respondDraw({ clientId: B, accept: true }).ok, false);
  assert.ok(m.respondDraw({ clientId: W, accept: true }).ok);
  assert.equal(m.snapshot(S).reason, "draw agreed");
});

test("resign, then anyone can start a rematch; offline players lose their seat", () => {
  const { m } = setup();
  play(m, "e2e4");
  assert.ok(m.resign({ clientId: B }).ok);
  assert.equal(m.snapshot(S).result, "1-0");
  m.setConnected(W, false);
  assert.equal(m.snapshot(S).can.newGame, true);
  assert.ok(m.newGame({ clientId: S }).ok);
  const s = m.snapshot(B);
  assert.equal(s.you, "white"); // colours swapped
  assert.equal(s.players.black, null); // offline Wendy unseated
  assert.equal(m.snapshot(S).can.sit.black, true);
});

test("an offline player's seat can be taken before the first move, not after", () => {
  const { m } = setup();
  m.setConnected(B, false);
  assert.ok(m.sit({ clientId: S, name: "Sam" }).ok);
  assert.equal(m.snapshot(S).you, "black");
  play(m, "e2e4");
  m.setConnected(B, false);
  m.setConnected(S, false);
  assert.equal(m.sit({ clientId: B, name: "Bob" }).ok, false);
});

test("abandoned game can be cleared by anyone after the timeout", () => {
  const { m, clock, dir } = setup();
  play(m, "e2e4 e7e5");
  m.setConnected(W, false);
  m.setConnected(B, false);
  assert.equal(m.newGame({ clientId: S }).ok, false);
  clock.t += ABANDON_MS;
  assert.ok(m.newGame({ clientId: S }).ok);
  assert.equal(m.snapshot(S).moves.length, 0);
  const games = JSON.parse(readFileSync(join(dir, "chess-games.json"), "utf8"));
  assert.equal(games[0].result, "*");
  assert.equal(games[0].reason, "abandoned");
});

test("restart restores the game, marks players offline, does not charge downtime", () => {
  const { m, dir, clock } = setup();
  m.setTimeControl({ clientId: W, id: "5+0" });
  play(m, "e2e4 e7e5 g1f3");
  clock.t += 10_000;
  const before = m.snapshot(S).clocks.black;
  clearTimeout(m.flagTimer);
  clock.t += 3_600_000; // Pi was off for an hour
  const m2 = new ChessManager({ dataDir: dir, now: () => clock.t });
  const s = m2.snapshot(B);
  assert.equal(s.moves.length, 3);
  assert.equal(s.players.white.connected, false);
  assert.ok(s.clocks.black >= before, "downtime must not be charged");
  assert.ok(m2.move({ clientId: B, from: "b8", to: "c6" }).ok);
  clearTimeout(m2.flagTimer);
});
