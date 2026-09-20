import { describe, expect, test } from "bun:test";
import type { Licence } from "@/lib/canDb";
import { toCSV, type Column } from "@/lib/export/serialize";

interface Row {
  icao: string;
  name: string | null;
  lat: number;
}

const COLUMNS: Column<Row>[] = [
  { header: "代号", get: (r) => r.icao },
  { header: "名称", get: (r) => r.name },
  { header: "纬度", get: (r) => r.lat },
];

const RESTRICTED: Licence = {
  redistributable: false,
  restricted: true,
  airac: ["2609"],
  notice: "本文件含有许可受限的航行资料，不得再分发。",
  attributions: [],
};

const OPEN: Licence = {
  redistributable: true,
  restricted: false,
  airac: ["2609"],
  notice: "",
  attributions: [],
};

const OPEN_WITH_ATTRIBUTION: Licence = {
  redistributable: true,
  restricted: false,
  airac: ["2609"],
  notice: "",
  attributions: ["地面线画部分来自 © OpenStreetMap contributors，ODbL 许可。"],
};

describe("toCSV", () => {
  // Windows 的 Excel 不看 BOM 就按本地代码页解，中文列名直接变乱码。
  test("以 UTF-8 BOM 开头", () => {
    expect(toCSV([], COLUMNS, null).startsWith("﻿")).toBe(true);
  });

  test("表头与数据行，CRLF 换行", () => {
    const csv = toCSV(
      [{ icao: "ZBAA", name: "首都", lat: 40.08 }],
      COLUMNS,
      null,
    );
    const lines = csv.replace("﻿", "").split("\r\n");
    expect(lines[0]).toBe("代号,名称,纬度");
    expect(lines[1]).toBe("ZBAA,首都,40.08");
  });

  test("空值留空，不写 null", () => {
    const csv = toCSV(
      [{ icao: "ZBAA", name: null, lat: 40.08 }],
      COLUMNS,
      null,
    );
    expect(csv).toContain("ZBAA,,40.08");
    expect(csv).not.toContain("null");
  });

  // RFC 4180：含逗号、引号或换行的值要加引号，里面的引号写成两个。
  test("引号、逗号、换行都被正确转义", () => {
    const csv = toCSV([{ icao: 'A"B', name: "X,Y", lat: 1 }], COLUMNS, null);
    expect(csv).toContain('"A""B","X,Y",1');
  });

  // 坐标原样输出。四舍五入是算数据，不是渲染 —— 那属于 can-db。
  test("坐标不被四舍五入", () => {
    const csv = toCSV(
      [{ icao: "ZBAA", name: null, lat: 40.080111111 }],
      COLUMNS,
      null,
    );
    expect(csv).toContain("40.080111111");
  });

  test("不可再分发时，警示行在表头之前", () => {
    const csv = toCSV([], COLUMNS, RESTRICTED).replace("﻿", "");
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("# 本文件含有许可受限的航行资料，不得再分发。");
    expect(lines).toContain("# AIRAC 2609");
    expect(lines[lines.findIndex((l) => !l.startsWith("#"))]).toBe(
      "代号,名称,纬度",
    );
  });

  // 可以再分发的时候不印警示——但周期是事实，不是许可表述，仍然要印。
  test("可再分发时只印周期，不印任何许可警示", () => {
    const csv = toCSV([], COLUMNS, OPEN).replace("﻿", "");
    const lines = csv.split("\r\n");
    expect(lines[0]).toBe("# AIRAC 2609");
    expect(csv).not.toContain("不得再分发");
    expect(lines[lines.findIndex((l) => !l.startsWith("#"))]).toBe(
      "代号,名称,纬度",
    );
  });

  // 警示和署名各判各的：可再分发（notice 空）时署名依然要印——ODbL/CC BY-SA
  // 的模式就是「可以传，但必须署名」，而这恰恰是署名最该出现的时候。
  test("可再分发且有署名时，署名照印，警示仍然不印", () => {
    const csv = toCSV([], COLUMNS, OPEN_WITH_ATTRIBUTION).replace("﻿", "");
    const lines = csv.split("\r\n");
    expect(lines).toContain(
      "# 地面线画部分来自 © OpenStreetMap contributors，ODbL 许可。",
    );
    expect(lines).toContain("# AIRAC 2609");
    expect(csv).not.toContain("不得再分发");
    expect(lines[lines.findIndex((l) => !l.startsWith("#"))]).toBe(
      "代号,名称,纬度",
    );
  });

  // licence 为 null 是「不知道」。最保守的做法是**不做任何表述** —— 编一句具体的
  // 警示等于替 can-db 断言了一件它没说过的事。
  test("licence 为 null 时不印任何抬头", () => {
    const csv = toCSV([], COLUMNS, null).replace("﻿", "");
    expect(csv.split("\r\n")[0]).toBe("代号,名称,纬度");
  });
});

import { toJSON, toGeoJSON, type Geometry } from "@/lib/export/serialize";

