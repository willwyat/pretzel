# Pretzel as a home gateway (no code)

Everything here is install-and-configure on the Pi: packages, admin-console clicks, and two config files. Nothing in `pretzel-server`, `tv-relay` or `remote-ui` changes.

| Goal | Tool | Where it listens | Who can reach it |
| --- | --- | --- | --- |
| Remote access to the home LAN, exit node | Tailscale (subnet router + exit node) | tailnet | Your devices signed in to Tailscale |
| USB printer as AirPrint / network printer | CUPS + Avahi | `:631` | LAN; tailnet by IP |
| USB scanner in a browser, plus a REST API | SANE + scanservjs | `:8090` | LAN, tailnet, gateway |
| Sonos | Already in Wyat AI (Sonos cloud). Optional local API: node-sonos-http-api | `:5005` | LAN, tailnet, gateway |
| Endpoints Wyat AI can call | Caddy (key check) + Tailscale Funnel | `127.0.0.1:8088` → `https://pretzel.<tailnet>.ts.net` | Anyone holding `PRETZEL_PUBLIC_KEY` |

Ports already taken on the Pi: **3000** (tv-relay), **3001** (pretzel-server), **8080** (remote-ui). Nothing below uses them.

The router needs **no port forwards** for any of this. Tailscale and Funnel connect outward.

The commands assume Raspberry Pi OS (Debian 12 "bookworm"), the hostname `pretzel`, and a home LAN of `192.168.1.0/24` (the TV is at `192.168.1.186`). Check yours with `ip -4 route | grep -v default`.

---

## 1. Remote access: Tailscale subnet router and exit node

Tailscale is WireGuard with the key exchange and NAT traversal handled for you. Use it instead of a hand-rolled WireGuard server: no open UDP port, no dynamic DNS, and phones get an app.

### On the Pi

```bash
curl -fsSL https://tailscale.com/install.sh | sh

# Let the Pi forward traffic for other devices
echo 'net.ipv4.ip_forward = 1'          | sudo tee /etc/sysctl.d/99-tailscale.conf
echo 'net.ipv6.conf.all.forwarding = 1' | sudo tee -a /etc/sysctl.d/99-tailscale.conf
sudo sysctl -p /etc/sysctl.d/99-tailscale.conf

sudo tailscale up \
  --hostname=pretzel \
  --advertise-routes=192.168.1.0/24 \
  --advertise-exit-node \
  --ssh
```

`tailscale up` prints a login URL. Open it and sign in with the account you will use on your phone and laptop.

### In the Tailscale admin console (login.tailscale.com → Machines)

1. Find **pretzel** → **…** → **Edit route settings**. Tick the `192.168.1.0/24` subnet and **Use as exit node**. Save.
2. **…** → **Disable key expiry**, so the Pi does not drop off the tailnet after 180 days.
3. **DNS** → make sure **MagicDNS** is on. `pretzel` then resolves from any of your devices.

### On your phone / laptop

Install Tailscale and sign in with the same account. Then, from anywhere:

- `http://pretzel:8080` → the Pretzel remote
- `http://192.168.1.x` → the NAS, router page, or anything else on the LAN (subnet route)
- `smb://192.168.1.x` → NAS shares
- Exit node: in the Tailscale app pick **Exit node → pretzel** to send all traffic through home (useful on hotel or café Wi‑Fi)
- `ssh william@pretzel` works without managing SSH keys (`--ssh`)

Linux clients need `sudo tailscale up --accept-routes` to use the subnet route. iOS, macOS, Android and Windows accept routes by default.

If you are away from home and the tailnet already reaches the Pi, the existing `/settings` page on `:8080` works too, so you can **Git pull** and restart services remotely.

**Check:** `tailscale status` on the Pi lists your devices. From your phone on cellular, open `http://pretzel:8080`.

---

## 2. Network printer: CUPS with AirPrint

CUPS shares the USB printer over IPP. Avahi announces it with Bonjour, so iPhones, iPads and Macs see it as an AirPrint printer with no app.

