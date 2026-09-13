import type { NetworkSector, SectorOwnership } from "@/lib/canDb";

/**
 * 扇区图层里几条**会静默出错**的规则。
 *
 * 抽出来是因为它们错了屏幕不会说话：颜色错了仍然是一张好看的图，画的顺序错了仍然每块
 * 都在，只是点不到想点的那块。和 `taxiwayLabels.ts` 同一个理由 —— 判据能单独测就单独测。
 */

/** 海里换米。`L.circle` 的半径是米，而 ESE 给的是海里。 */
export const NM_TO_M = 1852;

/** 一个呼号一个颜色，稳定：同一个呼号每次打开都是同一色。 */
export function ownerColor(callsign: string): string {
  let h = 0;
  for (let i = 0; i < callsign.length; i++) {
    h = (h * 31 + callsign.charCodeAt(i)) >>> 0;
  }
  return `hsl(${h % 360} 70% 55%)`;
}

/** 一块扇区在图上的三种状态。**是三种，不是两种** —— 见 sectorState。 */
export type SectorState = "unresolved" | "owned" | "uncovered";

/**
 * 这块扇区处在哪一种状态。
 *
 * **「没解析过」和「没人管」必须分开。** can-db 显式返回 `uncovered` 就是为了这件事：
 * 「没人管」和「没查到」在地图上长得一样，而它们是两件事。把没解析过的也画成「没人管」，
 * 等于告诉看图的人全网一块都没人管 —— 而他根本还没输入在线名单。
 */
export function sectorState(
  own: SectorOwnership | undefined | null,
): SectorState {
  if (!own) return "unresolved";
  if (own.uncovered) return "uncovered";
  return own.owner ? "owned" : "uncovered";
}

/** Leaflet 的 `PathOptions` 里这一层用得到的那几个。 */
export interface SectorPaint {
  color: string;
  weight: number;
  fillOpacity: number;
  fillColor?: string;
  dashArray?: string;
}

/**
 * 三种状态各一种画法。
 *
 * 没人管画**红色虚线且不填充** —— 和包色实线、和归属色半透明填充三者一眼分得开。
 */
export function sectorPaint(
  own: SectorOwnership | undefined | null,
  packageColor: string,
): SectorPaint {
  switch (sectorState(own)) {
    case "uncovered":
      return {
        color: "#e05252",
        weight: 1.5,
        dashArray: "5 4",
        fillOpacity: 0,
      };
    case "owned": {
      const c = ownerColor(own!.owner!);
      return { color: c, weight: 1.5, fillColor: c, fillOpacity: 0.14 };
    }
    default:
      return {
        color: packageColor,
        weight: 1,
        fillColor: packageColor,
        fillOpacity: 0.06,
      };
  }
}

/**
 * 包围盒面积，只用来排画的顺序。经纬度当平面用 —— 比大小够了，不需要投影。
 *
 * 顶点为空的多边形返回 0：它画不出来，排在最后无所谓。
 */
export function spread(sc: NetworkSector): number {
  if (sc.shape === "circle") return (sc.radiusNm ?? 0) ** 2;
  if (!sc.vertices.length) return 0;
  let minLat = 90,
    maxLat = -90,
    minLon = 180,
    maxLon = -180;
  for (const [lat, lon] of sc.vertices) {
    if (lat < minLat) minLat = lat;
    if (lat > maxLat) maxLat = lat;
    if (lon < minLon) minLon = lon;
    if (lon > maxLon) maxLon = lon;
  }
  return (maxLat - minLat) * (maxLon - minLon);
}

/**
 * 画的顺序：**大的先画，小的后画。**
 *
 * 扇区是竖着摞起来的 —— 同一片地面上常有低层塔台、进近和区域好几块，而 Leaflet 的点击
 * 只命中最上面那一个。按包围盒从大到小加进去，点下去命中的就是最小最具体的那块，而大块
 * 在它自己独占的地方仍然点得到。
 *
 * 这解决不了「一个点上摞着四块、想全部列出来」——那要自己做点在多边形内的判断。它挡掉的
 * 是最常见的那种错：想点塔台却弹出区调。
 *
 * **不原地排序**：传进来的那个数组是缓存里的那一份，原地排会让缓存跟着变。
 */
export function drawOrder(list: NetworkSector[]): NetworkSector[] {
  return [...list].sort((a, b) => spread(b) - spread(a));
}
