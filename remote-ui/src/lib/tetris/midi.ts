/**
 * Minimal Standard MIDI File reader for the Tetris soundtrack: formats 0 and 1,
 * running status, first tempo event. Only note on/off survive; everything else
 * (controllers, program changes, SysEx, other meta events) is skipped.
 */

export type MidiNote = { tick: number; durTicks: number; note: number; channel: number; velocity: number };
export type MidiSong = { ppq: number; bpm: number; lengthTicks: number; notes: MidiNote[] };

export function parseMidi(buf: ArrayBuffer): MidiSong {
  const d = new DataView(buf);
  const tag = (at: number) => String.fromCharCode(d.getUint8(at), d.getUint8(at + 1), d.getUint8(at + 2), d.getUint8(at + 3));
  if (tag(0) !== "MThd") throw new Error("not a MIDI file");
  const headerLen = d.getUint32(4);
  const nTracks = d.getUint16(10);
  const ppq = d.getUint16(12);
  if (ppq & 0x8000) throw new Error("SMPTE time division is not supported");

  let bpm = 120;
  let tempoSeen = false;
  let lengthTicks = 0;
  const notes: MidiNote[] = [];
  let pos = 8 + headerLen;

  for (let t = 0; t < nTracks && pos + 8 <= d.byteLength; t++) {
    if (tag(pos) !== "MTrk") throw new Error("bad track chunk");
    const end = pos + 8 + d.getUint32(pos + 4);
    let i = pos + 8;
    let tick = 0;
    let status = 0;
    /** `${channel}:${note}` -> start tick and velocity of the sounding note */
    const open = new Map<string, { tick: number; velocity: number }>();
    const vlq = () => {
      let v = 0;
      for (;;) {
        const b = d.getUint8(i++);
        v = (v << 7) | (b & 0x7f);
        if (b < 0x80) return v;
      }
    };
    const close = (channel: number, note: number) => {
      const key = `${channel}:${note}`;
      const on = open.get(key);
      if (!on) return;
      open.delete(key);
      if (tick > on.tick) notes.push({ tick: on.tick, durTicks: tick - on.tick, note, channel, velocity: on.velocity });
    };

    while (i < end) {
      tick += vlq();
      const b = d.getUint8(i);
      if (b === 0xff) {
        const type = d.getUint8(i + 1);
        i += 2;
        const len = vlq();
        if (type === 0x51 && len === 3 && !tempoSeen) {
          const usPerBeat = (d.getUint8(i) << 16) | (d.getUint8(i + 1) << 8) | d.getUint8(i + 2);
          bpm = 60_000_000 / usPerBeat;
          tempoSeen = true;
        }
        i += len;
        continue;
      }
      if (b === 0xf0 || b === 0xf7) {
        i += 1;
        i += vlq();
        continue;
      }
      // A data byte here means running status: reuse the previous event type.
      if (b & 0x80) {
        status = b;
        i += 1;
      }
      const type = status >> 4;
      const channel = status & 0x0f;
      if (type === 0xc || type === 0xd) {
        i += 1;
        continue;
      }
      const a = d.getUint8(i);
      const v = d.getUint8(i + 1);
      i += 2;
      if (type === 0x9 && v > 0) {
        close(channel, a); // retrigger: end the previous instance first
        open.set(`${channel}:${a}`, { tick, velocity: v });
      } else if (type === 0x8 || (type === 0x9 && v === 0)) {
        close(channel, a);
      }
    }
    lengthTicks = Math.max(lengthTicks, tick);
    pos = end;
  }

  notes.sort((x, y) => x.tick - y.tick || x.channel - y.channel);
  return { ppq, bpm, lengthTicks, notes };
}
