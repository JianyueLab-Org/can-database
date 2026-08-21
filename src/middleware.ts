import { defineMiddleware } from "astro:middleware";
import { resolveSession } from "@/server/canApi";
import { canUseConsole, signInUrl } from "@/lib/config";

/**
 * 每个请求先问一次 can-api「你是谁、有没有资料库权限」。
 *
 * **整站要登录，而且整站要授权。** 这个站一页公开的都没有，将来也不该有：它显示
 * 的是有许可限制的航行资料，而「有哪些机场」本身就已经超出一个匿名访客该看到的
 * 范围。
 *
 * 门槛是 `canUseConsole(aipAccess)`，也就是 **2 或 4**，不是 `>= 1`。ADM 在
 * can-api 的 `user` 表上授予那一列，而它编码了两条轴：1/2 看公开数据、3/4 additionally
 * 看官方汇编（许可轴），**单数只能调用、双数才能访问**（用途轴）。见
 * `lib/config.ts` 里那张表。
 *
 * **改对之前这里是 `aipAccess >= 1`，于是 1 级打得开整个站。** 1 级的意思是「别
 * 的服务可以替他从接口取数」——can-portal 的 SweatBox 生成器、EFB、雷达都是这么用
 * 的 —— 不是「他自己可以对着整库翻」。两者要的信任不一样。
 *
 * 它和评级（rating）是两条独立的轴 —— 一个校对航图的人可能一个管制评级都没有，一
 * 个 ADM 也未必该编辑程序编码。**教员评级不开这道门**：教员走的是「调用」那条路
 * （can-db 的 `CanRead` 放他们过），进站仍然要 `aipAccess` 是 2 或 4。
 *
 * ## 这一次，「便利不是边界」这句话要反过来读
 *
 * 别的站上这句话的意思是：中间件挡人只是为了不让人看见点下去必然 403 的链接，真
 * 正的判断在 can-api。这里那半句仍然成立 —— can-db 的每一条路由自己也判
 * `aipAccess`，`internal/httpx/server.go` 的 `guard` 就是它。
 *
 * 但这里多了一件事：**这个站自己也是数据的一部分**。页面是服务端渲染的，机场清
 * 单在 HTML 里就是明文。所以这道门不只是「别让他看见入口」，它同时是「别把资料
 * 渲染给他」。把这个数字改小，泄漏的是数据本身，不是几个 403 链接。
 */

/**
 * 不问会话、也不重定向的两条路径。
 *
 * - `/api/` 是本站的反代，它自己有白名单，而且它的调用方要的是状态码不是 302 ——
 *   把一个 fetch 重定向到登录页，岛屿拿到的会是一段 HTML，然后它会试着把
 *   `<!doctype html>` 当 JSON 解析。
 * - `/healthz` 是探活：它必须能在 can-api 挂掉时照样回 200，否则上游一抖
 *   kubelet 就会把这边的 Pod 一起滚掉。
 */
function isUnguarded(pathname: string): boolean {
  return pathname.startsWith("/api/") || pathname === "/healthz";
}

export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;

  if (isUnguarded(pathname)) {
    context.locals.user = null;
    return withSecurityHeaders(await next());
  }

  const user = await resolveSession(context);
  context.locals.user = user;

  if (!user) {
    return withSecurityHeaders(context.redirect(signInUrl(context.url)));
  }

  // 登录了但没被授权的人，**不重定向** —— 送去 /denied，一张说明该找谁的页面。
  //
  // 这和 can-portal 的做法不同（那边把不够格的人送回主站的飞行员面板），而区别是
  // 有理由的：一个点开 /instr/roster 的普通飞行员多半是点错了，送他回自己的地方
  // 是对的；而一个点开 database.ceruleanavi.net 的人几乎一定是**被告知**这里有东
  // 西要看的，把他弹走只会让他再点一次。他需要的是一句「找 ADM 开权限」。
  if (!canUseConsole(user.aipAccess) && pathname !== "/denied") {
    return withSecurityHeaders(context.redirect("/denied"));
  }

  // 反过来：已经有权限的人不该停在那张页面上。
  if (canUseConsole(user.aipAccess) && pathname === "/denied") {
    return withSecurityHeaders(context.redirect("/"));
  }

  return withSecurityHeaders(await next());
});

/**
 * 和几个兄弟站一致的安全头。
 *
 * 用函数包一层而不是在 `next()` 之后就地设置：上面那几个重定向是提前返回的，内联
 * 写法会让它们成为仅有的什么头都没有的响应 —— can-web 正是被这一条咬过。
 */
function withSecurityHeaders(response: Response): Response {
  response.headers.set("X-Frame-Options", "DENY");
  response.headers.set("X-Content-Type-Options", "nosniff");
  response.headers.set("Referrer-Policy", "origin-when-cross-origin");
  return response;
}
