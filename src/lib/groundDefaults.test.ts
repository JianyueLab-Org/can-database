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
  "shoulder",
  "runway_marking",
  "taxiway_label",
];

describe("defaultFeatureLayers", () => {
  test("滑行道、机坪、等待位置、航站楼、机场轮廓默认开", () => {
    const on = defaultFeatureLayers(KINDS);
    expect(on.taxiway).toBe(true);
    expect(on.apron).toBe(true);
    expect(on.holding_position).toBe(true);
    expect(on.terminal).toBe(true);
    expect(on.aerodrome).toBe(true);
  });

  test("道肩、跑道标志、滑行道标注默认开", () => {
    const on = defaultFeatureLayers(KINDS);
    expect(on.shoulder).toBe(true);
    expect(on.runway_marking).toBe(true);
    expect(on.taxiway_label).toBe(true);
  });

  test("机位和跑道默认关", () => {
    const on = defaultFeatureLayers(KINDS);
    expect(on.parking_position).toBe(false);
    expect(on.runway).toBe(false);
  });

  test("每一类都要有明确的开关，不能留 undefined", () => {
    const on = defaultFeatureLayers(KINDS);
    for (const k of KINDS) expect(typeof on[k]).toBe("boolean");
  });
});
