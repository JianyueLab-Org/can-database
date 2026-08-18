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
import { ACCESS_WRITE, webUrl } from "@/lib/config";

/**
 * 这个站的四页。
 *
 * `/` 带斜杠是给 `SidebarNav.isCurrentPath()` 看的：以斜杠结尾的条目只精确匹配，
 * 否则「总览」会在每一个子页面上都亮着。
 */
const PAGES: Array<{ key: string; href: string; icon: string }> = [
  { key: "nav.overview", href: "/", icon: "home" },
  { key: "nav.airports", href: "/airports", icon: "mapPin" },
  { key: "nav.fixes", href: "/fixes", icon: "signal" },
  { key: "nav.datasets", href: "/datasets", icon: "documentText" },
];

/**
 * 侧栏对只读和可编辑的人是一样的。
 *
 * 这不是偷懒：今天 can-db 一条写路由都没有（`internal/httpx/server.go` 的
 * `withWrite` 存在但没有挂任何路径），所以「可编辑」目前不多出任何一页。等编辑功
 * 能落地，多出来的入口在这里按 `ACCESS_WRITE` 加 —— 那个常量已经 import 好了，
 * 就是为了让那次改动是加三行而不是先想清楚门槛写在哪。
 *
 * **在那之前不要先把菜单加上。** 一个点下去只有占位的入口，会被当成坏掉的页面，
 * 而不是还没做的页面。can-efb 的四个占位页把这条写得很清楚。
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
      { name: t("nav.main"), href: webUrl("/"), icon: "paperAirplane" },
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

/** 未使用但保留：编辑权限的门槛常量，见 buildNavigation 的注释。 */
export const WRITE_ACCESS = ACCESS_WRITE;
