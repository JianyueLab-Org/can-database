# AGENTS.md

给在这个仓库里工作的人和模型看的。`CLAUDE.md` 是指向本文件的软链接。

## 这是什么

**航行资料控制台** —— `database.ceruleanavi.net`，Cerulean Aviation Network 的第八
个 Astro 站点，也是 **can-db 唯一的前端**。

它显示机场、跑道、机位、航路点、航路和进离场程序 —— SweatBox 生成器、航路解析和管
制工作站都要读的那批资料。

技术形状和 can-portal / can-controller / can-efb / can-dev / can-radar 一样，**不要
在这里发明第九套**：Astro SSR（standalone Node 适配器）+ Vue 岛屿 + Tailwind v4 +
can-ui，跑在 jyl-tyo 上，由 CI 部署，Ingress 走 `cloudflare-tunnel`。

## 它是从 can-db 里拆出来的

can-db 从前是一个仓库两半：Go 服务加一个 `web/` 目录。**拆开的规矩是一句话 ——
can-db 用 Go 管后端，前端全在这里，而所有逻辑归 can-db。**

「所有逻辑归 can-db」不是口号，拆的时候真的搬了两处：

- 总览页从前取全部 dataset，自己 filter 出 `active`、把机场数加起来、把来源去重。
  **「什么叫在服务的数据」是一条关于这批数据的规则**，不是渲染细节。现在是
  `GET /api/v1/aip/overview` 一条路由答完，can-db 那边配了测试（`internal/aip` 的
  `TestOverviewCountsOnlyActiveDatasets` 钉的就是「loading 的那一期一个数都不该
  进」）。
- 航路点页从前为了画一个 FIR 下拉框，把 233 条机场索引取回来去重。现在是
  `GET /api/v1/aip/firs`。

**在这里写任何一行「算」出来的东西之前，先问它是不是一条关于数据的规则。** 是的话
它属于 can-db —— 这个仓库存在的意义就是它不回答那种问题。排序、搜索框的即时过滤、
把 procedure 分成 SID 和 STAR 两栏来显示，这些是渲染，留在这里。

## 三条不变量

**没有数据库口令。** 一条都没有，将来也不该有。全网能连上那个 PostgreSQL 的只有
can-db 一个进程。

**没有 Secret，一个都没有。** 和 can-efb、can-controller 一样。会话是 can-api 签在
**父域** `.ceruleanavi.net` 上的那一枚 cookie，成员在主站登录过，浏览器本来就把它带
到这里来；这个站做的全部事情是把它**原样转发**给 can-db，由那边去问 can-api「这是
谁、有没有 aipAccess」。多存一份 `SESSION_SECRET` 等于多一处能签发任何人身份的地方。

**整站要登录，而且整站要授权。** 一页公开的都没有，将来也不该有 —— 这个站显示的是
有许可限制的航行资料，而「有哪些机场」本身就已经超出一个匿名访客该看到的范围。门槛
是 `aipAccess >= 1`（ADM 在 can-api 的 `user` 表上授予）或者教员评级，见 can-db 的
`internal/session`。

**这一次「便利不是边界」要反过来读。** 别的站上中间件挡人只是为了不让人看见点下去
必然 403 的链接。这里多了一件事：**页面是服务端渲染的，机场清单在 HTML 里就是明
文**。所以那道门不只是「别让他看见入口」，它同时是「别把资料渲染给他」。把
`src/middleware.ts` 里那个数字改小，泄漏的是数据本身。

## 接缝

### 岛屿 → can-db：走本站的同源反代

`src/pages/api/v1/[...path].ts`，**白名单是重点不是修饰**。一个通配的 `/api/*` 转发
等于把 can-db 整个 API 挂到公网上。每一条都写着谁在用它 —— 要加页面就要加条目，而
且要顺手写清楚「谁在用」，否则以后没人敢删任何一条。

服务端渲染的页面不走这条，走 `src/server/canDb.ts`（它转发 cookie）。

### can-db 的地址是**集群内**的，即使它有公网主机名

can-db 从 2026-08-18 起有了 `api-db.ceruleanavi.net`，但这个站仍然打
`app.can-db.svc.cluster.local`。那条公网地址是给**集群外**的消费者用的 —— can-atc 是
控制员机器上的桌面程序，解析不了 ClusterIP。这个站和 can-db 在同一个集群里，走
Service 少一跳，而且不会因为 Cloudflare 隧道抖一下就连自己的后端都读不到。

### `checkOrigin` 必须是关的

`astro.config.mjs` 里 `security.checkOrigin: false`。Astro 从 `Host` 头推导本站
origin 再和浏览器的 `Origin` 比对，而这个站跑在 TLS 终止的反代后面，推出来的是
`http://…`、浏览器发的是 `https://…`，**永远对不上，每一个 POST 都是 403**。
can-dev、can-radar、can-efb 都是踩了才关的。

关掉不等于不检查：写操作的 Origin 比对显式配置的 `PUBLIC_ORIGIN`，那个值反代动不了。

## 这个仓库为什么必须是公开的

**JianyueLab-Org 是 GitHub Free 计划，组织级 secret 到不了私有仓库。** 部署要的
`KUBECONFIG_B64` 和 `GHCR_PULL_TOKEN` 都是组织级的，所以仓库只要是私有的，CI 就拿不
到它们 —— 表现为 deploy 在「Check cluster credentials」那一步失败。can-controller 最
初建成私有正是这么红了一次，can-efb 至今卡在这条上。

