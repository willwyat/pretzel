import { useCallback, useEffect, useState } from "react";

const SETTINGS_PASSCODE = "Asdf1234";
const SESSION_UNLOCK_KEY = "pretzel_settings_unlocked";

type ServiceStamp = {
  activeEnterTimestamp: string | null;
  activeEnterTimestampIso: string | null;
  error?: string;
};

type AdminStatusBody = {
  ok: boolean;
  services?: {
    pretzelServer: ServiceStamp;
    tvRelay: ServiceStamp;
    /** Present after pretzel-server exposes `systemctl` for remote-ui.service */
    remoteUi?: ServiceStamp;
  };
  error?: string;
};

type RebuildStatus = {
  state: "idle" | "running" | "done" | "failed";
  step: string | null;
  error: string | null;
  logTail?: string[];
};

const POLL_MS = 2_000;
const RESTART_WAIT_MS = 60_000;
/** npm ci + vite build on the Pi can take several minutes. */
const REBUILD_WAIT_MS = 20 * 60_000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function formatWhen(iso: string | null, raw: string | null) {
  if (iso) {
    try {
      return new Intl.DateTimeFormat(undefined, {
        dateStyle: "medium",
        timeStyle: "short",
      }).format(new Date(iso));
    } catch {
      /* fall through */
    }
  }
  return raw || "—";
}

function ServiceRow({
  name,
  stamp,
}: {
  name: string;
  stamp: ServiceStamp | undefined;
}) {
  const led = stamp?.error
    ? "pretzel-led--warn"
    : stamp?.activeEnterTimestampIso || stamp?.activeEnterTimestamp
      ? "pretzel-led--ok"
      : "";
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-1">
      <span className={`pretzel-led ${led}`} aria-hidden />
      <span className="pretzel-text-group-label min-w-[7.5rem]">{name}</span>
      <span className="pretzel-readout text-xs">
        {formatWhen(
          stamp?.activeEnterTimestampIso ?? null,
          stamp?.activeEnterTimestamp ?? null,
        )}
      </span>
      {stamp?.error ? (
        <span className="pretzel-text-warn w-full text-xs">{stamp.error}</span>
      ) : null}
    </li>
  );
}

async function adminFetchJson(
  path: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; data: unknown }> {
  const r = await fetch(path, {
    ...init,
    headers: {
      Accept: "application/json",
      "X-Pretzel-Settings-Passcode": SETTINGS_PASSCODE,
      ...(init?.body ? { "Content-Type": "application/json" } : {}),
      ...init?.headers,
    },
  });
  const ct = r.headers.get("content-type") || "";
  let data: unknown = {};
  if (ct.includes("application/json")) {
    try {
      data = await r.json();
    } catch {
      data = {};
    }
  }
  return { ok: r.ok, status: r.status, data };
}

