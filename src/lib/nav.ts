/**
 * 侧栏是一份数据，不是每个页面各自拼的一串链接。
 *
 * 和 can-portal / can-controller 的同名文件同一个形状，也同一个理由：一部分链接
 * 是跨站的绝对地址，而那些地址来自环境变量，`src/lib/config.ts` 在模块顶层读
 * `process.env` —— 任何被岛屿 import 的模块这么做都会在浏览器里炸成
 * `process is not defined`。所以链接在 Astro 侧拼好，作为 props 进岛屿。
 */
import type { Translator } from "@/lib/i18n";
import type { NavItem, NavSecondary, Workspace } from "@jianyuelab-org/can-ui";
import { webUrl } from "@/lib/config";

/**
 * 侧栏的七页。
 *
 * `/` 带斜杠是给 `SidebarNav.isCurrentPath()` 看的：以斜杠结尾的条目只精确匹配，
 * 否则「总览」会在每一个子页面上都亮着。
 *
 * 航路在这里，是因为它读的是这批数据 —— 但**规划本身在 can-db**（`/aip/route`），
 * 这一页只是个入口。理由和总览那两个统计一样，见本文件顶上和 AGENTS.md。
 */
const PAGES: Array<{ key: string; href: string; icon: string }> = [
  { key: "nav.overview", href: "/", icon: "home" },
  { key: "nav.airports", href: "/airports", icon: "mapPin" },
  { key: "nav.map", href: "/map", icon: "map" },
  { key: "nav.route", href: "/route", icon: "paperAirplane" },
  { key: "nav.positions", href: "/positions", icon: "speakerWave" },
  { key: "nav.fixes", href: "/fixes", icon: "signal" },
  { key: "nav.datasets", href: "/datasets", icon: "documentText" },
];

/**
 * 侧栏对每个进得来的人都一样，而且现在这是**推论**而不是将就。
 *
 * 能打开这个站的只有 2 和 4 两级（`canUseConsole`，见 `lib/config.ts`）—— 1 和 3
 * 是「调用」那一档，根本进不来。所以站内没有「只读的人」可以区分：按一个「可编
 * 辑」门槛去分侧栏，会对**每一个**看得到侧栏的人都成立。
 *
 * 站内真正的区别是**许可轴**：3/4 看得到官方汇编，1/2 看不到。而 3 进不来，于是
 * 落到这里就是「4 比 2 多看得到一批数据」——**那是数据的多少，不是页面的多少**，
 * 每一页按自己拿到的数据渲染就够了，不需要在侧栏藏页。真要按档分页时，去问
 * can-db 的 `GET /api/v1/aip/session`（`tier` 字段），别在这里按 `aipAccess` 再
 * 算一遍梯子 —— 那正是中间件从前算错的地方。
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

/** 轨底的跨站链接。 */
export function buildSecondary(t: Translator): NavSecondary {
  return {
    label: t("nav.quickAccess"),
    items: [
      {
        name: t("nav.portal"),
        href: "https://portal.ceruleanavi.net",
        icon: "shieldCheck",
      },
      { name: t("nav.main"), href: webUrl("/"), icon: "globeAlt" },
      {
        name: t("nav.docs"),
        href: "https://docs.ceruleanavi.net",
        icon: "bookOpen",
      },
    ],
  };
}

/**
 * 顶上的分区切换器。
 *
 * 和 can-portal 一样，**不给资料库开一格**：切换器是每个成员都看得见的网络外壳，
 * 多一格等于告诉全网这里有一个他们进不去的地方。这个站的人是从别处被告知才来
 * 的，他们不需要一个入口，需要的是一条出去的路。
 */
export function buildWorkspaces(t: Translator): Workspace[] {
  return [
    {
      key: "pilots",
      name: t("workspace.pilots"),
      href: webUrl("/pilots/"),
      icon: "paperAirplane",
    },
    {
      key: "controllers",
      name: t("workspace.controllers"),
      href: "https://controller.ceruleanavi.net",
      icon: "signal",
    },
    {
      key: "exams",
      name: t("workspace.exams"),
      href: "https://exam.ceruleanavi.net",
      icon: "academicCap",
    },
  ];
}

// 从前这里导出过一个 `WRITE_ACCESS = ACCESS_WRITE`，「未使用但保留」，留着给将来
// 的编辑菜单当门槛。撤掉了，两个理由：`ACCESS_WRITE` 不是「写权限」（它是「访问」
// 那一档，见 config.ts），而且能进这个站的人全部满足它 —— 一个恒为真的门槛不是门
// 槛，留着只会让下一个人以为侧栏可以按它分。
