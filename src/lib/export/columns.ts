/**
 * 七张表各自导出哪些列。
 *
 * `headerKey` 是 i18n 键，**复用各页面命名空间里已有的表头键**，不另建一本
 * `export.columns` 字典 —— 同一个列名两处译文迟早不一致。
 *
 * `get` 取的是 can-db 给的字段，字段名和 `src/lib/canDb.ts` 的类型逐字对应 ——
 * **`runways` 是唯一的例外**，它读的是 `[icao].astro` 里几何表和物理表合并出来
 * 的行，字段名和字段本身（有没有对端坐标）都和 `canDb.ts` 的 `Runway` 不同，
 * 下面那张表的注释单独说了。
 *
 * **`positions` 那一列不是照抄计划里的字段名**：`NetworkPosition`
 * （`src/lib/canDb.ts`）没有 `frequency`/`squawk`，只有
 * `freqMhz`/`squawkStart`/`squawkEnd`。按计划原文写会让这一列在运行时静默
 * 输出 `undefined`——这个站反复踩过的那类不报错的坏法，这里不重蹈。
 *
 * **没有 `comms`。** 机场详情页只有跑道、机位、程序三节，没有频率表 ——
 * `AirportDetail` 也没有 `comms` 字段。一条没有任何页面用的列定义就是一个指向不
 * 存在功能的入口，这里不留。
 */
import type { Geometry } from "@/lib/export/serialize";

export interface ColumnSpec<T> {
  headerKey: string;
  get: (row: T) => unknown;
}

export interface TableSpec<T> {
  columns: ColumnSpec<T>[];
  /** 没有几何的表不给 GeoJSON —— 下拉里那一项也不出现。 */
  geometry?: Geometry<T>;
}

/**
 * 把程序点切成若干段，在没有坐标的点处断开。
 *
 * **无坐标的程序点是断口，不是 0,0**，也不是可以跳过的噪声 —— 全网 311 个点解析不出
 * 坐标（`canDb.ts` 的 `ProcedurePoint`）。跳过它们会画出一条穿过缺口的假线。
 * `AirportMap.vue:522-535` 对同一件事的处理就是断开，这里照做。
 */
export function splitAtGaps(
  points: Array<{ lat: number | null; lon: number | null }>,
): Array<Array<[number, number]>> {
  const segments: Array<Array<[number, number]>> = [];
  let current: Array<[number, number]> = [];
  for (const p of points) {
    if (p.lat === null || p.lon === null) {
      if (current.length > 0) segments.push(current);
      current = [];
      continue;
    }
    current.push([p.lon, p.lat]);
  }
  if (current.length > 0) segments.push(current);
  return segments;
}

/* 七张表的行类型各异，消费方按 resource 取用 —— 这里的 any 是那个分派点的代价，
   换成联合类型只会把同一个 switch 搬到每个调用点去。 */
export const TABLES: Record<string, TableSpec<any>> = {
  airports: {
    columns: [
      { headerKey: "airports.icao", get: (r) => r.icao },
      { headerKey: "airports.name", get: (r) => r.name },
      { headerKey: "airports.fir", get: (r) => r.fir },
      { headerKey: "airports.lat", get: (r) => r.lat },
      { headerKey: "airports.lon", get: (r) => r.lon },
      { headerKey: "airports.elev", get: (r) => r.elev },
      { headerKey: "datasets.airac", get: (r) => r.airac },
    ],
    geometry: { kind: "point", at: (r) => [r.lon, r.lat] },
  },
  /**
   * **没有几何。** `[icao].astro` 里 `runwayRows` 是几何表和物理表按代号合并
   * 出来的行 —— 字段是 `ident`/`opposite`/`hdg`/`lat`/`lon`/`lengthM`/…，
   * `lat`/`lon` 只是**入口**那一个点的坐标，合并行里没有对端坐标（没有
   * `endLat`/`endLon`，`canDb.ts` 的 `Runway.endLat/endLon` 从未进入这份合并
   * 结果）。画不出线就不给这一档 —— 下拉里不出现 GeoJSON，而不是导出一条
   * `[[lon,lat],[null,null]]`。
   */
  runways: {
    columns: [
      { headerKey: "airportMap.runway", get: (r) => r.ident },
      { headerKey: "airportMap.opposite", get: (r) => r.opposite },
      { headerKey: "airportMap.hdg", get: (r) => r.hdg },
      { headerKey: "airports.lat", get: (r) => r.lat },
      { headerKey: "airports.lon", get: (r) => r.lon },
    ],
  },
  stands: {
    columns: [
      { headerKey: "airports.standName", get: (r) => r.name },
      { headerKey: "airports.lat", get: (r) => r.lat },
      { headerKey: "airports.lon", get: (r) => r.lon },
      { headerKey: "airportMap.hdg", get: (r) => r.hdg },
      { headerKey: "airports.span", get: (r) => r.span },
    ],
    geometry: { kind: "point", at: (r) => [r.lon, r.lat] },
  },
  procedures: {
    columns: [
      { headerKey: "procedures.kind", get: (r) => r.kind },
      { headerKey: "procedures.name", get: (r) => r.name },
      { headerKey: "procedures.runways", get: (r) => r.runways ?? r.runway },
      {
        headerKey: "procedures.points",
        get: (r) => (r.points ?? []).join(" "),
      },
    ],
    geometry: { kind: "multiline", paths: (r) => splitAtGaps(r.path ?? []) },
  },
  fixes: {
    columns: [
      { headerKey: "fixes.ident", get: (r) => r.ident },
      { headerKey: "airports.lat", get: (r) => r.lat },
      { headerKey: "airports.lon", get: (r) => r.lon },
      { headerKey: "airports.fir", get: (r) => r.fir },
    ],
    geometry: { kind: "point", at: (r) => [r.lon, r.lat] },
  },
  positions: {
    columns: [
      { headerKey: "positions.callsign", get: (r) => r.callsign },
      { headerKey: "positions.identifier", get: (r) => r.identifier },
      { headerKey: "positions.freq", get: (r) => r.freqMhz },
      {
        headerKey: "positions.squawk",
        get: (r) => (r.squawkStart ? `${r.squawkStart}-${r.squawkEnd}` : null),
      },
    ],
  },
  datasets: {
    columns: [
      { headerKey: "datasets.airac", get: (r) => r.airac },
      { headerKey: "datasets.state", get: (r) => r.state },
      { headerKey: "datasets.redistributable", get: (r) => r.redistributable },
      { headerKey: "datasets.airports", get: (r) => r.airports },
      { headerKey: "datasets.activated", get: (r) => r.activatedAt },
    ],
  },
};
