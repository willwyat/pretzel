"use strict";

/** Matches frontend/src/lib/pretzel-server.ts */
const PRETZEL_SPEAK_MAX_CHARS = 8000;

/**
 * LG TV + Pi speaker remote UI — behavior aligned with Wyat:
 * - TVCard.tsx / PretzelSpeakerCard.tsx (fetch paths use same /tv/* and /pretzel/* as tv-relay.ts + pretzel-server client)
 */

function $(id) {
  return document.getElementById(id);
}

let tvRelayOffline = true;
let tvConnected = false;
let tvInputConnected = false;
let tvVolume = 0;
let tvMaxVolume = 100;
let tvMuted = false;
let tvLocalVolume = 0;
let tvDragging = false;
let tvLoading = true;
let tvPowerOffArmed = false;
let tvTurningOff = false;
let tvTurningOn = false;
let powerOffArmTimer = null;

let pzOffline = true;
let pzLoading = true;
let pzVolume = 0;
let pzLocalVolume = 0;
let pzDragging = false;
let speakSending = false;
let weatherSending = false;

async function fetchRes(url, opts) {
  const r = await fetch(url, {
    ...opts,
    headers: {
      Accept: "application/json",
      ...(opts && opts.body ? { "Content-Type": "application/json" } : {}),
      ...(opts && opts.headers),
    },
  });
  const ct = r.headers.get("content-type") || "";
  let data = {};
  if (ct.includes("application/json")) {
    try {
      data = await r.json();
    } catch {
      data = {};
    }
  }
  return { ok: r.ok, data, status: r.status };
}

function setTvErr(msg) {
  const e = $("tvError");
  e.textContent = msg || "";
  e.style.display = msg ? "block" : "none";
}

function setPzErr(msg) {
  const e = $("pretzelError");
  e.textContent = msg || "";
  e.style.display = msg ? "block" : "none";
}

function clearPowerOffArmTimer() {
  if (powerOffArmTimer) {
    clearTimeout(powerOffArmTimer);
    powerOffArmTimer = null;
  }
}

function schedulePowerOffArmExpiry() {
  clearPowerOffArmTimer();
  powerOffArmTimer = setTimeout(() => {
    tvPowerOffArmed = false;
    powerOffArmTimer = null;
    renderTv();
  }, 5000);
}

function pctOfTvVol(vol) {
  const safe = Math.min(Math.max(0, vol), tvMaxVolume);
  return tvMaxVolume > 0 ? Math.round((safe / tvMaxVolume) * 100) : safe;
}

function renderTv() {
  const dot = $("tvStatusDot");
  if (tvRelayOffline) {
    dot.className = "status-dot bad";
    dot.title = "Relay offline";
  } else if (tvConnected) {
    dot.className = "status-dot ok";
    dot.title = "Connected";
  } else {
    dot.className = "status-dot bad";
    dot.title = "Not connected";
  }

  const sub = $("tvSubtitle");
  if (tvLoading) sub.textContent = "Loading…";
  else if (tvRelayOffline) sub.textContent = "Pretzel offline";
  else if (!tvConnected) sub.textContent = "TV not connected";
  else sub.textContent = tvInputConnected ? "Source connected" : "No source";

  $("tvRefresh").style.display = tvLoading ? "none" : "inline-block";

  const controlsDisabled =
    tvRelayOffline || !tvConnected || tvLoading || tvTurningOff;
  const remoteDisabled =
    tvRelayOffline ||
    !tvConnected ||
    tvLoading ||
    tvTurningOff ||
    tvTurningOn;

  const volEl = $("tvVol");
  volEl.max = String(tvMaxVolume);
  const displayVol = tvDragging ? tvLocalVolume : tvVolume;
  const safeVol = Math.min(Math.max(0, displayVol), tvMaxVolume);
  if (!tvDragging) volEl.value = String(safeVol);
  else volEl.value = String(tvLocalVolume);
  $("tvVolPct").textContent = pctOfTvVol(safeVol) + "%";

  volEl.disabled = controlsDisabled;
  const muteBtn = $("tvMute");
  muteBtn.disabled = controlsDisabled;
  muteBtn.textContent = tvMuted ? "Unmute" : "Mute";
  muteBtn.title = tvMuted ? "Unmute" : "Mute";

  $("tvRemoteSection").hidden = !tvConnected;
  document.querySelectorAll("[data-remote]").forEach((b) => {
    b.disabled = remoteDisabled;
  });

  const onWrap = $("tvPowerOnWrap");
  const offWrap = $("tvPowerOffWrap");
  const btnOn = $("tvPowerOn");
  const btnOff = $("tvPowerOff");
  $("tvWaking").style.display = tvTurningOn ? "inline" : "none";
  $("tvTurningOff").style.display = tvTurningOff ? "inline" : "none";

  if (tvConnected) {
    onWrap.style.display = "none";
    offWrap.style.display = "block";
    btnOff.style.display = tvTurningOff ? "none" : "inline-block";
    btnOff.disabled = tvRelayOffline || tvLoading || tvTurningOff;
    btnOff.textContent = tvPowerOffArmed ? "Confirm power off" : "Power off";
    btnOff.className = tvPowerOffArmed ? "btn-power-off armed" : "btn-power-off";
  } else {
    onWrap.style.display = "block";
    offWrap.style.display = "none";
    btnOn.style.display = tvTurningOn ? "none" : "inline-block";
    btnOn.disabled = tvRelayOffline || tvLoading || tvTurningOn;
  }
}

