import { expect, spyOn, test } from "bun:test";
import { createContext } from "astro/middleware";
import {
  DELETE,
  GET,
  POST,
  passThroughHeaders,
  upstreamTarget,
  upstreamTimeout,
} from "./[...path]";
import { origin } from "@/lib/config";

function proxyContext(request: Request, path = "aip/export") {
  return createContext({
    request,
    params: { path },
    defaultLocale: "en-us",
  });
}

function interceptFetch(
  implementation: (...args: Parameters<typeof fetch>) => Promise<Response>,
) {
  return spyOn(globalThis, "fetch").mockImplementation(
    Object.assign(implementation, { preconnect: globalThis.fetch.preconnect }),
  );
}

test("request cancellation reaches upstream before response headers", async () => {
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  const headers = Promise.withResolvers<Response>();
  const started = Promise.withResolvers<void>();
  const fetchSpy = interceptFetch(async (_input, init) => {
    upstreamSignal = init?.signal;
    started.resolve();
    return headers.promise;
  });
  const response = GET(
    proxyContext(
      new Request("https://console.example/api/v1/aip/export", {
        signal: controller.signal,
      }),
    ),
  );
  try {
    await started.promise;
    controller.abort(new DOMException("Download cancelled", "AbortError"));
    expect(upstreamSignal?.aborted).toBe(true);
    expect(upstreamSignal?.reason).toBe(controller.signal.reason);
  } finally {
    headers.resolve(new Response(null));
    await response;
    fetchSpy.mockRestore();
  }
});

test("request cancellation aborts an upstream response being streamed", async () => {
  const controller = new AbortController();
  let upstreamSignal: AbortSignal | null | undefined;
  let bodyController: ReadableStreamDefaultController<Uint8Array>;
  let abort: () => void;
  const fetchSpy = interceptFetch(async (_input, init) => {
    upstreamSignal = init?.signal;
    return new Response(
      new ReadableStream<Uint8Array>({
        start(stream) {
          bodyController = stream;
          stream.enqueue(new TextEncoder().encode("ZIP chunk"));
          abort = () => stream.error(upstreamSignal?.reason);
          upstreamSignal?.addEventListener("abort", abort, { once: true });
        },
      }),
      { headers: { "content-type": "application/zip" } },
    );
  });
  try {
    const response = await GET(
      proxyContext(
        new Request("https://console.example/api/v1/aip/export", {
          signal: controller.signal,
        }),
      ),
    );
    const reader = response.body!.getReader();
    expect(new TextDecoder().decode((await reader.read()).value)).toBe(
      "ZIP chunk",
    );
    controller.abort(new DOMException("Download cancelled", "AbortError"));
    expect(upstreamSignal?.aborted).toBe(true);
    expect(await reader.read().catch((error: unknown) => error)).toMatchObject({
      name: "AbortError",
    });
  } finally {
    upstreamSignal?.removeEventListener("abort", abort!);
    if (!upstreamSignal?.aborted) bodyController!.close();
    fetchSpy.mockRestore();
  }
});

test("handler preserves export query, cookies, status, headers, and stream bytes", async () => {
  const query =
    "?include=airports.json&include=runways.csv&locale=ja-jp&tag=a%2Bb";
  const payload = new Uint8Array([80, 75, 3, 4, 0, 255]);
  let target = "";
  let forwarded: RequestInit | undefined;
  const fetchSpy = interceptFetch(async (input, init) => {
    target = String(input);
    forwarded = init;
    return new Response(payload, {
      status: 206,
      headers: {
        "content-type": "application/zip",
        "content-disposition": 'attachment; filename="current.zip"',
        "cache-control": "private, no-store",
        "set-cookie": "session=updated; HttpOnly",
        "x-private": "hidden",
      },
    });
  });
  try {
    const response = await GET(
      proxyContext(
        new Request("https://console.example/api/v1/aip/export" + query, {
          headers: { cookie: "session=current" },
        }),
      ),
    );
    // 「隐藏 NAIP 数据」默认开着：没有 `can_hide_naip` cookie 就带 `unrestricted=1`。
    expect(new URL(target).pathname + new URL(target).search).toBe(
      "/api/v1/aip/export" + query + "&unrestricted=1",
    );
    expect(new Headers(forwarded?.headers).get("cookie")).toBe(
      "session=current",
    );
    expect(forwarded?.method).toBe("GET");
    expect(forwarded?.body).toBeUndefined();
    expect(response.status).toBe(206);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toBe(
      'attachment; filename="current.zip"',
    );
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("set-cookie")).toBe(
      "session=updated; HttpOnly",
    );
    expect(response.headers.has("x-private")).toBe(false);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(payload);
  } finally {
    fetchSpy.mockRestore();
  }
});

