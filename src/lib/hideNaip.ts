/**
 * 「隐藏 NAIP 数据」：整个控制台一个开关。
 *
 * **默认开着**（和 can-portal 一致）：没有 cookie 就当开着，只有 `can_hide_naip=0` 才显示
 * NAIP。打开时，每一条发往 can-db 的**读**请求都带 `unrestricted=1`。can-db 对 3 级及以上把
 * 级别压到 2（不返回 NAIP），3 级以下是空转。值只有 `1`，别的值 can-db 回 400。
 *
 * **存在 cookie 里，不在 localStorage。** 这个站大部分数据是服务端渲染的
 * （`src/server/canDb.ts` 的 `callDb`），服务端读不到 localStorage。cookie 是唯一两边都
 * 读得到的地方，所以它是唯一的来源：浏览器写它，服务端和反代读它。
 *
 * 追加参数的地方只有两处，都调这里的 `applyHideNaip`：
 *
 * - `src/server/canDb.ts` —— 服务端渲染的页面。
 * - `src/pages/api/v1/[...path].ts` —— 岛屿的同源反代，只对 GET。导出的 ZIP 是原生表单
 *   GET，也走这里。
 *
 * **写界面不带。** 数据编辑器和修订记录（`/datasets/{id}/edit`、`/datasets/{id}/revisions`
 * 两页，以及 `aip/datasets/{id}/…` 下的全部路由）照原样读写：5 级要编辑的正是完整数据。
 *
 * 浏览器安全：不 import `src/server` 下的任何东西。
 */

export const HIDE_NAIP_COOKIE = "can_hide_naip";

/** 开关对谁显示：3 级及以上（控制台里是 4、5 级）。3 级以下 can-db 本来就不给 NAIP。 */
export const HIDE_NAIP_MIN_ACCESS = 3;

/**
 * 编辑器那一层的 can-db 路由：数据编辑器的行、修订记录、写操作，以及地面要素编辑器的
 * `ground/source` 和 `ground.json`（can-db 那边走 `withWrite`，压到 2 级就是 403）。
 */
const EDITOR_TARGET =
  /^\/api\/v1\/aip\/(datasets\/\d+\/|airports\/[A-Za-z0-9]{4}\/ground(\/source|\.json)$)/;

/** 数据编辑器那两页：它们的服务端读取也不带。 */
const EDITOR_PAGE = /^\/datasets\/\d+\/(edit|revisions)\/?$/;

/** 从一个 `Cookie` 请求头里读开关。默认开着：只有明确的 `0` 才算关。 */
export function hideNaipFromCookie(header: string | null | undefined): boolean {
  if (!header) return true;
  return !header
    .split(";")
    .some((part) => part.trim() === `${HIDE_NAIP_COOKIE}=0`);
}

/** 这一页是不是数据编辑器那两页之一。 */
export function isEditorPage(pathname: string): boolean {
  return EDITOR_PAGE.test(pathname);
}

/**
 * 给一个发往 can-db 的读请求地址加上 `unrestricted=1`。
 *
 * `target` 是完整地址（`http://…/api/v1/aip/…?…`）。`hide` 为假、或者目标是编辑器路由时
 * 原样返回。用 `set` 不用 `append`：同一个参数出现两次，can-db 读哪一个是它的事，不该
 * 让这里去赌。
 */
export function applyHideNaip(target: string, hide: boolean): string {
  if (!hide) return target;
  const url = new URL(target);
  if (EDITOR_TARGET.test(url.pathname)) return target;
  url.searchParams.set("unrestricted", "1");
  return url.toString();
}

/** 浏览器里读开关。拿不到 `document.cookie`（隐私设置、预览环境）就按默认值，开着。 */
export function readHideNaip(): boolean {
  try {
    return hideNaipFromCookie(document.cookie);
  } catch {
    return true;
  }
}

/**
 * 浏览器里写开关。只落在本站主机上（不设 Domain），一年有效。
 *
 * 写不进去时返回 false，调用方就不去刷新页面 —— 刷新了也还是旧的数据。
 */
export function writeHideNaip(on: boolean): boolean {
  try {
    const secure = window.location.protocol === "https:" ? "; Secure" : "";
    document.cookie = `${HIDE_NAIP_COOKIE}=${on ? "1" : "0"}; Path=/; Max-Age=31536000; SameSite=Lax${secure}`;
    return readHideNaip() === on;
  } catch {
    return false;
  }
}
