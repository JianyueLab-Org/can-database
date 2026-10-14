import type { APIContext, MiddlewareHandler, MiddlewareNext } from "astro";
import { afterEach, describe, expect, mock, test } from "bun:test";

import { DENIED_PATH } from "../lib/access";
import { signInUrl } from "../lib/config";
import type { SessionUser } from "./canApi";

// Astro's virtual helper is an identity wrapper around the actual handler.
mock.module("astro:middleware", () => ({
  defineMiddleware: (handler: MiddlewareHandler) => handler,
}));
const { onRequest } = await import("../middleware");

const USER: SessionUser = {
  username: "synthetic-member",
  name: "Synthetic Member",
  email: "member@example.com",
  rating: 0,
  aipAccess: 2,
};
const COOKIE = "can_session=synthetic-session; can_hide_naip=1";
const PROTECTED = "SYNTHETIC_LICENSED_CONTENT";
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
let upstreamCalls = 0;

function context(path = "/airports?q=ZB", cookie: string | null = COOKIE) {
  const url = new URL(`https://database.example.test${path}`);
  const redirects: string[] = [];
  const api = {
    url,
    request: new Request(url, { headers: cookie === null ? {} : { cookie } }),
    locals: { user: null },
    redirect: (target: string, status = 302) => {
      redirects.push(target);
      return new Response(null, { status, headers: { Location: target } });
    },
  } as APIContext;
  return { api, redirects };
}

function stub(respond: (init: RequestInit) => Response | Promise<Response>) {
  upstreamCalls = 0;
  globalThis.fetch = (async (_input, init = {}) => {
    upstreamCalls++;
    return respond(init);
  }) as typeof fetch;
}

async function invoke(
  api: APIContext,
  next: MiddlewareNext,
): Promise<Response> {
  const response = await onRequest(api, next);
  if (!(response instanceof Response)) throw new Error("Expected response");
  return response;
}

function expectSecurityHeaders(response: Response) {
  expect(response.headers.get("X-Frame-Options")).toBe("DENY");
  expect(response.headers.get("X-Content-Type-Options")).toBe("nosniff");
  expect(response.headers.get("Referrer-Policy")).toBe(
    "origin-when-cross-origin",
  );
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
});

