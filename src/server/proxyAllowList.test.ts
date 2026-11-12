import { expect, spyOn, test } from "bun:test";
import { createContext } from "astro/middleware";
import { CAN_API_ORIGIN, CAN_DB_ORIGIN, origin } from "@/lib/config";
import { GET, PATCH, POST } from "../pages/api/v1/[...path]";

function context(path: string, method = "GET", sentOrigin?: string) {
  return createContext({
    request: new Request(`https://console.example/api/v1/${path}`, {
      method,
      headers: sentOrigin ? { origin: sentOrigin } : {},
    }),
    params: { path },
    defaultLocale: "en-us",
  });
}

function interceptFetch() {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(async () => new Response("upstream", { status: 200 }), {
      preconnect: globalThis.fetch.preconnect,
    }),
  );
}

test.each(["toString", "constructor", "__proto__", "hasOwnProperty"])(
  "inherited key %s returns unknown-route 404 without an upstream request",
  async (path) => {
    const fetchSpy = interceptFetch();
    try {
      for (const method of ["GET", "POST"]) {
        const response = await GET(context(path, method));
        expect(response.status).toBe(404);
        expect(await response.json()).toMatchObject({ error: "not_allowed" });
      }
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  },
);

test.each([
  ["aip/datasets", "GET", CAN_DB_ORIGIN],
  ["aip/airports/ZBAA", "GET", CAN_DB_ORIGIN],
  ["notifications", "GET", CAN_API_ORIGIN],
  ["notifications/member/12", "PATCH", CAN_API_ORIGIN],
])(
  "allowed %s %s reaches the correct upstream",
  async (path, method, upstream) => {
    const fetchSpy = interceptFetch();
    try {
      const response = await GET(context(path, method, origin()));
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("upstream");
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      const [target, init] = fetchSpy.mock.calls[0]!;
      const url = new URL(String(target));
      expect(url.origin).toBe(new URL(upstream).origin);
      expect(url.pathname).toBe(`/api/v1/${path}`);
      expect(init?.method).toBe(method);
    } finally {
      fetchSpy.mockRestore();
    }
  },
);

test("known exact routes still reject unsupported methods before forwarding", async () => {
  const fetchSpy = interceptFetch();
  try {
    const response = await POST(context("aip/datasets", "POST", origin()));
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET");
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});

test.each([undefined, "https://other.example"])(
  "known write patterns reject missing or foreign Origin: %s",
  async (sentOrigin) => {
    const fetchSpy = interceptFetch();
    try {
      const response = await PATCH(
        context("notifications/member/12", "PATCH", sentOrigin),
      );
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: "bad_origin" });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  },
);
