/**
 * Piece-on-board sounds for Chess: one of a few recorded clicks per move, never
 * the same one twice in a row. Web Audio, so the opponent's moves can play
 * without a tap once any tap has unlocked the context (mobile autoplay rules).
 */
const URLS = ["/audio/chess-move-1.mp3", "/audio/chess-move-2.mp3", "/audio/chess-move-3.mp3"];
const GAIN = 0.8;

let ctx: AudioContext | null = null;
let buffers: AudioBuffer[] = [];
let loading = false;
let last = -1;

function load(c: AudioContext) {
  if (loading) return;
  loading = true;
  Promise.all(
    URLS.map((url) =>
      fetch(url)
        .then((r) => {
          if (!r.ok) throw new Error(`HTTP ${r.status}`);
          return r.arrayBuffer();
        })
        // Callback form: older Safari has no promise-returning decodeAudioData.
        .then((data) => new Promise<AudioBuffer>((res, rej) => c.decodeAudioData(data, res, rej))),
    ),
  )
    .then((b) => {
      buffers = b;
    })
    .catch((e) => {
      console.warn("chess sounds: could not load:", e);
      loading = false; // retry on the next tap
    });
}

/** Call from a tap: creates or wakes the audio context and loads the clips. */
export function unlockChessSounds() {
  if (!ctx) {
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    ctx = new Ctor();
  }
  if (ctx.state !== "running") ctx.resume().catch(() => {});
  load(ctx);
}

export function playMoveSound() {
  if (!ctx || ctx.state !== "running" || buffers.length === 0) return;
  let i = Math.floor(Math.random() * buffers.length);
  if (i === last && buffers.length > 1) i = (i + 1) % buffers.length;
  last = i;
  const src = ctx.createBufferSource();
  const gain = ctx.createGain();
  gain.gain.value = GAIN;
  src.buffer = buffers[i];
  src.connect(gain).connect(ctx.destination);
  src.start();
}
