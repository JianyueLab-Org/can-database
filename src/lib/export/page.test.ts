import { afterAll, afterEach, describe, expect, spyOn, test } from "bun:test";
import { plugin } from "bun";
import { parse, compileScript } from "vue/compiler-sfc";
import {
  Window,
  type HTMLButtonElement,
  type HTMLInputElement,
} from "happy-dom";
import { getMessages } from "@/lib/i18n";
import type { AirportSummary } from "@/lib/canDb";
import type { ExportOptions } from "./options";

const browser = new Window({ url: "https://database.ceruleanavi.net/export" });
const originalGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const key of [
  "window",
  "document",
  "Element",
  "HTMLElement",
  "SVGElement",
  "Node",
]) {
  originalGlobals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value: key === "window" ? browser : Reflect.get(browser, key),
  });
}

plugin({
  name: "vue-export-test",
  setup(build) {
    build.onLoad(
      { filter: /(DatasetExport|AirportExportScope)\.vue$/ },
      async ({ path }) => {
        const { descriptor } = parse(await Bun.file(path).text(), {
          filename: path,
        });
        return {
          contents: compileScript(descriptor, {
            id: "export-test",
            inlineTemplate: true,
          }).content,
          loader: "ts",
        };
      },
    );
  },
});

const { createApp, nextTick } = await import("vue");
const { default: DatasetExport } =
  await import("@/components/DatasetExport.vue");
const options: ExportOptions = {
  groups: [
    {
      id: "airport",
      resources: [
        {
          id: "airports",
          formats: ["json", "csv", "osm"],
          airportScoped: true,
        },
        { id: "procedures", formats: ["json"], airportScoped: true },
      ],
    },
    {
      id: "ground",
      resources: [
        {
          id: "ground-features",
          formats: ["json", "osm"],
          airportScoped: false,
        },
      ],
    },
  ],
  locales: ["en-us", "ja-jp", "zh-cn", "zh-tw"],
  defaultLocale: "zh-cn",
  limits: {
    includePairs: 128,
    records: 500000,
    coordinates: 5000000,
    archiveEntries: 512,
  },
};
const airports: AirportSummary[] = [
  {
    icao: "ZBAA",
    name: "Beijing Capital",
    fir: "ZBPE",
    lat: 40.08,
    lon: 116.58,
    elev: 116,
    variation: -7,
    airac: "2610",
    stands: 190,
  },
  {
    icao: "ZSPD",
    name: "Shanghai Pudong",
    fir: "ZSHA",
    lat: 31.14,
    lon: 121.79,
    elev: 13,
    variation: -5,
    airac: "2610",
    stands: 216,
  },
];

let app: ReturnType<typeof createApp> | undefined;
const fetchSpy = spyOn(
  globalThis as {
    fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
  },
  "fetch",
);
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 0));
  await nextTick();
}
function mount() {
  const host = browser.document.createElement("div");
  browser.document.body.append(host);
  app = createApp(DatasetExport, {
    messages: getMessages("en-us", "exportPage"),
    locale: "en-us",
    airports,
  });
  app.mount(host as unknown as HTMLElement);
  return host;
}
function succeed() {
  fetchSpy.mockImplementation(async (input) => {
    expect(input).toBe("/api/v1/aip/export/options");
    return Response.json({
      status: 200,
      data: options,
      timestamp: "2026-09-22T00:00:00Z",
    });
  });
}
afterEach(() => {
  app?.unmount();
  app = undefined;
  browser.document.body.replaceChildren();
  fetchSpy.mockReset();
});
afterAll(() => {
  fetchSpy.mockRestore();
  for (const [key, descriptor] of originalGlobals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else Reflect.deleteProperty(globalThis, key);
  }
  browser.happyDOM.abort();
});

