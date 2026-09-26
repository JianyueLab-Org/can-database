import { describe, expect, test } from "bun:test";
import {
  airportsQuery,
  bboxParam,
  fixRowKey,
  lonNear,
  segmentIdents,
  wrapLon,
} from "@/lib/viewport";
import type { AirwaySegment, Fix } from "@/lib/canDb";

describe("bboxParam", () => {
  test("plain box", () => {
    expect(bboxParam({ south: 20, west: 100, north: 40, east: 120 })).toBe(
      "20,100,40,120",
    );
  });

  test("pad grows the box and clamps latitude", () => {
    expect(bboxParam({ south: 70, west: 100, north: 85, east: 120 }, 0.5)).toBe(
      "62.5,90,90,130",
    );
  });

  test("box across 180 gives minLon > maxLon", () => {
    expect(bboxParam({ south: 30, west: 170, north: 50, east: 190 })).toBe(
      "30,170,50,-170",
    );
  });

  test("box panned a whole turn west is wrapped", () => {
    expect(bboxParam({ south: 0, west: -250, north: 10, east: -230 })).toBe(
      "0,110,10,130",
    );
  });

  test("box ending exactly at 180 does not cross", () => {
    expect(bboxParam({ south: 0, west: 170, north: 10, east: 180 })).toBe(
      "0,170,10,180",
    );
  });

  test("360 degrees or wider is the whole world", () => {
    expect(bboxParam({ south: -60, west: -300, north: 60, east: 200 })).toBe(
      "-60,-180,60,180",
    );
  });
});

describe("lonNear / wrapLon", () => {
  test("wrapLon folds into [-180, 180)", () => {
    expect(wrapLon(190)).toBe(-170);
    expect(wrapLon(-190)).toBe(170);
    expect(wrapLon(180)).toBe(-180);
  });

  test("lonNear moves a point to the reference's side", () => {
    expect(lonNear(-175, 178)).toBe(185);
    expect(lonNear(175, -178)).toBe(-185);
    expect(lonNear(100, 110)).toBe(100);
  });
});

describe("segmentIdents", () => {
  const base: AirwaySegment = {
    airway: "A1",
    from: "AKAGI@RJ/waypoint",
    to: "BOKAP@RK/waypoint",
    dir: "both",
    minAlt: null,
    maxAlt: null,
  };

  test("uses fromIdent/toIdent when present", () => {
    expect(
      segmentIdents({ ...base, fromIdent: "AKAGI", toIdent: "BOKAP" }),
    ).toEqual({ from: "AKAGI", to: "BOKAP" });
  });

  test("falls back to from/to on an older can-db", () => {
    expect(segmentIdents({ ...base, from: "AKAGI", to: "BOKAP" })).toEqual({
      from: "AKAGI",
      to: "BOKAP",
    });
  });
});

describe("airportsQuery", () => {
  test("empty filter is no query string", () => {
    expect(airportsQuery({})).toBe("");
  });

  test("carries filters, limit and cursor", () => {
    expect(
      airportsQuery({
        q: " zb ",
        fir: "ZBPE",
        region: "zb",
        limit: 200,
        cursor: "WkJBQQ",
      }),
    ).toBe("q=zb&fir=ZBPE&region=ZB&limit=200&cursor=WkJBQQ");
  });

  test("drops a malformed region", () => {
    expect(airportsQuery({ region: "Z" })).toBe("");
    expect(airportsQuery({ region: "1A" })).toBe("");
  });
});

describe("fixRowKey", () => {
  const fix = (over: Partial<Fix>): Fix => ({
    ident: "AKAGI",
    lat: 36,
    lon: 139,
    fir: null,
    region: "RJ",
    pointKind: "waypoint",
    ...over,
  });

  test("two rows sharing an ident get different keys", () => {
    expect(fixRowKey(fix({}))).not.toBe(
      fixRowKey(fix({ region: "ZL", lat: 38, lon: 104 })),
    );
    expect(fixRowKey(fix({}))).not.toBe(
      fixRowKey(fix({ pointKind: "terminal" })),
    );
  });
});
