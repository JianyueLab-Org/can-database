import { expect, test } from "bun:test";
import {
  passThroughHeaders,
  upstreamTarget,
  upstreamTimeout,
} from "./[...path]";

test("archive export uses the dedicated timeout", () => {
  expect(upstreamTimeout("aip/export")).toBe(120_000);
  expect(upstreamTimeout("aip/export/options")).toBe(15_000);
  expect(upstreamTimeout("aip/airports")).toBe(15_000);
});

test("archive export preserves the complete search string", () => {
  expect(
    upstreamTarget(
      "https://api-db.example.test",
      "aip/export",
      "?fir=ZB%2B%26&tag=upper+air&empty=&repeated=x&repeated=y",
    ),
  ).toBe(
    "https://api-db.example.test/api/v1/aip/export?fir=ZB%2B%26&tag=upper+air&empty=&repeated=x&repeated=y",
  );
});

test("export response forwards disposition", () => {
  const headers = passThroughHeaders(
    new Headers({
      "content-type": "application/zip",
      "content-disposition": 'attachment; filename="x.zip"',
      "cache-control": "private, no-store",
    }),
  );
  expect(headers.get("content-disposition")).toBe(
    'attachment; filename="x.zip"',
  );
});
