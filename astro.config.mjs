// @ts-check
import { defineConfig } from "astro/config";
import node from "@astrojs/node";
import vue from "@astrojs/vue";
import tailwindcss from "@tailwindcss/vite";

/**
 * 航行资料库控制台。第八个 Astro 站，形状和另外七个一样 —— Astro SSR
 * （standalone Node 适配器）+ Vue 岛屿 + Tailwind v4 + can-ui。
 * **不要在这里发明第九套。**
 *
 * 这个站有一处和别的站都不同，而且是它存在的前提：**它是 can-db 的前端，但一行
 * 数据库凭据都没有。** can-db（同一个仓库的 Go 服务）持有唯一那份 PostgreSQL
 * 口令；这个站通过本站的同源反代去问它，而反代转发的是成员的 cookie。所以整个
 * 网络里能连上那个数据库的，仍然只有一个进程。
 *
 * `output: "server"` 是必需的：每一页渲染前都要拿会话去问 can-api「你是谁、有没
 * 有资料库权限」，预渲染的页面既拿不到 cookie 也拿不到权限。
 *
 * `security.checkOrigin: false` 的理由和另外七个站逐字相同：Astro 从 `Host` 头
 * 推导 origin 再和浏览器的 `Origin` 比对，而这个站跑在 TLS 终止的反代后面，推出
 * 来的是 `http://…`、浏览器发的是 `https://…`，永远对不上。补上的那一半在
 * `src/pages/api/v1/[...path].ts`，比对的是显式的 `PUBLIC_ORIGIN`。
 */
export default defineConfig({
  output: "server",
  adapter: node({ mode: "standalone" }),
  integrations: [vue()],
  security: { checkOrigin: false },
  vite: {
    plugins: [tailwindcss()],
    // can-ui 发的是源码而不是构建产物；不加这行 SSR 会去 require 一个 .vue，
    // 首屏直接 500。
    ssr: { noExternal: ["@jianyuelab-org/can-ui"] },
  },
});
