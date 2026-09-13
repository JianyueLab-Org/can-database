import { describe, expect, test } from "bun:test";
import {
  drawOrder,
  ownerColor,
  sectorPaint,
  sectorState,
  spread,
} from "@/lib/sectorMap";
import type { NetworkSector, SectorOwnership } from "@/lib/canDb";

const sector = (over: Partial<NetworkSector> = {}): NetworkSector => ({
  id: 1,
  package: "ZBPE",
  name: "S_ZBAA_TWR_0_1800",
  seq: 0,
  floorFt: 0,
  ceilingFt: 1800,
  facility: "TWR",
  shape: "polygon",
  centreLat: null,
  centreLon: null,
  radiusNm: null,
  vertices: [],
  owners: [],
  depAirports: [],
  arrAirports: [],
  activeRunways: [],
  alsoIn: null,
  ...over,
});

const own = (over: Partial<SectorOwnership> = {}): SectorOwnership => ({
  id: 1,
  name: "S_ZBAA_TWR_0_1800",
  package: "ZBPE",
  owner: null,
  rank: null,
  uncovered: true,
  ...over,
});

/**
 * **三种状态，不是两种。**
 *
 * can-db 显式返回 `uncovered` 的理由是「没人管」和「没查到」在地图上长得一样，而它们是
 * 两件事。这里再加一件：**还没解析过**。把没解析过的画成「没人管」，等于在用户还没输入
 * 任何在线名单时就告诉他全网一块都没人管。
 */
describe("sectorState", () => {
  test("没有解析结果 = 还没解析过，不是没人管", () => {
    expect(sectorState(undefined)).toBe("unresolved");
    expect(sectorState(null)).toBe("unresolved");
  });

  test("uncovered 为真 = 没人管", () => {
    expect(sectorState(own({ uncovered: true }))).toBe("uncovered");
  });

  test("有 owner = 有人管", () => {
    expect(
      sectorState(own({ owner: "ZBAA_TWR", rank: 0, uncovered: false })),
    ).toBe("owned");
  });

  // 防守一种接口层面的矛盾：uncovered=false 却没有 owner。按「没人管」处理，
  // 因为把一块无主的扇区画成有人管，是这张图上最危险的一种谎。
  test("uncovered 为假但没有 owner，仍然按没人管处理", () => {
    expect(sectorState(own({ owner: null, uncovered: false }))).toBe(
      "uncovered",
    );
  });
});

describe("sectorPaint", () => {
  test("三种状态画出来互不相同", () => {
    const unresolved = sectorPaint(undefined, "#123456");
    const uncovered = sectorPaint(own({ uncovered: true }), "#123456");
    const owned = sectorPaint(
      own({ owner: "ZBAA_CTR", rank: 0, uncovered: false }),
      "#123456",
    );

    // 没解析过：包色，淡填充，实线
    expect(unresolved.color).toBe("#123456");
    expect(unresolved.fillOpacity).toBeGreaterThan(0);
    expect(unresolved.dashArray).toBeUndefined();

    // 没人管：红虚线，**不填充** —— 填充了就和「有人管」只差一个色相
    expect(uncovered.dashArray).toBeDefined();
    expect(uncovered.fillOpacity).toBe(0);

    // 有人管：跟着呼号的颜色，半透明填充
    expect(owned.fillOpacity).toBeGreaterThan(0);
    expect(owned.color).toBe(ownerColor("ZBAA_CTR"));
    expect(owned.dashArray).toBeUndefined();
  });
});

describe("ownerColor", () => {
  test("同一个呼号永远同一色", () => {
    expect(ownerColor("ZBAA_CTR")).toBe(ownerColor("ZBAA_CTR"));
  });

  test("不同呼号基本不撞色", () => {
    const calls = [
      "ZBAA_CTR",
      "ZBAA_APP",
      "ZBAA_TWR",
      "ZGGG_CTR",
      "RJTG_CTR",
      "RKRR_CTR",
      "ZSHA_APP",
      "PRC_FSS",
    ];
    const hues = new Set(calls.map(ownerColor));
    // 不要求 8 个全不同（哈希撞色是可能的），但撞成一团就说明散列坏了
    expect(hues.size).toBeGreaterThanOrEqual(7);
  });
});

describe("spread / drawOrder", () => {
  const big = sector({
    id: 1,
    vertices: [
      [30, 100],
      [40, 100],
      [40, 120],
      [30, 120],
      [30, 100],
    ],
  });
  const small = sector({
    id: 2,
    vertices: [
      [39, 116],
      [40, 116],
      [40, 117],
      [39, 117],
      [39, 116],
    ],
  });
  const circle = sector({
    id: 3,
    shape: "circle",
    vertices: [],
    centreLat: 40,
    centreLon: 116,
    radiusNm: 5,
  });

  test("圆按半径量，多边形按包围盒量", () => {
    expect(spread(big)).toBeCloseTo(200, 6);
    expect(spread(small)).toBeCloseTo(1, 6);
    expect(spread(circle)).toBeCloseTo(25, 6);
  });

  test("顶点为空的多边形是 0，不是 NaN", () => {
    // 空顶点会让 min/max 的初值原样返回，算出 (−90−90)×(−180−180) 这种负数或 NaN，
    // 而排序拿到 NaN 的结果是未定义的 —— 那会让整张图的画序随实现而变。
    expect(spread(sector({ vertices: [] }))).toBe(0);
  });

  test("大的排在前面，所以小的后画、点得到", () => {
    expect(drawOrder([small, big, circle]).map((s) => s.id)).toEqual([1, 3, 2]);
  });

  test("不原地改传进来的数组 —— 那是缓存里的那一份", () => {
    const input = [small, big];
    drawOrder(input);
    expect(input.map((s) => s.id)).toEqual([2, 1]);
  });
});