export function SettingsSection() {
  const [unlocked, setUnlocked] = useState(false);
  const [passInput, setPassInput] = useState("");
  const [unlockError, setUnlockError] = useState(false);

  const [statusLoading, setStatusLoading] = useState(false);
  const [statusBody, setStatusBody] = useState<AdminStatusBody | null>(null);

  const [gitBusy, setGitBusy] = useState(false);
  const [gitMessage, setGitMessage] = useState<string | null>(null);
  const [lastPull, setLastPull] = useState<{
    commit: string;
    pulledAt: string;
  } | null>(null);

  const [restartBusy, setRestartBusy] = useState<
    "pretzel" | "tv" | "ui" | "rebuild" | null
  >(null);
  const [rebuildLog, setRebuildLog] = useState<string[] | null>(null);
  const [reloadReady, setReloadReady] = useState(false);

  useEffect(() => {
    try {
      if (sessionStorage.getItem(SESSION_UNLOCK_KEY) === "1") {
        setUnlocked(true);
      }
    } catch {
      /* private mode */
    }
  }, []);

  const loadStatus = useCallback(async () => {
    setStatusLoading(true);
    try {
      const res = await adminFetchJson("/pretzel/admin/status");
      setStatusBody(res.data as AdminStatusBody);
    } catch {
      setStatusBody({ ok: false, error: "Network error" });
    } finally {
      setStatusLoading(false);
    }
  }, []);

  useEffect(() => {
    if (unlocked) void loadStatus();
  }, [unlocked, loadStatus]);

  const tryUnlock = () => {
    if (passInput === SETTINGS_PASSCODE) {
      setUnlockError(false);
      setUnlocked(true);
      try {
        sessionStorage.setItem(SESSION_UNLOCK_KEY, "1");
      } catch {
        /* ignore */
      }
      setPassInput("");
    } else {
      setUnlockError(true);
    }
  };

  const lock = () => {
    setUnlocked(false);
    try {
      sessionStorage.removeItem(SESSION_UNLOCK_KEY);
    } catch {
      /* ignore */
    }
  };

  const shortSha = (sha: string) =>
    sha.length > 7 ? sha.slice(0, 7) : sha;

  const handleGitPull = async () => {
    setGitBusy(true);
    setGitMessage(null);
    try {
      const res = await adminFetchJson("/pretzel/admin/git-pull", {
        method: "POST",
      });
      const d = res.data as {
        ok?: boolean;
        commit?: string;
        pulledAt?: string;
        error?: string;
      };
      if (res.ok && d.ok && d.commit && d.pulledAt) {
        setLastPull({ commit: d.commit, pulledAt: d.pulledAt });
        setGitMessage(
          `Pulled ${shortSha(d.commit)} at ${formatWhen(d.pulledAt, d.pulledAt)}`,
        );
      } else {
        setGitMessage(d.error || `Failed (${res.status})`);
      }
    } catch {
      setGitMessage("Network error");
    } finally {
      setGitBusy(false);
    }
  };

  const handleRestartPretzel = async () => {
    setRestartBusy("pretzel");
    setGitMessage(null);
    try {
      const res = await adminFetchJson("/pretzel/admin/restart/pretzel-server", {
        method: "POST",
      });
      const d = res.data as { message?: string; error?: string };
      if (res.ok) {
        setGitMessage(d.message || "Restart sent.");
      } else {
        setGitMessage(d.error || `Restart failed (${res.status})`);
      }
    } catch {
      setGitMessage("Network error (server may be restarting)");
    } finally {
      setRestartBusy(null);
    }
  };

  const handleRestartTv = async () => {
    setRestartBusy("tv");
    setGitMessage(null);
    try {
      const res = await adminFetchJson("/pretzel/admin/restart/tv-relay", {
        method: "POST",
      });
      const d = res.data as { message?: string; error?: string };
      if (res.ok) {
        setGitMessage(d.message || "tv-relay restarted.");
        await loadStatus();
      } else {
        setGitMessage(d.error || `Restart failed (${res.status})`);
      }
    } catch {
      setGitMessage("Network error");
    } finally {
      setRestartBusy(null);
    }
  };

  /** Wait for remote-ui's systemd start time to move past `before`; network errors are expected mid-restart. */
  const waitForRemoteUiRestart = async (before: string | null) => {
    const deadline = Date.now() + RESTART_WAIT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      try {
        const res = await adminFetchJson("/pretzel/admin/status");
        const body = res.data as AdminStatusBody;
        const now = body.services?.remoteUi?.activeEnterTimestampIso ?? null;
        if (res.ok && body.ok && now && now !== before) {
          setStatusBody(body);
          return true;
        }
      } catch {
        /* remote-ui restarting */
      }
    }
    return false;
  };

  const finishRemoteUiRestart = async (before: string | null) => {
    setGitMessage("Waiting for remote-ui to come back…");
    const back = await waitForRemoteUiRestart(before);
    setGitMessage(
      back
        ? "remote-ui restarted. Reload to use the new version."
        : "remote-ui did not report a new start time. Check journalctl -u remote-ui.",
    );
    setReloadReady(back);
  };

  const handleRestartUi = async () => {
    setRestartBusy("ui");
    setGitMessage(null);
    setRebuildLog(null);
    setReloadReady(false);
    const before = ui?.activeEnterTimestampIso ?? null;
    try {
      const res = await adminFetchJson("/pretzel/admin/restart/remote-ui", {
        method: "POST",
      });
      const d = res.data as { error?: string };
      if (!res.ok) {
        setGitMessage(d.error || `Restart failed (${res.status})`);
        return;
      }
    } catch {
      /* connection may drop as remote-ui goes down */
    }
    try {
      await finishRemoteUiRestart(before);
    } finally {
      setRestartBusy(null);
    }
  };

  const handleRebuildUi = async () => {
    setRestartBusy("rebuild");
    setGitMessage(null);
    setRebuildLog(null);
    setReloadReady(false);
    const before = ui?.activeEnterTimestampIso ?? null;
    try {
      const start = await adminFetchJson("/pretzel/admin/rebuild/remote-ui", {
        method: "POST",
      });
      const s = start.data as RebuildStatus & { error?: string };
      if (!start.ok && start.status !== 409) {
        setGitMessage(s.error || `Rebuild failed to start (${start.status})`);
        return;
      }
      let job: RebuildStatus | null = null;
      const deadline = Date.now() + REBUILD_WAIT_MS;
      while (Date.now() < deadline) {
        try {
          const res = await adminFetchJson("/pretzel/admin/rebuild/remote-ui");
          if (res.ok) {
            job = res.data as RebuildStatus;
            if (job.state !== "running") break;
            setGitMessage(`Rebuilding remote-ui: ${job.step ?? "…"}`);
          }
        } catch {
          /* proxy blip; keep polling */
        }
        await sleep(POLL_MS);
      }
      if (job?.state === "failed") {
        setGitMessage(`Rebuild failed at ${job.step}: ${job.error ?? "unknown error"}`);
        setRebuildLog(job.logTail ?? []);
        return;
      }
      if (job?.state !== "done") {
        // Restart already happened if the last poll was lost to it.
        if (job?.step !== "restart") {
          setGitMessage("Rebuild is taking too long; check status again later.");
          return;
        }
      }
      await finishRemoteUiRestart(before);
    } finally {
      setRestartBusy(null);
    }
  };

  const ps = statusBody?.services?.pretzelServer;
  const tv = statusBody?.services?.tvRelay;
  const ui = statusBody?.services?.remoteUi;

  return (
    <section className="pretzel-panel">
      <div className="pretzel-panel__header">
        <div>
          <h2 className="pretzel-text-panel-title">Settings</h2>
          <p className="pretzel-text-panel-subtle mt-1">
            Operator tools (same Wi‑Fi). Passcode required.
          </p>
        </div>
        {unlocked && (
          <button type="button" onClick={lock} className="pretzel-btn-ghost">
            Lock
          </button>
        )}
      </div>

      <div className="pretzel-panel__body">
        {!unlocked ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label
                htmlFor="settings-pass"
                className="pretzel-text-panel-muted mb-1 block text-xs font-medium"
              >
                Passcode
              </label>
              <input
                id="settings-pass"
                type="password"
                autoComplete="off"
                value={passInput}
                onChange={(e) => {
                  setPassInput(e.target.value);
                  setUnlockError(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Enter") tryUnlock();
                }}
                className="pretzel-input"
              />
              {unlockError && (
                <p className="pretzel-text-alert mt-1 text-xs">Incorrect passcode.</p>
              )}
            </div>
            <button
              type="button"
              onClick={tryUnlock}
              className="pretzel-btn-secondary pretzel-key--accent px-5"
            >
              Unlock
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="pretzel-nested-card">
              <p className="pretzel-text-group-label">
                Last service start (systemd)
              </p>
              {statusLoading && (
                <p className="pretzel-text-panel-body mt-2">Loading status…</p>
              )}
              {!statusLoading && statusBody && !statusBody.ok && (
                <p className="pretzel-text-alert mt-2 text-sm">
                  {statusBody.error || "Could not load status."}
                </p>
              )}
              {!statusLoading && statusBody?.ok && statusBody.services && (
                <ul className="mt-3 space-y-2.5">
                  <ServiceRow name="pretzel-server" stamp={ps} />
                  <ServiceRow name="tv-relay" stamp={tv} />
                  <ServiceRow name="remote-ui" stamp={ui} />
                </ul>
              )}
              <button
                type="button"
                onClick={() => void loadStatus()}
                disabled={statusLoading}
                className="pretzel-btn-ghost pretzel-btn-ghost--sm mt-3"
              >
                Refresh status
              </button>
            </div>

            {lastPull && (
              <p className="pretzel-text-panel-muted text-xs">
                Last pull:{" "}
                <span className="font-mono pretzel-text-panel-title">
                  {shortSha(lastPull.commit)}
                </span>{" "}
                at {formatWhen(lastPull.pulledAt, lastPull.pulledAt)}
              </p>
            )}

            {gitMessage && (
              <p className="pretzel-text-panel-body" aria-live="polite">
                {gitMessage}
              </p>
            )}

            {reloadReady && (
              <button
                type="button"
                onClick={() => window.location.reload()}
                className="pretzel-btn-secondary pretzel-key--accent"
              >
                Reload page
              </button>
            )}

            {rebuildLog && rebuildLog.length > 0 && (
              <details className="pretzel-nested-card">
                <summary className="pretzel-text-panel-muted cursor-pointer text-xs font-medium">
                  Build log (last {rebuildLog.length} lines)
                </summary>
                <pre className="pretzel-readout mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[11px] leading-snug">
                  {rebuildLog.join("\n")}
                </pre>
              </details>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                disabled={gitBusy || restartBusy !== null}
                onClick={() => void handleGitPull()}
                className="pretzel-btn-secondary disabled:cursor-not-allowed"
              >
                {gitBusy ? "Pulling…" : "Git pull"}
              </button>
              <button
                type="button"
                disabled={restartBusy !== null || gitBusy}
                onClick={() => void handleRebuildUi()}
                className="pretzel-btn-secondary pretzel-key--accent"
              >
                {restartBusy === "rebuild" ? "Rebuilding…" : "Rebuild remote-ui"}
              </button>
              <button
                type="button"
                disabled={restartBusy !== null || gitBusy}
                onClick={() => void handleRestartPretzel()}
                className="pretzel-btn-secondary pretzel-key--danger"
              >
                {restartBusy === "pretzel" ? "Restarting…" : "Restart pretzel-server"}
              </button>
              <button
                type="button"
                disabled={restartBusy !== null || gitBusy}
                onClick={() => void handleRestartTv()}
                className="pretzel-btn-secondary pretzel-key--danger"
              >
                {restartBusy === "tv" ? "Restarting…" : "Restart tv-relay"}
              </button>
              <button
                type="button"
                disabled={restartBusy !== null || gitBusy}
                onClick={() => void handleRestartUi()}
                className="pretzel-btn-secondary pretzel-key--danger"
              >
                {restartBusy === "ui" ? "Restarting…" : "Restart remote-ui"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