function renderPz() {
  const dot = $("pzStatusDot");
  if (pzOffline) {
    dot.className = "status-dot bad";
    dot.title = "Pretzel server offline";
  } else {
    dot.className = "status-dot ok";
    dot.title = "Connected";
  }

  const sub = $("pzSubtitle");
  if (pzLoading) sub.textContent = "Loading…";
  else if (pzOffline) sub.textContent = "Pretzel server offline";
  else sub.textContent = "USB audio on Pretzel";

  $("pzRefresh").style.display = pzLoading ? "none" : "inline-block";

  const volEl = $("pzVol");
  const displayVol = pzDragging ? pzLocalVolume : pzVolume;
  if (!pzDragging) volEl.value = String(displayVol);
  else volEl.value = String(pzLocalVolume);
  $("pzVolPct").textContent = displayVol + "%";
  volEl.disabled = pzOffline || pzLoading;

  const ta = $("speakText");
  ta.disabled = pzOffline || speakSending;
  ta.placeholder = pzOffline
    ? "Connect to Pretzel to send speech…"
    : "Type something for OpenAI TTS on the Pi…";

  $("speakCount").textContent =
    ta.value.length + "/" + PRETZEL_SPEAK_MAX_CHARS;

  $("weatherBtn").disabled = pzOffline || weatherSending;
  $("weatherBtn").textContent = weatherSending ? "Sending…" : "Weather";

  $("speakBtn").disabled =
    pzOffline || speakSending || ta.value.trim().length === 0;
  $("speakBtn").textContent = speakSending ? "Sending…" : "Speak";
}

async function fetchAllTv() {
  tvLoading = true;
  renderTv();
  setTvErr("");
  try {
    const [statusRes, volRes] = await Promise.all([
      fetchRes("/tv/status"),
      fetchRes("/tv/volume"),
    ]);
    if (!statusRes.ok || !volRes.ok) {
      tvRelayOffline = true;
      tvConnected = false;
      tvLoading = false;
      renderTv();
      return;
    }
    const status = statusRes.data;
    const volJson = volRes.data;
    tvRelayOffline = false;
    tvConnected = !!status.connected;
    tvInputConnected = !!status.inputConnected;

    const vs = volJson.volumeStatus;
    if (vs && typeof vs.volume === "number") {
      tvVolume = vs.volume;
      if (!tvDragging) tvLocalVolume = vs.volume;
      tvMuted = !!vs.muteStatus;
      if (typeof vs.maxVolume === "number" && vs.maxVolume > 0) {
        tvMaxVolume = vs.maxVolume;
      }
    }
  } catch {
    tvRelayOffline = true;
    tvConnected = false;
  } finally {
    tvLoading = false;
    renderTv();
  }
}

async function fetchPzVolume() {
  pzLoading = true;
  renderPz();
  setPzErr("");
  try {
    const res = await fetchRes("/pretzel/volume");
    const data = res.data;
    if (!res.ok) {
      pzOffline = true;
      pzLoading = false;
      renderPz();
      return;
    }
    pzOffline = false;
    if (typeof data.volume === "number" && Number.isFinite(data.volume)) {
      const v = Math.max(0, Math.min(100, data.volume));
      pzVolume = v;
      if (!pzDragging) pzLocalVolume = v;
    }
  } catch {
    pzOffline = true;
  } finally {
    pzLoading = false;
    renderPz();
  }
}

function commitTvVolume(val) {
  const clamped = Math.max(0, Math.min(tvMaxVolume, Math.round(val)));
  tvVolume = clamped;
  tvLocalVolume = clamped;
  renderTv();
  void fetchRes("/tv/volume", {
    method: "POST",
    body: JSON.stringify({ volume: clamped }),
  }).catch(() => {});
  void fetchRes("/pretzel/volume", {
    method: "POST",
    body: JSON.stringify({ volume: clamped, announce: true }),
  }).catch(() => {});
}

function commitPzVolume(val) {
  const clamped = Math.max(0, Math.min(100, Math.round(val)));
  pzVolume = clamped;
  pzLocalVolume = clamped;
  renderPz();
  void fetchRes("/pretzel/volume", {
    method: "POST",
    body: JSON.stringify({ volume: clamped, announce: true }),
  }).catch(() => {});
}

function toggleTvMute() {
  const controlsDisabled =
    tvRelayOffline || !tvConnected || tvLoading || tvTurningOff;
  if (controlsDisabled) return;
  const next = !tvMuted;
  tvMuted = next;
  renderTv();
  void fetchRes("/tv/mute", {
    method: "POST",
    body: JSON.stringify({ mute: next }),
  })
    .then((r) => {
      if (!r.ok) tvMuted = !next;
    })
    .catch(() => {
      tvMuted = !next;
    });
}

