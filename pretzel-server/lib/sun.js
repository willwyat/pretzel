"use strict";

// Sunrise and sunset computed on the Pi (no network), so routines anchored to
// the sun have a known time ahead of the day. Formulas follow the NOAA / suncalc
// approach (Julian days, solar mean anomaly, equation of centre); accurate to
// about a minute at mid latitudes.

const { localToUtc } = require("./tztime");

const RAD = Math.PI / 180;
const DAY_MS = 864e5;
const J1970 = 2440588;
const J2000 = 2451545;
const J0 = 0.0009;
const OBLIQUITY = RAD * 23.4397;
/** Sun's upper limb on the horizon, with refraction. */
const H0 = RAD * -0.833;

const toDays = (ms) => ms / DAY_MS - 0.5 + J1970 - J2000;
const fromJulian = (j) => (j + 0.5 - J1970) * DAY_MS;

function solarMeanAnomaly(d) {
  return RAD * (357.5291 + 0.98560028 * d);
}

function eclipticLongitude(M) {
  const C = RAD * (1.9148 * Math.sin(M) + 0.02 * Math.sin(2 * M) + 0.0003 * Math.sin(3 * M));
  return M + C + RAD * 102.9372 + Math.PI;
}

function solarTransitJ(ds, M, L) {
  return J2000 + ds + 0.0053 * Math.sin(M) - 0.0069 * Math.sin(2 * L);
}

/**
 * Sunrise and sunset (epoch ms) for the local calendar date `ymd` in `tz`.
 * Either is null when the sun doesn't cross the horizon that day.
 */
function sunTimes(ymd, lat, lon, tz) {
  const noonMs = localToUtc(ymd, "12:00", tz);
  const lw = RAD * -lon;
  const phi = RAD * lat;
  const d = toDays(noonMs);
  const n = Math.round(d - J0 - lw / (2 * Math.PI));
  const ds = J0 + lw / (2 * Math.PI) + n;
  const M = solarMeanAnomaly(ds);
  const L = eclipticLongitude(M);
  const dec = Math.asin(Math.sin(L) * Math.sin(OBLIQUITY));
  const jNoon = solarTransitJ(ds, M, L);
  const cosW = (Math.sin(H0) - Math.sin(phi) * Math.sin(dec)) / (Math.cos(phi) * Math.cos(dec));
  if (cosW < -1 || cosW > 1) return { sunrise: null, sunset: null };
  const w = Math.acos(cosW);
  const jSet = solarTransitJ(J0 + (w + lw) / (2 * Math.PI) + n, M, L);
  const jRise = jNoon - (jSet - jNoon);
  return { sunrise: Math.round(fromJulian(jRise)), sunset: Math.round(fromJulian(jSet)) };
}

module.exports = { sunTimes };
