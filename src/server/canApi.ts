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

/** 请求所属的成员，没登录是 null。 */
export interface SessionUser {
  username: string;
  name: string;
  email: string;
  rating: number;
  /** 资料库访问级别：0 无 / 1 只读 / 2 可编辑。由 ADM 授予。 */
  aipAccess: number;
}

/**
 * 向 can-api 解出调用者。
 *
 * `/api/v1/auth/session` 在没人登录时回的是 200 + `user: null`，不是 401 ——
 * 「没登录」在公开页面上是预期状态而不是错误。所以这里对「没登录」和「调用失败」
 * 都返回 null。
 *
 * 失败和登出不可区分是**安全的那个方向**：can-api 不可达时这个站把每个人都当成
 * 匿名访客，于是什么都不显示 —— 对一个放着有许可限制的资料的控制台，失败必须朝
 * 关闭的方向倒。
 *
 * `aipAccess` 每个请求重新读一次（can-api 那边也不信任 token 里的副本），所以
 * ADM 撤销权限会在这个人**下一次翻页**时生效，而不是等 30 天的 token 过期。
 */
export async function resolveSession(
  context: Pick<APIContext, "request">,
): Promise<SessionUser | null> {
  const cookie = context.request.headers.get("cookie");
  if (!cookie) return null;

  let response: Response;
  try {
    response = await fetch(`${CAN_API_ORIGIN}/api/v1/auth/session`, {
      headers: { cookie },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error("can-api unreachable:", error);
    return null;
  }

  if (!response.ok) return null;

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;
  const data = ("data" in body ? body.data : body) as
    { user?: SessionUser | null } | undefined;
  return data?.user ?? null;
}
