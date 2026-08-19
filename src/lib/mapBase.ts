import L from "leaflet";

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

/* ===========================================================================
   航路和点的画法 —— 照 can-radar 的约定来

   雷达图上一条航路是这么画的，这里照抄，理由是**同一个网络的两张图不该有两套读
   法**：一个成员在雷达上认得的三角形航路点和压在腿中间的航路名，点进资料库应该还
   是那一套。can-radar 的 `RadarMap.vue` 是那一份的出处。

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
 * 按当前缩放开关三类标签。
 *
 * 挂在容器的 class 上 —— 换一次缩放是切三个 class，不是重建几十个 marker。
 */
export function applyLabelZoom(map: L.Map): void {
  const zoom = map.getZoom();
  const el = map.getContainer();
  el.classList.toggle("show-via-labels", zoom >= VIA_LABEL_MIN_ZOOM);
  el.classList.toggle("show-fix-labels", zoom >= FIX_LABEL_MIN_ZOOM);
  el.classList.toggle("show-terminal-labels", zoom >= TERMINAL_LABEL_MIN_ZOOM);
}

/** 一个航路点：三角形加名字。`terminal` 的名字要更高的缩放才出。 */
export function fixMarker(
  lat: number,
  lon: number,
  ident: string,
  options: { color: string; terminal?: boolean } = { color: "" },
): L.Marker {
  const cls = options.terminal ? "can-fix can-fix--terminal" : "can-fix";
  return L.marker([lat, lon], {
    interactive: false,
    icon: L.divIcon({
      className: "can-map-icon",
      html:
        `<div class="${cls}" style="--can-fix-color:${options.color}">` +
        `<svg class="can-fix__dot" viewBox="0 0 10 9" aria-hidden="true">` +
        `<path d="M5 .6 9.5 8.4H.5z"/></svg>` +
        `<span class="can-fix__name">${escapeHtml(ident)}</span></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

/**
 * 只有名字的标签，给「点已经画了、只差名字」的场合。
 *
 * 全网图上航路点是 circleMarker（三千多个 divIcon 会掉帧，见 NetworkMap 的注释），所以
 * 那里的名字用这个补，而不是整套换成 fixMarker。
 */
export function nameMarker(
  lat: number,
  lon: number,
  text: string,
  color: string,
): L.Marker {
  return L.marker([lat, lon], {
    interactive: false,
    icon: L.divIcon({
      className: "can-map-icon",
      html:
        `<div class="can-fix" style="--can-fix-color:${color}">` +
        `<span class="can-fix__name can-fix__name--always">${escapeHtml(text)}</span></div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

/** 压在腿中间的航路名。 */
export function viaMarker(
  lat: number,
  lon: number,
  name: string,
  color: string,
): L.Marker {
  return L.marker([lat, lon], {
    interactive: false,
    icon: L.divIcon({
      className: "can-map-icon",
      html: `<div class="can-via" style="--can-via-color:${color}">${escapeHtml(name)}</div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

/** 机场点：实心圆加代号，永远显示 —— 它是这张图的骨架。 */
export function airportMarker(
  lat: number,
  lon: number,
  icao: string,
  color: string,
): L.Marker {
  return L.marker([lat, lon], {
    interactive: false,
    icon: L.divIcon({
      className: "can-map-icon",
      html:
        `<div class="can-airport" style="--can-airport-color:${color}">` +
        `<span class="can-airport__dot"></span>${escapeHtml(icao.toUpperCase())}</div>`,
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    }),
  });
}

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
