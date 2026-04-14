const express = require("express");
const { exec } = require("child_process");

const PORT = 3001;
const SPEAK_SCRIPT = "/home/william/pretzel/scripts/speak.sh";

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
  exec("amixer -c 2 sget 'Speaker'", (err, stdout) => {
    if (err) return res.status(500).json({ error: err.message });
    const match = stdout.match(/\[(\d+)%\]/);
    const volume = match ? parseInt(match[1]) : null;
    res.json({ ok: true, volume });
  });
});

app.post("/pretzel/volume", (req, res) => {
  const { volume, announce = true } = req.body;
  if (volume === undefined)
    return res.status(400).json({ error: "volume is required" });
  const clamped = Math.max(0, Math.min(100, volume));
  exec(`amixer -c 2 sset 'Speaker' ${clamped}%`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    if (announce) speak(`Changed my volume to ${clamped} percent`);
    res.json({ ok: true, volume: clamped });
  });
});

app.get("/pretzel/status", (req, res) => {
  res.json({ ok: true, host: "pretzel" });
});

app.listen(PORT, "0.0.0.0", () =>
  console.log(`Pretzel server listening on ${PORT}`),
);
