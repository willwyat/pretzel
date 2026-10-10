"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");
const { parseIpNeigh, parseProcArp, defaultRoute, isRandomMac } = require("./devices");

test("parses ip neigh output", () => {
  const rows = parseIpNeigh(
    [
      "192.168.1.1 dev wlan0 lladdr 3c:84:6a:aa:bb:cc REACHABLE",
      "192.168.1.186 dev wlan0 lladdr 64:CB:E9:11:22:33 STALE",
      "192.168.1.77 dev wlan0  FAILED",
      "192.168.1.90 dev wlan0 lladdr 9a:11:22:33:44:55 router DELAY",
    ].join("\n"),
  );
  assert.deepEqual(rows.map((r) => [r.ip, r.mac, r.state]), [
    ["192.168.1.1", "3c:84:6a:aa:bb:cc", "REACHABLE"],
    ["192.168.1.186", "64:cb:e9:11:22:33", "STALE"],
    ["192.168.1.77", null, "FAILED"],
    ["192.168.1.90", "9a:11:22:33:44:55", "DELAY"],
  ]);
});

test("parses /proc/net/arp, skipping incomplete entries", () => {
  const rows = parseProcArp(
    "IP address       HW type     Flags       HW address            Mask     Device\n" +
      "192.168.1.1      0x1         0x2         3c:84:6a:aa:bb:cc     *        wlan0\n" +
      "192.168.1.9      0x1         0x0         00:00:00:00:00:00     *        wlan0\n",
  );
  assert.deepEqual(rows.map((r) => r.ip), ["192.168.1.1"]);
});

test("finds the default route and gateway", () => {
  const r = defaultRoute(
    "Iface\tDestination\tGateway \tFlags\tRefCnt\tUse\tMetric\tMask\n" +
      "docker0\t000011AC\t00000000\t0001\t0\t0\t0\t0000FFFF\n" +
      "wlan0\t00000000\t0101A8C0\t0003\t0\t0\t600\t00000000\n",
  );
  assert.deepEqual(r, { iface: "wlan0", gateway: "192.168.1.1" });
});

test("flags randomized (locally administered) MACs", () => {
  assert.equal(isRandomMac("9a:11:22:33:44:55"), true);
  assert.equal(isRandomMac("3c:84:6a:aa:bb:cc"), false);
});
