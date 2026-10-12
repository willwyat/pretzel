"""Local (LAN) control of Tuya devices through tinytuya, for pretzel-server.

Usage: tuya_local.py DEVICES_JSON status DEVICE_ID [IP]
       tuya_local.py DEVICES_JSON set DEVICE_ID DP true|false [IP]

DEVICES_JSON is the devices.json written by `python -m tinytuya wizard`; it holds
each device's local key, protocol version and IP. Prints one JSON object:
{"dps": {...}} on success or {"error": "..."}.
"""

import json
import sys

import tinytuya


def main(argv):
    devices_file, action, dev_id, *rest = argv
    with open(devices_file) as f:
        devices = {d["id"]: d for d in json.load(f)}
    dev = devices.get(dev_id)
    if not dev or not dev.get("key"):
        return {"error": f"{dev_id} not in {devices_file}"}

    ip = None
    if action == "set":
        dp, value, *rest = rest
    if rest:
        ip = rest[0]
    ip = ip or dev.get("ip")
    if not ip:
        return {"error": f"no IP for {dev_id}"}

    d = tinytuya.Device(dev_id, ip, dev["key"], version=float(dev.get("version") or 3.3))
    d.set_socketTimeout(3)
    d.set_socketRetryLimit(1)
    if action == "set":
        result = d.set_value(int(dp), value == "true")
    else:
        result = d.status()
    if not isinstance(result, dict) or "Error" in result:
        msg = result.get("Error") if isinstance(result, dict) else "no reply"
        return {"error": f"Tuya {ip}: {msg}"}
    return {"dps": result.get("dps", {})}


if __name__ == "__main__":
    try:
        out = main(sys.argv[1:])
    except Exception as e:  # report, never a traceback, to pretzel-server
        out = {"error": str(e)}
    print(json.dumps(out))
