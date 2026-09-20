import { describe, expect, test } from "bun:test";
import { exportFilename } from "@/lib/export/download";

describe("exportFilename", () => {
  test("资源、场、周期、日期", () => {
    expect(
      exportFilename(
        "stands",
        "ZBAA",
        ["2609"],
        "csv",
        new Date("2026-09-20T00:00:00Z"),
      ),
    ).toBe("stands_ZBAA_2609_20260920.csv");
  });

  test("没有场的时候不留空段", () => {
    expect(
      exportFilename(
        "datasets",
        null,
        ["2609"],
        "json",
        new Date("2026-09-20T00:00:00Z"),
      ),
    ).toBe("datasets_2609_20260920.json");
  });

  // 一份导出可能横跨两期 —— 文件名要说清楚，不能只写最新的那一期。
  test("多个周期用连字符连起来", () => {
    expect(
      exportFilename(
        "fixes",
        null,
        ["2609", "2608"],
        "csv",
        new Date("2026-09-20T00:00:00Z"),
      ),
    ).toBe("fixes_2609-2608_20260920.csv");
  });

  test("周期未知时写 unknown", () => {
    expect(
      exportFilename(
        "fixes",
        null,
        [],
        "csv",
        new Date("2026-09-20T00:00:00Z"),
      ),
    ).toBe("fixes_unknown_20260920.csv");
  });
});
