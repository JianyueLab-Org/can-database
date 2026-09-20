/**
 * 把屏幕上的表转成文件。
 *
 * **这里是渲染，不是数据规则。** 判据是 AGENTS.md:32 那一条：排序、即时过滤、把
 * procedure 分成两栏显示都留在这个站；而「这批数据能不能再分发」是一条关于数据的
 * 规则，住在 can-db，由响应信封上的 `licence` 带过来 —— 这里只负责把它印出去。
 *
 * 纯函数，不碰 DOM。下载那一步在 `download.ts`。
 */
import type { Licence } from "@/lib/canDb";

/** 一列：显示用的名字 + 取值。i18n 键在 columns.ts，调用方解好再传进来。 */
export interface Column<T> {
  header: string;
  get: (row: T) => unknown;
}

const BOM = "﻿";
const EOL = "\r\n";

/**
 * 许可抬头。
 *
 * `licence` 为 null 表示不知道（老版本 can-db），按最保守的一档处理 —— 但「最保守」
 * 在这里是**不做正面表述**，而不是编一句警示：我们并不知道这批数据受不受限，印一句
 * 具体的警示等于替 can-db 断言了一件它没说过的事。
 */
function header(licence: Licence | null): string[] {
  if (!licence || !licence.notice) return [];
  const lines = [`# ${licence.notice}`];
  if (licence.airac.length > 0)
    lines.push(`# AIRAC ${licence.airac.join(" ")}`);
  for (const a of licence.attributions) lines.push(`# ${a}`);
  return lines;
}

/** RFC 4180 的一格。 */
function cell(value: unknown): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function toCSV<T>(
  rows: T[],
  columns: Column<T>[],
  licence: Licence | null,
): string {
  const lines = [
    ...header(licence),
    columns.map((c) => cell(c.header)).join(","),
    ...rows.map((row) => columns.map((c) => cell(c.get(row))).join(",")),
  ];
  return BOM + lines.join(EOL) + EOL;
}

/**
 * 给脚本吃的那一份。
 *
 * **键名原样保留 can-db 给的英文。** CSV 那一份的中文列名是给 Excel 看的；同一个
 * 字段两种名字是有意的分工，不是不一致。
 */
export function toJSON<T>(rows: T[], licence: Licence | null): string {
  return JSON.stringify({ licence, data: rows }, null, 2) + "\n";
}

/** 一行的几何怎么取。取不到就返回 null，那一行会被跳过。 */
export type Geometry<T> =
  | { kind: "point"; at: (row: T) => [number, number] | null }
  | { kind: "line"; path: (row: T) => Array<[number, number]> | null }
  | {
      kind: "multiline";
      paths: (row: T) => Array<Array<[number, number]>> | null;
    };

/**
 * 带坐标的那几张表另出一份。
 *
 * **坐标顺序是 [经度, 纬度]**，GeoJSON 规范如此，和页面上「纬度在前」的读法相反。
 *
 * **取不到几何的行跳过，不写 null geometry。** 规范允许 null，但 QGIS 和
 * geojson.io 对它的处理各不相同，而一个静默少了几行的图层比一个报错的图层更难发现。
 *
 * licence 挂在 FeatureCollection 顶层 —— 规范允许 foreign member。
 */
export function toGeoJSON<T>(
  rows: T[],
  geometry: Geometry<T>,
  columns: Column<T>[],
  licence: Licence | null,
): string {
  const features = [];
  for (const row of rows) {
    let shape: { type: string; coordinates: unknown } | null = null;
    if (geometry.kind === "point") {
      const at = geometry.at(row);
      if (at) shape = { type: "Point", coordinates: at };
    } else if (geometry.kind === "line") {
      const path = geometry.path(row);
      if (path && path.length >= 2)
        shape = { type: "LineString", coordinates: path };
    } else {
      /* 断口处断开 —— 少于两个点的段画不成线，直接丢。一段也不剩就跳过这一行。 */
      const paths = (geometry.paths(row) ?? []).filter(
        (seg) => seg.length >= 2,
      );
      if (paths.length > 0)
        shape = { type: "MultiLineString", coordinates: paths };
    }
    if (!shape) continue;

    const properties: Record<string, unknown> = {};
    for (const c of columns) properties[c.header] = c.get(row) ?? null;
    features.push({ type: "Feature", geometry: shape, properties });
  }
  return (
    JSON.stringify({ type: "FeatureCollection", licence, features }, null, 2) +
    "\n"
  );
}