describe("database session middleware", () => {
  test.each([2, 4, 5])(
    "access level %i renders protected work after successful verification",
    async (aipAccess) => {
      const user = { ...USER, aipAccess };
      stub(() => Response.json({ user }));
      const { api, redirects } = context();
      let downstreamReads = 0;
      const response = await invoke(api, async () => {
        downstreamReads++;
        return new Response(PROTECTED);
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe(PROTECTED);
      expect(downstreamReads).toBe(1);
      expect(upstreamCalls).toBe(1);
      expect(api.locals.user).toEqual(user);
      expect(redirects).toHaveLength(0);
      expectSecurityHeaders(response);
    },
  );

  test.each([0, 1, 3])(
    "access level %i remains denied without rendering the protected page",
    async (aipAccess) => {
      stub(() => Response.json({ user: { ...USER, aipAccess } }));
      const { api, redirects } = context();
      const rewrites: unknown[] = [];
      let protectedReads = 0;
      const response = await invoke(api, async (rewrite) => {
        rewrites.push(rewrite);
        if (!rewrite) protectedReads++;
        return new Response("No console access", { status: 403 });
      });
      expect(response.status).toBe(403);
      expect(rewrites).toEqual([DENIED_PATH]);
      expect(protectedReads).toBe(0);
      expect(api.locals.noAccess).toEqual({
        kind: "permission",
        name: "aipAccess",
      });
      expect(redirects).toHaveLength(0);
      expectSecurityHeaders(response);
    },
  );

  test.each([
    "no cookie",
    "HTTP 200 user:null",
    "HTTP 401 null JSON",
    "HTTP 401 malformed JSON",
  ])(
    "only confirmed signed-out outcome %s redirects to sign-in",
    async (kind) => {
      stub(() =>
        kind === "HTTP 200 user:null"
          ? Response.json({ user: null })
          : new Response(kind === "HTTP 401 null JSON" ? "null" : "malformed", {
              status: 401,
            }),
      );
      const { api, redirects } = context(
        "/airports?q=ZB",
        kind === "no cookie" ? null : COOKIE,
      );
      let protectedReads = 0;
      const response = await invoke(api, async () => {
        protectedReads++;
        return new Response(PROTECTED);
      });
      expect(response.status).toBe(302);
      expect(response.headers.get("Location")).toBe(signInUrl(api.url));
      expect(redirects).toEqual([signInUrl(api.url)]);
      expect(protectedReads).toBe(0);
      expect(api.locals.user).toBeNull();
      expect(upstreamCalls).toBe(kind === "no cookie" ? 0 : 1);
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expectSecurityHeaders(response);
    },
  );

  test.each([
    "429",
    "500",
    "503",
    "403",
    "network",
    "malformed JSON",
    "JSON null",
    "missing user",
    "201 user:null",
  ])(
    "unavailable verification %s blocks all protected work with private/no-store 503",
    async (kind) => {
      stub(() => {
        if (kind === "network") throw new Error("synthetic unavailable");
        if (kind === "malformed JSON") return new Response("malformed");
        if (kind === "JSON null") return Response.json(null);
        if (kind === "missing user") return Response.json({});
        return Response.json(
          { user: null },
          { status: kind === "201 user:null" ? 201 : Number(kind) },
        );
      });
      const { api, redirects } = context();
      let downstreamReads = 0;
      const response = await invoke(api, async () => {
        downstreamReads++;
        return new Response(PROTECTED);
      });
      expect(response.status).toBe(503);
      expect(response.headers.get("Cache-Control")).toBe("private, no-store");
      expect(response.headers.get("Content-Type")).toBe(
        "text/plain; charset=utf-8",
      );
      expect(response.headers.get("Location")).toBeNull();
      expect(response.headers.get("Set-Cookie")).toBeNull();
      expect(redirects).toHaveLength(0);
      expect(downstreamReads).toBe(0);
      expect(api.locals.user).toBeNull();
      expect(upstreamCalls).toBe(1);
      const body = await response.text();
      expect(body).toBe(
        "Session verification is unavailable. Please try again.",
      );
      expect(body).not.toContain(PROTECTED);
      expect(body).not.toContain(USER.email);
      expectSecurityHeaders(response);
    },
  );

  test("timeout blocks protected work without sign-in redirect or cookie changes", async () => {
    const durations: number[] = [];
    AbortSignal.timeout = (duration) => {
      durations.push(duration);
      return originalTimeout(2);
    };
    stub(
      (init) =>
        new Promise((_resolve, reject) =>
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          ),
        ),
    );
    const { api, redirects } = context();
    let protectedReads = 0;
    const response = await invoke(api, async () => {
      protectedReads++;
      return new Response(PROTECTED);
    });
    expect(response.status).toBe(503);
    expect(response.headers.get("Cache-Control")).toBe("private, no-store");
    expect(response.headers.get("Set-Cookie")).toBeNull();
    expect(redirects).toHaveLength(0);
    expect(protectedReads).toBe(0);
    expect(durations).toEqual([5000]);
    expectSecurityHeaders(response);
  });

  test("recovery is a new explicit request, without retries or stale user fallback", async () => {
    const replies = [
      Response.json({ user: USER }),
      new Response("synthetic failure", { status: 503 }),
      Response.json({ user: USER }),
    ];
    stub(() => replies.shift()!);
    const { api, redirects } = context();
    let protectedReads = 0;
    const next: MiddlewareNext = async () => {
      protectedReads++;
      return new Response(PROTECTED);
    };
    expect((await invoke(api, next)).status).toBe(200);
    expect((await invoke(api, next)).status).toBe(503);
    expect(api.locals.user).toBeNull();
    expect((await invoke(api, next)).status).toBe(200);
    expect(upstreamCalls).toBe(3);
    expect(protectedReads).toBe(2);
    expect(redirects).toHaveLength(0);
  });

  test("permission revocation takes effect on the next page request", async () => {
    const replies = [
      Response.json({ user: USER }),
      Response.json({ user: { ...USER, aipAccess: 1 } }),
    ];
    stub(() => replies.shift()!);
    const { api } = context();
    let protectedReads = 0;
    const next: MiddlewareNext = async (rewrite) => {
      if (rewrite === DENIED_PATH)
        return new Response("Denied", { status: 403 });
      protectedReads++;
      return new Response(PROTECTED);
    };
    expect((await invoke(api, next)).status).toBe(200);
    expect((await invoke(api, next)).status).toBe(403);
    expect(protectedReads).toBe(1);
    expect(upstreamCalls).toBe(2);
  });

  test.each(["/api/v1/aip/airports", "/healthz"])(
    "unguarded %s retains its existing behavior",
    async (path) => {
      stub(() => {
        throw new Error("This must not query session verification");
      });
      const { api, redirects } = context(path);
      let nextCalls = 0;
      const response = await invoke(api, async () => {
        nextCalls++;
        return new Response("unguarded response");
      });
      expect(response.status).toBe(200);
      expect(await response.text()).toBe("unguarded response");
      expect(nextCalls).toBe(1);
      expect(upstreamCalls).toBe(0);
      expect(redirects).toHaveLength(0);
      expect(api.locals.user).toBeNull();
      expectSecurityHeaders(response);
    },
  );
});
