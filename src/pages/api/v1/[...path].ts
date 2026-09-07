import type { APIRoute } from "astro";
import { CAN_API_ORIGIN, CAN_DB_ORIGIN, origin } from "@/lib/config";

export const prerender = false;

/**
 * 走白名单的 can-db 反代。
 *
 * ## 为什么有这一层
 *
 * 别的站上这一层的理由是 CORS：can-api 的 `ALLOWED_ORIGINS` 里没有它们的域，同源
 * 反代让它们今天就能跑。这里的理由一样，**而不是「更硬一层」** —— 这一段从前写着
 * 「can-db 在集群里根本没有 Ingress，浏览器不是最好别直连，是根本连不上」，于是这个
 * 文件是浏览器和那份数据之间唯一的通路。那句话是假的。
 *
 * can-db 从 2026-08-18 起就有 `api-db.ceruleanavi.net`（它的 `deploy/k8s.yaml` 里那
 * 条走 `cloudflare-tunnel` 的 Ingress），因为它真正要服务的消费者根本不在集群里 ——
 * 控制员机器上的桌面程序解析不了 ClusterIP。而且它的 `ALLOWED_ORIGINS` 恰恰就是
 * `https://database.ceruleanavi.net`，还带 `Access-Control-Allow-Credentials: true`：
 * 这个域下的浏览器**带着会话 cookie 直连它是通的**。这一层不是那份数据唯一的通路，
 * 从来都不是。
 *
 * 真正挡住人的是 can-db 自己的两样东西：`internal/httpx/server.go` 里每一条路由都套
 * 着的 `guard`（它解析会话、判 `aipAccess`；`/healthz` 是唯一一条没套的），加上那份
 * 不是通配的 CORS 白名单。今天一个字节都没漏出去，是因为**没有一条路由是裸的**，不
 * 是因为外面连不上。
 *
 * 这段话必须写成现在这样，理由不在这个文件里：一句「反正外面连不上」会让下一个在
 * can-db 那边加路由的人以为漏掉 `withRead`/`withWrite` 只是一处内部疏忽。它不是，它
 * 是公网泄漏。这一层的价值仍然在 —— 白名单把这个站的浏览器能碰到的路径收到它真的要
 * 用的那几条 —— 但它是**一层**，不是那道边界。
 *
 * ## 鉴权在哪
 *
 * 三处，各管各的，谁也不替谁：
 *
 *  1. 本站的中间件挡住没登录、没授权的人 —— 那是「页面给不给渲染」。
 *  2. 这一层挡住不在名单上的路径和方法 —— 那是「路径给不给转」。
 *  3. can-db 自己的 `guard` 判 `aipAccess` —— 那是「数据给不给」。
 *
 * 第三条是真正的边界。注意中间件对 `/api/` 前缀是放行的（否则一个 fetch 会被
 * 302 到登录页，岛屿拿到 HTML 再去 JSON.parse），所以一个没授权的成员**可以**直
 * 接打这些路径 —— 他会拿到 can-db 的 403。这正是设计：在这里再判一次 rating 或
 * access，就是第二份可能和上游不一致的判断，而不一致的时候症状会是「界面能开、
 * 接口 404」，比一个干脆的 403 难查得多。
 */

interface Allowed {
  methods: string[];
  /** 谁在用它 —— 没有这一句，以后没人敢删任何一条。 */
  who: string;
}

/** 精确匹配的路径。 */
const ALLOW_LIST: Record<string, Allowed> = {
  "aip/datasets": { methods: ["GET"], who: "Datasets.vue —— 周期与来源总览" },
  "aip/airports": { methods: ["GET"], who: "Airports.vue —— 机场清单" },
  "aip/fixes": {
    methods: ["GET"],
    who: "Fixes.vue —— 按 FIR 浏览航路点；NetworkMap.vue —— 选中 FIR 后的航路点图层",
  },
  "aip/route": {
    methods: ["GET"],
    who: "RoutePlanner.vue —— 航路生成器；规划在 can-db，这里只转发",
  },
  "aip/airways": {
    methods: ["GET"],
    who: "NetworkMap.vue —— 航路网图层（点开才取，取一次留着）",
  },
};

