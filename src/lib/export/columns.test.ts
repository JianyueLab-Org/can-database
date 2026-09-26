import { describe, expect, test } from "bun:test";
import { splitAtGaps, TABLES } from "@/lib/export/columns";
import { toGeoJSON } from "@/lib/export/serialize";

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

/**
 * 一行「形状真实」的代表性数据，per 表。
 *
 * 字段名照着 `src/lib/canDb.ts` 的类型写——**runways 是例外**：那张表的列定义读
 * 的不是 `canDb.ts` 的 `Runway`，是 `[icao].astro` 里几何表和物理表按代号合并
 * 出来的行（`ident`/`opposite`/`hdg`/`lat`/`lon`/`endLat`/`endLon`/`lengthM`/
 * …），这里照那份合并行的真实形状写，不是照 `Runway`。这条注释本身就是 FIX 1
 * 的教训：字段名要查实际消费者，不能照抄类型名或照抄计划文字——`endLat`/
 * `endLon` 确实存在，第一版漏掉它们是没查 `Runway` 接口，不是它们真的不存在。
 */
const SAMPLE_ROWS: Record<string, unknown> = {
  airports: {
    icao: "ZBAA",
    fir: "ZBAA",
    name: "北京首都",
    lat: 40.08,
    lon: 116.58,
    elev: 35,
    variation: -6.2,
    airac: "2609",
  },
  runways: {
    ident: "18L",
    opposite: "36R",
    hdg: 184,
    lat: 40.08,
    lon: 116.58,
    endLat: 40.12,
    endLon: 116.6,
    lengthM: 3800,
    widthM: 60,
    surface: "沥青",
    strength: "PCN80",
    strengthDesc: "重载",
    trueBrg: 183.5,
    thrElevM: 35,
  },
  stands: {
    name: "101",
    lat: 40.081,
    lon: 116.581,
    hdg: 90,
    span: 36,
  },
  procedures: {
    kind: "sid",
    name: "LAND1A",
    runway: "18L",
    runways: "18L,18R",
    chart: null,
    variant: null,
    points: ["ABCDE", "FGHIJ"],
    path: [
      {
        ident: "ABCDE",
        lat: 40.0,
        lon: 116.0,
        path: null,
        transition: null,
        routeType: null,
        alt: null,
        speedKt: null,
        speedKind: null,
        turn: null,
        courseMag: null,
        vpaDeg: null,
        flyover: null,
        isMap: null,
        part: null,
      },
      {
        ident: "FGHIJ",
        lat: 40.1,
        lon: 116.1,
        path: null,
        transition: null,
        routeType: null,
        alt: null,
        speedKt: null,
        speedKind: null,
        turn: null,
        courseMag: null,
        vpaDeg: null,
        flyover: null,
        isMap: null,
        part: null,
      },
    ],
  },
  fixes: {
    ident: "ABCDE",
    lat: 40.0,
    lon: 116.0,
    fir: "ZBAA",
    region: "ZB",
    pointKind: "waypoint",
  },
  positions: {
    callsign: "ZBAA_TWR",
    radioName: null,
    freqMhz: 118.5,
    identifier: "TW",
    middleLetter: null,
    prefix: null,
    facility: "TWR",
    squawkStart: "0100",
    squawkEnd: "0177",
    package: "ZBAA",
    alsoIn: null,
    visibilityPoints: 0,
  },
  datasets: {
    id: 1,
    airac: "2609",
    state: "active",
    redistributable: true,
    createdAt: "2026-01-01T00:00:00Z",
    activatedAt: "2026-01-02T00:00:00Z",
    airports: 233,
    minAccess: 1,
  },
};

/** 递归找坐标数组里有没有 null/undefined 元素——[[lon,null]] 这类非法坐标。 */
function hasNullCoord(value: unknown): boolean {
  if (value === null || value === undefined) return true;
  if (Array.isArray(value)) return value.some(hasNullCoord);
  return false;
}

// FIX 1 的教训钉成测试：字段名对不上时，列会静默产出 undefined，几何会静默产出
// [[lon,lat],[null,null]]——两者都不报错。这条测试就是当初会让 FIX 1 变红的那条。
describe("TABLES", () => {
  for (const [resource, spec] of Object.entries(TABLES)) {
    const row = SAMPLE_ROWS[resource];
    if (row === undefined) {
      throw new Error(`SAMPLE_ROWS 缺 "${resource}" 这张表的代表性数据`);
    }

    test(`${resource}：每一列都取得到值，不是 undefined`, () => {
      for (const column of spec.columns) {
        const value = column.get(row);
        expect(value).not.toBeUndefined();
      }
    });

    if (spec.geometry) {
      const geometry = spec.geometry;
      test(`${resource}：几何取到的坐标里没有 null 元素`, () => {
        let coords: unknown;
        if (geometry.kind === "point") coords = geometry.at(row);
        else if (geometry.kind === "line") coords = geometry.path(row);
        else coords = geometry.paths(row);

        expect(coords).not.toBeUndefined();
        if (coords !== null) expect(hasNullCoord(coords)).toBe(false);
      });
    }
  }
});

/**
 * 跑道几何补回来之后的两个边界，各自钉一条测试。
 *
 * 用 `toGeoJSON` 而不是直接调 `geometry.path`：要验证的是「缺对端坐标的行被整
 * 行跳过」这个 `toGeoJSON` 里的行为，不是几何回调本身——回调返回 `null` 只是
 * 半句话，`toGeoJSON` 拿到 `null` 之后真的把这一行丢掉才是 FIX 1/这次改正一起
 * 要的效果。
 */
describe("runways 几何", () => {
  const geometry = TABLES.runways.geometry!;

  test("四个坐标齐全时出 LineString，坐标深比对", () => {
    const row = SAMPLE_ROWS.runways as Record<string, unknown>;
    const fc = JSON.parse(toGeoJSON([row], geometry, null));
    expect(fc.features).toHaveLength(1);
    expect(fc.features[0].geometry).toEqual({
      type: "LineString",
      coordinates: [
        [row.lon, row.lat],
        [row.endLon, row.endLat],
      ],
    });
  });

  test("只有物理数据（四个坐标全 null）时整行被跳过", () => {
    const physicalOnly = {
      ...(SAMPLE_ROWS.runways as Record<string, unknown>),
      lat: null,
      lon: null,
      endLat: null,
      endLon: null,
    };
    const fc = JSON.parse(toGeoJSON([physicalOnly], geometry, null));
    expect(fc.features).toEqual([]);
  });
});
