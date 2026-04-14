const express = require('express');
const { exec } = require('child_process');

const PORT = 3001;
const SPEAK_SCRIPT = '/home/william/pretzel/scripts/speak.sh';

const app = express();
app.use(express.json());

app.post('/pretzel/speak', (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'text is required' });
  const safe = text.replace(/"/g, '\\"');
  exec(`${SPEAK_SCRIPT} "${safe}"`, (err) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json({ ok: true });
  });
});

app.get('/pretzel/status', (req, res) => {
  res.json({ ok: true, host: 'pretzel' });
});

app.listen(PORT, '0.0.0.0', () => console.log(`Pretzel server listening on ${PORT}`));
