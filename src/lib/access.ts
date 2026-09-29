/**
 * 进控制台的门，和被拒时的原因。
 *
 * 门槛是 `canUseConsole(aipAccess)`（2、4 或 5），见 `lib/config.ts` 那张表。
 * 中间件按它决定是否渲染 `NoAccess`；`denied.astro` 把 `name` 换成当前语言的权限名。
 */
import type { NoAccessReason } from "@jianyuelab-org/can-ui";
import { canUseConsole } from "./config";

/** 中间件改写到的页面。直接打开它会被送回 `/`。 */
export const DENIED_PATH = "/denied";

export function consoleNoAccess(aipAccess: number): NoAccessReason | null {
  return canUseConsole(aipAccess)
    ? null
    : { kind: "permission", name: "aipAccess" };
}
