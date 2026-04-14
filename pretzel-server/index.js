const express = require("express");
const { execFile } = require("child_process");

const PORT = 3001;
const SPEAK_SCRIPT = "/home/william/pretzel/scripts/speak.sh";

const envCard = process.env.PRETZEL_AMIXER_CARD;
const envControl = process.env.PRETZEL_AMIXER_CONTROL;
const parsedPreferred =
  envCard !== undefined && envCard !== "" ? Number(envCard) : 2;
const PREFERRED_CARD = Number.isFinite(parsedPreferred) ? parsedPreferred : 2;
const PREFERRED_CONTROL =
  typeof envControl === "string" && envControl.trim() !== ""
    ? envControl.trim()
    : "Speaker";

/** First successful sget output (has [n%]) wins; reused for later requests. */
let resolvedTarget = null;

function volumeCandidates() {
  const names = ["PCM", "Headphone", "Speaker", "Master", "Digital"];
  const cards = [0, 1, 2, 3, 4];
  const out = [[PREFERRED_CARD, PREFERRED_CONTROL]];
  for (const c of cards) {
    for (const n of names) {
      out.push([c, n]);
    }
  }
  const seen = new Set();
  return out.filter(([c, n]) => {
    const k = `${c}:${n}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/**
 * @param {(err: Error|null, target: {card:number,control:string}|null, probeStdout: string|null) => void} done
 */
function resolveTarget(done) {
  if (resolvedTarget) {
    return done(null, resolvedTarget, null);
  }
  const tries = volumeCandidates();
  let i = 0;
  function next() {
    if (i >= tries.length) {
      const err = new Error(
        "No ALSA simple volume control found (exhausted env preferred + common controls on cards 0–4)",
      );
      return done(err, null, null);
    }
    const [card, control] = tries[i++];
    execFile(
      "amixer",
      ["-c", String(card), "sget", control],
      { encoding: "utf8" },
      (err, stdout) => {
        if (!err && stdout && /\[\d+%\]/.test(stdout)) {
          resolvedTarget = { card, control };
          return done(null, resolvedTarget, stdout);
        }
        next();
      },
    );
  }
  next();
}

const app = express();
app.use(express.json());

function speak(text) {
  execFile(SPEAK_SCRIPT, [text], (err) => {
    if (err) console.error("speak error:", err.message);
  });
}

app.post("/pretzel/speak", (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: "text is required" });
  speak(text);
  res.json({ ok: true });
});

app.get("/pretzel/volume", (req, res) => {
  resolveTarget((err, target, probeStdout) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    if (probeStdout) {
      const match = probeStdout.match(/\[(\d+)%\]/);
      const volume = match ? parseInt(match[1], 10) : null;
      return res.json({ ok: true, volume });
    }
    execFile(
      "amixer",
      ["-c", String(target.card), "sget", target.control],
      { encoding: "utf8" },
      (e2, stdout) => {
        if (e2) {
          resolvedTarget = null;
          return res.status(500).json({ error: e2.message });
        }
        const match = stdout.match(/\[(\d+)%\]/);
        const volume = match ? parseInt(match[1], 10) : null;
        res.json({ ok: true, volume });
      },
    );
  });
});

app.post("/pretzel/volume", (req, res) => {
  const { volume, announce = true } = req.body;
  if (volume === undefined)
    return res.status(400).json({ error: "volume is required" });
  const clamped = Math.max(0, Math.min(100, volume));
  resolveTarget((err, target) => {
    if (err) {
      return res.status(500).json({ error: err.message });
    }
    execFile(
      "amixer",
      ["-c", String(target.card), "sset", target.control, `${clamped}%`],
      { encoding: "utf8" },
      (e2) => {
        if (e2) {
          resolvedTarget = null;
          return res.status(500).json({ error: e2.message });
        }
        if (announce) speak(`Changed my volume to ${clamped} percent`);
        res.json({ ok: true, volume: clamped });
      },
    );
  });
});

app.get("/pretzel/status", (req, res) => {
  res.json({ ok: true, host: "pretzel" });
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`Pretzel server listening on ${PORT}`),
);
