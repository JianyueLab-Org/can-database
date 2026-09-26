/**
 * 视野取数和分页用到的纯函数。不 import Leaflet —— 这里的东西要能单独测。
 *
 * - `bboxParam`：地图视野 → can-db 的 `bbox=minLat,minLon,maxLat,maxLon`。跨 180° 时
 *   minLon > maxLon，can-db 认这种写法。
 * - `lonNear`：把经度挪到参考经度附近（±360），跨 180° 的视野里线才画在同一侧。
 * - `segmentIdents`：航段两端的显示代号。`from`/`to` 是图键，不拿来显示。
 * - `airportsQuery`：`/aip/airports` 的查询串。
 * - `fixRowKey`：航路点行的 key。代号不唯一。
 */
import type { AirwaySegment, Fix } from "@/lib/canDb";

/** Leaflet `LatLngBounds` 的四个边，经度可能超出 ±180（平移过了一圈）。 */
export interface ViewBounds {
  south: number;
  west: number;
  north: number;
  east: number;
}

const round = (x: number) => Number(x.toFixed(4));

/** 经度折回 [-180, 180)。 */
export function wrapLon(lon: number): number {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/**
 * 视野（可选外扩 `pad` 倍）→ `bbox` 参数值。
 *
 * 横跨 360° 及以上时给全经度。否则西边折回 [-180, 180)，东边按跨度推：超过 180 就是
 * 跨 180° 的盒子，写成 minLon > maxLon。
 */
export function bboxParam(b: ViewBounds, pad = 0): string {
  const dLat = (b.north - b.south) * pad;
  const dLon = (b.east - b.west) * pad;
  const south = Math.max(-90, b.south - dLat);
  const north = Math.min(90, b.north + dLat);
  let west = b.west - dLon;
  let east = b.east + dLon;
  if (east - west >= 360) {
    west = -180;
    east = 180;
  } else {
    const span = east - west;
    west = wrapLon(west);
    east = west + span;
    if (east > 180) east -= 360;
  }
  return [south, west, north, east].map(round).join(",");
}

/** 把 `lon` 挪 ±360，让它离 `ref` 不超过 180°。 */
export function lonNear(lon: number, ref: number): number {
  let out = lon;
  while (out - ref > 180) out -= 360;
  while (ref - out > 180) out += 360;
  return out;
}

/** 航段两端的显示代号。老 can-db 没有 `fromIdent`/`toIdent`，那时 `from`/`to` 就是代号。 */
export function segmentIdents(seg: AirwaySegment): {
  from: string;
  to: string;
} {
  return { from: seg.fromIdent ?? seg.from, to: seg.toIdent ?? seg.to };
}

export interface AirportFilter {
  q?: string;
  fir?: string;
  region?: string;
  limit?: number;
  cursor?: string | null;
  bbox?: string;
}

/** 机场清单一页多少条。can-db 的上限是 1000。 */
export const AIRPORT_PAGE = 200;

/** can-db 的 region 格式：两位，首位字母。 */
export const REGION_PATTERN = /^[A-Z][A-Z0-9]$/;

/**
 * `/aip/airports` 的查询串，不带 `?`。空值和格式不对的 region 不带。
 *
 * 调用处写成 `` `/api/v1/aip/airports?${airportsQuery(…)}` ``：`?` 留在字面量里，
 * `allowList.test.ts` 才认得出路径。
 */
export function airportsQuery(f: AirportFilter): string {
  const p = new URLSearchParams();
  const q = f.q?.trim();
  if (q) p.set("q", q);
  if (f.fir) p.set("fir", f.fir);
  const region = f.region?.trim().toUpperCase();
  if (region && REGION_PATTERN.test(region)) p.set("region", region);
  if (f.bbox) p.set("bbox", f.bbox);
  if (f.limit) p.set("limit", String(f.limit));
  if (f.cursor) p.set("cursor", f.cursor);
  return p.toString();
}

/** 航路点行的 key。同一 FIR 里同一代号可以有几行（不同 region、不同种类）。 */
export function fixRowKey(f: Fix): string {
  return `${f.ident}@${f.region ?? f.fir ?? ""}/${f.pointKind ?? ""}/${f.lat},${f.lon}`;
}