test("handler preserves an allowed POST body and content type", async () => {
  let forwarded: RequestInit | undefined;
  const fetchSpy = interceptFetch(async (_input, init) => {
    forwarded = init;
    return new Response(null, { status: 204 });
  });
  try {
    const response = await POST(
      proxyContext(
        new Request("https://console.example/api/v1/auth/signout", {
          method: "POST",
          headers: { origin: origin(), "content-type": "application/json" },
          body: '{"everywhere":true}',
        }),
        "auth/signout",
      ),
    );
    expect(response.status).toBe(204);
    expect(forwarded?.method).toBe("POST");
    expect(new Headers(forwarded?.headers).get("content-type")).toBe(
      "application/json",
    );
    expect(await new Response(forwarded?.body).text()).toBe(
      '{"everywhere":true}',
    );
  } finally {
    fetchSpy.mockRestore();
  }
});

test("archive export uses the dedicated timeout", () => {
  expect(upstreamTimeout("aip/export")).toBe(120_000);
  expect(upstreamTimeout("aip/export/options")).toBe(15_000);
  expect(upstreamTimeout("aip/airports")).toBe(15_000);
});

test("route deadlines still abort upstream when the client stays connected", async () => {
  for (const [path, duration] of [
    ["aip/export", 120_000],
    ["aip/export/options", 15_000],
    ["aip/airports", 15_000],
  ] as const) {
    const deadline = new AbortController();
    const requestedTimeouts: number[] = [];
    const timeoutSpy = spyOn(AbortSignal, "timeout").mockImplementation(
      (ms) => {
        requestedTimeouts.push(ms);
        return deadline.signal;
      },
    );
    let upstreamSignal: AbortSignal | null | undefined;
    const fetchSpy = interceptFetch(async (_input, init) => {
      upstreamSignal = init?.signal;
      return new Response(null);
    });
    try {
      const request = new Request("https://console.example/api/v1/" + path);
      await GET(proxyContext(request, path));
      expect(requestedTimeouts).toEqual([duration]);
      expect(upstreamSignal?.aborted).toBe(false);
      deadline.abort(new DOMException("Deadline exceeded", "TimeoutError"));
      expect(upstreamSignal?.aborted).toBe(true);
      expect(upstreamSignal?.reason).toBe(deadline.signal.reason);
      expect(request.signal.aborted).toBe(false);
    } finally {
      fetchSpy.mockRestore();
      timeoutSpy.mockRestore();
    }
  }
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

test("dataset DELETE is forwarded with origin and without unrestricted", async () => {
  let target = "";
  let forwarded: RequestInit | undefined;
  const fetchSpy = interceptFetch(async (input, init) => {
    target = String(input);
    forwarded = init;
    return new Response(null, { status: 204 });
  });
  try {
    const response = await DELETE(
      proxyContext(
        new Request("https://console.example/api/v1/aip/datasets/12", {
          method: "DELETE",
          headers: { origin: origin(), cookie: "session=current" },
        }),
        "aip/datasets/12",
      ),
    );
    expect(response.status).toBe(204);
    expect(forwarded?.method).toBe("DELETE");
    expect(new URL(target).pathname).toBe("/api/v1/aip/datasets/12");
    expect(new URL(target).search).toBe("");
    const headers = new Headers(forwarded?.headers);
    expect(headers.get("origin")).toBe(origin());
    expect(headers.get("cookie")).toBe("session=current");
  } finally {
    fetchSpy.mockRestore();
  }
});

test("dataset DELETE without a matching origin is refused", async () => {
  const fetchSpy = interceptFetch(async () => new Response(null));
  try {
    const response = await DELETE(
      proxyContext(
        new Request("https://console.example/api/v1/aip/datasets/12", {
          method: "DELETE",
        }),
        "aip/datasets/12",
      ),
    );
    expect(response.status).toBe(403);
    expect(fetchSpy).not.toHaveBeenCalled();
  } finally {
    fetchSpy.mockRestore();
  }
});
