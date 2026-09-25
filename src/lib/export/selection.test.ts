import { describe, expect, test } from "bun:test";
import type { Locale } from "@/lib/i18n";
import type { ExportOptions } from "@/lib/export/options";
import {
  buildExportSearch,
  createDefaultSelection,
  normalizeSelection,
  parseAirportScope,
  toggleGroupFormat,
} from "@/lib/export/selection";

const optionsFixture: ExportOptions = {
  groups: [
    {
      id: "airport",
      resources: [
        {
          id: "airports",
          formats: ["json", "csv", "osm"],
          airportScoped: true,
        },
        { id: "procedures", formats: ["json", "csv"], airportScoped: true },
      ],
    },
    {
      id: "ground",
      resources: [
        {
          id: "ground-features",
          formats: ["json", "osm"],
          airportScoped: true,
        },
      ],
    },
  ],
  locales: ["en-us", "zh-cn"],
  defaultLocale: "en-us",
  limits: {
    includePairs: 128,
    records: 500_000,
    coordinates: 2_000_000,
    archiveEntries: 256,
  },
};

describe("export selection helpers", () => {
  test("defaults every resource to JSON only", () => {
    const selected = createDefaultSelection(optionsFixture);

    expect([...selected]).toEqual([
      "airports.json",
      "procedures.json",
      "ground-features.json",
    ]);
  });

  test("enables a format only for compatible resources in one group", () => {
    const selected = toggleGroupFormat(
      optionsFixture,
      new Set(["procedures.json"]),
      "airport",
      "osm",
      true,
    );

    expect([...selected]).toEqual(["airports.osm", "procedures.json"]);
    expect(selected.has("procedures.osm")).toBe(false);
  });

  test("disables a group format without changing other groups", () => {
    const selected = toggleGroupFormat(
      optionsFixture,
      new Set([
        "airports.json",
        "airports.osm",
        "ground-features.osm",
        "unknown.json",
      ]),
      "airport",
      "osm",
      false,
    );

    expect([...selected]).toEqual(["airports.json", "ground-features.osm"]);
  });

  test("normalizes unknown and unsupported pairs in options order", () => {
    const selected = normalizeSelection(
      optionsFixture,
      new Set([
        "ground-features.osm",
        "not-a-resource.json",
        "procedures.osm",
        "airports.json",
        "broken",
      ]),
    );

    expect([...selected]).toEqual(["airports.json", "ground-features.osm"]);
  });

  test("does not mutate the input selection", () => {
    const input = new Set(["airports.json"]);

    toggleGroupFormat(optionsFixture, input, "airport", "osm", true);

    expect([...input]).toEqual(["airports.json"]);
  });

  test("builds repeated includes and locale in sorted order", () => {
    const query = buildExportSearch(
      new Set(["ground-features.osm", "airports.json"]),
      "zh-cn" as Locale,
      [" zspd ", "zbaa", "ZSPD", ""],
    );

    expect(query.getAll("include")).toEqual([
      "airports.json",
      "ground-features.osm",
    ]);
    expect(query.get("locale")).toBe("zh-cn");
    expect(query.getAll("airport")).toEqual(["ZBAA", "ZSPD"]);
    expect([...query.keys()]).toEqual([
      "include",
      "include",
      "airport",
      "airport",
      "locale",
    ]);
  });

  test("retains an explicit blank airport parameter as invalid while normalizing valid codes", () => {
    expect(parseAirportScope([" zspd ", "", "ZBAA"])).toEqual({
      airports: ["ZBAA", "ZSPD"],
      hasInvalidBlank: true,
    });
  });
});