describe("dataset export page", () => {
  test("preselects airports from the URL and emits sorted native query fields", async () => {
    browser.history.replaceState(
      {},
      "",
      "/export?airport=ZSPD&airport=ZBAA&airport=ZSPD",
    );
    succeed();
    const host = mount();
    await settle();

    expect(
      host.querySelector<HTMLInputElement>("#export-airport-search"),
    ).toBeTruthy();
    expect(host.querySelector("#export-airport-status")?.textContent).toContain(
      "2 airports selected",
    );
    expect(
      new browser.FormData(host.querySelector("form")!).getAll("airport"),
    ).toEqual(["ZBAA", "ZSPD"]);
  });

  test("filters airport choices, supports multiple selections and clear means all airports", async () => {
    browser.history.replaceState({}, "", "/export");
    succeed();
    const host = mount();
    await settle();
    const search = host.querySelector<HTMLInputElement>(
      "#export-airport-search",
    )!;
    search.value = "shanghai";
    search.dispatchEvent(new browser.Event("input", { bubbles: true }));
    await nextTick();
    expect(host.textContent).toContain("Shanghai Pudong");
    expect(host.textContent).not.toContain("Beijing Capital");

    host.querySelector<HTMLInputElement>("#export-airport-ZSPD")!.click();
    await nextTick();
    expect(host.querySelector("#export-airport-status")?.textContent).toContain(
      "1 airports selected",
    );
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Clear airports")!
      .click();
    await nextTick();
    expect(host.querySelector("#export-airport-status")?.textContent).toContain(
      "All current airports",
    );
    expect(
      new browser.FormData(host.querySelector("form")!).getAll("airport"),
    ).toEqual([]);
  });

  test("labels airport-scoped resources and explains unscoped resources stay complete", async () => {
    browser.history.replaceState({}, "", "/export");
    succeed();
    const host = mount();
    await settle();
    expect(
      host.querySelector("#export-resource-airports")?.textContent,
    ).toContain("Airport scoped");
    expect(
      host.querySelector("#export-resource-ground-features")?.textContent,
    ).not.toContain("Airport scoped");
    expect(host.textContent).toContain("Global resources remain complete");
  });

  test("preserves format headers and bulk controls in labelled keyboard-scrollable matrices", async () => {
    succeed();
    const host = mount();
    await settle();
    const tables = [...host.querySelectorAll("table")];
    expect(tables).toHaveLength(2);
    for (const table of tables) {
      expect(table.classList.contains("data-table")).toBe(false);
      expect(table.classList.contains("export-matrix")).toBe(true);
      expect(table.classList.contains("min-w-[40rem]")).toBe(true);
      const region = table.closest('[role="region"]');
      expect(region).toBeTruthy();
      expect(region!.classList.contains("overflow-x-auto")).toBe(true);
      expect(region!.getAttribute("tabindex")).toBe("0");
      const legend = table.closest("fieldset")!.querySelector("legend")!;
      expect(region!.getAttribute("aria-labelledby")).toBe(legend.id);
      expect(legend.id).not.toBe("");
      const instruction = host.querySelector(
        `#${region!.getAttribute("aria-describedby")}`,
      );
      expect(instruction?.textContent).toContain("Scroll horizontally");
      expect(instruction?.textContent).toContain("Left and Right arrow keys");
      expect(
        [...table.querySelectorAll("thead label > span[aria-hidden]")].map(
          (label) => label.textContent,
        ),
      ).toEqual(["JSON", "CSV", "GeoJSON", "OSM"]);
      expect(
        table.querySelectorAll('thead input[type="checkbox"]'),
      ).toHaveLength(4);
      const scrollRegion = region as InstanceType<typeof browser.HTMLElement>;
      scrollRegion.focus();
      expect(browser.document.activeElement).toBe(scrollRegion);
    }
    const bulkToggle = host.querySelector<HTMLInputElement>(
      "#export-group-airport-osm",
    )!;
    bulkToggle.focus();
    expect(browser.document.activeElement).toBe(bulkToggle);
    bulkToggle.click();
    await nextTick();
    expect(
      new browser.FormData(host.querySelector("form")!).getAll("include"),
    ).toEqual([
      "airports.json",
      "airports.osm",
      "ground-features.json",
      "procedures.json",
    ]);
  });

  test("announces loading, then renders backend compatibility with accessible disabled cells", async () => {
    let release!: (value: Response) => void;
    fetchSpy.mockImplementation(
      () =>
        new Promise((resolve) => {
          release = resolve;
        }),
    );
    const host = mount();
    expect(
      host.querySelector('form > p[role="status"]')?.textContent ?? "",
    ).toContain("Loading export options");
    expect(
      host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(true);
    release(Response.json({ data: options }));
    await settle();
    expect(
      [...host.querySelectorAll("fieldset > legend")].map((n) => n.textContent),
    ).toEqual(["Airport scope", "Airport data", "Ground data"]);
    expect(host.querySelectorAll('tbody input[type="checkbox"]').length).toBe(
      12,
    );
    const unsupported = host.querySelector<HTMLInputElement>(
      "#export-procedures-osm",
    )!;
    expect(unsupported.disabled).toBe(true);
    expect(unsupported.checked).toBe(false);
    expect(
      host.querySelector(`#${unsupported.getAttribute("aria-describedby")}`)
        ?.textContent,
    ).toContain("not available in this format");
    for (const input of host.querySelectorAll<HTMLInputElement>(
      'input[type="checkbox"]',
    )) {
      expect(
        host.querySelector(`label[for="${input.id}"]`)?.textContent?.trim(),
      ).toBeTruthy();
    }
    expect(
      host.querySelector('form > p[role="status"]')?.textContent,
    ).toContain("3 resource and format pairs selected");
  });

  test("refetches failed options when retry is activated", async () => {
    fetchSpy.mockResolvedValueOnce(
      new Response("unavailable", { status: 503 }),
    );
    const host = mount();
    await settle();
    expect(
      host.querySelector('form > p[role="status"]')?.textContent ?? "",
    ).toContain("could not be loaded");
    succeed();
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Retry")!
      .click();
    await settle();
    expect(host.querySelectorAll("fieldset").length).toBe(3);
    expect(
      host.querySelector('form > p[role="status"]')?.textContent,
    ).toContain("3 resource");
  });

  test("bulk selection respects compatibility and native form emits sorted repeated includes and locale", async () => {
    succeed();
    const host = mount();
    await settle();
    expect(host.querySelector("#export-group-airport-osm")).toBeTruthy();
    host.querySelector<HTMLInputElement>("#export-group-airport-osm")!.click();
    host
      .querySelector<HTMLInputElement>("#export-ground-features-osm")!
      .click();
    await nextTick();
    const form = host.querySelector("form")!;
    expect(form.getAttribute("method")).toBe("get");
    expect(form.getAttribute("action")).toBe("/api/v1/aip/export");
    const fields = new browser.FormData(form);
    expect(fields.getAll("include")).toEqual([
      "airports.json",
      "airports.osm",
      "ground-features.json",
      "ground-features.osm",
      "procedures.json",
    ]);
    expect(fields.get("locale")).toBe("en-us");
    expect([...fields.keys()]).toEqual([
      "include",
      "include",
      "include",
      "include",
      "include",
      "locale",
    ]);
    expect(
      host.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.textContent,
    ).toContain("(5)");
    host.querySelector<HTMLInputElement>("#export-group-airport-osm")!.click();
    await nextTick();
    expect(new browser.FormData(form).getAll("include")).toEqual([
      "airports.json",
      "ground-features.json",
      "ground-features.osm",
      "procedures.json",
    ]);
  });

  test("clear announces empty selection and select-all restores the supported JSON defaults", async () => {
    succeed();
    const host = mount();
    await settle();
    const clear = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Clear selection",
    );
    expect(clear).toBeTruthy();
    clear!.click();
    await nextTick();
    expect(
      host.querySelector('form > p[role="status"]')?.textContent,
    ).toContain("Select at least one");
    expect(
      host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(true);
    const rejected = new browser.Event("submit", { cancelable: true });
    host.querySelector("form")!.dispatchEvent(rejected);
    expect(rejected.defaultPrevented).toBe(true);
    [...host.querySelectorAll("button")]
      .find((button) => button.textContent === "Select all JSON (default)")!
      .click();
    await nextTick();
    expect(
      new browser.FormData(host.querySelector("form")!).getAll("include"),
    ).toEqual(["airports.json", "ground-features.json", "procedures.json"]);
    expect(
      host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(false);
  });

  test("permits the native download, prevents duplicates, and resets after 1500ms or pageshow", async () => {
    succeed();
    const host = mount();
    await settle();
    const form = host.querySelector("form")!;
    expect(form).toBeTruthy();
    const first = new browser.Event("submit", { cancelable: true });
    form.dispatchEvent(first);
    expect(first.defaultPrevented).toBe(false);
    const duplicate = new browser.Event("submit", { cancelable: true });
    form.dispatchEvent(duplicate);
    expect(duplicate.defaultPrevented).toBe(true);
    await nextTick();
    expect(
      host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(true);
    expect(
      host.querySelector<HTMLButtonElement>('button[type="submit"]')
        ?.textContent,
    ).toContain("Starting download (3)");
    await new Promise((resolve) => setTimeout(resolve, 1550));
    await nextTick();
    expect(
      host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(false);
    form.dispatchEvent(new browser.Event("submit", { cancelable: true }));
    browser.dispatchEvent(new browser.Event("pageshow"));
    await nextTick();
    expect(
      host.querySelector<HTMLButtonElement>('button[type="submit"]')?.disabled,
    ).toBe(false);
  });
});
