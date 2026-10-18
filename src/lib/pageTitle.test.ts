import { expect, test } from "bun:test";
import { pageTitle } from "./pageTitle";

test("page · site, localised", () => {
  expect(pageTitle("Fixes", "en-us")).toBe("Fixes · Aeronautical Data");
  expect(pageTitle("航路点", "zh-cn")).toBe("航路点 · 航行资料库");
});

test("root page is the site name alone", () => {
  expect(pageTitle(undefined, "zh-tw")).toBe("航行資料庫");
});
