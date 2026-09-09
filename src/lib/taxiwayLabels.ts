/**
 * 滑行道编号标在图上的位置。
 *
 * **一个编号一个标注，放在最长那一段上。**
 *
 * 一条滑行道在数据里是几十条短线：航图那一份是几十条短路径（ZBAA 195 条带编号的线只有
 * 141 种编号），OSM 那一份是被每个路口切开的 way。逐条标就是同一个 `C3` 沿着滑行道印
 * 二十遍，糊成一条黑带 —— 那不是「标出编号」，那是把图盖住。
 *
 * 挑**最长**的那一段，因为它最可能是这条滑行道的主干。挑第一条或随便一条，取决于数据在
 * 数组里的顺序，而那个顺序没有任何含义（航图那份是内容流里的出现次序，OSM 那份是 id）。
 *
 * 中点按**长度**取而不按顶点序号：一段折线的顶点可能疏密不均，取中间那个顶点会把标注甩
 * 到一头去。
 */

export interface TaxiwaySegment {
  name: string;
  /** [纬, 经] */
  points: [number, number][];
}

export interface TaxiwayLabel {
  name: string;
  lat: number;
  lon: number;
}

/** 两点之间的近似米数。机场这个尺度上够用，而且只用来比大小。 */
function metres(a: [number, number], b: [number, number]): number {
  const deg = 111320;
  const dy = (b[0] - a[0]) * deg;
  const dx = (b[1] - a[1]) * deg * Math.cos((a[0] * Math.PI) / 180);
  return Math.hypot(dx, dy);
}

/** 一条折线的长度，以及按长度取的中点。 */
function measure(points: [number, number][]): {
  length: number;
  mid: [number, number];
} {
  let total = 0;
  for (let i = 1; i < points.length; i++)
    total += metres(points[i - 1], points[i]);
  const half = total / 2;
  let run = 0;
  for (let i = 1; i < points.length; i++) {
    const d = metres(points[i - 1], points[i]);
    if (run + d >= half) {
      const t = d === 0 ? 0 : (half - run) / d;
      return {
        length: total,
        mid: [
          points[i - 1][0] + (points[i][0] - points[i - 1][0]) * t,
          points[i - 1][1] + (points[i][1] - points[i - 1][1]) * t,
        ],
      };
    }
    run += d;
  }
  return { length: total, mid: points[0] };
}

/** 每个编号挑一个标注位置。 */
export function taxiwayLabels(segments: TaxiwaySegment[]): TaxiwayLabel[] {
  const best = new Map<string, { length: number; mid: [number, number] }>();
  for (const s of segments) {
    // 先规范化再分组，否则 `C3` 和 `C3 ` 会各出一个标注。
    const name = (s.name ?? "").trim();
    if (!name || !s.points || s.points.length < 2) continue;
    const m = measure(s.points);
    const cur = best.get(name);
    if (!cur || m.length > cur.length) best.set(name, m);
  }
  return [...best.entries()].map(([name, m]) => ({
    name,
    lat: m.mid[0],
    lon: m.mid[1],
  }));
}

/**
 * 把一个点吸附到一条折线上（取垂足，落在段外就收到端点）。
 *
 * **给滑行道编号用的。** 航图把编号印在线**旁边**：实测离它命名的那条线中位 9–16 米、
 * 最大 30 米（30 是绑定阈值）。在机场图的缩放下这是个看得见的空隙，而平行滑行道间距常常
 * 只有几十米 —— 30 米的偏就能让标注**看起来离邻线更近**，读的人根本认不出它在说哪条。
 *
 * 吸附是**渲染**的事：库里存的仍然是航图印它的位置（`refLat`/`refLon`），那是事实；摆在
 * 哪儿好读是另一回事。所以这一步在这里做，不在 can-db 做。
 *
 * 不外插：垂足在段外就收到端点。外插会把标注甩到线的延长线上，比原来更远。
 */
export function snapToLine(
  lat: number,
  lon: number,
  points: [number, number][],
): [number, number] {
  if (!points || points.length < 2) return [lat, lon];
  // 米每度。经度那一档随纬度收缩，在机场这个尺度上取一次就够。
  const mLat = 111320;
  const mLon = mLat * Math.cos((lat * Math.PI) / 180);

  let best = Infinity;
  let out: [number, number] = [lat, lon];
  for (let i = 1; i < points.length; i++) {
    const [aLat, aLon] = points[i - 1];
    const [bLat, bLon] = points[i];
    const ax = (aLon - lon) * mLon;
    const ay = (aLat - lat) * mLat;
    const bx = (bLon - lon) * mLon;
    const by = (bLat - lat) * mLat;
    const dx = bx - ax;
    const dy = by - ay;
    const l2 = dx * dx + dy * dy;
    const t =
      l2 === 0 ? 0 : Math.max(0, Math.min(1, -(ax * dx + ay * dy) / l2));
    const d = Math.hypot(ax + t * dx, ay + t * dy);
    if (d < best) {
      best = d;
      out = [aLat + (bLat - aLat) * t, aLon + (bLon - aLon) * t];
    }
  }
  return out;
}
