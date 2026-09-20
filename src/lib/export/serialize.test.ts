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

  // 可以再分发的时候什么都不印。绝不补一句「本文件可自由使用」。
  test("可再分发时不印任何许可正面表述", () => {
    const csv = toCSV([], COLUMNS, OPEN).replace("﻿", "");
    expect(csv.split("\r\n")[0]).toBe("代号,名称,纬度");
  });

  // licence 为 null 是「不知道」。最保守的做法是**不做任何表述** —— 编一句具体的
  // 警示等于替 can-db 断言了一件它没说过的事。
  test("licence 为 null 时不印任何抬头", () => {
    const csv = toCSV([], COLUMNS, null).replace("﻿", "");
    expect(csv.split("\r\n")[0]).toBe("代号,名称,纬度");
  });
});
