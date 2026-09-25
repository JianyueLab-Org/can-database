/**
 * 地面图层的默认开关。
 *
 * 地面要素只有一份：扇区包手工做的那份（OSM 派生，来自 Ground 仓库）。
 *
 * 机位和跑道默认关：机位太密（一个大场几千个），跑道在别处已经画了。其余默认开。
 */

const ALWAYS_OFF = new Set(["parking_position", "runway"]);

export function defaultFeatureLayers(kinds: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = {};
  for (const k of kinds) out[k] = !ALWAYS_OFF.has(k);
  return out;
}
