/**
 * 地面要素的画法：颜色、线宽、类别次序。
 *
 * 机场图（`AirportMap.vue`）和地面要素编辑器（`GroundEditor.vue`）共用这一份 —— 编辑器
 * 里画出来的样子要和成员在机场图上看到的一样，两处各写一份颜色，漂移只是时间问题。
 *
 * 纯常量，不 import Leaflet：服务端渲染的岛屿也可能读它。
 */

export interface FeatureStyle {
  color: string;
  weight: number;
  /** 面要素的填充不透明度。没有时面只画轮廓（编辑器给一层很淡的底）。 */
  fillOpacity?: number;
}

/**
 * 各类要素的画法。跑道最显眼，机位最轻，其余居中。
 *
 * 道肩是铺面，填一层比机坪、滑行道暗的灰；跑道标志是白色实心面。
 * 滑行道标注（`taxiway_label`）不画点，只画 `name` 这几个字，颜色用滑行道的。
 */
export const FEATURE_STYLE: Record<string, FeatureStyle> = {
  runway: { color: "#e05252", weight: 3 },
  taxiway: { color: "#4c92c1", weight: 1.6 },
  taxiway_label: { color: "#4c92c1", weight: 1 },
  apron: { color: "#5bbd8a", weight: 1.2 },
  shoulder: { color: "#7d8288", weight: 0.6, fillOpacity: 0.35 },
  terminal: { color: "#9a8ac1", weight: 1.2 },
  runway_marking: { color: "#ffffff", weight: 0.5, fillOpacity: 0.9 },
  holding_position: { color: "#e0a252", weight: 2 },
  parking_position: { color: "#8a8a8a", weight: 1 },
  aerodrome: { color: "#8a8a8a", weight: 1 },
};

export const FEATURE_FALLBACK: FeatureStyle = { color: "#8a8a8a", weight: 1 };

/** 只画文字的类别：点上不画圆点，画 `name`。 */
export const LABEL_KINDS: ReadonlySet<string> = new Set(["taxiway_label"]);

/** 类别按这个次序排，不按条数 —— 读的人按重要性找，不按多少找。 */
export const FEATURE_ORDER = [
  "runway",
  "taxiway",
  "holding_position",
  "parking_position",
  "taxiway_label",
  "apron",
  "shoulder",
  "terminal",
  "runway_marking",
  "aerodrome",
];

/**
 * 画的先后：前面的先画、压在底下。和 `FEATURE_ORDER`（图例次序）是两回事。
 *
 * 面从大到小，再是线，最后是点和字。道肩在滑行道下面，跑道标志在跑道上面。
 */
export const FEATURE_DRAW_ORDER = [
  "aerodrome",
  "apron",
  "shoulder",
  "terminal",
  "taxiway",
  "runway",
  "runway_marking",
  "parking_position",
  "holding_position",
  "taxiway_label",
];

/** 类别的画序；不认识的类别排在已知的面和线之后、点之前。 */
export function drawRank(kind: string): number {
  const i = FEATURE_DRAW_ORDER.indexOf(kind);
  return i === -1 ? FEATURE_DRAW_ORDER.indexOf("runway_marking") + 0.5 : i;
}
