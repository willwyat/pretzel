"use strict";

const os = require("os");
const dns = require("dns").promises;
const { execFile } = require("child_process");
const { readFileSync } = require("fs");

const CACHE_MS = 15_000;
const PING_CONCURRENCY = 32;

let cache = null; // { at, devices }
let inflight = null;

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout }, (err, stdout) => {
      resolve(err ? null : stdout);
    });
  });
}

function ipToInt(ip) {
  return ip.split(".").reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
}
function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

/** First non-internal IPv4 interface → { address, hosts[] } (capped at a /24). */
function localSubnet() {
  for (const [name, addrs] of Object.entries(os.networkInterfaces())) {
    for (const a of addrs || []) {
      if (a.family !== "IPv4" || a.internal) continue;
      const mask = ipToInt(a.netmask);
      let prefixMask = mask;
      // Never sweep more than a /24.
      if ((~mask >>> 0) > 255) prefixMask = 0xffffff00;
      const net = (ipToInt(a.address) & prefixMask) >>> 0;
      const size = (~prefixMask >>> 0) + 1;
      const hosts = [];
      for (let i = 1; i < size - 1; i++) hosts.push(intToIp(net + i));
      return { iface: name, address: a.address, hosts };
    }
  }
  return null;
}

async function pingSweep(hosts) {
  let i = 0;
  const worker = async () => {
    while (i < hosts.length) {
      const ip = hosts[i++];
      await run("ping", ["-c", "1", "-W", "1", ip], 3000);
    }
  };
  await Promise.all(Array.from({ length: PING_CONCURRENCY }, worker));
}

function parseIpNeigh(text) {
  const out = [];
  for (const line of text.split("\n")) {
    // 192.168.1.5 dev wlan0 lladdr aa:bb:cc:dd:ee:ff REACHABLE
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)(?:\s+lladdr\s+([0-9a-f:]{17}))?.*?\s(\w+)\s*$/i);
    if (m) out.push({ ip: m[1], iface: m[2], mac: m[3] ? m[3].toLowerCase() : null, state: m[4].toUpperCase() });
  }
  return out;
}

function parseProcArp() {
  try {
    return readFileSync("/proc/net/arp", "utf8")
      .split("\n")
      .slice(1)
      .map((l) => l.trim().split(/\s+/))
      .filter((c) => c.length >= 6 && c[2] !== "0x0")
      .map((c) => ({ ip: c[0], iface: c[5], mac: c[3].toLowerCase(), state: "STALE" }));
  } catch {
    return [];
  }
}

async function reverseName(ip) {
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => setTimeout(() => rej(new Error("timeout")), 800)),
    ]);
    return names[0] || null;
  } catch {
    return null;
  }
}

async function scan(knownLabels) {
  const subnet = localSubnet();
  if (!subnet) return { subnet: null, devices: [] };
  await pingSweep(subnet.hosts);
  const text = await run("ip", ["-4", "neigh", "show"], 5000);
  const raw = text !== null ? parseIpNeigh(text) : parseProcArp();
  const prefix = subnet.address.split(".").slice(0, 3).join(".") + ".";
  const seen = raw.filter((d) => d.ip.startsWith(prefix) && d.state !== "FAILED" && d.mac);
  const devices = await Promise.all(
    seen.map(async (d) => ({
      ip: d.ip,
      mac: d.mac,
      state: d.state,
      online: d.state === "REACHABLE" || d.state === "DELAY" || d.state === "PROBE",
      hostname: await reverseName(d.ip),
      isSelf: false,
      label: knownLabels[d.ip] || null,
    })),
  );
  devices.push({
    ip: subnet.address,
    mac: (os.networkInterfaces()[subnet.iface].find((a) => a.family === "IPv4") || {}).mac || null,
    state: "SELF",
    online: true,
    hostname: os.hostname(),
    isSelf: true,
    label: "This Pi",
  });
  devices.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  return { subnet: { iface: subnet.iface, address: subnet.address }, devices };
}

/** Cached for CACHE_MS; concurrent callers share one sweep. `force` bypasses the cache. */
async function listDevices({ knownLabels = {}, force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  if (!inflight) {
    inflight = scan(knownLabels)
      .then((result) => {
        cache = { at: Date.now(), result };
        return result;
      })
      .finally(() => {
        inflight = null;
      });
  }
  return inflight;
}

module.exports = { listDevices, parseIpNeigh };
