"use strict";

// What routine steps do: change lights (LIFX cloud and local WiZ) and speak.

const { targetsLight } = require("./routines");

const IP_RE = /^\d{1,3}(\.\d{1,3}){3}$/;
/** WiZ has no fade of its own, so fades are stepped from the Pi. */
const WIZ_FADE_STEPS = 30;
const WIZ_MIN_STEP_MS = 2_000;
const WIZ_MIN_DIMMING = 10;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{
 *   wizLights: { ip: string, label: string, room: string }[],
 *   getWizLight: (cfg: object) => Promise<object>,
 *   wizRequest: (ip: string, msg: object) => Promise<object>,
 *   lifxToken: () => string|null,
 *   lifxBase: string,
 *   fetchImpl?: typeof fetch,
 *   sleepImpl?: (ms: number) => Promise<void>,
 * }} deps
 */
function createLights({ wizLights, getWizLight, wizRequest, lifxToken, lifxBase, fetchImpl = fetch, sleepImpl = sleep }) {
  /** ip → fade generation; a newer action on the same bulb stops an older fade. */
  const fadeGen = new Map();

  async function lifxCall(path, { method = "GET", body } = {}) {
    const token = lifxToken();
    if (!token) throw new Error("LIFX_API_TOKEN not configured");
    const r = await fetchImpl(`${lifxBase}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        ...(body ? { "Content-Type": "application/json" } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: AbortSignal.timeout(10_000),
    });
    if (!r.ok) throw new Error(`LIFX API ${r.status}: ${(await r.text()).slice(0, 200)}`);
    return r.json();
  }

  /** Every light as `{ id, provider, label, room, connected, power, brightness }`. */
  async function list() {
    const out = [];
    if (lifxToken()) {
      const lifx = await lifxCall("/lights/all");
      for (const l of lifx) {
        out.push({
          id: l.id,
          provider: "lifx",
          label: l.label,
          room: l.group?.name ?? "",
          connected: l.connected !== false,
          power: l.power,
          brightness: l.brightness,
        });
      }
    }
    const wiz = await Promise.all(wizLights.map(getWizLight));
    for (const l of wiz) {
      out.push({
        id: l.id,
        provider: "wiz",
        label: l.label,
        room: l.group?.name ?? "",
        connected: l.connected,
        power: l.power,
        brightness: l.brightness,
      });
    }
    return out;
  }

  /** LIFX selectors and WiZ bulbs for targets, without reading any state. */
  function resolveTargets(targets) {
    const lifx = [];
    const wiz = new Map();
    for (const t of targets) {
      if (t === "all") {
        lifx.push("all");
        for (const w of wizLights) wiz.set(w.ip, w);
      } else if (t.startsWith("room:")) {
        const room = t.slice(5);
        lifx.push(`group:${room}`);
        for (const w of wizLights) if (w.room.toLowerCase() === room.toLowerCase()) wiz.set(w.ip, w);
      } else {
        const id = t.slice(6);
        const w = wizLights.find((x) => x.ip === id);
        if (w) wiz.set(w.ip, w);
        else if (!IP_RE.test(id)) lifx.push(`id:${id}`);
      }
    }
    return { lifx, wiz: [...wiz.values()] };
  }

  function lifxState(selector, a) {
    const s = { selector };
    if (a.power) s.power = a.power;
    if (a.brightness !== undefined && a.power !== "off") s.brightness = a.brightness;
    if (a.kelvin !== undefined && a.power !== "off") s.color = `kelvin:${a.kelvin}`;
    s.duration = a.fadeS ?? 0;
    return s;
  }

  async function setLifx(selectors, a) {
    if (selectors.length === 0) return 0;
    const res = await lifxCall("/lights/states", {
      method: "PUT",
      body: { states: selectors.map((sel) => lifxState(sel, a)) },
    });
    // A selector that matches no light (e.g. an empty room) is not an error.
    const results = (res.results ?? []).flatMap((r) => r.results ?? []);
    const bad = results.filter((r) => r.status !== "ok");
    if (bad.length > 0 && bad.length === results.length) {
      throw new Error(`LIFX: ${bad.map((r) => `${r.label ?? r.id} ${r.status}`).join(", ")}`);
    }
    return results.length - bad.length;
  }

  async function wizPilot(ip) {
    return wizRequest(ip, { method: "getPilot", params: {} });
  }

  async function wizSet(ip, params) {
    return wizRequest(ip, { method: "setPilot", params });
  }

  /** Apply a lights action to one WiZ bulb, stepping the fade in the background. */
  async function setWiz(cfg, a) {
    const gen = (fadeGen.get(cfg.ip) ?? 0) + 1;
    fadeGen.set(cfg.ip, gen);
    const pilot = await wizPilot(cfg.ip);
    const isOn = Boolean(pilot?.state);
    // No `power`: change brightness and colour only on bulbs that are on.
    if (!a.power && !isOn) return false;
    if (a.power === "off" && !isOn) return true;

    const fromDim = isOn && typeof pilot.dimming === "number" ? pilot.dimming : WIZ_MIN_DIMMING;
    const toDim =
      a.power === "off"
        ? WIZ_MIN_DIMMING
        : a.brightness !== undefined
          ? Math.max(WIZ_MIN_DIMMING, Math.min(100, Math.round(a.brightness * 100)))
          : fromDim;
    const temp = a.kelvin !== undefined ? Math.max(2200, Math.min(6500, a.kelvin)) : undefined;
    const fadeMs = (a.fadeS ?? 0) * 1000;

    const first = { state: true, dimming: fadeMs > 0 ? fromDim : toDim };
    if (temp !== undefined) first.temp = temp;
    if (a.power === "off" && fadeMs === 0) {
      await wizSet(cfg.ip, { state: false });
      return true;
    }
    await wizSet(cfg.ip, first);
    if (fadeMs > 0) {
      void (async () => {
        const n = Math.max(1, Math.min(WIZ_FADE_STEPS, Math.floor(fadeMs / WIZ_MIN_STEP_MS)));
        for (let i = 1; i <= n; i += 1) {
          await sleepImpl(fadeMs / n);
          if (fadeGen.get(cfg.ip) !== gen) return;
          const dimming = Math.round(fromDim + ((toDim - fromDim) * i) / n);
          try {
            await wizSet(cfg.ip, { state: true, dimming });
          } catch (e) {
            console.error(`WiZ ${cfg.label} fade: ${e.message}`);
          }
        }
        if (a.power === "off" && fadeGen.get(cfg.ip) === gen) {
          await wizSet(cfg.ip, { state: false }).catch((e) =>
            console.error(`WiZ ${cfg.label} off: ${e.message}`),
          );
        }
      })();
    }
    return true;
  }

  /** Run a lights action. Resolves with a short note, or throws when nothing changed. */
  async function apply(a) {
    let lifxSelectors;
    let wizCfgs;
    if (a.onlyIfOff) {
      // Read state first; if that fails, do nothing rather than override lights someone turned on.
      let lights;
      try {
        lights = await list();
      } catch (e) {
        throw new Error(`skipped: couldn't read light state (${e.message})`);
      }
      const off = lights.filter((l) => targetsLight(a.targets, l) && l.connected && l.power !== "on");
      if (off.length === 0) return "all target lights already on";
      lifxSelectors = off.filter((l) => l.provider === "lifx").map((l) => `id:${l.id}`);
      wizCfgs = off.filter((l) => l.provider === "wiz").map((l) => wizLights.find((w) => w.ip === l.id));
    } else {
      const r = resolveTargets(a.targets);
      // Without a LIFX token only WiZ bulbs exist; a lone light:<lifx id> still reports the error.
      lifxSelectors = lifxToken() || r.wiz.length === 0 ? r.lifx : [];
      wizCfgs = r.wiz;
    }

    const errors = [];
    let changed = 0;
    if (lifxSelectors.length > 0) {
      try {
        changed += await setLifx(lifxSelectors, a);
      } catch (e) {
        errors.push(e.message);
      }
    }
    for (const cfg of wizCfgs) {
      try {
        if (await setWiz(cfg, a)) changed += 1;
      } catch (e) {
        errors.push(`WiZ ${cfg.label}: ${e.message}`);
      }
    }
    if (errors.length > 0 && changed === 0) throw new Error(errors.join("; "));
    const note = `${changed} light${changed === 1 ? "" : "s"}`;
    return errors.length > 0 ? `${note}; ${errors.join("; ")}` : note;
  }

  return { list, apply, resolveTargets };
}

