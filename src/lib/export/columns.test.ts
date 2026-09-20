import { describe, expect, test } from "bun:test";
import { splitAtGaps } from "@/lib/export/columns";

describe("splitAtGaps", () => {
  // 中间断口把一条程序切成两段，而不是连过去画出一条穿过缺口的假线。
  test("中间有断口时切成两段", () => {
    const segments = splitAtGaps([
      { lat: 40.0, lon: 116.5 },
      { lat: 40.1, lon: 116.6 },
      { lat: null, lon: null },
      { lat: 40.3, lon: 116.8 },
      { lat: 40.4, lon: 116.9 },
    ]);
    expect(segments).toEqual([
      [
        [116.5, 40.0],
        [116.6, 40.1],
      ],
      [
        [116.8, 40.3],
        [116.9, 40.4],
      ],
    ]);
  });

  // 首尾的断口不产生空段——不是「切出三段，两头是空的」。
  test("首尾的 null 不产生空段", () => {
    const segments = splitAtGaps([
      { lat: null, lon: null },
      { lat: 40.0, lon: 116.5 },
      { lat: 40.1, lon: 116.6 },
      { lat: null, lon: null },
    ]);
    expect(segments).toEqual([
      [
        [116.5, 40.0],
        [116.6, 40.1],
      ],
    ]);
  });

  // 全是断口时一段都拼不出来。
  test("全是 null 时返回空数组", () => {
    const segments = splitAtGaps([
      { lat: null, lon: null },
      { lat: null, lon: null },
    ]);
    expect(segments).toEqual([]);
  });

  // 坐标顺序是 [经度, 纬度]，和输入的 {lat, lon} 顺序相反——GeoJSON 的规矩。
  test("坐标顺序是 [lon, lat]", () => {
    const segments = splitAtGaps([
      { lat: 40.08, lon: 116.58 },
      { lat: 40.09, lon: 116.59 },
    ]);
    expect(segments[0][0]).toEqual([116.58, 40.08]);
  });
});
