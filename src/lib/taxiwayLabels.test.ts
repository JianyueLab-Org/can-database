import { describe, expect, test } from "bun:test";
import { taxiwayLabels } from "@/lib/taxiwayLabels";

/**
 * 一个编号一个标注，放在**最长**那一段上。
 *
 * 一条滑行道在数据里是几十条短线：航图那份是几十条短路径（ZBAA 195 条带编号只有
 * 141 种），OSM 那份是被每个路口切开的 way。逐条标就是同一个 `C3` 沿着滑行道印二十
 * 遍，糊成一条黑带。
 *
 * 挑最长的那一段，是因为它最有可能是这条滑行道的主干；挑第一条或随便一条，取决于
 * 数据在数组里的顺序 —— 那个顺序没有任何含义。
 */
describe("taxiwayLabels", () => {
  const seg = (name: string, ...pts: [number, number][]) => ({
    name,
    points: pts,
  });

  test("一个编号只出一个标注", () => {
    const got = taxiwayLabels([
      seg("C3", [40, 116], [40, 116.001]),
      seg("C3", [40, 116.001], [40, 116.002]),
      seg("C3", [40, 116.002], [40, 116.003]),
    ]);
    expect(got.length).toBe(1);
    expect(got[0].name).toBe("C3");
  });

  test("放在最长那一段上，不是第一段", () => {
    const got = taxiwayLabels([
      seg("C3", [40, 116], [40, 116.0001]), // 短
      seg("C3", [41, 117], [41, 117.01]), // 长
    ]);
    expect(got[0].lat).toBeCloseTo(41, 3);
  });

  // 中点按**长度**取，不按顶点序号：一段折线的顶点可能疏密不均，取中间那个顶点会把
  // 标注甩到一头去。
  test("中点按长度取，不按顶点序号", () => {
    // 顶点：0 → 0.001 → 0.01。中间那个顶点在 0.001，而按长度的中点在 0.005。
    const got = taxiwayLabels([
      seg("C3", [40, 116], [40, 116.001], [40, 116.01]),
    ]);
    expect(got[0].lon).toBeCloseTo(116.005, 3);
  });

  test("多个编号各出一个", () => {
    const got = taxiwayLabels([
      seg("C3", [40, 116], [40, 116.001]),
      seg("D7", [41, 117], [41, 117.001]),
    ]);
    expect(got.map((g) => g.name).sort()).toEqual(["C3", "D7"]);
  });

  // 没名字的、只有一个点的都不标 —— 没有可标的东西，也没有可放的位置。
  test("没名字或点不够的不标", () => {
    const got = taxiwayLabels([
      seg("", [40, 116], [40, 116.001]),
      seg("  ", [40, 116], [40, 116.001]),
      seg("C3", [40, 116]),
    ]);
    expect(got.length).toBe(0);
  });

  // 名字两侧的空白要收掉再分组，否则 `C3` 和 `C3 ` 会各出一个标注。
  test("名字先规范化再分组", () => {
    const got = taxiwayLabels([
      seg("C3", [40, 116], [40, 116.001]),
      seg(" C3 ", [41, 117], [41, 117.01]),
    ]);
    expect(got.length).toBe(1);
    expect(got[0].name).toBe("C3");
  });
});
