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
