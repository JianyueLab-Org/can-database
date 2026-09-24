/**
 * 这个站要知道的四个地址，集中在一处。
 *
 * 和 can-portal / can-controller / can-efb 的同名文件几乎一样，是有意抄的而不是
 * 抽包共用：几个站各自部署、各自有自己的默认值，绑成一个包意味着改一个站的默认
 * 端口会顺手改掉另一个的。
 */

function clean(value: string | undefined): string {
  return (value || "").replace(/\/+$/, "");
}

/**
 * can-db 的 API。**用集群内地址，即使它现在有公网主机名了。**
 *
 * can-db 从 2026-08-18 起有了 `api-db.ceruleanavi.net`，但这里仍然指
 * `app.can-db.svc.cluster.local`（线上由部署清单注入）。那条公网地址是给**集群外**
 * 的消费者用的 —— can-atc 是控制员机器上的桌面程序，解析不了 ClusterIP。这个站和
 * can-db 在同一个集群里，走 Service 少一跳，而且不会因为 Cloudflare 隧道抖一下就连
 * 自己的后端都读不到。
 *
 * 这个站的岛屿只打本站的同源反代（`src/pages/api/v1/[...path].ts`），由反代转进集
 * 群。**但别把它读成「浏览器无论如何打不到 can-db」** —— 这一段从前就是那么写的，而
 * `api-db.ceruleanavi.net` 是公网可达的，can-db 的 CORS 白名单里还正好有这个域。挡
 * 住人的是 can-db 每条路由上的 `guard`，不是网络可达性；那一层的完整说明在反代文件
 * 的抬头。
 *
 * 兜底值是 `localhost:8080` 而不是某个 https 地址：本地开发时你自己起一个 can-db。
 * 写一个公网地址当兜底会让「忘了配」这件事悄悄变成「打到了别的东西上」。
 */
export const CAN_DB_ORIGIN =
  clean(process.env.CAN_DB_ORIGIN) || "http://127.0.0.1:8080";

/**
 * can-api 的 origin。会话在那边解，权限也在那边读。
 *
 * 这个站自己不验会话 cookie，也不该验：签名密钥只有一份，多一个验证方就多一处
 * 可能对「你是谁」给出不同答案的地方。
 */
export const CAN_API_ORIGIN =
  clean(process.env.CAN_API_ORIGIN) ||
  clean(import.meta.env.PUBLIC_CAN_API_ORIGIN) ||
  "https://api.ceruleanavi.net";

/** can-web 的 origin。只用来把没登录的人送去登录页。 */
export const CAN_WEB_ORIGIN =
  clean(process.env.CAN_WEB_ORIGIN) ||
  clean(import.meta.env.PUBLIC_CAN_WEB_ORIGIN) ||
  "https://ceruleanavi.net";

/**
 * 本站自己的 origin，写操作的 Origin 头要和它比对。
 *
 * 必须是**显式配置**的值，不能从 `Host` 头推：反代后面推出来的是 `http://`，
 * 浏览器发的是 `https://`，永远对不上。
 */
export function origin(): string {
  return (
    clean(process.env.PUBLIC_ORIGIN) ||
    clean(import.meta.env.PUBLIC_ORIGIN) ||
    "https://database.ceruleanavi.net"
  );
}

/**
 * 登录去哪儿。
 *
 * **现在带 callbackUrl 了。** 从前这里写着「不带」，理由是 can-web 的 `/signin`
 * 只接受站内绝对路径 —— 那是一道防开放重定向的检查，把跨站地址传过去只会被丢
 * 掉、回落到 `/pilots`，于是成员登录完停在主站还得自己走回来。
 *
 * can-web 现在有一份显式白名单（`src/lib/callbackUrl.ts`，配一套只测「必须被拒
 * 的输入」的测试），这个域在名单上。
 */
export function signInUrl(returnTo?: URL): string {
  const base = `${CAN_WEB_ORIGIN}/signin`;
  if (!returnTo) return base;
  // 用 origin() 而不是 returnTo.origin：这个站跑在 TLS 终止的反代后面，请求 URL
  // 的 origin 推出来是 http://，那既配不上 can-web 白名单里的 https://（于是被
  // 拒、回落 /pilots，白做一场），也会把成员从 https 降到 http。
  //
  // 片段（#...）不带：它本来就不会发到服务端。
  const target = `${origin()}${returnTo.pathname}${returnTo.search}`;
  return `${base}?callbackUrl=${encodeURIComponent(target)}`;
}

