const cron = require("node-cron");
const { readFileSync, writeFileSync, renameSync, existsSync } = require("fs");
const { join } = require("path");
const { isoToHM, nextSunriseIsoAfterNow } = require("./weather");

const STATE_FILE = "light-automation-state.json";
const RAMP_WAYPOINTS = [0.25, 0.5, 0.75, 1.0];
const RAMP_STEP_DELAY_MS = 60_000;
const RAMP_TRANSITION_S = 30;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class LightAutomationScheduler {
  /**
   * @param {{
   *   tz: string,
   *   fetchWeather: () => Promise<object>,
   *   lifxApiBase: string,
   *   getLifxToken: () => string,
   *   dataDir: string,
   * }} opts
   */
  constructor({ tz, fetchWeather, lifxApiBase, getLifxToken, dataDir }) {
    this.tz = tz;
    this.fetchWeather = fetchWeather;
    this.lifxApiBase = lifxApiBase;
    this.getLifxToken = getLifxToken;
    this.statePath = join(dataDir, STATE_FILE);
    /** @type {import('node-cron').ScheduledTask[]} */
    this.cronTasks = [];
    this.sunsetTask = null;
    this.sunriseTask = null;
  }

  // ── State ────────────────────────────────────────────────────

  _loadState() {
    if (!existsSync(this.statePath)) return { sunsetFiredDate: null };
    try {
      return JSON.parse(readFileSync(this.statePath, "utf8"));
    } catch {
      return { sunsetFiredDate: null };
    }
  }

  _saveState(state) {
    const tmp = `${this.statePath}.tmp`;
    writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
    renameSync(tmp, this.statePath);
  }

  _todayDateStr() {
    return new Intl.DateTimeFormat("en-CA", {
      timeZone: this.tz,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).format(new Date());
  }

  // ── LIFX helpers ────────────────────────────────────────────

  _encodeSelector(selector) {
    return String(selector).replace(/ /g, "%20").replace(/#/g, "%23");
  }

  async _lifxGet(selector) {
    const token = this.getLifxToken();
    if (!token) throw new Error("LIFX_API_TOKEN not set");
    const enc = this._encodeSelector(selector);
    const res = await fetch(`${this.lifxApiBase}/lights/${enc}`, {
      headers: { Authorization: `Bearer ${token}` },
    });
    if (!res.ok) throw new Error(`LIFX GET ${selector} → ${res.status}`);
    return res.json();
  }

  async _lifxSetState(selector, body) {
    const token = this.getLifxToken();
    if (!token) throw new Error("LIFX_API_TOKEN not set");
    const enc = this._encodeSelector(selector);
    const res = await fetch(`${this.lifxApiBase}/lights/${enc}/state`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LIFX PUT state ${selector} → ${res.status}: ${text}`);
    }
    return res.json();
  }

  async _lifxSetStates(states) {
    if (!states || states.length === 0) return;
    const token = this.getLifxToken();
    if (!token) throw new Error("LIFX_API_TOKEN not set");
    const res = await fetch(`${this.lifxApiBase}/lights/states`, {
      method: "PUT",
      headers: {
        Authorization: `Bearer ${token}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ states }),
    });
    if (!res.ok) {
      const text = await res.text();
      throw new Error(`LIFX PUT states → ${res.status}: ${text}`);
    }
    return res.json();
  }

  // ── Rule: Sunset ramp ───────────────────────────────────────

  async _doSunsetAutomation() {
    const today = this._todayDateStr();
    const state = this._loadState();
    if (state.sunsetFiredDate === today) {
      console.log("[light-auto] Sunset already fired today, skipping.");
      return;
    }

    let lights;
    try {
      lights = await this._lifxGet("all");
    } catch (e) {
      console.error("[light-auto] Sunset: failed to fetch lights:", e.message);
      return;
    }

    const wasOff = lights.filter((l) => l.power === "off");
    const wasOn = lights.filter((l) => l.power === "on");
    const allAtMax = wasOn.every((l) => (l.brightness ?? 0) >= 0.99);

    if (wasOff.length === 0 && allAtMax) {
      console.log("[light-auto] Sunset: all lights already at 100%, skipping ramp.");
      return;
    }

    // Turn on lights that were off (Warm color, near-zero brightness)
    if (wasOff.length > 0) {
      const initStates = wasOff.map((l) => ({
        selector: `id:${l.id}`,
        power: "on",
        color: "kelvin:2700",
        brightness: 0.01,
        duration: 1,
      }));
      try {
        await this._lifxSetStates(initStates);
      } catch (e) {
        console.error("[light-auto] Sunset: failed to turn on lights:", e.message);
        return;
      }
    }

    // Record initial brightness per light
    const initialBrightness = {};
    for (const l of wasOff) initialBrightness[l.id] = 0;
    for (const l of wasOn) initialBrightness[l.id] = l.brightness ?? 0;

    // Persist fired date before the async ramp so restarts don't re-fire
    this._saveState({ ...state, sunsetFiredDate: today });
    console.log(`[light-auto] Sunset: starting ramp for ${lights.length} light(s).`);

    for (const target of RAMP_WAYPOINTS) {
      await sleep(RAMP_STEP_DELAY_MS);

      let current;
      try {
        current = await this._lifxGet("all");
      } catch (e) {
        console.error("[light-auto] Sunset ramp: fetch error:", e.message);
        continue;
      }

      const onLights = current.filter((l) => l.power === "on");
      if (onLights.length === 0) {
        console.log("[light-auto] Sunset ramp: all lights off, aborting ramp.");
        return;
      }

      const toUpdate = onLights
        .filter((l) => target > (initialBrightness[l.id] ?? 0))
        .map((l) => ({
          selector: `id:${l.id}`,
          brightness: target,
          duration: RAMP_TRANSITION_S,
        }));

      if (toUpdate.length === 0) continue;

      try {
        await this._lifxSetStates(toUpdate);
        console.log(`[light-auto] Sunset ramp: set ${toUpdate.length} light(s) to ${Math.round(target * 100)}%`);
      } catch (e) {
        console.error("[light-auto] Sunset ramp step error:", e.message);
      }
    }

    console.log("[light-auto] Sunset ramp complete.");
  }

  // ── Rule: Midnight → Lounge purple ─────────────────────────

  async _doMidnightAutomation() {
    let lights;
    try {
      lights = await this._lifxGet("group:Lounge");
    } catch (e) {
      console.error("[light-auto] Midnight: failed to fetch Lounge lights:", e.message);
      return;
    }

    const anyOn = lights.some((l) => l.power === "on");
    if (!anyOn) {
      console.log("[light-auto] Midnight: Lounge lights off, skipping.");
      return;
    }

    try {
      await this._lifxSetState("group:Lounge", {
        color: "hue:270 saturation:1.0",
        duration: 5,
      });
      console.log("[light-auto] Midnight: Lounge set to purple.");
    } catch (e) {
      console.error("[light-auto] Midnight: failed to set purple:", e.message);
    }
  }

  // ── Rule: Sunrise → turn all lights off ─────────────────────

  async _doSunriseAutomation() {
    let lights;
    try {
      lights = await this._lifxGet("all");
    } catch (e) {
      console.error("[light-auto] Sunrise: failed to fetch lights:", e.message);
      return;
    }

    const anyOn = lights.some((l) => l.power === "on");
    if (!anyOn) {
      console.log("[light-auto] Sunrise: all lights already off, skipping.");
      return;
    }

    try {
      await this._lifxSetState("all", { power: "off", duration: 5 });
      console.log("[light-auto] Sunrise: turned all lights off.");
    } catch (e) {
      console.error("[light-auto] Sunrise: failed to turn off lights:", e.message);
    }
  }

  // ── Scheduling ──────────────────────────────────────────────

  stopAll() {
    for (const t of this.cronTasks) {
      try { t.stop(); } catch { /* ignore */ }
    }
    this.cronTasks = [];
    if (this.sunsetTask) {
      try { this.sunsetTask.stop(); } catch { /* ignore */ }
      this.sunsetTask = null;
    }
    if (this.sunriseTask) {
      try { this.sunriseTask.stop(); } catch { /* ignore */ }
      this.sunriseTask = null;
    }
  }

  async scheduleSunset() {
    if (this.sunsetTask) {
      try { this.sunsetTask.stop(); } catch { /* ignore */ }
      this.sunsetTask = null;
    }

    let hour = 19, minute = 0;
    try {
      const wx = await this.fetchWeather();
      ({ hour, minute } = isoToHM(wx.daily.sunset[0]));
    } catch (e) {
      console.warn("[light-auto] scheduleSunset: weather fetch failed, defaulting to 19:00:", e.message);
    }

    console.log(`[light-auto] Scheduling sunset light automation at ${hour}:${String(minute).padStart(2, "0")}`);
    this.sunsetTask = cron.schedule(
      `${minute} ${hour} * * *`,
      () => { this._doSunsetAutomation().catch((e) => console.error("[light-auto] Sunset error:", e.message)); },
      { timezone: this.tz },
    );
  }

  async scheduleSunrise() {
    if (this.sunriseTask) {
      try { this.sunriseTask.stop(); } catch { /* ignore */ }
      this.sunriseTask = null;
    }

    let hour = 6, minute = 0;
    try {
      const wx = await this.fetchWeather();
      const riseIso = nextSunriseIsoAfterNow(wx, new Date());
      ({ hour, minute } = isoToHM(riseIso));
    } catch (e) {
      console.warn("[light-auto] scheduleSunrise: weather fetch failed, defaulting to 06:00:", e.message);
    }

    console.log(`[light-auto] Scheduling sunrise light automation at ${hour}:${String(minute).padStart(2, "0")}`);
    this.sunriseTask = cron.schedule(
      `${minute} ${hour} * * *`,
      () => { this._doSunriseAutomation().catch((e) => console.error("[light-auto] Sunrise error:", e.message)); },
      { timezone: this.tz },
    );
  }

  async reload() {
    this.stopAll();

    // Fixed midnight task
    const midnightTask = cron.schedule(
      "0 0 * * *",
      () => { this._doMidnightAutomation().catch((e) => console.error("[light-auto] Midnight error:", e.message)); },
      { timezone: this.tz },
    );
    this.cronTasks.push(midnightTask);

    // Daily 6am recalculation of dynamic sunrise/sunset times
    const sixAmTask = cron.schedule(
      "0 6 * * *",
      async () => {
        try {
          await this.scheduleSunset();
          await this.scheduleSunrise();
        } catch (e) {
          console.error("[light-auto] 6am recalc error:", e.message);
        }
      },
      { timezone: this.tz },
    );
    this.cronTasks.push(sixAmTask);

    await this.scheduleSunset();
    await this.scheduleSunrise();
  }
}

module.exports = { LightAutomationScheduler };