**它能公开是因为它什么都不装：** 没有凭据、没有 Secret、没有一行有许可的航行资料，
也没有 can-db 那个描述私有 `Sector` 仓库布局的提取脚本。控制台渲染的每一个字节都是
can-db 现给的。

改回私有 = CI 立刻不能部署。

## 两张图

`/map` 是全网图，机场详情页顶上是机场图。共用 `src/lib/mapBase.ts`（瓦片、主题跟随、
FIR 配色），**共用是必须的**：一个成员在清单上认得的 ZGZU 的颜色，点进地图应该还是那
一个，两处各写一份配色漂移只是时间问题。机场清单上那排色块也取自同一个 `firColor`。

几条踩过或差点踩到的：

**`leaflet.css` 在 `AppLayout.astro` 里引，而且排在 `globals.css` 前面。** 从岛屿里引
的话它是一张动态样式表，浏览器插到 `<head>` 最后 —— 排在整站样式**后面**，于是 Leaflet
自带的 `.leaflet-control-attribution a { color:#0078A8 }` 赢过主题规则，版权条上留一串
默认亮蓝色链接。can-radar 踩过。

**地图岛屿必须 `client:only="vue"`。** Leaflet 在模块顶层就要 `window`，SSR 会直接炸。

**Leaflet 对象放 `shallowRef`，不放 `ref`。** 它们是庞大的自引用结构，深响应式代理既
没用又很贵。

**三千段航路是一条 `L.polyline`，不是三千条。** 后者是三千个 SVG 元素，平移一次浏览器
就重排三千次。多段线接受「线的数组」，画出来一样。

**航路点只在选中 FIR 后才画。** 全网 15278 个点糊成一片，读不出任何东西；单个 FIR 最多
3914（RJJJ）还在能读的范围。所以不选 FIR 时那个开关是禁用的，而不是按了没反应。

**无坐标的程序点是断口，不是 0,0。** 那 311 个点会把线拉到几内亚湾。`AirportMap` 遇到
它就把线**切成两段**，而不是连过去。

**可疑的程序段画出来并标红，不藏。** 见 can-db 的〈程序点的解析在日本会挑错点〉：56 条
SID 的首点落在几百到一千多公里外。这个站是拿来校对数据的，把可疑的一段藏起来，看图的人
会以为数据是干净的。判据（离本场 > 400 km）和那份记录一致 —— 改一处要改两处。

**popup 里的文本一律 `escapeHtml`。** 机场名和航路点代号来自扇区包，是贡献进来的数据，
不是我们写的常量。

## 清单页的两条规矩

**能被搜的清单一定要有搜索框。** 航路点页原来只有一个 FIR 下拉和一个滚动框，而 RJJJ 有
3914 个点 —— 打开那一页的人几乎总是在找某一个代号，唯一的办法却是用眼睛扫，或者按浏览
器的 Ctrl+F 去搜一份已经渲染出来的 DOM。搜索框是这一页的主操作，不是附加功能。

**截断必须说出来。** 航路点页只渲染前 300 条（三千多个 `<li>` 各带两个 `<span>` 是一万
多个节点，而能看见的不到三十个），机场详情页只渲染前 60 个机位。两处都把省略掉的数量写
在下面 —— **一个悄悄截断的列表会让人以为剩下的不存在**，那比慢糟得多，而这个站的用途正
是校对数据。

## 控制台目前是只读的，这是有意的

can-db 今天一条写路由都没有。`src/lib/nav.ts` 里 `ACCESS_WRITE` 已经 import 好了，
但侧栏对只读和可编辑的人是一样的。

**在写接口落地之前不要先把编辑菜单加上。** 一个点下去只有占位的入口会被当成坏掉的
页面，而不是还没做的页面 —— can-efb 那四个占位页把这条写得很清楚。

## 本地开发

```bash
bun install
bun run dev            # :4329
bun run lint           # format:check + astro check + vue-tsc —— CI 就跑这一条
bun run build
```

端口 4329 接着那条阶梯：4321 can-web、4322 can-dev、4323 can-radar、4324 can-efb、
4325 can-exam、4326 can-controller、4327 can-ui、4328 can-portal。

本地跑要给 `PUBLIC_ORIGIN`，否则写操作的 Origin 检查会拿线上地址去比对本地的
`http://localhost:4329`：

```bash
PUBLIC_ORIGIN=http://localhost:4329 CAN_DB_ORIGIN=http://127.0.0.1:8080 bun run dev
```

`CAN_DB_ORIGIN` 兜底是 `http://127.0.0.1:8080` 而不是某个 https 地址：本地开发时你
自己起一个 can-db。写一个公网地址当兜底会让「忘了配」悄悄变成「打到了别的东西上」。

## 上游

can-db 在 **JianyueLab**（不是这个组织）：`https://github.com/JianyueLab/can-db`。
它是私有的，理由写在它自己的 AGENTS.md 里 —— 简单说不是因为它藏了凭据（没有），而是
`scripts/build-sweatbox.mjs` 描述了私有 `Sector` 仓库的文件布局。

改接口是**两个仓库的事**：can-db 加路由、加测试，这里加白名单条目和类型。两边 CI 谁
也看不见对方。
