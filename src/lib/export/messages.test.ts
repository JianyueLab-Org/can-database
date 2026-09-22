import { describe, expect, test } from "bun:test";
import { buildNavigation } from "@/lib/nav";
import { getMessages, useTranslations, type Locale } from "@/lib/i18n";

const locales: Locale[] = ["en-us", "ja-jp", "zh-cn", "zh-tw"];
const keys = [
  "title",
  "description",
  "selectAll",
  "clear",
  "unsupported",
  "loading",
  "optionsError",
  "empty",
  "download",
  "retry",
  "submitting",
  "selected",
  "resource",
  "selectGroupFormat",
  ...["airport", "navigation", "ground", "airspace", "network"].map(
    (id) => `groups.${id}`,
  ),
  ...["json", "csv", "geojson", "osm"].map((id) => `formats.${id}`),
  ...[
    "airports",
    "runways",
    "stands",
    "procedures",
    "terminal-waypoints",
    "terminal-holdings",
    "comms",
    "ils",
    "fixes",
    "airways",
    "navaids",
    "mora",
    "flight-routes",
    "route-restrictions",
    "enroute-holdings",
    "ground-features",
    "ground-lines",
    "airspaces",
    "network-positions",
    "network-sectors",
  ].map((id) => `resources.${id}`),
];

describe("export page locale contract", () => {
  for (const locale of locales) {
    test(`${locale} resolves every export label and status`, () => {
      const t = useTranslations(locale, "exportPage");
      expect(
        Object.keys(getMessages(locale, "exportPage")).length,
      ).toBeGreaterThan(0);
      for (const key of keys) {
        expect(t(key)).not.toBe(key);
        expect(t(key).trim()).not.toBe("");
      }
      for (const key of ["download", "submitting", "selected"]) {
        expect(t(key, { count: 7 })).toContain("7");
        expect(t(key, { count: 7 })).not.toContain("{count}");
      }
      expect(
        t("selectGroupFormat", { group: "GROUP", format: "FORMAT" }),
      ).toContain("GROUP");
      expect(
        t("selectGroupFormat", { group: "GROUP", format: "FORMAT" }),
      ).toContain("FORMAT");
    });

    test(`${locale} exposes the localized export page to console access levels`, () => {
      const t = useTranslations(locale);
      expect(t("nav.export")).not.toBe("nav.export");
      for (const access of [2, 4]) {
        expect(
          buildNavigation(t, access).filter((item) => item.href === "/export"),
        ).toEqual([
          { name: t("nav.export"), href: "/export", icon: "arrowDownTray" },
        ]);
      }
    });
  }
});
