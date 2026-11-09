import type { APIRoute } from "astro";
import { health, healthResponse } from "@/server/health";

export const prerender = false;

/**
 * 给外部监控的健康检查：问 can-db 的 `/health`。不给探针用 —— 探针仍是 `/healthz`。
 * 中间件对它放行（`isUnguarded`）。
 */
export const GET: APIRoute = async () => healthResponse(await health());