function handlePowerOffClick() {
  if (tvRelayOffline || tvLoading || tvTurningOff) return;
  if (!tvConnected && !tvPowerOffArmed) return;
  if (!tvPowerOffArmed) {
    tvPowerOffArmed = true;
    schedulePowerOffArmExpiry();
    renderTv();
    return;
  }
  clearPowerOffArmTimer();
  tvPowerOffArmed = false;
  tvTurningOff = true;
  renderTv();
  void fetchRes("/tv/power/off", { method: "POST" })
    .catch(() => {})
    .finally(() => {
      tvTurningOff = false;
      void fetchAllTv();
    });
}

function handlePowerOnClick() {
  if (tvRelayOffline || tvLoading || tvTurningOn || tvConnected) return;
  tvTurningOn = true;
  renderTv();
  void fetchRes("/tv/power/on", { method: "POST" })
    .catch(() => {})
    .finally(() => {
      tvTurningOn = false;
      void fetchAllTv();
    });
}

function sendRemote(path) {
  const remoteDisabled =
    tvRelayOffline ||
    !tvConnected ||
    tvLoading ||
    tvTurningOff ||
    tvTurningOn;
  if (remoteDisabled) return;
  void fetchRes(path, { method: "POST" }).catch(() => {});
}

function handleSpeak() {
  const ta = $("speakText");
  const text = ta.value.trim();
  if (!text || pzOffline || speakSending) return;
  speakSending = true;
  renderPz();
  void fetchRes("/pretzel/speak", {
    method: "POST",
    body: JSON.stringify({ text }),
  })
    .then((r) => {
      if (r.ok) ta.value = "";
    })
    .catch(() => {})
    .finally(() => {
      speakSending = false;
      renderPz();
    });
}

function handleWeatherSpeak() {
  if (pzOffline || weatherSending) return;
  weatherSending = true;
  renderPz();
  const at = new Date().toISOString();
  void fetchRes("/pretzel/weather", {
    method: "POST",
    body: JSON.stringify({ requestedAt: at }),
  })
    .catch(() => {})
    .finally(() => {
      weatherSending = false;
      renderPz();
    });
}

function wire() {
  const tvVol = $("tvVol");
  tvVol.addEventListener("input", () => {
    tvLocalVolume = Number(tvVol.value);
    tvDragging = true;
    renderTv();
  });
  tvVol.addEventListener("mouseup", () => {
    tvDragging = false;
    commitTvVolume(Number(tvVol.value));
  });
  tvVol.addEventListener("touchend", () => {
    tvDragging = false;
    commitTvVolume(Number(tvVol.value));
  });

  $("tvMute").addEventListener("click", toggleTvMute);
  $("tvPowerOn").addEventListener("click", handlePowerOnClick);
  $("tvPowerOff").addEventListener("click", handlePowerOffClick);
  $("tvRefresh").addEventListener("click", () => {
    void fetchAllTv();
  });

  const pzVol = $("pzVol");
  pzVol.addEventListener("input", () => {
    pzLocalVolume = Number(pzVol.value);
    pzDragging = true;
    renderPz();
  });
  pzVol.addEventListener("mouseup", () => {
    pzDragging = false;
    commitPzVolume(Number(pzVol.value));
  });
  pzVol.addEventListener("touchend", () => {
    pzDragging = false;
    commitPzVolume(Number(pzVol.value));
  });

  $("pzRefresh").addEventListener("click", () => {
    void fetchPzVolume();
  });

  $("speakText").addEventListener("input", () => {
    $("speakText").value = $("speakText").value.slice(
      0,
      PRETZEL_SPEAK_MAX_CHARS,
    );
    renderPz();
  });

  $("speakBtn").addEventListener("click", handleSpeak);
  $("weatherBtn").addEventListener("click", handleWeatherSpeak);

  $("btnUp").addEventListener("click", () => sendRemote("/tv/up"));
  $("btnDown").addEventListener("click", () => sendRemote("/tv/down"));
  $("btnLeft").addEventListener("click", () => sendRemote("/tv/left"));
  $("btnRight").addEventListener("click", () => sendRemote("/tv/right"));
  $("btnEnter").addEventListener("click", () => sendRemote("/tv/enter"));
  $("btnHome").addEventListener("click", () => sendRemote("/tv/home"));
  $("btnBack").addEventListener("click", () => sendRemote("/tv/back"));
  $("btnSettings").addEventListener("click", () => sendRemote("/tv/settings"));
}

document.addEventListener("DOMContentLoaded", () => {
  $("tvPowerOn").title =
    "Wake-on-LAN and/or network turn-on (configure TV_WOL_MAC on the Pi)";
  wire();
  renderTv();
  renderPz();
  void fetchAllTv();
  void fetchPzVolume();
});
