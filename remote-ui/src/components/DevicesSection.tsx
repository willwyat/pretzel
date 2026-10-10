import { useCallback, useEffect, useState } from "react";

type Device = {
  ip: string;
  mac: string | null;
  /** Locally administered ("private Wi-Fi address"): changes per network / over time. */
  randomMac: boolean;
  hostname: string | null;
  state: string;
  online: boolean;
  isSelf: boolean;
  label: string | null;
};

type FetchAdmin = (
  path: string,
) => Promise<{ ok: boolean; status: number; data: unknown }>;

export function DevicesSection({ fetchAdmin }: { fetchAdmin: FetchAdmin }) {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [subnet, setSubnet] = useState<{ iface: string; cidr: string } | null>(null);
  const [scannedAt, setScannedAt] = useState<number | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(
    async (refresh: boolean) => {
      setBusy(true);
      setError(null);
      try {
        const r = await fetchAdmin(`/pretzel/admin/devices${refresh ? "?refresh=1" : ""}`);
        const d = r.data as {
          ok?: boolean;
          error?: string;
          devices?: Device[];
          subnet?: { iface: string; cidr: string } | null;
          scannedAt?: number;
        };
        if (!r.ok || !d.devices) throw new Error(d.error || `HTTP ${r.status}`);
        setDevices(d.devices);
        setSubnet(d.subnet ?? null);
        setScannedAt(d.scannedAt ?? null);
      } catch (e) {
        setError(e instanceof Error ? e.message : "Scan failed");
      } finally {
        setBusy(false);
      }
    },
    [fetchAdmin],
  );

  useEffect(() => {
    void load(false);
  }, [load]);

  return (
    <section className="pretzel-panel mt-6">
      <div className="pretzel-panel__header">
        <div>
          <h2 className="pretzel-text-panel-title">Network devices</h2>
          <p className="pretzel-text-panel-subtle mt-1">
            Devices answering on the Pi's LAN{subnet ? ` (${subnet.cidr} via ${subnet.iface})` : ""}.
            Sleeping devices may be missing.
            {scannedAt ? ` Scanned ${new Date(scannedAt).toLocaleTimeString()}.` : ""}
          </p>
        </div>
        <button
          type="button"
          disabled={busy}
          onClick={() => void load(true)}
          className="pretzel-btn-ghost"
        >
          {busy ? "Scanning…" : "Rescan"}
        </button>
      </div>
      <div className="pretzel-panel__body">
        {error ? <p className="pretzel-text-warn text-sm">{error}</p> : null}
        {devices === null && !error ? (
          <p className="pretzel-text-panel-muted text-sm">Scanning the network… (a few seconds)</p>
        ) : null}
        {devices ? (
          <ul className="flex flex-col gap-2">
            {devices.map((d) => (
              <li key={d.ip} className="pretzel-nested-card flex flex-wrap items-center gap-x-3 gap-y-1">
                <span className={`pretzel-led ${d.online ? "pretzel-led--ok" : "pretzel-led--warn"}`} aria-hidden />
                <span className="pretzel-readout text-xs min-w-[7.5rem]">{d.ip}</span>
                <span className="pretzel-text-group-label min-w-0 flex-1 truncate">
                  {d.label ?? d.hostname ?? "Unknown device"}
                </span>
                <span className="pretzel-text-panel-muted w-full font-mono text-xs">
                  {d.mac ?? "—"}
                  {d.randomMac ? " (private)" : ""} · {d.state.toLowerCase()}
                  {d.label && d.hostname ? ` · ${d.hostname}` : ""}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
    </section>
  );
}