/**
 * 带一个动态段的路径。
 *
 * 正则是**收紧的**而不是 `.*`：四位字母数字，仅此而已。一个 `[^/]+` 就足以让
 * `aip/airports/../../datasets` 这类东西有讨论余地，而这里不给它机会。
 */
const ALLOW_PATTERNS: Array<Allowed & { test: RegExp }> = [
  {
    test: /^aip\/airports\/[A-Za-z0-9]{4}$/,
    methods: ["GET"],
    who: "AirportDetail.vue —— 一个机场的跑道、机位、进离场程序",
  },
  {
    // 子路径要**单独一条**：上面那条以 `$` 收尾，`.../ZSPD/ground` 不匹配它。
    // 漏了这条的症状很误导 —— 反代回 404，岛屿把它当成「这个机场没有地面数据」，
    // 于是每一个机场看起来都没有，而库里其实一条不少。
    test: /^aip\/airports\/[A-Za-z0-9]{4}\/ground$/,
    methods: ["GET"],
    who: "AirportMap.vue —— 地面要素与线画（勾上才取，一个大场一兆多）",
  },
];

function lookup(path: string): Allowed | undefined {
  return (
    ALLOW_LIST[path] ?? ALLOW_PATTERNS.find((entry) => entry.test.test(path))
  );
}

/**
 * 走 **can-api** 而不是 can-db 的那一条。
 *
 * 退出登录必须打 can-api：会话是它签的，清 cookie 也只能是它，一个属性对不上的
 * Set-Cookie 只会让浏览器同时留着两份。
 *
 * 单独一张表而不是在上面那张里加个字段，是为了让「这条转去哪」在读的时候一眼可
 * 见。两个上游混在一张表里，靠一个 `upstream: "api"` 字段区分，是那种加第三条时
 * 会填错的形状 —— 而填错的后果是把一个带着会话 cookie 的请求送到错误的服务上。
 */
const AUTH_PATHS: Record<string, Allowed> = {
  "auth/signout": { methods: ["POST"], who: "AppShell 退出登录" },
};

const UNSAFE = new Set(["POST", "PATCH", "PUT", "DELETE"]);

/**
 * 逐字转发的响应头。
 *
 * `set-cookie` **必须**在里面：退出登录是 can-api 用一个 Set-Cookie 清掉会话
 * 的，漏掉它成员就永远登不出去 —— 按钮有反应、页面跳转、然后他还是登录着。
 */
const PASS_THROUGH = ["content-type", "cache-control", "set-cookie"];

