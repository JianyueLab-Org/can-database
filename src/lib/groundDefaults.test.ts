import { describe, expect, test } from "bun:test";
import { defaultFeatureLayers } from "@/lib/groundDefaults";

const KINDS = [
  "runway",
  "taxiway",
  "holding_position",
  "parking_position",
  "apron",
  "terminal",
  "aerodrome",
];

/**
 * 有航图就以航图为准，没有才用 OSM。
 *
 * 两份数据画的是同一批东西：航图那份是汇编抠的线画（93 个机场，5–20 米，带滑行道编号），
 * OSM 那份是 `ground_feature`（343 个机场 —— 而 `sector` 那一份也是 Overpass 抓的，
 * 见 `Ground/tools/fetch.py:18`）。两边同时画就是同一条滑行道画两遍、颜色还不一样。
 *
 * **只关掉航图画得了的那几类。** 等待位置、航站楼、机场轮廓航图给不出（它们不是
 * `#4d4d4d` 的引导线），关掉就是白丢。
 *
 * 关掉是**默认值**不是能力：勾回来仍然能两份对着看 —— 而那正是判断航图那份准不准的
 * 唯一办法。
 */
describe("defaultFeatureLayers", () => {
  test("没有航图时，OSM 那几类照旧开着", () => {
    const on = defaultFeatureLayers(KINDS, false);
    expect(on.taxiway).toBe(true);
    expect(on.apron).toBe(true);
    expect(on.terminal).toBe(true);
    expect(on.holding_position).toBe(true);
  });

  test("有航图时，航图画得了的那几类默认关掉", () => {
    const on = defaultFeatureLayers(KINDS, true);
    expect(on.taxiway).toBe(false);
    expect(on.apron).toBe(false);
  });

  test("航图给不出的那几类，有航图也照开", () => {
    const on = defaultFeatureLayers(KINDS, true);
    expect(on.holding_position).toBe(true);
    expect(on.terminal).toBe(true);
  });

  // 这两类和有没有航图无关：机位太密（一个大场几千个），跑道在别处已经画了。
  test("机位和跑道两边都默认关", () => {
    for (const hasChart of [true, false]) {
      const on = defaultFeatureLayers(KINDS, hasChart);
      expect(on.parking_position).toBe(false);
      expect(on.runway).toBe(false);
    }
  });

  test("每一类都要有明确的开关，不能留 undefined", () => {
    const on = defaultFeatureLayers(KINDS, true);
    for (const k of KINDS) expect(typeof on[k]).toBe("boolean");
  });
});
