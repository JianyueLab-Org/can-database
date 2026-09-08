/**
 * 地面图层的默认开关：**有航图就以航图为准，没有才用 OSM。**
 *
 * 两份数据画的是同一批东西。航图那份是汇编抠的线画（93 个机场，5–20 米，带滑行道编号）；
 * OSM 那份是 `ground_feature`（343 个机场 —— 注意 `sector` 那一份也是 Overpass 抓的，见
 * `Ground/tools/fetch.py:18`，所以两份都是 OSM 派生）。两边同时画就是同一条滑行道画两遍，
 * 颜色还不一样。
 *
 * **只关掉航图画得了的那几类。** 等待位置、航站楼、机场轮廓航图给不出 —— 它们不是
 * `#4d4d4d` 的引导线，抠出来也没有语义。关掉就是白丢。
 *
 * 这是**默认值不是能力**：勾回来仍然能两份对着看，而那正是判断航图那份准不准的唯一办法
 * （两边的滑行道编号有 40 到 100 种对不上，逐个看图是目前唯一的判据）。
 */

/** 航图的引导线能替代的那几类。 */
const CHART_COVERS = new Set(["taxiway", "apron"]);

/** 和有没有航图无关，一律默认关：机位太密（一个大场几千个），跑道在别处已经画了。 */
const ALWAYS_OFF = new Set(["parking_position", "runway"]);

export function defaultFeatureLayers(
  kinds: string[],
  hasChart: boolean,
): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of kinds) {
    out[k] = !ALWAYS_OFF.has(k) && !(hasChart && CHART_COVERS.has(k));
  }
  return out;
}
