"use strict";

// Spoken clips for routines: speak.sh saves the speech to an MP3 once, the Pi
// plays it, and Sonos speakers fetch the same file from
// GET /pretzel/clips/:id.mp3 on the Pi's LAN address. Clips are kept briefly.

const { mkdirSync, readdirSync, statSync, rmSync, existsSync } = require("fs");
const { join } = require("path");
const { randomBytes } = require("crypto");
const os = require("os");

const CLIP_RE = /^[a-f0-9]{16}\.mp3$/;
const KEEP_MS = 60 * 60_000;
const MAX_CLIPS = 30;

/** Home-network (RFC 1918) addresses; Tailscale's 100.x and others can't be reached by speakers. */
const PRIVATE_RE = /^(10\.|192\.168\.|172\.(1[6-9]|2\d|3[01])\.)/;

/**
 * Base URL other LAN devices use to reach pretzel-server: `PRETZEL_LAN_URL`
 * when set, else the Pi's first private IPv4 address on `port`.
 */
function lanBaseUrl(port, env = process.env, interfaces = os.networkInterfaces()) {
  const set = typeof env.PRETZEL_LAN_URL === "string" ? env.PRETZEL_LAN_URL.trim() : "";
  if (set) return set.replace(/\/+$/, "");
  for (const list of Object.values(interfaces)) {
    for (const a of list ?? []) {
      if (a.family === "IPv4" && !a.internal && PRIVATE_RE.test(a.address)) {
        return `http://${a.address}:${port}`;
      }
    }
  }
  return null;
}

class ClipStore {
  /**
   * @param {{ dir: string, render: (text: string, outPath: string) => Promise<void>, now?: () => number }} opts
   */
  constructor({ dir, render, now = () => Date.now() }) {
    this.dir = dir;
    this.render = render;
    this.now = now;
    mkdirSync(dir, { recursive: true });
  }

  /** Render `text` to a new MP3; resolves with `{ name, path }`. */
  async create(text) {
    this.prune();
    const name = `${randomBytes(8).toString("hex")}.mp3`;
    const path = join(this.dir, name);
    await this.render(text, path);
    if (!existsSync(path) || statSync(path).size === 0) {
      rmSync(path, { force: true });
      throw new Error("speech came back empty");
    }
    return { name, path };
  }

  /** Path for a clip name from a URL, or null if it isn't one of ours. */
  pathFor(name) {
    if (!CLIP_RE.test(name)) return null;
    const path = join(this.dir, name);
    return existsSync(path) ? path : null;
  }

  prune() {
    let files;
    try {
      files = readdirSync(this.dir)
        .filter((f) => CLIP_RE.test(f))
        .map((f) => ({ f, t: statSync(join(this.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t);
    } catch {
      return;
    }
    files.forEach(({ f, t }, i) => {
      if (i >= MAX_CLIPS || this.now() - t > KEEP_MS) rmSync(join(this.dir, f), { force: true });
    });
  }
}

module.exports = { ClipStore, lanBaseUrl, CLIP_RE };
