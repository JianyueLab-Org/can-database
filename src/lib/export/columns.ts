/**
 * 八张表各自导出哪些列。
 *
 * `headerKey` 是 i18n 键，**复用各页面命名空间里已有的表头键**，不另建一本
 * `export.columns` 字典 —— 同一个列名两处译文迟早不一致。
 *
 * `get` 取的是 can-db 给的字段，字段名和 `src/lib/canDb.ts` 的类型逐字对应。
 *
 * **`comms` 和 `positions` 两处不是照抄计划里的字段名**：`AirportComm`
 * （can-db `internal/aip/facilities.go`）没有 `freq`/`name`，只有 `freqMhz`/
 * `callsign`；`NetworkPosition`（`src/lib/canDb.ts`）没有 `frequency`/`squawk`，
 * 只有 `freqMhz`/`squawkStart`/`squawkEnd`。按计划原文写会让这两列在运行时静默
 * 输出 `undefined`——这个站反复踩过的那类不报错的坏法，这里不重蹈。
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

/* 八张表的行类型各异，消费方按 resource 取用 —— 这里的 any 是那个分派点的代价，
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
  runways: {
    columns: [
      { headerKey: "airportMap.runway", get: (r) => r.id },
      { headerKey: "airportMap.opposite", get: (r) => r.opposite },
      { headerKey: "airportMap.hdg", get: (r) => r.hdg },
      { headerKey: "airports.lat", get: (r) => r.lat },
      { headerKey: "airports.lon", get: (r) => r.lon },
    ],
    geometry: {
      kind: "line",
      path: (r) => [
        [r.lon, r.lat],
        [r.endLon, r.endLat],
      ],
    },
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
  comms: {
    columns: [
      { headerKey: "airports.commType", get: (r) => r.type },
      { headerKey: "positions.frequency", get: (r) => r.freqMhz },
      { headerKey: "airports.commName", get: (r) => r.callsign },
    ],
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
    geometry: {
      kind: "line",
      path: (r) => (r.path ?? []).map((p: any) => [p.lon, p.lat]),
    },
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
      { headerKey: "positions.frequency", get: (r) => r.freqMhz },
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