const handler: APIRoute = async (context) => {
  const rest = context.params.path ?? "";
  const authEntry = AUTH_PATHS[rest];
  const entry = authEntry ?? lookup(rest);

  if (!entry) {
    return Response.json(
      { error: "not_allowed", message: "该接口不在此站的转发白名单内。" },
      { status: 404 },
    );
  }

  const method = context.request.method.toUpperCase();
  if (!entry.methods.includes(method)) {
    return Response.json(
      { error: "method_not_allowed", message: "方法不被允许。" },
      { status: 405, headers: { allow: entry.methods.join(", ") } },
    );
  }

  // 写操作的 Origin 检查。Astro 的 checkOrigin 关掉了（反代下它永远误判，见
  // astro.config.mjs），这是补上的那一半。
  //
  // **头不在就是不通过，不是跳过检查。** 这里从前写的是 `if (sent && sent !== …)`，
  // 于是一个**不带** Origin 头的请求径直穿过去 —— 而那正是要防的那一类：CSRF 想要的
  // 就是让浏览器代替成员发一个请求，攻击者控制不了这个头，但一个不经浏览器的客户端
  // （或者哪天某个不发这个头的路径）就白拿一次放行。一道只在攻击者不方便时才生效的
  // 检查不是检查。
  //
  // **这只管不安全的方法，而那正好是浏览器一定带 Origin 的那一类。** 按 Fetch 规范，
  // 方法既不是 GET 也不是 HEAD 的请求一律带 Origin，**同源的也带** —— 所以把它改成必
  // 须匹配，不会伤到任何一个正常的 POST。反过来，GET 根本进不到这几行：同源导航和同
  // 源 GET 通常**不**带 Origin，要是这道检查也套在它们头上，整站每一次取数都是 403。
  // 所以 `UNSAFE` 这个集合不是修饰，它是这条检查能收紧的前提。
  //
  // 今天走到这里的写操作只有一条：`POST auth/signout`（转给 can-api）。can-db 那边
  // 已经有三条改数据集生命周期的路由（`POST /aip/datasets/{id}/activate` 一类，走
  // `withWrite`，也就是 `aipAccess >= 2`），这个站只是还没有调它们的界面 —— 加那天记
  // 得两样一起加：白名单条目的 methods，和一个真的会用它的页面。
  if (UNSAFE.has(method)) {
    const sent = context.request.headers.get("origin");
    if (sent !== origin()) {
      return Response.json(
        { error: "bad_origin", message: "跨站请求被拒绝。" },
        { status: 403 },
      );
    }
  }

  // 两个上游在这里交汇，而这是**唯一**一行在它们之间做选择的代码。这个文件其余
  // 部分都和上游无关，是刻意的。
  const upstreamOrigin = authEntry ? CAN_API_ORIGIN : CAN_DB_ORIGIN;
  const target = upstreamOrigin + "/api/v1/" + rest + context.url.search;

  // cookie 一定要带：can-db 靠它去 can-api 认人，没有它每一条都是 401。
  const headers = new Headers();
  const cookie = context.request.headers.get("cookie");
  if (cookie) headers.set("cookie", cookie);
  const contentType = context.request.headers.get("content-type");
  if (contentType) headers.set("content-type", contentType);

  // 写操作要把 Origin 带给 can-db。
  //
  // can-db 现在对不安全的方法查 Origin，而且**头不在就是拒绝**（它那边的
  // `sameOrigin` 中间件；活跃站点的 activate/supersede 不带 body 也不带自定义头，
  // 是 CORS 的简单请求，浏览器直接就发出去了，所以那是唯一挡得住的地方）。
  //
  // 而这一层是**服务端** fetch：它自己不会加 Origin。所以第一条转到 can-db 的写路
  // 由如果不带这个头，会稳定地拿到 403，而错误信息说的是「跨站请求被拒绝」——
  // 指向 CSRF，不指向这里少了一行。
  //
  // 带过去的就是上面刚验过的那一个（不匹配的早已 403 返回），也正是 can-db 的
  // `ALLOWED_ORIGINS` 里那一个。**只给 can-db 带** —— can-api 那条走的是签退，它
  // 的 CORS 名单是另一份，往上塞一个它没预期的头不属于这次改动。
  if (UNSAFE.has(method) && !authEntry) headers.set("origin", origin());

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method,
      headers,
      body:
        method === "GET" || method === "HEAD"
          ? undefined
          : context.request.body,
      ...(method === "GET" || method === "HEAD" ? {} : { duplex: "half" }),
      signal: AbortSignal.timeout(15_000),
    } as RequestInit);
  } catch (error) {
    console.error(
      `${authEntry ? "can-api" : "can-db"} ${rest} unreachable:`,
      error,
    );
    return Response.json(
      { error: "unreachable", message: "无法连接到资料库服务，请稍后再试。" },
      { status: 502 },
    );
  }

  const out = new Headers();
  for (const name of PASS_THROUGH) {
    const value = upstream.headers.get(name);
    if (value) out.set(name, value);
  }

  return new Response(upstream.body, { status: upstream.status, headers: out });
};

export const GET = handler;
export const POST = handler;
