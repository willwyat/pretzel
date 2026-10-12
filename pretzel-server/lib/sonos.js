"use strict";

// Sonos via the Wyat backend. Wyat owns the Sonos OAuth tokens (and refreshes
// them), so the Pi never holds Sonos credentials: it calls Wyat's /sonos/*
// routes, which let the home's public IP in as a Home guest (HOME_PUBLIC_IP).

const express = require("express");

const DEFAULT_WYAT_API_URL = "https://api.wyat.ai";
const DEFAULT_TIMEOUT_MS = 10_000;

/** Sonos household / group ids look like `Sonos_ab.cd` and `RINCON_…:123`. */
const ID_RE = /^[A-Za-z0-9_.:-]{1,128}$/;

function wyatApiBase(raw) {
  const v = typeof raw === "string" ? raw.trim().replace(/\/+$/, "") : "";
  return v !== "" ? v : DEFAULT_WYAT_API_URL;
}

function errorMessage(status, data) {
  if (data && typeof data.error === "string" && data.error !== "") {
    return data.error;
  }
  // The Home gate answers 401/403 with an empty body.
  if (status === 401 || status === 403) {
    return "Wyat refused the Pi (is the home IP in HOME_PUBLIC_IP on Wyat?)";
  }
  return `Wyat API ${status}`;
}

class WyatError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

/**
 * Client for Wyat's /sonos/* routes. Every method resolves with data or
 * throws a WyatError whose `status` is safe to send back to the browser.
 */
function createWyatSonos({
  baseUrl,
  fetchImpl = fetch,
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const base = wyatApiBase(baseUrl);

  async function call(path, { method = "GET", body } = {}) {
    let r;
    try {
      r = await fetchImpl(`${base}${path}`, {
        method,
        headers: {
          Accept: "application/json",
          ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new WyatError(502, `Could not reach Wyat: ${e.message}`);
    }
    let data = {};
    try {
      data = await r.json();
    } catch {
      data = {};
    }
    if (!r.ok) {
      // Keep auth failures visible; anything else from Wyat is a bad gateway.
      const status = r.status === 401 || r.status === 403 ? r.status : 502;
      throw new WyatError(status, errorMessage(r.status, data));
    }
    return data;
  }

  const groupPath = (id) => `/sonos/groups/${encodeURIComponent(id)}`;

  return {
    /** Every group in every household, each tagged with its householdId. */
    async listGroups() {
      const { households } = await call("/sonos/households");
      const lists = await Promise.all(
        (Array.isArray(households) ? households : []).map(async (hh) => {
          const { groups } = await call(
            `/sonos/households/${encodeURIComponent(hh.id)}/groups`,
          );
          return (Array.isArray(groups) ? groups : []).map((g) => ({
            id: g.id,
            name: g.name,
            playbackState: g.playbackState ?? null,
            householdId: hh.id,
          }));
        }),
      );
      return lists.flat();
    },

    /** Playback state, now playing and group volume in one round trip. */
    async groupStatus(id) {
      const [playback, metadata, volume] = await Promise.all([
        call(`${groupPath(id)}/playback`),
        // Metadata is cosmetic; a failure should not blank the card.
        call(`${groupPath(id)}/playback/metadata`).catch(() => ({})),
        call(`${groupPath(id)}/volume`),
      ]);
      const track = metadata?.currentItem?.track;
      return {
        playbackState: playback?.playbackState ?? null,
        track: track?.name ?? null,
        artist: track?.artist?.name ?? null,
        source: metadata?.container?.name ?? metadata?.streamInfo ?? null,
        volume: typeof volume?.volume === "number" ? volume.volume : null,
        muted: volume?.muted === true,
      };
    },

    play: (id) => call(`${groupPath(id)}/playback/play`, { method: "POST" }),
    pause: (id) => call(`${groupPath(id)}/playback/pause`, { method: "POST" }),
    setVolume: (id, volume) =>
      call(`${groupPath(id)}/volume`, { method: "POST", body: { volume } }),
  };
}

/** Routes mounted at /pretzel/sonos. */
function createSonosRouter(client) {
  const router = express.Router();

  const handle = (fn) => async (req, res) => {
    try {
      res.json(await fn(req));
    } catch (e) {
      const status = e instanceof WyatError ? e.status : 500;
      res.status(status).json({ error: e.message });
    }
  };

  router.param("id", (req, res, next, id) => {
    if (!ID_RE.test(id)) {
      return res.status(400).json({ error: "Invalid Sonos group id" });
    }
    next();
  });

  router.get(
    "/groups",
    handle(async () => ({ groups: await client.listGroups() })),
  );
  router.get(
    "/groups/:id",
    handle((req) => client.groupStatus(req.params.id)),
  );
  router.post(
    "/groups/:id/play",
    handle(async (req) => {
      await client.play(req.params.id);
      return { ok: true };
    }),
  );
  router.post(
    "/groups/:id/pause",
    handle(async (req) => {
      await client.pause(req.params.id);
      return { ok: true };
    }),
  );
  router.post("/groups/:id/volume", (req, res, next) => {
    const v = req.body?.volume;
    if (!Number.isInteger(v) || v < 0 || v > 100) {
      return res.status(400).json({ error: "volume must be an integer 0–100" });
    }
    return handle(async () => {
      await client.setVolume(req.params.id, v);
      return { ok: true, volume: v };
    })(req, res, next);
  });

  return router;
}

module.exports = {
  DEFAULT_WYAT_API_URL,
  wyatApiBase,
  createWyatSonos,
  createSonosRouter,
};
