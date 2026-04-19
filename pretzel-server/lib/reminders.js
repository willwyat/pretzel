const cron = require("node-cron");
const { readFileSync } = require("fs");
const { join } = require("path");
const { isoToHM, fmtTime } = require("./weather");

function readRemindersFile(remindersPath) {
  const raw = JSON.parse(readFileSync(remindersPath, "utf8"));
  return Array.isArray(raw.reminders) ? raw.reminders : [];
}

function parseHm(timeStr) {
  const [h, m] = String(timeStr).split(":").map((x) => parseInt(x, 10));
  return { hour: h || 0, minute: m || 0 };
}

function interpolate(template, ctx) {
  return String(template).replace(/\{\{(\w+)\}\}/g, (_, key) => {
    const v = ctx[key];
    if (v === undefined || v === null) return "";
    return String(v);
  });
}

class RemindersScheduler {
  /**
   * @param {{
   *   dataDir: string,
   *   tz: string,
   *   speakWithSfx: (text: string, instructions?: string) => Promise<void>,
   *   fetchWeather: () => Promise<object>,
   *   buildWeatherContext: (wx: object, reminderHour: number, now: Date, meta: object) => object,
   *   choresManager: import('./chores').ChoresManager,
   * }} opts
   */
  constructor(opts) {
    this.dataDir = opts.dataDir;
    this.tz = opts.tz;
    this.speakWithSfx = opts.speakWithSfx;
    this.fetchWeather = opts.fetchWeather;
    this.buildWeatherContext = opts.buildWeatherContext;
    this.choresManager = opts.choresManager;
    this.remindersPath = join(this.dataDir, "reminders.json");
    /** @type {import('node-cron').ScheduledTask[]} */
    this.cronTasks = [];
    this.sunsetTask = null;
    /** @type {any[]} */
    this.reminderDefs = [];
  }

  stopAll() {
    for (const t of this.cronTasks) {
      try {
        t.stop();
      } catch {
        /* ignore */
      }
    }
    this.cronTasks = [];
    if (this.sunsetTask) {
      try {
        this.sunsetTask.stop();
      } catch {
        /* ignore */
      }
      this.sunsetTask = null;
    }
  }

  async runReminder(reminder) {
    const now = new Date();
    let reminderHour = 12;
    if (reminder.time === "sunset") {
      try {
        const wx0 = await this.fetchWeather();
        const { hour } = isoToHM(wx0.daily.sunset[0]);
        reminderHour = hour;
      } catch {
        reminderHour = 18;
      }
    } else {
      reminderHour = parseHm(reminder.time).hour;
    }

    let ctx = {};
    try {
      const wx = await this.fetchWeather();
      ctx = this.buildWeatherContext(wx, reminderHour, now, {
        reminderId: reminder.id,
      });
    } catch (e) {
      console.error(`Reminder ${reminder.id} weather error:`, e.message);
      ctx = {};
    }

    if (reminder.includeChores) {
      ctx.chores =
        reminder.id === "evening"
          ? this.choresManager.buildChoresSummary(now)
          : this.choresManager.pendingSummaryShort(now) ?? "";
    } else {
      ctx.chores = "";
    }

    if (reminder._spokenWallTime) {
      ctx.time = reminder._spokenWallTime;
    }

    let text = interpolate(reminder.template, ctx);

    try {
      await this.speakWithSfx(text);
      this.choresManager.onReminderFired(now);
    } catch (e) {
      console.error(`Reminder ${reminder.id} speak error:`, e.message);
    }
  }

  async scheduleSunset() {
    const list = readRemindersFile(this.remindersPath);
    const sunsetRem = list.find((r) => r.id === "sunset" && r.enabled && r.time === "sunset");
    if (this.sunsetTask) {
      this.sunsetTask.stop();
      this.sunsetTask = null;
    }
    if (!sunsetRem) {
      console.log("Sunset reminder disabled or missing; not scheduling.");
      return;
    }

    const wx = await this.fetchWeather();
    const sunsetIso = wx.daily.sunset[0];
    const { hour, minute } = isoToHM(sunsetIso);
    const sunsetTimeStr = fmtTime(sunsetIso);
    console.log(
      `Scheduling sunset reminder for ${hour}:${minute < 10 ? "0" + minute : minute}`,
    );

    this.sunsetTask = cron.schedule(
      `${minute} ${hour} * * *`,
      async () => {
        await this.runReminder({
          ...sunsetRem,
          _spokenWallTime: sunsetTimeStr,
        });
      },
      { timezone: this.tz },
    );
  }

  async reload() {
    this.stopAll();
    this.reminderDefs = readRemindersFile(this.remindersPath);

    for (const r of this.reminderDefs) {
      if (!r.enabled) continue;
      if (r.time === "sunset") continue;

      const { hour, minute } = parseHm(r.time);
      const task = cron.schedule(
        `${minute} ${hour} * * *`,
        async () => {
          await this.runReminder(r);
        },
        { timezone: this.tz },
      );
      this.cronTasks.push(task);
    }

    const sixAm = cron.schedule(
      "0 6 * * *",
      async () => {
        try {
          this.choresManager.backupState();
          await this.scheduleSunset();
          this.choresManager.reload();
        } catch (e) {
          console.error("6am chores/sunset job:", e.message);
        }
      },
      { timezone: this.tz },
    );
    this.cronTasks.push(sixAm);

    await this.scheduleSunset();
  }
}

module.exports = { RemindersScheduler, readRemindersFile, interpolate };