/** 主站上某个页面的绝对地址。 */
export function webUrl(path: string): string {
  return `${CAN_WEB_ORIGIN}${path}`;
}

/**
 * 资料库访问级别，和 can-api 的 `aipAccess` 列对齐。
 *
 * 抄一份而不是共享，理由和 can-db 的 `internal/session` 里那份一样：两个仓库各自
 * 发布，共享模块会把它们的发布节奏绑在一起。can-api 的 `aipaccess_test.go` 专门
 * 把这几个数字钉死，就是为了让这些副本敢依赖它们。
 *
 * ## 一个数字，两条轴，外加一档管理
 *
 * | 级别 | 名称       | 许可轴（哪一批数据） | 用途轴（怎么用）       |
 * | ---- | ---------- | -------------------- | ---------------------- |
 * | 0    | 无权访问   | ——                   | ——                     |
 * | 1    | 可调用     | 公开数据             | **调用** —— 接口取数   |
 * | 2    | 可阅读     | 公开数据             | 调用 + **进控制台**    |
 * | 3    | 受限可调用 | 公开 + 官方汇编      | 调用                   |
 * | 4    | 受限可阅读 | 公开 + 官方汇编      | 调用 + 进控制台        |
 * | 5    | 管理/编辑  | 全部                 | 全部，包括所有写操作   |
 *
 * **许可轴累积，1–4 的用途轴看奇偶。** 前者让 can-db 那边 `min_access <= can_access()`
 * 一条比较成立：3 级看得到门槛 1 和门槛 3 的东西，5 级看得到一切。后者不是 ——
 * **3 比 2 大，但 3 只能调用而 2 进得了控制台**。
 *
 * **5 级在奇偶规则之外。** 它是奇数，却进得了控制台；它也是唯一的写权限档。
 *
 * 「调用」是别的服务替成员取数（can-portal 的 SweatBox 生成器、EFB、雷达都走接口）；
 * 「阅读」是这个人自己打开这个站翻。
 */
export const ACCESS_NONE = 0;
export const ACCESS_CALL = 1;
export const ACCESS_BROWSE = 2;
export const ACCESS_RESTRICTED_CALL = 3;
export const ACCESS_RESTRICTED_BROWSE = 4;
export const ACCESS_MANAGE = 5;

/**
 * 这个人能不能打开资料库本身：2、4、5 级。
 *
 * **必须列举，不能比大小。** 写成 `aipAccess >= ACCESS_BROWSE` 会把 3 级放进来，
 * 而 3 是「受限可调用」—— 它的数字比 2 大（许可轴上它确实在 2 之上，看得到官方
 * 汇编），用途轴上却在 2 之下。这不是笔误，是一个数字编码两件事的必然结果。
 *
 * 这一条从前就是错的：中间件拦的是 `aipAccess < 1`，也就是 `>= 1` 就放进来，于是
 * 1 级（只该**调用**）打得开整个站。
 *
 * **上游没有这条规则的权威副本。** can-db 没有 session 路由；它把成员的 cookie
 * **原样转给 can-api** 的 `GET /api/v1/auth/session`，拿回 `rating` 和 `aipAccess`
 * （`internal/session`），自己只判 `CanRead()`（调用那一侧，教员评级也放）和
 * `CanWrite()`（`withWrite` 用的写门槛）。所以这一条是**这个站自己的门槛**，改它就是
 * 改谁能打开这个站，而进得来的人拿到的是渲染在 HTML 里的航行资料。
 *
 * 这里抄一份是因为中间件手上**已经有** `aipAccess` 了，而这条规则是它的纯函数 ——
 * 为了算一个已经拿得到的东西给每个页面请求加一次网络往返，不划算。
 */
export function canUseConsole(aipAccess: number): boolean {
  return (
    aipAccess === ACCESS_BROWSE ||
    aipAccess === ACCESS_RESTRICTED_BROWSE ||
    aipAccess === ACCESS_MANAGE
  );
}

/**
 * 这个人能不能用写界面：只有 5 级「管理/编辑」。
 *
 * 用于页面 frontmatter 和侧栏/按钮的显隐。真正的写权限由 can-db 的 `withWrite` 判。
 */
export function canManage(aipAccess: number): boolean {
  return aipAccess === ACCESS_MANAGE;
}
