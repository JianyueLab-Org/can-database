/**
 * 侧栏是一份数据，不是每个页面各自拼的一串链接。
 *
 * 和 can-portal / can-controller 的同名文件同一个形状：在 Astro 侧拼好，作为
 * props 进岛屿。分区切换器不在这里 —— 它是 can-ui 的 `buildWorkspaces`，四个
 * AppShell 站一份，见 `layouts/AppLayout.astro`。
 */
import type { Translator } from "@/lib/i18n";
import type { IconName, NavItem, NavSecondary } from "@jianyuelab-org/can-ui";
// Deep import, not the barrel: the barrel re-exports every Vue component in
// the package, and this file is imported by a bun:test file
// (`export/messages.test.ts`) that shares a process with `export/page.test.ts`'s
// happy-dom document. Loading the whole component tree here tore that
// document down from under the other file — `visibleSites` alone needs none
// of it.
import {
  visibleSites,
  WORKSPACE_SITE_KEYS,
} from "@jianyuelab-org/can-ui/sites";

/**
 * 侧栏的八页。
 *
 * `/` 带斜杠是给 `isCurrentPath()` 看的：以斜杠结尾的条目只精确匹配，否则「总
 * 览」会在每一个子页面上都亮着。
 *
 * 航路在这里，是因为它读的是这批数据 —— 但**规划本身在 can-db**（`/aip/route`），
 * 这一页只是个入口。理由和总览那两个统计一样，见本文件顶上和 AGENTS.md。
 */
const PAGES: Array<{ key: string; href: string; icon: IconName }> = [
  { key: "nav.overview", href: "/", icon: "home" },
  { key: "nav.airports", href: "/airports", icon: "mapPin" },
  { key: "nav.map", href: "/map", icon: "map" },
  { key: "nav.route", href: "/route", icon: "paperAirplane" },
  { key: "nav.positions", href: "/positions", icon: "speakerWave" },
  { key: "nav.fixes", href: "/fixes", icon: "signal" },
  { key: "nav.datasets", href: "/datasets", icon: "documentText" },
  { key: "nav.export", href: "/export", icon: "arrowDownTray" },
];

/**
 * 侧栏对每个进得来的人都一样，而且现在这是**推论**而不是将就。
 *
 * 能打开这个站的只有 2、4、5 三级（`canUseConsole`，见 `lib/config.ts`）—— 1 和 3
 * 是「调用」那一档，根本进不来。
 *
 * 站内的区别有两条。**许可轴**：4 和 5 看得到官方汇编，2 看不到 ——**那是数据的多少，
 * 不是页面的多少**，每一页按自己拿到的数据渲染就够了，不需要在侧栏藏页。**写权限**：
 * 只有 5 级有（`canManage`，即 `aipAccess === ACCESS_MANAGE`）。写界面挂在 `/datasets`
 * 的每一期下面（编辑、修订记录），没有全局入口，所以侧栏不按它分。
 *
 * **别去问 can-db 要一个 `tier`。** 这里从前写着「真要按档分页时，去问 can-db 的
 * `GET /api/v1/aip/session`（`tier` 字段）」—— 那条路由和那个字段都不存在。can-db
 * 只是把 cookie 原样转给 can-api 的 `GET /api/v1/auth/session`，回来的是成员本身
 * （`rating`、`aipAccess`），判断也是它自己的 `CanRead()` / `CanWrite()`，没有一个
 * 叫 `tier` 的东西。真要按档分页，用的是中间件已经解出来的 `aipAccess` 加
 * `lib/config.ts` 里那张表 —— 那是这个站唯一的一份；别在侧栏里另写一套梯子，那正是
 * 中间件从前算错的地方。
 *
 * **不要加指向不存在功能的入口。** 一个点下去只有占位的入口，会被当成坏掉的页
 * 面，而不是还没做的页面。can-efb 的四个占位页把这条写得很清楚。
 */
export function buildNavigation(t: Translator, _access: number): NavItem[] {
  return PAGES.map((entry) => ({
    name: t(entry.key),
    href: entry.href,
    icon: entry.icon,
  }));
}

/**
 * 轨底的跨站链接。
 *
 * 从前这里手抄着门户、主站、文档三条；现在来自 can-ui 的 `visibleSites`，九个站
 * 一份，站名的四种语言也在那边，门户和资料库按评级决定露不露 —— 那是画菜单的
 * 依据，不是权限。
 */
export function buildSecondary(
  t: Translator,
  opts: { locale: string; rating?: number; signedIn: boolean },
): NavSecondary {
  return {
    label: t("nav.quickAccess"),
    // 分区切换器（`buildWorkspaces`，见文件顶注）已经画着管制员中心和考试中
    // 心，这里要把 WORKSPACE_SITE_KEYS 排掉，不然这两个站在切换器和这份常用
    // 链接里各出现一次。
    items: visibleSites({
      locale: opts.locale,
      current: "database",
      rating: opts.rating,
      signedIn: opts.signedIn,
      excludeCurrent: true,
    })
      .filter((site) => !WORKSPACE_SITE_KEYS.includes(site.key))
      .map((site) => ({
        name: site.name,
        href: site.href,
        icon: site.icon,
      })),
  };
}

// 写门槛是 config.ts 的 `canManage`；侧栏不用它。
