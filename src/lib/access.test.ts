import { describe, expect, test } from "bun:test";
import { consoleNoAccess } from "./access";

describe("consoleNoAccess", () => {
  test("call-only and none are refused", () => {
    for (const level of [0, 1, 3]) {
      expect(consoleNoAccess(level)).toEqual({
        kind: "permission",
        name: "aipAccess",
      });
    }
  });

  test("browse and manage get in", () => {
    for (const level of [2, 4, 5]) {
      expect(consoleNoAccess(level)).toBeNull();
    }
  });
});
