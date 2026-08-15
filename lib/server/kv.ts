/**
 * Minimal Vercel KV client (Upstash Redis REST API) — no SDK needed, works
 * from any Node serverless runtime. Reads KV_REST_API_URL / KV_REST_API_TOKEN,
 * the exact env vars Vercel injects when you attach a KV store to a project.
 */

const BASE_URL = process.env.KV_REST_API_URL;
const TOKEN = process.env.KV_REST_API_TOKEN;

export function kvConfigured(): boolean {
  return Boolean(BASE_URL && TOKEN);
}

async function kvFetch(path: string, init?: RequestInit): Promise<Record<string, unknown>> {
  const res = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      ...(init?.headers ?? {}),
    },
    cache: "no-store",
  });
  if (!res.ok) {
    throw new Error(`KV request failed (${res.status})`);
  }
  return (await res.json().catch(() => ({}))) as Record<string, unknown>;
}

/** GET /get/<key> — returns the stored string or null. */
export async function kvGetString(key: string): Promise<string | null> {
  const data = await kvFetch(`/get/${encodeURIComponent(key)}`);
  const result = data.result;
  return typeof result === "string" ? result : null;
}

/** POST /set/<key> with the raw value as the request body. */
export async function kvSetString(key: string, raw: string): Promise<void> {
  await kvFetch(`/set/${encodeURIComponent(key)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: raw,
  });
}

/** POST /del/<key>. */
export async function kvDelete(key: string): Promise<void> {
  await kvFetch(`/del/${encodeURIComponent(key)}`, { method: "POST" });
}
