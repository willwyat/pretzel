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
  };
  error?: string;
};

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

  const [restartBusy, setRestartBusy] = useState<"pretzel" | "tv" | null>(null);

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

  const ps = statusBody?.services?.pretzelServer;
  const tv = statusBody?.services?.tvRelay;

  return (
    <section className="rounded-xl border border-gray-700 bg-gray-900">
      <div className="border-b border-gray-700 p-4">
        <div className="flex items-start justify-between gap-3">
          <div>
            <h2 className="text-base font-semibold text-gray-100">Settings</h2>
            <p className="mt-1 text-xs text-gray-500">
              Operator tools (same Wi‑Fi). Passcode required.
            </p>
          </div>
          {unlocked && (
            <button
              type="button"
              onClick={lock}
              className="flex-shrink-0 rounded-lg border border-gray-600 px-3 py-1.5 text-xs font-medium text-gray-300 transition hover:bg-gray-800"
            >
              Lock
            </button>
          )}
        </div>
      </div>

      <div className="p-4">
        {!unlocked ? (
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <div className="min-w-0 flex-1">
              <label
                htmlFor="settings-pass"
                className="mb-1 block text-xs font-medium text-gray-400"
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
                className="w-full rounded-lg border border-gray-600 bg-gray-950 px-3 py-2 text-sm text-gray-100 focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
              />
              {unlockError && (
                <p className="mt-1 text-xs text-red-400">Incorrect passcode.</p>
              )}
            </div>
            <button
              type="button"
              onClick={tryUnlock}
              className="rounded-lg border border-blue-600 bg-blue-700 px-4 py-2 text-sm font-medium text-white transition hover:bg-blue-600"
            >
              Unlock
            </button>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            <div className="rounded-lg border border-gray-600 bg-gray-950/80 p-3">
              <p className="text-xs font-medium text-gray-400">
                Last service start (systemd)
              </p>
              {statusLoading && (
                <p className="mt-2 text-sm text-gray-500">Loading status…</p>
              )}
              {!statusLoading && statusBody && !statusBody.ok && (
                <p className="mt-2 text-sm text-red-400">
                  {statusBody.error || "Could not load status."}
                </p>
              )}
              {!statusLoading && statusBody?.ok && statusBody.services && (
                <ul className="mt-2 space-y-2 text-sm text-gray-200">
                  <li>
                    <span className="text-gray-500">pretzel-server:</span>{" "}
                    {formatWhen(
                      ps?.activeEnterTimestampIso ?? null,
                      ps?.activeEnterTimestamp ?? null,
                    )}
                    {ps?.error ? (
                      <span className="text-amber-400"> ({ps.error})</span>
                    ) : null}
                  </li>
                  <li>
                    <span className="text-gray-500">tv-relay:</span>{" "}
                    {formatWhen(
                      tv?.activeEnterTimestampIso ?? null,
                      tv?.activeEnterTimestamp ?? null,
                    )}
                    {tv?.error ? (
                      <span className="text-amber-400"> ({tv.error})</span>
                    ) : null}
                  </li>
                </ul>
              )}
              <button
                type="button"
                onClick={() => void loadStatus()}
                disabled={statusLoading}
                className="mt-2 rounded border border-gray-600 px-2 py-1 text-xs text-gray-300 hover:bg-gray-800 disabled:opacity-50"
              >
                Refresh status
              </button>
            </div>

            {lastPull && (
              <p className="text-xs text-gray-400">
                Last pull:{" "}
                <span className="font-mono text-gray-200">
                  {shortSha(lastPull.commit)}
                </span>{" "}
                at {formatWhen(lastPull.pulledAt, lastPull.pulledAt)}
              </p>
            )}

            {gitMessage && (
              <p className="text-sm text-gray-300">{gitMessage}</p>
            )}

            <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap">
              <button
                type="button"
                disabled={gitBusy || restartBusy !== null}
                onClick={() => void handleGitPull()}
                className="rounded-lg border border-gray-600 bg-gray-800 px-3 py-2 text-sm font-medium text-gray-200 transition hover:bg-gray-700 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {gitBusy ? "Pulling…" : "Git pull"}
              </button>
              <button
                type="button"
                disabled={restartBusy !== null || gitBusy}
                onClick={() => void handleRestartPretzel()}
                className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-950/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {restartBusy === "pretzel" ? "Restarting…" : "Restart pretzel-server"}
              </button>
              <button
                type="button"
                disabled={restartBusy !== null || gitBusy}
                onClick={() => void handleRestartTv()}
                className="rounded-lg border border-amber-700/60 bg-amber-950/40 px-3 py-2 text-sm font-medium text-amber-100 transition hover:bg-amber-950/60 disabled:cursor-not-allowed disabled:opacity-50"
              >
                {restartBusy === "tv" ? "Restarting…" : "Restart tv-relay"}
              </button>
            </div>
          </div>
        )}
      </div>
    </section>
  );
}
