"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { sunTimes } = require("./sun");
const { localToUtc, hmInTz, addDays, weekdayMon0, parseHm } = require("./tztime");

const TZ = "America/New_York";
const minutes = (hm) => parseHm(hm);

test("sunrise and sunset in New York match published times within 2 minutes", () => {
  // Published (timeanddate.com) for New York City.
  const cases = [
    ["2026-06-21", "05:25", "20:31"],
    ["2026-12-21", "07:17", "16:32"],
    ["2026-10-12", "07:04", "18:22"],
  ];
  for (const [ymd, rise, set] of cases) {
    const t = sunTimes(ymd, 40.71, -74.01, TZ);
    assert.ok(Math.abs(minutes(hmInTz(t.sunrise, TZ)) - minutes(rise)) <= 2, `${ymd} sunrise ${hmInTz(t.sunrise, TZ)}`);
    assert.ok(Math.abs(minutes(hmInTz(t.sunset, TZ)) - minutes(set)) <= 2, `${ymd} sunset ${hmInTz(t.sunset, TZ)}`);
  }
});

test("polar days have no sunrise or sunset", () => {
  assert.deepEqual(sunTimes("2026-06-21", 78.2, 15.6, "Arctic/Longyearbyen"), { sunrise: null, sunset: null });
});

test("local times resolve across DST changes", () => {
  assert.equal(new Date(localToUtc("2026-01-15", "09:00", TZ)).toISOString(), "2026-01-15T14:00:00.000Z");
  assert.equal(new Date(localToUtc("2026-07-15", "09:00", TZ)).toISOString(), "2026-07-15T13:00:00.000Z");
  // 02:30 doesn't exist on 8 March: it lands an hour later.
  assert.equal(hmInTz(localToUtc("2026-03-08", "02:30", TZ), TZ), "03:30");
  // 01:30 happens twice on 1 November: the first (EDT) one wins.
  assert.equal(new Date(localToUtc("2026-11-01", "01:30", TZ)).toISOString(), "2026-11-01T05:30:00.000Z");
});

test("date helpers", () => {
  assert.equal(addDays("2026-12-31", 1), "2027-01-01");
  assert.equal(addDays("2026-03-01", -1), "2026-02-28");
  assert.equal(weekdayMon0("2026-10-12"), 0); // Monday
  assert.equal(weekdayMon0("2026-10-18"), 6); // Sunday
  assert.equal(parseHm("24:00"), null);
  assert.equal(parseHm("9:00"), null);
  assert.equal(parseHm("01:05"), 65);
});
