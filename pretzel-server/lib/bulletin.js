"use strict";

const { randomUUID } = require("crypto");
const { readFileSync, writeFileSync, renameSync, existsSync } = require("fs");
const { join } = require("path");

const MAX_MESSAGE = 500;
const MAX_NOTES = 80;

function atomicWriteJson(filePath, obj) {
  const tmp = `${filePath}.tmp`;
  writeFileSync(tmp, JSON.stringify(obj, null, 2), "utf8");
  renameSync(tmp, filePath);
}

function cleanMessage(raw) {
  if (typeof raw !== "string") return "";
  return raw.replace(/[\u0000-\u001f<>]/g, "").trim().slice(0, MAX_MESSAGE);
}

function isNote(value) {
  if (typeof value !== "object" || value === null) return false;
  const note = value;
  return (
    typeof note.id === "string" &&
    note.id.length > 0 &&
    typeof note.message === "string" &&
    typeof note.date === "string" &&
    typeof note.isSeen === "boolean"
  );
}

class Bulletin {
  constructor(dataDir) {
    this.path = join(dataDir, "bulletin.json");
    /** @type {{ id: string, message: string, date: string, isSeen: boolean }[]} */
    this.notes = [];
  }

  load() {
    if (!existsSync(this.path)) {
      this.notes = [];
      return;
    }
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8"));
      const notes = Array.isArray(raw.notes) ? raw.notes : [];
      this.notes = notes.filter(isNote);
    } catch (e) {
      console.error("bulletin: could not read board:", e.message);
      this.notes = [];
    }
  }

  save() {
    atomicWriteJson(this.path, { notes: this.notes });
  }

  list() {
    return this.notes.map((note) => ({ ...note }));
  }

  add(message) {
    const text = cleanMessage(message);
    if (!text) return { ok: false, error: "Message is empty" };
    if (this.notes.length >= MAX_NOTES) {
      return { ok: false, error: "The board is full" };
    }
    const note = {
      id: randomUUID(),
      message: text,
      date: new Date().toISOString(),
      isSeen: false,
    };
    this.notes.unshift(note);
    this.save();
    return { ok: true, note };
  }

  remove(id) {
    const before = this.notes.length;
    this.notes = this.notes.filter((note) => note.id !== id);
    if (this.notes.length === before) {
      return { ok: false, error: "Unknown note" };
    }
    this.save();
    return { ok: true };
  }

  setSeen(id, isSeen) {
    const note = this.notes.find((item) => item.id === id);
    if (!note) return { ok: false, error: "Unknown note" };
    note.isSeen = isSeen;
    this.save();
    return { ok: true, note: { ...note } };
  }
}

module.exports = { Bulletin, MAX_MESSAGE };
