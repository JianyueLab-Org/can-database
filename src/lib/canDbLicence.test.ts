import { afterEach, describe, expect, test } from "bun:test";
import { api } from "@/lib/canDb";

const realFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = realFetch;
});

function stub(body: unknown, status = 200) {
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

describe("api() 透出 licence", () => {
  test("信封里有 licence 就带出来", async () => {
    stub({
      status: "success",
      data: [{ icao: "ZBAA" }],
      licence: {
        redistributable: false,
        restricted: true,
        airac: ["2609"],
        notice: "本文件含有许可受限的航行资料，不得再分发。",
        attributions: [],
      },
    });
    const result = await api<unknown[]>("/api/v1/aip/airports");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.licence?.redistributable).toBe(false);
    expect(result.licence?.airac).toEqual(["2609"]);
  });

  test("信封里没有 licence 就是 null", async () => {
    stub({ status: "success", data: [] });
    const result = await api<unknown[]>("/api/v1/aip/airports");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.licence).toBeNull();
  });

  test("信封里 licence 显式为 null 就是 null", async () => {
    stub({ status: "success", data: [], licence: null });
    const result = await api<unknown[]>("/api/v1/aip/airports");
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.licence).toBeNull();
  });
});
