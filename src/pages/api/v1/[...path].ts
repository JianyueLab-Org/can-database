import type { APIRoute } from "astro";
import { CAN_API_ORIGIN, CAN_DB_ORIGIN, origin } from "@/lib/config";

export const prerender = false;

/**
 * 走白名单的 can-db 反代。
 *
 * ## 为什么有这一层
 *
 * 别的站上这一层的理由是 CORS：can-api 的 `ALLOWED_ORIGINS` 里没有它们的域，同源
 * 反代让它们今天就能跑。这里的理由更硬一层：**can-db 在集群里根本没有 Ingress**。
 * 它服务的是有许可限制的航行资料，而唯一需要它的就是这个站，所以它只在集群内监
 * 听。浏览器不是「最好别直连」，是根本连不上。
 *
 * 于是这个文件是浏览器和那份数据之间**唯一**的通路，值得按那个分量来读。
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
  // astro.config.mjs），这是补上的那一半。今天名单里一条写操作都没有 —— 编辑功能
  // 还没做 —— 但这几行现在就写着，因为第一条写路径加进来的那天，谁也不会记得回来
  // 补它。
  if (UNSAFE.has(method)) {
    const sent = context.request.headers.get("origin");
    if (sent && sent !== origin()) {
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
