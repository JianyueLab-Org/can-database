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
  const dict = (locale: string) =>
    JSON.parse(
      readFileSync(
        new URL(`../../language/${locale}.json`, import.meta.url),
        "utf8",
      ),
    );
  const read = (locale: string) => dict(locale).nav;
  const flatten = (value: unknown, prefix = ""): string[] =>
    value !== null && typeof value === "object"
      ? Object.entries(value).flatMap(([k, v]) =>
          flatten(v, prefix ? `${prefix}.${k}` : k),
        )
      : [prefix];

  test("en-us nav has no CJK", () => {
    expect(JSON.stringify(read("en-us"))).not.toMatch(/[぀-ヿ一-鿿]/);
  });

  test("en-us airports, fixes, datasets and common have no CJK", () => {
    const en = dict("en-us");
    for (const ns of ["airports", "fixes", "datasets", "common"]) {
      expect(JSON.stringify(en[ns])).not.toMatch(/[぀-ヿ一-鿿]/);
    }
  });

  test("every locale has the same nav keys, groups included", () => {
    const keys = (locale: string) => flatten(read(locale)).sort();
    for (const locale of ["zh-tw", "en-us", "ja-jp"]) {
      expect(keys(locale)).toEqual(keys("zh-cn"));
    }
  });

  test("zh-tw and ja-jp translate the list-page strings", () => {
    const keys = [
      "airports.title",
      "airports.description",
      "airports.empty",
      "airports.variation",
      "airports.airac",
      "airports.coords",
      "airports.runways",
      "airports.notFound",
      "airports.noElev",
      "airports.magneticNote",
      "fixes.title",
      "fixes.pick",
      "fixes.count",
      "fixes.empty",
      "fixes.coords",
      "datasets.title",
      "datasets.description",
      "datasets.created",
      "datasets.yes",
      "datasets.no",
      "common.loading",
      "common.error",
    ];
    const get = (locale: string, path: string) =>
      path.split(".").reduce((o, k) => o[k], dict(locale));
    // Same characters in both scripts, so the zh-cn string is also correct.
    const shared: Record<string, string[]> = {
      "zh-tw": [
        "airports.variation",
        "airports.runways",
        "airports.noElev",
        "datasets.yes",
        "datasets.no",
      ],
      "ja-jp": [],
    };
    for (const locale of ["zh-tw", "ja-jp"]) {
      for (const key of keys.filter((k) => !shared[locale].includes(k))) {
        expect(get(locale, key)).not.toBe(get("zh-cn", key));
      }
    }
  });

  test("zh-tw and ja-jp are not the zh-cn strings", () => {
    for (const locale of ["zh-tw", "ja-jp"]) {
      for (const key of ["overview", "airports", "fixes", "datasets"]) {
        expect(read(locale)[key]).not.toBe(read("zh-cn")[key]);
      }
    }
  });
});
