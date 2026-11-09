import { describe, expect, test } from "bun:test";
import { checkUpstream, createHealth, healthResponse } from "./health";

describe("health", () => {
  test("200 when all checks pass", async () => {
    const res = healthResponse(
      await createHealth(async () => ({ "can-db": "ok" }))(),
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({
      status: "ok",
      checks: { "can-db": "ok" },
    });
  });

  test("503 when a check fails", async () => {
    const fakeFetch = (async () =>
      new Response("", { status: 500 })) as unknown as typeof fetch;
    const h = createHealth(async () => ({
      "can-db": await checkUpstream("http://x", fakeFetch),
    }));
    const res = healthResponse(await h());
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      status: "fail",
      checks: { "can-db": "http 500" },
    });
  });

  test("caches for 10 s and shares concurrent runs", async () => {
    let calls = 0;
    let t = 0;
    const h = createHealth(
      async () => {
        calls++;
        return { "can-db": "ok" };
      },
      () => t,
    );
    await Promise.all([h(), h(), h()]);
    expect(calls).toBe(1);
    t = 9_999;
    await h();
    expect(calls).toBe(1);
    t = 10_000;
    await h();
    expect(calls).toBe(2);
  });
});
