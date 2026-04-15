export type FetchJsonResult = {
  ok: boolean;
  data: unknown;
  status: number;
};

export async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<FetchJsonResult> {
  const r = await fetch(url, {
    ...init,
    headers: {
      Accept: "application/json",
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
  return { ok: r.ok, data, status: r.status };
}
