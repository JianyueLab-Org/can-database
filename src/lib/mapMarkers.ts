import L from "leaflet";

import {
  escapeHtml,
  FIX_LABEL_MIN_ZOOM,
  TERMINAL_LABEL_MIN_ZOOM,
  VIA_LABEL_MIN_ZOOM,
} from "@/lib/mapBase";

/**
 * 需要 Leaflet 的地图零件。
 *
 * **和 `mapBase.ts` 分开，而且这条分界是硬的**：mapBase 被 `Airports.vue`、`Fixes.vue`
 * 这些服务端渲染的岛屿 import（它们只要 `firColor` 和瓦片地址），而 Leaflet 在模块顶层
 * 就要 `window` —— 把它 import 进 mapBase，每一个渲染机场清单的请求都会炸在
 * `window is not defined` 上。这个文件只许 `client:only` 的地图岛屿 import。
 *
 * 画法的说明在 mapBase 顶上那一段，出处是 can-radar 的 `RadarMap.vue`。
 */

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

/**
 * 一个航路点：三角形加名字。
 *
 * 名字什么时候出，三档：
 *   `always`   —— 一直出。给**航路串里出现的那些点**用（`MIKIP A461 BUBDA` 的两头）。
 *   默认        —— 6 级以上出。
 *   `terminal` —— 9 级以上才出。给密集的终端点和航路中间那些只决定线形的点用。
 */
export function fixMarker(
  lat: number,
  lon: number,
  ident: string,
  options: { color: string; terminal?: boolean; always?: boolean } = {
    color: "",
  },
): L.Marker {
  const cls = options.always
    ? "can-fix can-fix--always"
    : options.terminal
      ? "can-fix can-fix--terminal"
      : "can-fix";
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

/**
 * 压在腿中间的航路名。
 *
 * `always` 给只画一条航路的图用：那里标签本来就只有几个，而看图的人正是来看「这段是哪
 * 条航路」的 —— 缩放阈值在那种场景下只会让整条航路一个名字都没有。
 */
export function viaMarker(
  lat: number,
  lon: number,
  name: string,
  color: string,
  options: { always?: boolean } = {},
): L.Marker {
  const cls = options.always ? "can-via can-via--always" : "can-via";
  return L.marker([lat, lon], {
    interactive: false,
    icon: L.divIcon({
      className: "can-map-icon",
      html: `<div class="${cls}" style="--can-via-color:${color}">${escapeHtml(name)}</div>`,
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
