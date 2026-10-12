"use strict";

// HTTP routes for routines, mounted at /pretzel/routines. Reading the schedule,
// one-off changes (skip or move one cycle) and "run now" are open on the LAN
// like the rest of the household controls; creating, editing and deleting
// routines needs the settings passcode.

const express = require("express");

const LIGHTS_CACHE_MS = 60_000;

/**
 * @param {{
 *   engine: import('./routines').RoutineEngine,
 *   listLights: () => Promise<{ id: string, room: string }[]>,
 *   requirePasscode: express.RequestHandler,
 * }} deps
 */
function createRoutinesRouter({ engine, listLights, requirePasscode }) {
  const router = express.Router();
  let lightsCache = { at: 0, lights: null };

  async function cachedLights() {
    if (lightsCache.lights && Date.now() - lightsCache.at < LIGHTS_CACHE_MS) return lightsCache.lights;
    const lights = await listLights();
    lightsCache = { at: Date.now(), lights };
    return lights;
  }

  router.get("/", (req, res) => {
    res.json({ ok: true, tz: engine.geo.tz, routines: engine.routines });
  });

  router.get("/upcoming", (req, res) => {
    res.json({ ok: true, ...engine.upcoming() });
  });

  // Each light's next scheduled change, keyed by light id (LIFX id or WiZ IP).
  router.get("/lights-next", async (req, res) => {
    try {
      const lights = await cachedLights();
      res.json({
        ok: true,
        tz: engine.geo.tz,
        now: new Date(engine.now()).toISOString(),
        lights: engine.nextForLights(lights),
      });
    } catch (e) {
      res.status(502).json({ ok: false, error: e.message });
    }
  });

  router.get("/runs", (req, res) => {
    const limit = Math.max(1, Math.min(200, Number(req.query.limit) || 50));
    res.json({ ok: true, runs: engine.store.runs.slice(-limit).reverse() });
  });

  router.put("/:id", requirePasscode, (req, res) => {
    const r = engine.saveRoutine({ ...req.body, id: req.params.id });
    if (!r.ok) return res.status(400).json(r);
    res.json(r);
  });

  router.delete("/:id", requirePasscode, (req, res) => {
    if (!engine.deleteRoutine(req.params.id)) {
      return res.status(404).json({ ok: false, error: "Unknown routine" });
    }
    res.json({ ok: true });
  });

  // Runs in the background; progress shows up in /runs and /upcoming.
  router.post("/:id/run", (req, res) => {
    if (!engine.getRoutine(req.params.id)) {
      return res.status(404).json({ ok: false, error: "Unknown routine" });
    }
    void engine.runNow(req.params.id);
    res.status(202).json({ ok: true });
  });

  router.put("/:id/override/:cycleDate", (req, res) => {
    const r = engine.setOverride(req.params.id, req.params.cycleDate, req.body);
    if (!r.ok) return res.status(r.status).json({ ok: false, error: r.error });
    res.json(r);
  });

  router.delete("/:id/override/:cycleDate", (req, res) => {
    engine.clearOverride(req.params.id, req.params.cycleDate);
    res.json({ ok: true });
  });

  return router;
}

module.exports = { createRoutinesRouter };
