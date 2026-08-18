import type { APIContext } from "astro";
import { CAN_DB_ORIGIN } from "@/lib/config";

/**
 * 服务端调用 can-db。
 *
 * SSR 的时候没有浏览器替我们带 cookie，所以把进来的 `Cookie` 头**原样转发**过
 * 去 —— can-db 拿它去 can-api 认人，没有它每一条都是 401。
 *
 * 大部分页面走这条路而不是在岛屿里 fetch：这个站的读多写少，而一份服务端渲染好
 * 的表格比一个先显示骨架再自己去取的岛屿快一整个往返。需要交互的两页（机场搜索、
 * 航路点浏览）才用岛屿。
 *
 * **服务端专用**，它读请求头，绝不能被岛屿 import。
 */

const TIMEOUT_MS = 8_000;

export interface ServerResult<T> {
  ok: boolean;
  status: number;
  data: T | null;
  error?: string;
  message?: string;
}

export async function callDb<T = unknown>(
  context: Pick<APIContext, "request">,
  path: string,
): Promise<ServerResult<T>> {
  const headers: Record<string, string> = {};
  const cookie = context.request.headers.get("cookie");
  if (cookie) headers.cookie = cookie;

  let response: Response;
  try {
    response = await fetch(CAN_DB_ORIGIN + path, {
      headers,
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error(`can-db ${path} unreachable:`, error);
    return { ok: false, status: 0, data: null, error: "unreachable" };
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      data: null,
      error: String(body.error ?? "http_error"),
      message: typeof body.message === "string" ? body.message : undefined,
    };
  }

  const data = "data" in body ? body.data : body;
  return {
    ok: true,
    status: response.status,
    data: (data ?? null) as T | null,
  };
}