/** `{{name}}` → ctx[name]; unknown names become empty. */
function interpolate(template, ctx) {
  return String(template)
    .replace(/\{\{(\w+)\}\}/g, (_, key) => (ctx[key] === undefined || ctx[key] === null ? "" : String(ctx[key])))
    .replace(/\s{2,}/g, " ")
    .trim();
}

const WEATHER_KEYS = ["tempC", "condition", "rainNote", "sunClause"];

/**
 * Speak a routine's text on the Pi speaker and on Sonos. Fill-ins: {{time}}
 * {{date}} {{sunrise}} {{sunset}} {{chores}}, and with a weather fetch
 * {{tempC}} {{condition}} {{rainNote}} {{sunClause}}.
 *
 * The speech is rendered once (an MP3 in `clips`); the Pi plays it and each
 * Sonos speaker fetches it from `lanUrl()`. The step fails only when no
 * speaker played it.
 *
 * @param {{
 *   clips: { create: (text: string) => Promise<{ name: string, path: string }> },
 *   playOnPi: (path: string) => Promise<void>,
 *   sonos?: { listPlayers: () => Promise<{ id: string, name: string, audioClip: boolean }[]>, audioClip: Function } | null,
 *   lanUrl: () => string|null,
 *   weather: typeof import('./weather'),
 *   sunToday: () => { sunrise: string|null, sunset: string|null },
 *   choresManager: import('./chores').ChoresManager,
 *   tz: string,
 *   now?: () => Date,
 * }} deps
 */