```bash
sudo apt update
sudo apt install -y cups avahi-daemon
# Drivers for older USB printers (install the ones that match yours):
sudo apt install -y printer-driver-gutenprint   # many Canon / Epson
sudo apt install -y hplip                       # HP
sudo apt install -y printer-driver-brlaser      # Brother lasers
sudo apt install -y printer-driver-splix        # older Samsung / Xerox

sudo usermod -aG lpadmin "$USER"   # lets you use the CUPS web UI
sudo cupsctl --remote-admin --remote-any --share-printers
sudo systemctl restart cups
```

`--remote-any` lets tailnet clients (100.x addresses) print, not only the LAN. It is safe because the router does not forward port 631.

Plug the printer in, then from a laptop on the LAN open **`https://pretzel.local:631/admin`**. Accept the self-signed certificate warning and sign in with your Pi user and password.

1. **Add Printer** → choose the USB printer under *Local Printers*.
2. Tick **Share This Printer**.
3. Pick the make/model driver. If yours is not listed, try the closest model from the same family, or the "driverless" / "IPP Everywhere" entry if offered.
4. **Print Test Page** from the printer's page.

**Check:**

- iPhone: Share → **Print** → the printer appears as "… @ pretzel".
- Mac: System Settings → Printers & Scanners → **+**; it shows under Bonjour.
- Windows: Settings → Printers → **Add device**, or add `http://pretzel.local:631/printers/<NAME>` by URL.
- Remote over Tailscale: Bonjour does not cross the tunnel, so add it by address: `ipp://pretzel:631/printers/<NAME>` (or the Pi's 100.x IP).

`<NAME>` is the queue name shown in the CUPS web UI (e.g. `HP_LaserJet_1020`).

---

## 3. Network scanner: SANE and scanservjs

SANE drives the USB scanner (or the scanner half of an all-in-one). scanservjs puts a scan page in the browser and gives you a REST API.

```bash
sudo apt install -y sane-utils
scanimage -L   # should list the scanner; if empty, unplug/replug and retry
```

If `scanimage -L` lists nothing, HP all-in-ones also need `hplip` (above). Brother and Epson models may need the vendor's `.deb` driver from their support site.

Install scanservjs (its own installer, runs as a systemd service):

```bash
curl -s https://raw.githubusercontent.com/sbs20/scanservjs/master/bootstrap.sh | sudo bash -s -- -v latest
```

scanservjs defaults to port **8080**, which remote-ui already uses. Move it to **8090** by creating `/etc/scanservjs/config.local.js` with exactly this:

```js
module.exports = {
  afterConfig(config) {
    config.port = 8090;
  }
};
```

```bash
sudo systemctl restart scanservjs
```

**Use it:** `http://pretzel.local:8090` on the LAN, `http://pretzel:8090` over Tailscale. Scans are saved on the Pi and downloadable from the **Files** tab.

**API** (also reachable through the gateway at `/scan/...`, section 5):

| Method | Path | Does |
| --- | --- | --- |
| `GET` | `/api/v1/context` | Scanners, resolutions, modes, formats |
| `POST` | `/api/v1/scan` | Run a scan (JSON body with the same fields the web page sends) |
| `GET` | `/api/v1/files` | List finished scans |
| `GET` | `/api-docs` | Swagger page listing every endpoint |

Optional AirScan (scan from a Mac's Image Capture or the iOS Files app): the community project [AirSane](https://github.com/SimulPiscator/AirSane) republishes a SANE scanner as AirScan. It is built from source (cmake), so treat it as an extra, not part of this setup.

---

## 4. Sonos

**You don't need the Pi for Sonos.** Wyat AI already controls Sonos through the Sonos cloud API (`/sonos/*` on the backend, and the `sonos_playback` / `set_sonos_volume` MCP tools). That works from anywhere, with or without the Pi.

Add the Pi only if you want something the cloud API doesn't give you: control when the internet is down, lower latency, or "say this on the kitchen speaker" announcements. For that, run [node-sonos-http-api](https://github.com/jishi/node-sonos-http-api) on the Pi. It finds speakers on the LAN and turns each action into a URL:

```bash
cd ~ && git clone https://github.com/jishi/node-sonos-http-api.git
cd node-sonos-http-api && npm install --production
```

Run it as a service: create `/etc/systemd/system/sonos-http-api.service` with

```ini
[Unit]
Description=node-sonos-http-api (local Sonos control on :5005)
After=network-online.target
Wants=network-online.target

[Service]
User=pi
WorkingDirectory=/home/pi/node-sonos-http-api
ExecStart=/usr/bin/node server.js
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
```

(change `pi` to your user), then `sudo systemctl daemon-reload && sudo systemctl enable --now sonos-http-api`.

Example URLs (room names are the ones in the Sonos app; URL-encode spaces):

```bash
curl http://pretzel:5005/zones
curl http://pretzel:5005/Living%20Room/play
curl http://pretzel:5005/Living%20Room/pause
curl http://pretzel:5005/Living%20Room/volume/20
curl http://pretzel:5005/Living%20Room/favorite/Morning%20Jazz
curl "http://pretzel:5005/Kitchen/say/Dinner%20is%20ready"
```

It relies on Sonos' local UPnP control. Sonos S2 still supports this today, but the project warns a future Sonos firmware could break it. That is another reason to keep the cloud path in Wyat AI as the main one.

---

## 5. Endpoints Wyat AI can call: Caddy + Tailscale Funnel

Wyat AI runs on Vercel (`app.wyat.ai`) and Render (`api.wyat.ai`). Neither is on your home network, so neither can reach `pretzel.local` or the tailnet. **Tailscale Funnel** gives the Pi a public HTTPS address, `https://pretzel.<tailnet>.ts.net`, with a real certificate and no router port.

Funnel is public: anyone who learns the hostname can send requests (hostnames show up in public certificate logs). `pretzel-server` routes like `/pretzel/speak` have no login, so **Caddy** sits in front and rejects any request without the secret header `X-Pretzel-Key`. The Pi's operator routes (`/pretzel/admin/*`) are never exposed through it.

```text
Wyat AI (Vercel / Render)
  → https://pretzel.<tailnet>.ts.net        Tailscale Funnel (TLS)
    → 127.0.0.1:8088                        Caddy: needs X-Pretzel-Key, blocks /pretzel/admin/*
      /pretzel/*, /lifx/*  → :3001          pretzel-server
      /tv/*                → :3000          tv-relay
      /scan/*              → :8090          scanservjs
      /sonos/*             → :5005          node-sonos-http-api (optional)
```

CUPS is deliberately not on this list. Keep the printer LAN/tailnet only.

### Install Caddy with the bundled config

```bash
sudo apt install -y caddy
sudo cp ~/pretzel/gateway/Caddyfile.example /etc/caddy/Caddyfile

# Make a key and give it to the caddy service only
KEY=$(openssl rand -hex 32); echo "PRETZEL_PUBLIC_KEY=$KEY"   # save this value
sudo mkdir -p /etc/systemd/system/caddy.service.d
printf '[Service]\nEnvironment=PRETZEL_PUBLIC_KEY=%s\n' "$KEY" | sudo tee /etc/systemd/system/caddy.service.d/pretzel-key.conf >/dev/null
sudo chmod 600 /etc/systemd/system/caddy.service.d/pretzel-key.conf
sudo systemctl daemon-reload && sudo systemctl restart caddy
```

Use a hex key (as above). If the key is missing, the gateway answers 503 to everything, so it can't accidentally run open.

**Check on the Pi:**

```bash
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8088/pretzel/status                              # 401
curl -s -H "X-Pretzel-Key: $KEY" http://127.0.0.1:8088/pretzel/status                                    # pretzel-server JSON
curl -s -o /dev/null -w "%{http_code}\n" -H "X-Pretzel-Key: $KEY" http://127.0.0.1:8088/pretzel/admin/status # 403
```

### Publish it with Funnel

1. Admin console → **DNS** → enable **HTTPS Certificates**.
2. Admin console → **Access controls**: Funnel needs the `funnel` node attribute. The first `tailscale funnel` run prints a link that adds it for you.
3. On the Pi:

```bash
sudo tailscale funnel --bg 8088
tailscale funnel status          # shows https://pretzel.<tailnet>.ts.net → http://127.0.0.1:8088
```

`--bg` keeps it on across reboots. Turn it off with `sudo tailscale funnel reset`.

**Check from outside** (phone on cellular, or any computer):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://pretzel.<tailnet>.ts.net/pretzel/status                       # 401
curl -s -H "X-Pretzel-Key: <KEY>" https://pretzel.<tailnet>.ts.net/pretzel/status                             # JSON
curl -s -H "X-Pretzel-Key: <KEY>" -X POST -H "Content-Type: application/json" \
  -d '{"text":"Hello from the internet"}' https://pretzel.<tailnet>.ts.net/pretzel/speak                      # Pi speaks
```

### What Wyat AI needs

Endpoints Wyat AI can then call (all with `X-Pretzel-Key`):

| Path | What |
| --- | --- |
| `GET /pretzel/status`, `GET/POST /pretzel/volume`, `POST /pretzel/speak`, `POST /pretzel/weather` | Pi speaker (what `/home` already uses) |
| `GET /pretzel/chores`, `GET /pretzel/reminders`, `GET/POST /pretzel/bulletin` | Household data |
| `/tv/*` | LG TV relay (what the TV card already uses) |
| `/lifx/*` | LIFX proxy |
| `GET /scan/api/v1/context`, `POST /scan/api/v1/scan`, `GET /scan/api/v1/files` | Scanner |
| `/sonos/<Room>/play`, `/sonos/zones`, … | Local Sonos (only if section 4's optional service is running) |

Settings on the Wyat AI side, done in the Vercel / Render dashboards:

- `NEXT_PUBLIC_PRETZEL_SERVER_URL` = `https://pretzel.<tailnet>.ts.net`
- `NEXT_PUBLIC_TV_RELAY_URL` = `https://pretzel.<tailnet>.ts.net` (the gateway serves `/tv/*` too)
- `PRETZEL_PUBLIC_KEY` = the key, as a **server-only** variable. Never prefix it with `NEXT_PUBLIC_`, which would ship it in the browser bundle.

**One small Wyat AI change is still required.** Today the Next.js proxies (`frontend/src/app/api/pretzel-server/[...path]/route.ts` and `frontend/src/app/api/pretzel/[...path]/route.ts`) forward requests without extra headers, so the gateway would answer 401. Each proxy needs to add `X-Pretzel-Key: process.env.PRETZEL_PUBLIC_KEY`. That is about two lines per file; nothing on the Pi changes for it. The same header is all the Rust backend or the MCP server would need to call the Pi later (for example, an MCP tool for "print/scan" or "announce on the Pi").

---

## Troubleshooting

- **Subnet route doesn't work from the phone:** the route isn't approved in the admin console, or IP forwarding is off (`sysctl net.ipv4.ip_forward` should print `1`).
- **AirPrint printer missing on iPhone:** `systemctl status avahi-daemon cups`, and confirm **Shared** is Yes on the printer page in CUPS. Phone and Pi must be on the same Wi‑Fi (Bonjour doesn't cross Tailscale).
- **scanservjs shows no scanner:** `scanimage -L` as the `scanservjs` user: `sudo -u scanservjs scanimage -L`. If only root sees it, add the user to the `scanner` group: `sudo usermod -aG scanner scanservjs && sudo systemctl restart scanservjs`.
- **Gateway returns 503:** `PRETZEL_PUBLIC_KEY` isn't set for caddy. `systemctl show caddy -p Environment` should show it.
- **Gateway returns 502:** the service behind that path isn't running (`systemctl status pretzel-server tv-relay scanservjs sonos-http-api`).
- **Logs:** `journalctl -u tailscaled -u cups -u scanservjs -u caddy -n 50 --no-pager`.
