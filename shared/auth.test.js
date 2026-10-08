"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { apiKeyMiddleware, bindAddr, safeEqual } = require("./auth");

function run(mw, { path = "/pretzel/volume", method = "GET", headers = {} } = {}) {
  let status = 200;
  let body = null;
  let nexted = false;
  const res = {
    status(c) {
      status = c;
      return this;
    },
    json(b) {
      body = b;
      return this;
    },
  };
  mw({ path, method, headers }, res, () => {
    nexted = true;
  });
  return { status, body, nexted };
}

const quiet = () => {
  const orig = console.warn;
  console.warn = () => {};
  return () => {
    console.warn = orig;
  };
};

test("safeEqual compares strings in constant time and rejects non-strings", () => {
  assert.equal(safeEqual("abc", "abc"), true);
  assert.equal(safeEqual("abc", "abd"), false);
  assert.equal(safeEqual("abc", "abcd"), false);
  assert.equal(safeEqual(undefined, "abc"), false);
});

test("unset key lets requests through (backward compatible)", () => {
  const restore = quiet();
  const mw = apiKeyMiddleware({ env: {} });
  restore();
  assert.equal(run(mw).nexted, true);
});

test("set key: missing and wrong keys get 401, right key passes", () => {
  const mw = apiKeyMiddleware({ env: { PRETZEL_API_KEY: "s3cret" } });
  const none = run(mw);
  assert.equal(none.status, 401);
  assert.deepEqual(none.body, { ok: false, error: "Unauthorized" });
  assert.equal(run(mw, { headers: { "x-pretzel-key": "nope" } }).status, 401);
  assert.equal(run(mw, { headers: { "x-pretzel-key": "s3cret" } }).nexted, true);
});

test("exempt paths and OPTIONS skip the check", () => {
  const mw = apiKeyMiddleware({
    env: { PRETZEL_API_KEY: "k" },
    exemptPaths: ["/pretzel/status"],
  });
  assert.equal(run(mw, { path: "/pretzel/status" }).nexted, true);
  assert.equal(run(mw, { method: "OPTIONS" }).nexted, true);
  assert.equal(run(mw, { path: "/pretzel/status/x" }).status, 401);
});

test("bindAddr defaults to 0.0.0.0 and honours BIND_ADDR", () => {
  assert.equal(bindAddr({}), "0.0.0.0");
  assert.equal(bindAddr({ BIND_ADDR: " 100.64.0.5 " }), "100.64.0.5");
});
