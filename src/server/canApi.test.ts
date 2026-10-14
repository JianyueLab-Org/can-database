import { afterEach, describe, expect, test } from "bun:test";

import { CAN_API_ORIGIN } from "../lib/config";
import { resolveSession, type SessionUser } from "./canApi";

const USER: SessionUser = {
  username: "synthetic-member",
  name: "Synthetic Member",
  email: "member@example.com",
  rating: 0,
  aipAccess: 2,
};
const COOKIE = "can_session=synthetic-session; can_hide_naip=1";
const originalFetch = globalThis.fetch;
const originalTimeout = AbortSignal.timeout;
const originalError = console.error;
let calls: Array<{ url: string; init: RequestInit }> = [];

function context(cookie: string | null = COOKIE) {
  return {
    request: new Request("https://database.example.test/airports", {
      headers: {
        ...(cookie === null ? {} : { cookie }),
        Authorization: "Bearer synthetic-ignored",
      },
    }),
  };
}

function stub(respond: (init: RequestInit) => Response | Promise<Response>) {
  calls = [];
  globalThis.fetch = (async (input, init = {}) => {
    calls.push({
      url: input instanceof Request ? input.url : String(input),
      init,
    });
    return respond(init);
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = originalFetch;
  AbortSignal.timeout = originalTimeout;
  console.error = originalError;
});

describe("resolveSession", () => {
  test("no cookie is signed-out without querying upstream", async () => {
    stub(() => Response.json({ user: USER }));
    expect(await resolveSession(context(null))).toEqual({ kind: "signed-out" });
    expect(calls).toHaveLength(0);
  });

  test("valid top-level session authenticates and forwards only the original cookie", async () => {
    stub(() => Response.json({ user: USER }));
    expect(await resolveSession(context())).toEqual({
      kind: "authenticated",
      user: USER,
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.url).toBe(`${CAN_API_ORIGIN}/api/v1/auth/session`);
    expect(calls[0]!.init.headers).toEqual({ cookie: COOKIE });
    expect(calls[0]!.init.signal).toBeInstanceOf(AbortSignal);
  });

  test("preserves the existing enveloped session shape", async () => {
    stub(() => Response.json({ status: 200, data: { user: USER } }));
    expect(await resolveSession(context())).toEqual({
      kind: "authenticated",
      user: USER,
    });
  });

  test.each([{ user: null }, { status: 200, data: { user: null } }])(
    "documented HTTP 200 anonymous response %j is signed-out",
    async (body) => {
      stub(() => Response.json(body));
      expect(await resolveSession(context())).toEqual({ kind: "signed-out" });
    },
  );

  test.each([
    "null",
    "malformed JSON",
    '{"error":"unauthorized"}',
    "",
    '{"user":null}',
  ])(
    "authoritative HTTP 401 is signed-out regardless of error body %s",
    async (body) => {
      stub(() => new Response(body, { status: 401 }));
      expect(await resolveSession(context())).toEqual({ kind: "signed-out" });
    },
  );

  test("HTTP 401 does not attempt to read a broken error body", async () => {
    stub(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("synthetic body error"));
            },
          }),
          { status: 401 },
        ),
    );
    expect(await resolveSession(context())).toEqual({ kind: "signed-out" });
  });

  test.each([400, 403, 404, 408, 429, 500, 502, 503, 504])(
    "HTTP %i is unavailable, not signed-out, even with a null-user body",
    async (status) => {
      stub(() => Response.json({ user: null }, { status }));
      expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
    },
  );

  test.each([201, 202, 203, 204, 205, 206, 207, 226])(
    "unexpected success status %i is unavailable",
    async (status) => {
      stub(
        () =>
          new Response(
            status === 204 || status === 205 ? null : '{"user":null}',
            { status },
          ),
      );
      expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
    },
  );

  test("unexpected 201 with a valid user is unavailable", async () => {
    stub(() => Response.json({ user: USER }, { status: 201 }));
    expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
  });

  test.each([
    "malformed JSON",
    "",
    "null",
    "[]",
    "false",
    "1",
    '"string"',
    "{}",
    '{"data":null}',
    '{"data":{}}',
    '{"user":false}',
    '{"user":[]}',
    '{"user":{}}',
    '{"status":503,"data":{"user":null}}',
  ])(
    "invalid HTTP 200 payload %s is unavailable without throwing",
    async (body) => {
      stub(() => new Response(body));
      expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
    },
  );

  test.each([
    { ...USER, username: "" },
    { ...USER, username: 123 },
    { ...USER, name: null },
    { ...USER, email: null },
    { ...USER, rating: "0" },
    { ...USER, rating: -1 },
    { ...USER, rating: 1.5 },
    { ...USER, aipAccess: "2" },
    { ...USER, aipAccess: 2.5 },
    { ...USER, aipAccess: 6 },
    { ...USER, aipAccess: -1 },
  ])("invalid user fields do not authenticate: %j", async (user) => {
    stub(() => Response.json({ user }));
    expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
  });

  test("network errors are unavailable and do not log cookies or payloads", async () => {
    const logged: unknown[] = [];
    console.error = (...args) => {
      logged.push(args);
    };
    stub(() => {
      throw new Error("synthetic network failure");
    });
    expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
    expect(logged).toHaveLength(0);
  });

  test("keeps the 5-second timeout and classifies aborts as unavailable", async () => {
    const durations: number[] = [];
    AbortSignal.timeout = (duration) => {
      durations.push(duration);
      return originalTimeout(2);
    };
    stub(
      (init) =>
        new Promise((_resolve, reject) => {
          init.signal!.addEventListener(
            "abort",
            () => reject(init.signal!.reason),
            { once: true },
          );
        }),
    );
    expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
    expect(durations).toEqual([5000]);
  });

  test("success body read failures are unavailable", async () => {
    stub(
      () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.error(new Error("synthetic body failure"));
            },
          }),
        ),
    );
    expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
  });

  test("refreshes permissions per request without caching or stale fallback", async () => {
    const replies = [
      Response.json({ user: USER }),
      Response.json({ user: { ...USER, aipAccess: 1 } }),
      Response.json({ user: null }, { status: 503 }),
    ];
    stub(() => replies.shift()!);
    expect(await resolveSession(context())).toEqual({
      kind: "authenticated",
      user: USER,
    });
    expect(await resolveSession(context())).toEqual({
      kind: "authenticated",
      user: { ...USER, aipAccess: 1 },
    });
    expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(3);
  });

  test("does not retry upstream failures automatically", async () => {
    stub(() => new Response("synthetic service failure", { status: 503 }));
    expect(await resolveSession(context())).toEqual({ kind: "unavailable" });
    expect(calls).toHaveLength(1);
  });
});
