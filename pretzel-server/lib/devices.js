"use strict";

const os = require("os");
const dgram = require("dgram");
const dns = require("dns").promises;
const { execFile } = require("child_process");
const { readFileSync } = require("fs");

const CACHE_MS = 15_000;
/** How long to let ARP replies come back after probing the subnet. */
const ARP_WAIT_MS = 1500;
const DNS_TIMEOUT_MS = 800;
const ONLINE_STATES = new Set(["REACHABLE", "DELAY", "PROBE"]);

let cache = null; // { at, result }
let inflight = null;

function run(file, args, timeout) {
  return new Promise((resolve) => {
    execFile(file, args, { encoding: "utf8", timeout }, (err, stdout) => resolve(err ? null : stdout));
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function ipToInt(ip) {
  return ip.split(".").reduce((a, o) => ((a << 8) + Number(o)) >>> 0, 0);
}
function intToIp(n) {
  return [24, 16, 8, 0].map((s) => (n >>> s) & 255).join(".");
}

/** Default IPv4 route from /proc/net/route → { iface, gateway } (no external tools needed). */
function defaultRoute(text) {
  for (const line of text.split("\n").slice(1)) {
    const c = line.trim().split(/\s+/);
    if (c.length < 8 || c[1] !== "00000000") continue;
    // Gateway is little-endian hex.
    const g = parseInt(c[2], 16);
    const gateway = [0, 8, 16, 24].map((s) => (g >>> s) & 255).join(".");
    return { iface: c[0], gateway: gateway === "0.0.0.0" ? null : gateway };
  }
  return null;
}

/**
 * The LAN the Pi uses for its default route (so docker/VPN interfaces are
 * skipped), falling back to the first non-internal IPv4. The sweep is capped
 * at the Pi's /24.
 */
function localSubnet() {
  let route = null;
  try {
    route = defaultRoute(readFileSync("/proc/net/route", "utf8"));
  } catch {
    /* not Linux */
  }
  const ifaces = os.networkInterfaces();
  const candidates = Object.entries(ifaces).flatMap(([name, addrs]) =>
    (addrs || []).filter((a) => a.family === "IPv4" && !a.internal).map((a) => ({ name, a })),
  );
  const pick = candidates.find((c) => route && c.name === route.iface) || candidates[0];
  if (!pick) return null;
  const { name, a } = pick;
  let mask = ipToInt(a.netmask);
  if ((~mask >>> 0) > 255) mask = 0xffffff00;
  const net = (ipToInt(a.address) & mask) >>> 0;
  const size = (~mask >>> 0) + 1;
  const hosts = [];
  for (let i = 1; i < size - 1; i++) hosts.push(intToIp(net + i));
  return {
    iface: name,
    address: a.address,
    mac: a.mac || null,
    cidr: `${intToIp(net)}/${32 - Math.log2(size)}`,
    gateway: route && route.iface === name ? route.gateway : null,
    inSubnet: (ip) => ((ipToInt(ip) & mask) >>> 0) === net,
    hosts,
  };
}

/**
 * Make the kernel ARP every host by sending one tiny UDP datagram to the
 * discard port. Hosts that answer ARP land in the neighbour table even if they
 * drop ping/UDP (iPhones, Windows firewalls), and no processes are spawned.
 */
async function arpProbe(hosts) {
  const sock = dgram.createSocket("udp4");
  sock.on("error", () => {}); // EHOSTUNREACH etc. are expected
  const payload = Buffer.alloc(1);
  await Promise.all(
    hosts.map((ip) => new Promise((resolve) => sock.send(payload, 9, ip, () => resolve()))),
  );
  await sleep(ARP_WAIT_MS);
  sock.close();
}

/** Parse `ip -4 neigh show` lines, e.g. "192.168.1.5 dev wlan0 lladdr aa:bb:cc:dd:ee:ff REACHABLE". */
function parseIpNeigh(text) {
  const out = [];
  for (const line of text.split("\n")) {
    const m = line.match(/^(\d+\.\d+\.\d+\.\d+)\s+dev\s+(\S+)(?:\s+lladdr\s+([0-9a-f:]{17}))?.*?\s([A-Z]+)\s*$/i);
    if (m) out.push({ ip: m[1], iface: m[2], mac: m[3] ? m[3].toLowerCase() : null, state: m[4].toUpperCase() });
  }
  return out;
}

/** /proc/net/arp fallback when iproute2 is missing (no reachability state there). */
function parseProcArp(text) {
  return text
    .split("\n")
    .slice(1)
    .map((l) => l.trim().split(/\s+/))
    .filter((c) => c.length >= 6 && c[2] !== "0x0" && c[3] !== "00:00:00:00:00:00")
    .map((c) => ({ ip: c[0], iface: c[5], mac: c[3].toLowerCase(), state: "STALE" }));
}

async function readNeighbours() {
  const text = await run("ip", ["-4", "neigh", "show"], 5000);
  if (text !== null) return parseIpNeigh(text);
  try {
    return parseProcArp(readFileSync("/proc/net/arp", "utf8"));
  } catch {
    return [];
  }
}

async function reverseName(ip) {
  let timer;
  try {
    const names = await Promise.race([
      dns.reverse(ip),
      new Promise((_, rej) => {
        timer = setTimeout(() => rej(new Error("timeout")), DNS_TIMEOUT_MS);
      }),
    ]);
    return names[0] ? names[0].replace(/\.$/, "") : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Phones/laptops with "private Wi-Fi address" set the locally-administered bit. */
function isRandomMac(mac) {
  return !!mac && (parseInt(mac.slice(0, 2), 16) & 2) === 2;
}

async function scan() {
  const subnet = localSubnet();
  if (!subnet) return { subnet: null, devices: [], scannedAt: Date.now() };
  await arpProbe(subnet.hosts.filter((ip) => ip !== subnet.address));
  const seen = (await readNeighbours()).filter(
    (d) => d.mac && d.state !== "FAILED" && d.state !== "INCOMPLETE" && subnet.inSubnet(d.ip),
  );
  const devices = await Promise.all(
    seen.map(async (d) => ({
      ip: d.ip,
      mac: d.mac,
      randomMac: isRandomMac(d.mac),
      state: d.state,
      online: ONLINE_STATES.has(d.state),
      hostname: await reverseName(d.ip),
      isSelf: false,
      label: d.ip === subnet.gateway ? "Router" : null,
    })),
  );
  devices.push({
    ip: subnet.address,
    mac: subnet.mac,
    randomMac: false,
    state: "SELF",
    online: true,
    hostname: os.hostname(),
    isSelf: true,
    label: "This Pi",
  });
  devices.sort((a, b) => ipToInt(a.ip) - ipToInt(b.ip));
  return {
    subnet: { iface: subnet.iface, address: subnet.address, cidr: subnet.cidr },
    devices,
    scannedAt: Date.now(),
  };
}

/** Cached for CACHE_MS; concurrent callers share one scan. `force` bypasses the cache. */
async function listDevices({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_MS) return cache.result;
  if (!inflight) {
    inflight = scan()
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

module.exports = { listDevices, parseIpNeigh, parseProcArp, defaultRoute, isRandomMac };
