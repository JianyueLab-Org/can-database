import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { buildNavigation } from "./nav";

const t = (key: string) => key;

describe("buildNavigation", () => {
  test("Overview, then Data, Tools, Maintenance", () => {
    const nav = buildNavigation(t);
    expect(nav.map((item) => item.name)).toEqual([
      "nav.overview",
      "nav.groups.data",
      "nav.groups.tools",
      "nav.groups.maintenance",
    ]);
    expect(nav[0].href).toBe("/");
    expect(nav.slice(1).map((g) => g.children?.map((c) => c.href))).toEqual([
      ["/airports", "/fixes", "/positions"],
      ["/map", "/route"],
      ["/datasets", "/export"],
    ]);
  });
});

describe("nav dictionary", () => {
  const read = (locale: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../language/${locale}.json`, import.meta.url),
        "utf8",
      ),
    ).nav;

  test("en-us nav has no CJK", () => {
    expect(JSON.stringify(read("en-us"))).not.toMatch(/[぀-ヿ一-鿿]/);
  });

  test("every locale has the same nav keys", () => {
    const keys = (locale: string) => Object.keys(read(locale)).sort();
    for (const locale of ["zh-tw", "en-us", "ja-jp"]) {
      expect(keys(locale)).toEqual(keys("zh-cn"));
    }
  });

  test("zh-tw and ja-jp are not the zh-cn strings", () => {
    for (const locale of ["zh-tw", "ja-jp"]) {
      expect(read(locale).overview).not.toBe(read("zh-cn").overview);
    }
  });
});
