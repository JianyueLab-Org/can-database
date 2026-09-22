import { describe, expect, test } from "bun:test";
import { airportExportHref } from "@/lib/export/airportLink";

describe("airport export link", () => {
  test("opens the shared export page with one encoded airport selection", () => {
    expect(airportExportHref("ZSPD")).toBe("/export?airport=ZSPD");
  });
});
