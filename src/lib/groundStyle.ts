/**
 * 地面要素的画法：颜色、线宽、类别次序。
 *
 * 机场图（`AirportMap.vue`）和地面要素编辑器（`GroundEditor.vue`）共用这一份 —— 编辑器
 * 里画出来的样子要和成员在机场图上看到的一样，两处各写一份颜色，漂移只是时间问题。
 *
 * 纯常量，不 import Leaflet：服务端渲染的岛屿也可能读它。
 */

/** 各类要素的画法。跑道最显眼，机位最轻，其余居中。 */
export const FEATURE_STYLE: Record<string, { color: string; weight: number }> =
  {
    runway: { color: "#e05252", weight: 3 },
    taxiway: { color: "#4c92c1", weight: 1.6 },
    apron: { color: "#5bbd8a", weight: 1.2 },
    terminal: { color: "#9a8ac1", weight: 1.2 },
    holding_position: { color: "#e0a252", weight: 2 },
    parking_position: { color: "#8a8a8a", weight: 1 },
    aerodrome: { color: "#8a8a8a", weight: 1 },
  };

export const FEATURE_FALLBACK = { color: "#8a8a8a", weight: 1 };

/** 类别按这个次序排，不按条数 —— 读的人按重要性找，不按多少找。 */
export const FEATURE_ORDER = [
  "runway",
  "taxiway",
  "holding_position",
  "parking_position",
  "apron",
  "terminal",
  "aerodrome",
];
