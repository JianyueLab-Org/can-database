/** 把一段文本交给浏览器下载。这个文件碰 DOM，只能在岛屿里用。 */

/** `stands_ZBAA_2609_20260920.csv`：资源、场（有的话）、周期、导出日期。 */
export function exportFilename(
  resource: string,
  scope: string | null,
  airac: string[],
  ext: string,
  now: Date = new Date(),
): string {
  const cycle = airac.length > 0 ? airac.join("-") : "unknown";
  const day = now.toISOString().slice(0, 10).replaceAll("-", "");
  return [resource, scope, cycle, day].filter(Boolean).join("_") + "." + ext;
}

export function download(filename: string, mime: string, text: string): void {
  const url = URL.createObjectURL(new Blob([text], { type: mime }));
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
}
