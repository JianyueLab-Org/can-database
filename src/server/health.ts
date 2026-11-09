import { CAN_DB_ORIGIN } from "@/lib/config";

export type HealthChecks = Record<string, string>;
export interface HealthResult {
  ok: boolean;
  checks: HealthChecks;
}

const CHECK_TIMEOUT_MS = 3_000;
const CACHE_MS = 10_000;

/** Calls an upstream `/health`; non-2xx or a network error is a failure. */
export async function checkUpstream(
  origin: string,
  fetchImpl: typeof fetch = fetch,
): Promise<string> {
  try {
    const res = await fetchImpl(origin + "/health", {
      signal: AbortSignal.timeout(CHECK_TIMEOUT_MS),
      headers: { accept: "application/json" },
    });
    return res.ok ? "ok" : `http ${res.status}`;
  } catch (err) {
    return err instanceof Error && err.name === "TimeoutError"
      ? "timeout"
      : "unreachable";
  }
}

/** Runs the checks at most once per CACHE_MS; concurrent callers share one run. */
export function createHealth(
  run: () => Promise<HealthChecks>,
  now: () => number = Date.now,
): () => Promise<HealthResult> {
  let cached: { at: number; result: HealthResult } | null = null;
  let inflight: Promise<HealthResult> | null = null;
  return () => {
    if (cached && now() - cached.at < CACHE_MS)
      return Promise.resolve(cached.result);
    inflight ??= run()
      .then((checks) => {
        const result = {
          ok: Object.values(checks).every((v) => v === "ok"),
          checks,
        };
        if (!result.ok) console.warn("health check failed", checks);
        cached = { at: now(), result };
        return result;
      })
      .finally(() => {
        inflight = null;
      });
    return inflight;
  };
}

export const health = createHealth(async () => ({
  "can-db": await checkUpstream(CAN_DB_ORIGIN),
}));

export function healthResponse(result: HealthResult): Response {
  return new Response(
    JSON.stringify({
      status: result.ok ? "ok" : "fail",
      checks: result.checks,
    }),
    {
      status: result.ok ? 200 : 503,
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    },
  );
}
