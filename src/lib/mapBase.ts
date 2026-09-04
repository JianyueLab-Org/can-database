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
 * 瓦片。照抄 can-radar 的选择，不是随手挑的：Esri 的 Canvas 深浅两套**只标国名，不画
 * 路网也不标城市**，航路线和机场点压在上面读得清；换成 OSM 标准图，底图自己的路网和
 * 地名会和航路抢注意力。
 *
 * **2026-09 从 CARTO 换过来。** `basemaps.cartocdn.com` 开始给没有 API key 的请求回一
 * 张把 "API KEY REQUIRED" 烤进 PNG 里的瓦片 —— HTTP 还是 200，图也照画，只看状态码发
 * 现不了。换供应商而不是去申请一把 key：这个仓库是公开的，客户端包里的 key 就是公开
 * 的 key。can-radar 的 `RadarMap.vue` 是这一份的出处，同一天同一处改的，两边要一起动。
 *
 * 三个组件都不传 `subdomains`，因为这条模板没有 `{s}` 子域，也没有 `{r}` 高清后缀 ——
 * 抄别家瓦片地址回来时把这两个占位符落下或者多带，都会得到一片 404。
 */
export const TILES: Record<"dark" | "light", string> = {
  dark: "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Dark_Gray_Base/MapServer/tile/{z}/{y}/{x}",
  light:
    "https://server.arcgisonline.com/ArcGIS/rest/services/Canvas/World_Light_Gray_Base/MapServer/tile/{z}/{y}/{x}",
};

/**
 * 这两张底图**真正有数据**的最深一级。
 *
 * 和瓦片地址放在一起，因为它是地址的一部分属性而不是各组件自己的偏好：换供应商时
 * 两个值必须一起改。Esri 的 Canvas 数据到 **z16** 为止，再深它**不返回 404**，而是
 * 一张 HTTP 200、写着 "Map data not yet available" 的占位图，全球每块都一样。所以
 * 超过这一级必须靠 `maxNativeZoom` 让 Leaflet 放大最深那级，而不能放任它去请求。
 *
 * can-radar 的 `RadarMap.vue` 是同一处判断的出处，那边连实测数据一起记着。
 */
export const TILE_MAX_NATIVE_ZOOM = 16;

export const TILE_ATTRIBUTION =
  '&copy; <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, &copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';

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

/* ===========================================================================
   航路和点的画法 —— 照 can-radar 的约定来

   雷达图上一条航路是这么画的，这里照抄，理由是**同一个网络的两张图不该有两套读
   法**：一个成员在雷达上认得的三角形航路点和压在腿中间的航路名，点进资料库应该还
   是那一套。can-radar 的 `RadarMap.vue` 是那一份的出处。

   **需要 Leaflet 的那几个不在这个文件里**，在 `mapMarkers.ts`。这个文件被
   `Airports.vue`、`Fixes.vue` 这些**服务端渲染**的岛屿 import（它们要 `firColor`），而
   Leaflet 在模块顶层就要 `window` —— 在这里 import 它，等于让每一个渲染机场清单的请求都
   炸在 `window is not defined` 上。犯过一次。

   四条约定，每一条都是那边踩出来的：

   1. **名字建在 marker 里，用容器上的一个 class 开关**，而不是 tooltip。tooltip 要
      悬停、一次只出一个，而看图的人想要的是「这一片点都叫什么」。开关一个 class 比
      在几十个 marker 上重建 DOM 便宜得多。
   2. **三个缩放阈值，不是一个。** 航路名最早出现（少而关键），航路点次之，终端点最
      后 —— 一条 SID 把六个点铺在一个进近区里，早出就是把程序写在自己身上。
   3. **航路名标在腿上，不标在点上**，而且每一段都标。名字属于那条腿；一条长航路只
      在中间标一次，等于放大去看某个点的人正好看不到它是哪条航路。
   4. **程序虚线、航路实线**，转折的那条腿同时属于两段，所以线在换样式的地方没有缺
      口。
   =========================================================================== */

/** 航路线的颜色。灰而不是蓝：底图上要压得住，又不能和限制/告警抢眼。 */
export const ROUTE_COLORS: Record<"dark" | "light", string> = {
  dark: "#8a8a8a",
  light: "#5a5a5a",
};

/**
 * 三个标签的缩放阈值。
 *
 * 数值取自 can-radar，不是猜的：航路名 5 级就出（一屏放得下整条航路时，`W47` 正是那
 * 时候要读的东西），航路点 6 级，终端点 9 级。
 */
export const VIA_LABEL_MIN_ZOOM = 5;
export const FIX_LABEL_MIN_ZOOM = 6;
export const TERMINAL_LABEL_MIN_ZOOM = 9;

/**
 * 两点之间的大圆插值。
 *
 * 直接连两个经纬度画出来的是墨卡托上的直线，而航路飞的是大圆 —— 跨度一大，两者在图
 * 上差得出来（ZGGG→RJTT 中段能差出上百公里）。段数按跨度给，短腿就是一条直线。
 */
export function arc(
  from: [number, number],
  to: [number, number],
): [number, number][] {
  const rad = Math.PI / 180;
  const [lat1, lon1] = [from[0] * rad, from[1] * rad];
  const [lat2, lon2] = [to[0] * rad, to[1] * rad];

  const d =
    2 *
    Math.asin(
      Math.sqrt(
        Math.sin((lat2 - lat1) / 2) ** 2 +
          Math.cos(lat1) * Math.cos(lat2) * Math.sin((lon2 - lon1) / 2) ** 2,
      ),
    );
  if (!Number.isFinite(d) || d < 0.01) return [from, to];

  const steps = Math.min(64, Math.max(8, Math.round((d / rad) * 2)));
  const points: [number, number][] = [];
  for (let i = 0; i <= steps; i++) {
    const f = i / steps;
    const a = Math.sin((1 - f) * d) / Math.sin(d);
    const b = Math.sin(f * d) / Math.sin(d);
    const x =
      a * Math.cos(lat1) * Math.cos(lon1) + b * Math.cos(lat2) * Math.cos(lon2);
    const y =
      a * Math.cos(lat1) * Math.sin(lon1) + b * Math.cos(lat2) * Math.sin(lon2);
    const z = a * Math.sin(lat1) + b * Math.sin(lat2);
    points.push([
      Math.atan2(z, Math.sqrt(x * x + y * y)) / rad,
      Math.atan2(y, x) / rad,
    ]);
  }
  return points;
}
