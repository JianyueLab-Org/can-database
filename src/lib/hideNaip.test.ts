import { describe, expect, test } from "bun:test";
import { applyHideNaip, hideNaipFromCookie, isEditorPage } from "./hideNaip";

const DB = "http://can-db.test";

describe("hideNaipFromCookie", () => {
  test("reads the flag among other cookies", () => {
    expect(hideNaipFromCookie("a=1; can_hide_naip=1; b=2")).toBe(true);
    expect(hideNaipFromCookie("can_hide_naip=0")).toBe(false);
    expect(hideNaipFromCookie("xcan_hide_naip=1")).toBe(false);
    expect(hideNaipFromCookie(null)).toBe(false);
  });
});

describe("applyHideNaip", () => {
  test("adds unrestricted=1 to reads", () => {
    expect(applyHideNaip(`${DB}/api/v1/aip/airports`, true)).toBe(
      `${DB}/api/v1/aip/airports?unrestricted=1`,
    );
    expect(applyHideNaip(`${DB}/api/v1/aip/route?from=ZGGG`, true)).toBe(
      `${DB}/api/v1/aip/route?from=ZGGG&unrestricted=1`,
    );
  });

  test("does not duplicate the parameter", () => {
    expect(applyHideNaip(`${DB}/api/v1/aip/route?unrestricted=1`, true)).toBe(
      `${DB}/api/v1/aip/route?unrestricted=1`,
    );
  });

  test("leaves the target alone when off", () => {
    const target = `${DB}/api/v1/aip/fixes?fir=ZGZU`;
    expect(applyHideNaip(target, false)).toBe(target);
  });

  test("skips the data editor routes", () => {
    for (const path of [
      "/api/v1/aip/datasets/7/tables/airport/rows?limit=50",
      "/api/v1/aip/datasets/7/revisions?limit=50",
    ]) {
      expect(applyHideNaip(DB + path, true)).toBe(DB + path);
    }
  });
});

describe("isEditorPage", () => {
  test("matches only the edit and revisions pages", () => {
    expect(isEditorPage("/datasets/7/edit")).toBe(true);
    expect(isEditorPage("/datasets/7/revisions")).toBe(true);
    expect(isEditorPage("/datasets")).toBe(false);
    expect(isEditorPage("/airports/ZGGG")).toBe(false);
  });
});