function createSpeaker({ clips, playOnPi, sonos = null, lanUrl, weather, sunToday, choresManager, tz, now = () => new Date() }) {
  async function context(text) {
    const t = now();
    const sun = sunToday();
    const ctx = {
      time: t.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: tz }),
      date: weather.todayLabel(t),
      sunrise: sun.sunrise ?? "",
      sunset: sun.sunset ?? "",
    };
    if (/\{\{chores\}\}/.test(text)) ctx.chores = choresManager.pendingSummaryShort(t) ?? "";
    if (WEATHER_KEYS.some((k) => text.includes(`{{${k}}}`))) {
      try {
        const wx = await weather.fetchWeather();
        const hour = Number(t.toLocaleString("en-US", { hour: "numeric", hour12: false, timeZone: tz })) % 24;
        Object.assign(ctx, weather.buildWeatherContext(wx, hour, t, {}));
      } catch (e) {
        console.error("routine speak weather:", e.message);
      }
    }
    return ctx;
  }

  /** Sonos player ids for a step: every clip-capable speaker for "all". */
  async function sonosTargets(choice) {
    if (!sonos || choice === "none") return [];
    if (Array.isArray(choice)) return choice.map((id) => ({ id, name: id }));
    const players = await sonos.listPlayers();
    return players.filter((p) => p.audioClip);
  }

  async function apply(a, { routine } = {}) {
    const text = interpolate(a.text, await context(a.text));
    const clip = await clips.create(text);

    const outputs = [
      playOnPi(clip.path).then(
        () => ({ ok: true, label: "Pi" }),
        (e) => ({ ok: false, label: "Pi", error: e.message }),
      ),
    ];
    const choice = a.sonos ?? "all";
    if (choice !== "none") {
      outputs.push(
        (async () => {
          const base = lanUrl();
          if (!base) throw new Error("no LAN address for the Pi (set PRETZEL_LAN_URL)");
          const targets = await sonosTargets(choice);
          if (targets.length === 0) throw new Error("no Sonos speaker can play clips");
          const streamUrl = `${base}/pretzel/clips/${clip.name}`;
          return Promise.all(
            targets.map((p) =>
              sonos
                .audioClip(p.id, { streamUrl, volume: a.sonosVolume, name: routine?.name ?? "Pretzel" })
                .then(
                  () => ({ ok: true, label: p.name }),
                  (e) => ({ ok: false, label: p.name, error: e.message }),
                ),
            ),
          );
        })().catch((e) => ({ ok: false, label: "Sonos", error: e.message })),
      );
    }
    const results = (await Promise.all(outputs)).flat();
    const played = results.filter((r) => r.ok).map((r) => r.label);
    const failed = results.filter((r) => !r.ok).map((r) => `${r.label}: ${r.error}`);
    if (played.length === 0) throw new Error(failed.join("; "));
    choresManager.onReminderFired(now());
    const said = `said “${text.length > 50 ? `${text.slice(0, 47)}…` : text}” on ${played.join(", ")}`;
    return failed.length > 0 ? `${said}; ${failed.join("; ")}` : said;
  }

  return { apply, interpolate };
}

const RAMP_STEP_MS = 20_000;

/**
 * Start a Sonos Favorite on a speaker, then (optionally) raise or lower its
 * volume gradually in the background.
 *
 * @param {{ sonos: { playFavoriteOnPlayer: Function, setVolume: Function }, sleepImpl?: (ms: number) => Promise<void> }} deps
 */
function createSonosMusic({ sonos, sleepImpl = sleep }) {
  /** player id → ramp generation; a newer step on the same speaker stops an older ramp. */
  const rampGen = new Map();

  async function apply(a) {
    const gen = (rampGen.get(a.playerId) ?? 0) + 1;
    rampGen.set(a.playerId, gen);
    const groupId = await sonos.playFavoriteOnPlayer(a.playerId, {
      favoriteId: a.favoriteId,
      volume: a.volume,
      shuffle: a.shuffle ?? false,
    });
    const what = `${a.favoriteName ?? `favorite ${a.favoriteId}`} on ${a.playerName ?? a.playerId}`;
    if (a.rampTo === undefined || a.volume === undefined || a.rampTo === a.volume || !groupId) {
      return `playing ${what}`;
    }
    const from = a.volume;
    const to = a.rampTo;
    const totalMs = (a.rampS ?? 0) * 1000;
    const n = Math.max(1, Math.round(totalMs / RAMP_STEP_MS));
    void (async () => {
      for (let i = 1; i <= n; i += 1) {
        await sleepImpl(totalMs / n);
        if (rampGen.get(a.playerId) !== gen) return;
        try {
          await sonos.setVolume(groupId, Math.round(from + ((to - from) * i) / n));
        } catch (e) {
          console.error(`Sonos ramp ${a.playerName ?? a.playerId}: ${e.message}`);
        }
      }
    })();
    return `playing ${what}, volume ${from} → ${to}`;
  }

  return { apply };
}

module.exports = { createLights, createSpeaker, createSonosMusic, interpolate };
