/**
 * 两张图共用的底图部分：瓦片、主题跟随、FIR 配色。
 *
 * 抽出来是因为网络图和机场图**必须看起来是同一张图** —— 一个成员从机场清单点进详情
 * 页，两处的 ZGZU 应该是同一个颜色。分别写两份配色，漂移只是时间问题。
 *
 * 这个文件被岛屿 import，所以**不能碰 `process.env`**（`src/lib/config.ts` 在模块顶层
 * 读它，任何被岛屿 import 的模块这么做都会在浏览器里炸成 `process is not defined`）。
 * 这里只有常量和纯函数。
 */

/**
 * 瓦片。照抄 can-radar 的选择，不是随手挑的：CARTO 的 light_all / dark_all 是**无注记
 * 的浅色底**，航路线和机场点压在上面读得清；换成 OSM 标准图，底图自己的路网和地名会
 * 和航路抢注意力。
 *
 * `{r}` 是高清后缀，`{s}` 是子域 —— 两个都是 CARTO 模板的一部分，抄别家瓦片地址时把
 * 它们一起带过去会得到一片 404。
 */
export const TILES: Record<"dark" | "light", string> = {
  dark: "https://{s}.basemaps.cartocdn.com/dark_all/{z}/{x}/{y}{r}.png",
  light: "https://{s}.basemaps.cartocdn.com/light_all/{z}/{x}/{y}{r}.png",
};

export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> &copy; <a href="https://carto.com/attributions">CARTO</a>';

/** 当前主题。can-ui 的 ThemeScript 把 `.dark` 放在 <html> 上，这里就读那一处。 */
export function currentTheme(): "dark" | "light" {
  return document.documentElement.classList.contains("dark") ? "dark" : "light";
}

/**
 * 订阅主题变化。
 *
 * 用 MutationObserver 盯 `<html>` 的 class，而不是让页面把主题当 prop 传进来：这个站
 * 没有 can-radar 那样的设置 store，而主题是成员在外壳上随时会按的一个开关。返回一个
 * 取消订阅的函数，**onBeforeUnmount 里一定要调** —— 岛屿卸载后还活着的 observer 会
 * 抓着整个组件闭包不放。
 */
export function watchTheme(
  onChange: (theme: "dark" | "light") => void,
): () => void {
  let last = currentTheme();
  const observer = new MutationObserver(() => {
    const next = currentTheme();
    if (next !== last) {
      last = next;
      onChange(next);
    }
  });
  observer.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
  return () => observer.disconnect();
}

/**
 * FIR 配色。
 *
 * 手写一张表而不是按 hash 生成颜色：全网只有 11 个 FIR，而生成出来的颜色既不保证相邻
 * 的两个区分得开，也不保证在深浅两套底图上都还看得见。这些值在两套底图上都验过。
 *
 * 不在表里的 FIR 落到 `FIR_FALLBACK`，而不是随机取一个 —— 一个没见过的 FIR 应该看起来
 * 像「没见过」，不该冒充成已知的某一个。
 */
export const FIR_COLORS: Record<string, string> = {
  ZBPE: "#4c92c1", // 北京
  ZGZU: "#e2725b", // 广州
  ZSHA: "#5bbd8a", // 上海
  ZLHW: "#c9a227", // 兰州
  ZHWH: "#9b7fd4", // 武汉
  ZPKM: "#43b3ae", // 昆明
  ZWUQ: "#d4763f", // 乌鲁木齐
  ZYSH: "#7a9e5c", // 沈阳
  ZJSA: "#d46a9f", // 三亚
  RJJJ: "#8e9bb3", // 福冈
  RCAA: "#b5654a", // 台北
};

export const FIR_FALLBACK = "#8a8f98";

export function firColor(fir: string | null | undefined): string {
  return (fir && FIR_COLORS[fir]) || FIR_FALLBACK;
}

/**
 * 在 HTML 里插入文本前先转义。
 *
 * Leaflet 的 popup 收的是 HTML 字符串，而机场名和航路点代号来自扇区包 —— 那是贡献进来
 * 的数据，不是我们写的常量。can-radar 的地图对同一件事有同一个函数，理由也一样。
 */
export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
