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
 * Speak a routine's text on the Pi speaker. Fill-ins: {{time}} {{date}}
 * {{sunrise}} {{sunset}} {{chores}}, and with a weather fetch {{tempC}}
 * {{condition}} {{rainNote}} {{sunClause}}.
 *
 * @param {{
 *   speak: (text: string, style: "cheerful"|"plain") => Promise<void>,
 *   weather: typeof import('./weather'),
 *   sunToday: () => { sunrise: string|null, sunset: string|null },
 *   choresManager: import('./chores').ChoresManager,
 *   tz: string,
 *   now?: () => Date,
 * }} deps
 */
function createSpeaker({ speak, weather, sunToday, choresManager, tz, now = () => new Date() }) {
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

  async function apply(a) {
    const text = interpolate(a.text, await context(a.text));
    await speak(text, a.style ?? "cheerful");
    choresManager.onReminderFired(now());
    return `said “${text.length > 60 ? `${text.slice(0, 57)}…` : text}”`;
  }

  return { apply, interpolate };
}

module.exports = { createLights, createSpeaker, interpolate };
