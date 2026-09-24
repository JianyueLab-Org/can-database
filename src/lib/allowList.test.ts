import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ALLOW_LIST,
  ALLOW_PATTERNS,
  allowed,
  lookup,
} from "../pages/api/v1/[...path]";

/**
 * 岛屿里每一条打给反代的路径，都必须在白名单上。
 *
 * **这条测试是踩出来的。** `/map` 的扇区图层上线之后才发现 `aip/sectors/network` 不在
 * 名单里 —— 反代答 404，而 `api()` 不抛异常，岛屿把失败当成「这一层没有数据」，于是屏
 * 幕上是一张没有扇区的地图，不是一个错误。同一个形状在这个文件的注释里已经记过一次
 * （`.../ground` 那条子路径），但记住不等于挡住。
 *
 * 接缝在两个仓库之间：can-db 加路由、这里加白名单条目，**两边 CI 谁也看不见对方**。
 * 所以能自动挡的只有这一半 —— 至少让「岛屿打了一条没放行的路径」在本地 `bun test` 就红。
 *
 * ## 它挡不住什么
 *
 * - **路径是运行时拼出来的**（整段来自变量）时扫不到。今天没有这种写法；真要写，
 *   把可枚举的那几条写成字面量。
 * - **can-db 那边有没有这条路由**它不知道。白名单放行一条不存在的路径，得到的是 can-db
 *   的 404，不是这里的。
 */

const ROOT = new URL("../", import.meta.url).pathname;

function sources(): Array<{ file: string; text: string }> {
  const out: Array<{ file: string; text: string }> = [];
  // 只扫**浏览器**里跑的那些。`src/server/` 和 `.astro` 的 frontmatter 走
  // `callDb`，直连 can-db，不经过反代 —— 把它们算进来会要求给服务端专用的
  // 路径也开白名单，那是反过来放大了这一层的开口。
  for (const dir of ["components", "lib"]) {
    const base = join(ROOT, dir);
    for (const name of readdirSync(base)) {
      if (!name.endsWith(".vue") && !name.endsWith(".ts")) continue;
      if (name.endsWith(".test.ts")) continue;
      out.push({
        file: `${dir}/${name}`,
        text: readFileSync(join(base, name), "utf8"),
      });
    }
  }
  return out;
}

/**
 * 从一处字面量里取出反代路径。
 *
 * `${…}` 按表达式换成一个能过 `ALLOW_PATTERNS` 的样例值：名字里带 `table` 的换成
 * `airport`，带 `id` 的换成 `1`（数据集 id），其余换成 `ZBAA`（ICAO 或包名）。换成空串
 * 会让 `airports/${icao}/ground` 塌成 `airports//ground`，测试就会为了一个不存在的形状
 * 而红。
 */
function sample(expr: string): string {
  if (/table/i.test(expr)) return "airport";
  if (/id\b/i.test(expr) || /Id\b/.test(expr)) return "1";
  return "ZBAA";
}

function normalise(raw: string): string {
  return raw
    .replace(/\$\{([^}]*)\}/g, (_, expr: string) => sample(expr))
    .replace(/[?#].*$/, "")
    .replace(/^\/api\/v1\//, "");
}

describe("反代白名单", () => {
  const found = new Map<string, string[]>();
  for (const { file, text } of sources()) {
    // 去掉注释，免得文档里提到的路径被当成真的调用。
    const code = text
      .replace(/\/\*[\s\S]*?\*\//g, "")
      .replace(/^\s*\/\/.*$/gm, "");
    for (const m of code.matchAll(/["'`](\/api\/v1\/[^"'`]*)["'`]/g)) {
      const path = normalise(m[1]);
      found.set(path, [...(found.get(path) ?? []), file]);
    }
  }

  test("扫到了路径 —— 一条都没扫到多半是扫错了目录", () => {
    expect(found.size).toBeGreaterThan(3);
  });

  test("每一条都在白名单上", () => {
    // 走 handler 用的那个 `allowed`，而不是只查 can-db 那张表 —— 签退走的是
    // `AUTH_PATHS`（转给 can-api），只查 `lookup` 会把它误报成漏放行。
    const missing = [...found].filter(([path]) => !allowed(path));
    expect(
      missing.map(([path, files]) => `${path}  ←  ${files.join(", ")}`),
    ).toEqual([]);
  });

  test("每一条至少允许一个方法 —— 空 methods 是永远 405", () => {
    for (const [path] of found) {
      expect(allowed(path)?.methods.length ?? 0).toBeGreaterThan(0);
    }
  });
});

describe("白名单自己", () => {
  test("export page paths permit GET only", () => {
    expect(lookup("aip/export")).toMatchObject({ methods: ["GET"] });
    expect(lookup("aip/export/options")).toMatchObject({ methods: ["GET"] });
    expect(lookup("aip/export/preview")).toBeUndefined();
  });

  test("扇区那两条在（图层和 top-down 各一条）", () => {
    expect(lookup("aip/sectors/network")).toBeDefined();
    expect(lookup("aip/sectors/network/resolve")).toBeDefined();
  });

  test("精确路径表里没有写方法", () => {
    /* 写方法只在 `ALLOW_PATTERNS` 里 `aip/datasets/{id}…` 那几条上（5 级写界面）。
     * 签退那条（POST）不在这张表里，它走 `AUTH_PATHS`、转给 can-api。 */
    const writes = Object.entries(ALLOW_LIST).filter(([, a]) =>
      a.methods.some((m) => m !== "GET"),
    );
    expect(writes.map(([p]) => p)).toEqual([]);
  });

  test("写方法只放行 5 级写界面的那几条", () => {
    expect(lookup("aip/datasets/12")?.methods).toEqual(["PATCH"]);
    for (const op of ["activate", "supersede", "clone"]) {
      expect(lookup(`aip/datasets/12/${op}`)?.methods).toEqual(["POST"]);
    }
    // 修订记录、登记表、AIRAC 日历由页面 frontmatter 经 `callDb` 取，不走反代。
    expect(lookup("aip/datasets/12/revisions")).toBeUndefined();
    expect(lookup("aip/tables")).toBeUndefined();
    expect(lookup("aip/datasets/12/tables/runway/rows")?.methods).toEqual([
      "GET",
      "POST",
      "PATCH",
      "DELETE",
    ]);
    const writable = ALLOW_PATTERNS.filter((a) =>
      a.methods.some((m) => m !== "GET"),
    );
    expect(writable).toHaveLength(3);
  });

  test("写路径的动态段收得紧", () => {
    expect(lookup("aip/datasets/abc")).toBeUndefined();
    expect(lookup("aip/datasets/12/delete")).toBeUndefined();
    expect(lookup("aip/datasets/12/tables/Runway/rows")).toBeUndefined();
    expect(lookup("aip/datasets/12/tables/../rows")).toBeUndefined();
    expect(lookup("aip/datasets/12/tables/runway/rows/1")).toBeUndefined();
  });

  test("路径里带 .. 的过不去", () => {
    expect(lookup("aip/airports/../../datasets")).toBeUndefined();
    expect(lookup("aip/sectors/network/../datasets")).toBeUndefined();
  });
});
