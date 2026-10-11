import type { APIContext } from "astro";
import { CAN_API_ORIGIN } from "@/lib/config";

/**
 * 服务端向 can-api 解会话。
 *
 * 把进来的 `Cookie` 头**原样转发**过去再读回答案 —— 这个站不验签、不存密钥。
 * 和 can-portal / can-controller 的同名文件是同一件东西。
 *
 * **服务端专用**，它读请求头，绝不能被岛屿 import。
 */

const TIMEOUT_MS = 5_000;

/** The authenticated member returned by can-api. */
export interface SessionUser {
  username: string;
  name: string;
  email: string;
  rating: number;
  /**
   * 资料库访问级别：0 无权访问 / 1 可调用 / 2 可阅读 / 3 受限可调用 / 4 受限可阅读 /
   * 5 管理/编辑。由 ADM 授予，见 `lib/config.ts`。
   */
  aipAccess: number;
}

export type SessionOutcome =
  | { kind: "authenticated"; user: SessionUser }
  | { kind: "signed-out" }
  | { kind: "unavailable" };

/** Resolve permissions on every request. Failures do not imply signed-out. */
export async function resolveSession(
  context: Pick<APIContext, "request">,
): Promise<SessionOutcome> {
  const cookie = context.request.headers.get("cookie");
  if (!cookie) return { kind: "signed-out" };

  try {
    const response = await fetch(`${CAN_API_ORIGIN}/api/v1/auth/session`, {
      headers: { cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });

    // An authoritative 401 is signed-out regardless of its error body.
    if (response.status === 401) return { kind: "signed-out" };
    if (response.status !== 200) return { kind: "unavailable" };

    const body: unknown = await response.json();
    if (
      !isRecord(body) ||
      (Object.hasOwn(body, "status") && body.status !== 200)
    ) {
      return { kind: "unavailable" };
    }
    // Preserve both the documented top-level reply and the existing envelope.
    const data = Object.hasOwn(body, "data") ? body.data : body;
    if (!isRecord(data) || !Object.hasOwn(data, "user")) {
      return { kind: "unavailable" };
    }
    if (data.user === null) return { kind: "signed-out" };
    if (!isSessionUser(data.user)) return { kind: "unavailable" };
    return { kind: "authenticated", user: data.user };
  } catch {
    // Transport, timeout, body-read, and JSON failures remain fail-closed.
    return { kind: "unavailable" };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isSessionUser(value: unknown): value is SessionUser {
  return (
    isRecord(value) &&
    typeof value.username === "string" &&
    value.username.length > 0 &&
    typeof value.name === "string" &&
    typeof value.email === "string" &&
    typeof value.rating === "number" &&
    Number.isInteger(value.rating) &&
    value.rating >= 0 &&
    typeof value.aipAccess === "number" &&
    Number.isInteger(value.aipAccess) &&
    value.aipAccess >= 0 &&
    value.aipAccess <= 5
  );
}
