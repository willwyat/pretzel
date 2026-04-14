const express = require("express");
const { exec } = require("child_process");

const PORT = 3001;
const SPEAK_SCRIPT = "/home/william/pretzel/scripts/speak.sh";
const AMIXER_CARD = 2;
const AMIXER_CONTROL = "Speaker";

// #region agent log
function debugLog(payload) {
  fetch("http://127.0.0.1:7936/ingest/c2b7cbb4-2867-44d0-a699-3b5c23b6c228", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Debug-Session-Id": "53bd17",
    },
    body: JSON.stringify({
      sessionId: "53bd17",
      timestamp: Date.now(),
      runId: payload.runId ?? "pre-fix",
      ...payload,
    }),
  }).catch(() => {});
}
// #endregion

const app = express();
app.use(express.json());

function speak(text) {
  const safe = text.replace(/"/g, '\\"');
  exec(`${SPEAK_SCRIPT} "${safe}"`, (err) => {
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
  // #region agent log
  debugLog({
    location: "index.js:GET /pretzel/volume",
    message: "volume get: using amixer target",
    hypothesisId: "H1",
    data: { card: AMIXER_CARD, control: AMIXER_CONTROL },
  });
  // #endregion
  exec(
    `amixer -c ${AMIXER_CARD} sget '${AMIXER_CONTROL}'`,
    (err, stdout) => {
      if (err) {
        exec(
          `sh -c 'for c in 0 1 2; do echo "====card $c===="; amixer -c $c scontrols 2>&1; done'`,
          (e2, discovery) => {
            // #region agent log
            debugLog({
              location: "index.js:GET /pretzel/volume err",
              message: "amixer sget failed; discovery scontrols",
              hypothesisId: "H1",
              data: {
                amixerError: err.message,
                discovery: discovery?.slice(0, 4000) ?? null,
                discoveryExecError: e2?.message ?? null,
              },
            });
            // #endregion
            return res.status(500).json({ error: err.message });
          },
        );
        return;
      }
      const match = stdout.match(/\[(\d+)%\]/);
      const volume = match ? parseInt(match[1]) : null;
      // #region agent log
      debugLog({
        location: "index.js:GET /pretzel/volume ok",
        message: "parsed volume",
        hypothesisId: "H3",
        data: { volume, rawSample: stdout?.slice(0, 500) ?? "" },
      });
      // #endregion
      res.json({ ok: true, volume });
    },
  );
});

app.post("/pretzel/volume", (req, res) => {
  const { volume, announce = true } = req.body;
  if (volume === undefined)
    return res.status(400).json({ error: "volume is required" });
  const clamped = Math.max(0, Math.min(100, volume));
  // #region agent log
  debugLog({
    location: "index.js:POST /pretzel/volume",
    message: "volume set: using amixer target",
    hypothesisId: "H2",
    data: { card: AMIXER_CARD, control: AMIXER_CONTROL, clamped },
  });
  // #endregion
  exec(
    `amixer -c ${AMIXER_CARD} sset '${AMIXER_CONTROL}' ${clamped}%`,
    (err) => {
      if (err) {
        exec(
          `sh -c 'for c in 0 1 2; do echo "====card $c===="; amixer -c $c scontrols 2>&1; done'`,
          (e2, discovery) => {
            // #region agent log
            debugLog({
              location: "index.js:POST /pretzel/volume err",
              message: "amixer sset failed; discovery scontrols",
              hypothesisId: "H2",
              data: {
                amixerError: err.message,
                discovery: discovery?.slice(0, 4000) ?? null,
                discoveryExecError: e2?.message ?? null,
              },
            });
            // #endregion
            return res.status(500).json({ error: err.message });
          },
        );
        return;
      }
      if (announce) speak(`Changed my volume to ${clamped} percent`);
      res.json({ ok: true, volume: clamped });
    },
  );
});

app.get("/pretzel/status", (req, res) => {
  res.json({ ok: true, host: "pretzel" });
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`Pretzel server listening on ${PORT}`),
);