describe("toJSON", () => {
  // 保留 can-db 的英文键：这一份是给脚本吃的，CSV 那一份才是给人看的。
  test("原样保留行的键名，licence 在顶层", () => {
    const text = toJSON([{ icao: "ZBAA", lat: 40.08 }], RESTRICTED);
    const parsed = JSON.parse(text);
    expect(parsed.data[0].icao).toBe("ZBAA");
    expect(parsed.licence.redistributable).toBe(false);
  });

  test("licence 为 null 时顶层是 null 而不是缺键", () => {
    const parsed = JSON.parse(toJSON([], null));
    expect("licence" in parsed).toBe(true);
    expect(parsed.licence).toBeNull();
  });
});

describe("toGeoJSON", () => {
  const point: Geometry<Row> = { kind: "point", at: (r) => [116.58, r.lat] };

  // GeoJSON 的坐标是 [经度, 纬度]。反过来写是这一类代码最经典的一个错。
  test("坐标是 [lon, lat]", () => {
    const fc = JSON.parse(
      toGeoJSON([{ icao: "ZBAA", name: null, lat: 40.08 }], point, null),
    );
    expect(fc.type).toBe("FeatureCollection");
    expect(fc.features[0].geometry.coordinates).toEqual([116.58, 40.08]);
  });

  // properties 用原始行的英文键，不用调用方 i18n 过的列名——GeoJSON 是给脚本吃
  // 的，键名随界面语言漂移会让同一份导出换个人（换个语言）跑就对不上字段。
  test("属性用原始行的键，licence 在 FeatureCollection 顶层", () => {
    const fc = JSON.parse(
      toGeoJSON(
        [{ icao: "ZBAA", name: "首都", lat: 40.08 }],
        point,
        RESTRICTED,
      ),
    );
    expect(fc.features[0].properties).toEqual({
      icao: "ZBAA",
      name: "首都",
      lat: 40.08,
    });
    expect(fc.licence.notice).toContain("不得再分发");
  });

  // 没有几何的行跳过，而不是写一个 null geometry —— 后者会让 QGIS 报错。
  test("取不到几何的行被跳过", () => {
    const nothing: Geometry<Row> = { kind: "point", at: () => null };
    const fc = JSON.parse(
      toGeoJSON([{ icao: "ZBAA", name: null, lat: 40.08 }], nothing, null),
    );
    expect(fc.features).toEqual([]);
  });

  test("线几何写成 LineString，坐标逐点比对", () => {
    const linePath: Array<[number, number]> = [
      [116.5, 40.0],
      [116.6, 40.1],
    ];
    const line: Geometry<Row> = { kind: "line", path: () => linePath };
    const fc = JSON.parse(
      toGeoJSON([{ icao: "ZBAA", name: null, lat: 40.08 }], line, null),
    );
    expect(fc.features[0].geometry.type).toBe("LineString");
    expect(fc.features[0].geometry.coordinates).toEqual(linePath);
  });

  // 少于两个点画不成线。
  test("线几何点数不足两个时跳过", () => {
    const line: Geometry<Row> = { kind: "line", path: () => [[116.5, 40.0]] };
    const fc = JSON.parse(
      toGeoJSON([{ icao: "ZBAA", name: null, lat: 40.08 }], line, null),
    );
    expect(fc.features).toEqual([]);
  });

  // 断口处断开：一条程序在没有坐标的点上被切成两段，而不是连过去画出一条假线。
  test("多段线写成 MultiLineString", () => {
    const multiline: Geometry<Row> = {
      kind: "multiline",
      paths: () => [
        [
          [116.5, 40.0],
          [116.6, 40.1],
        ],
        [
          [116.7, 40.2],
          [116.8, 40.3],
          [116.9, 40.4],
        ],
      ],
    };
    const fc = JSON.parse(
      toGeoJSON([{ icao: "ZBAA", name: null, lat: 40.08 }], multiline, null),
    );
    expect(fc.features[0].geometry.type).toBe("MultiLineString");
    expect(fc.features[0].geometry.coordinates).toHaveLength(2);
    expect(fc.features[0].geometry.coordinates[0]).toEqual([
      [116.5, 40.0],
      [116.6, 40.1],
    ]);
  });

  // 不足两点的段本身画不成线，被丢掉——其余段照常画。
  test("多段线里不足两点的段被丢弃", () => {
    const multiline: Geometry<Row> = {
      kind: "multiline",
      paths: () => [
        [[116.5, 40.0]],
        [
          [116.7, 40.2],
          [116.8, 40.3],
        ],
      ],
    };
    const fc = JSON.parse(
      toGeoJSON([{ icao: "ZBAA", name: null, lat: 40.08 }], multiline, null),
    );
    expect(fc.features[0].geometry.coordinates).toHaveLength(1);
  });

  // 一段也不剩：整行跳过，不是写一个空的 MultiLineString。
  test("多段线一段都不剩时整行被跳过", () => {
    const multiline: Geometry<Row> = {
      kind: "multiline",
      paths: () => [[[116.5, 40.0]], [[116.7, 40.2]]],
    };
    const fc = JSON.parse(
      toGeoJSON([{ icao: "ZBAA", name: null, lat: 40.08 }], multiline, null),
    );
    expect(fc.features).toEqual([]);
  });
});
