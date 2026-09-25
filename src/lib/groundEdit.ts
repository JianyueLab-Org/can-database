/**
 * 地面要素编辑器的模型：命中判断、编辑操作、撤销/重做、客户端校验。
 *
 * 纯函数，不 import Leaflet 也不 import Vue —— 命中判断拿一个投影函数（经纬度 → 屏幕像
 * 素）做参数，所以能在 `bun test` 里单独测。`GroundEditor.vue` 把 Leaflet 的
 * `latLngToContainerPoint` 传进来。
 *
 * **每个操作返回一份新数组，没改到的要素原样复用。** 撤销栈存的是整份快照，结构共享让
 * 快照几乎不占内存；编辑器重画时比对引用，只重画变了的那几条。
 *
 * **校验以 can-db 为准。** `validate` 照 `PUT …/ground` 的规则抄一份，只为了在保存前就
 * 指出是哪一条 —— can-db 回 400 时那句话仍然原样显示。改规则要改两处。
 */

export type LatLon = [number, number];

export interface Pt {
  x: number;
  y: number;
}

export type Project = (p: LatLon) => Pt;

/** 线上的形状：和 `GET/PUT /aip/airports/{icao}/ground[/source]` 的 json 逐字对应。 */
export interface EditFeature {
  kind: string;
  name: string | null;
  width_m: number | null;
  points: LatLon[];
}

/** can-db 接受的类别。次序即编辑器里下拉框的次序。 */
export const GROUND_KINDS = [
  "taxiway",
  "runway",
  "holding_position",
  "parking_position",
  "apron",
  "terminal",
  "aerodrome",
] as const;

export type GroundKind = (typeof GROUND_KINDS)[number];

/** 面：画成闭合多边形，点在里面也算命中。 */
export const POLYGON_KINDS: ReadonlySet<string> = new Set([
  "apron",
  "terminal",
  "aerodrome",
]);

/** 单点要素：画一下就完成，不等回车。 */
export const POINT_KINDS: ReadonlySet<string> = new Set(["holding_position"]);

/** 每一类至少几个点 —— 和 can-db 的校验一致。 */
export function minPoints(kind: string): number {
  if (POLYGON_KINDS.has(kind)) return 3;
  if (kind === "taxiway" || kind === "runway") return 2;
  return 1;
}

export function isKnownKind(kind: string): kind is GroundKind {
  return (GROUND_KINDS as readonly string[]).includes(kind);
}

export function isPolygonKind(kind: string): boolean {
  return POLYGON_KINDS.has(kind);
}

function samePoint(a: LatLon, b: LatLon): boolean {
  return a[0] === b[0] && a[1] === b[1];
}

/**
 * 面要素首尾是同一个点（Ground 仓库里的面都是这么存的）。
 *
 * 这样的环挪首点要连尾点一起挪，删首点要重新闭合 —— 否则一拖就是一个缺口。
 */
export function isClosedRing(f: EditFeature): boolean {
  return (
    isPolygonKind(f.kind) &&
    f.points.length >= 4 &&
    samePoint(f.points[0], f.points[f.points.length - 1])
  );
}

/** 要画出把手的顶点下标：闭合环的尾点和首点是同一个，只给一个把手。 */
export function handleIndices(f: EditFeature): number[] {
  const n = isClosedRing(f) ? f.points.length - 1 : f.points.length;
  return Array.from({ length: n }, (_, i) => i);
}

/** 新坐标保留 7 位小数（约 1 cm），和 Ground 仓库的精度一致，免得导出的文件满是噪声。 */
export function roundCoord(p: LatLon): LatLon {
  return [Math.round(p[0] * 1e7) / 1e7, Math.round(p[1] * 1e7) / 1e7];
}

/* ---------------------------------------------------------------------------
   命中判断。全部在屏幕坐标里做：容差是像素，和缩放无关。
--------------------------------------------------------------------------- */

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 点到线段的距离，以及线段上最近的那个点。 */
export function segmentDistance(p: Pt, a: Pt, b: Pt): { d: number; t: number } {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t =
    len2 === 0
      ? 0
      : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return { d: dist(p, { x: a.x + t * dx, y: a.y + t * dy }), t };
}

export function pointInPolygon(p: Pt, ring: Pt[]): boolean {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const a = ring[i];
    const b = ring[j];
    if (
      a.y > p.y !== b.y > p.y &&
      p.x < ((b.x - a.x) * (p.y - a.y)) / (b.y - a.y) + a.x
    ) {
      inside = !inside;
    }
  }
  return inside;
}

function area(ring: Pt[]): number {
  let s = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    s += (ring[j].x + ring[i].x) * (ring[j].y - ring[i].y);
  }
  return Math.abs(s / 2);
}

export interface VertexHit {
  feature: number;
  vertex: number;
}

export interface SegmentHit {
  feature: number;
  /** 线段 `segment` → `segment + 1`。 */
  segment: number;
  /** 在线段上的比例位置，0–1。 */
  t: number;
}

/**
 * 离 `at` 最近、在容差内的顶点。`only` 给了就只看那几条要素（通常是选中的那一条）。
 */
export function hitVertex(
  features: EditFeature[],
  project: Project,
  at: Pt,
  tolerance: number,
  only?: number[],
): VertexHit | null {
  let best: VertexHit | null = null;
  let bestD = tolerance;
  const indices = only ?? features.map((_, i) => i);
  for (const fi of indices) {
    const f = features[fi];
    if (!f) continue;
    for (const vi of handleIndices(f)) {
      const d = dist(project(f.points[vi]), at);
      if (d <= bestD) {
        bestD = d;
        best = { feature: fi, vertex: vi };
      }
    }
  }
  return best;
}

/** 离 `at` 最近、在容差内的线段。单点要素没有线段。 */
export function hitSegment(
  features: EditFeature[],
  project: Project,
  at: Pt,
  tolerance: number,
  only?: number[],
): SegmentHit | null {
  let best: SegmentHit | null = null;
  let bestD = tolerance;
  const indices = only ?? features.map((_, i) => i);
  for (const fi of indices) {
    const f = features[fi];
    if (!f || f.points.length < 2) continue;
    const pts = f.points.map(project);
    for (let i = 0; i < pts.length - 1; i++) {
      const { d, t } = segmentDistance(at, pts[i], pts[i + 1]);
      if (d <= bestD) {
        bestD = d;
        best = { feature: fi, segment: i, t };
      }
    }
  }
  return best;
}

/**
 * 点在哪条要素上。
 *
 * 次序：单点要素 → 线（最近的那条）→ 面的内部（**最小**的那块）。面是层层套着的 —— 场界
 * 装着机坪，机坪装着航站楼 —— 点在里面时最具体的那块才是想点的；线画在面上面，所以线先
 * 于面。
 */
export function hitFeature(
  features: EditFeature[],
  project: Project,
  at: Pt,
  tolerance: number,
): number | null {
  let best: number | null = null;
  let bestD = tolerance;
  for (let fi = 0; fi < features.length; fi++) {
    const f = features[fi];
    if (f.points.length !== 1) continue;
    const d = dist(project(f.points[0]), at);
    if (d <= bestD) {
      bestD = d;
      best = fi;
    }
  }
  if (best !== null) return best;

  const seg = hitSegment(features, project, at, tolerance);
  if (seg) return seg.feature;

  let smallest = Infinity;
  for (let fi = 0; fi < features.length; fi++) {
    const f = features[fi];
    if (!isPolygonKind(f.kind) || f.points.length < 3) continue;
    const ring = f.points.map(project);
    if (!pointInPolygon(at, ring)) continue;
    const a = area(ring);
    if (a < smallest) {
      smallest = a;
      best = fi;
    }
  }
  return best;
}

/* ---------------------------------------------------------------------------
   编辑操作。都返回新数组；做不到时返回 null（调用方据此提示），不抛异常。
--------------------------------------------------------------------------- */

function replaceAt(
  features: EditFeature[],
  fi: number,
  f: EditFeature,
): EditFeature[] {
  const out = features.slice();
  out[fi] = f;
  return out;
}

export function moveVertex(
  features: EditFeature[],
  fi: number,
  vi: number,
  to: LatLon,
): EditFeature[] {
  const f = features[fi];
  if (!f || vi < 0 || vi >= f.points.length) return features;
  const p = roundCoord(to);
  const points = f.points.slice();
  const last = points.length - 1;
  if (isClosedRing(f) && (vi === 0 || vi === last)) {
    points[0] = p;
    points[last] = p;
  } else {
    points[vi] = p;
  }
  return replaceAt(features, fi, { ...f, points });
}

/** 在线段 `segment` → `segment + 1` 中间插一个顶点。返回新数组和新顶点的下标。 */
export function insertVertex(
  features: EditFeature[],
  fi: number,
  segment: number,
  at: LatLon,
): { features: EditFeature[]; vertex: number } | null {
  const f = features[fi];
  if (!f || segment < 0 || segment >= f.points.length - 1) return null;
  const points = f.points.slice();
  points.splice(segment + 1, 0, roundCoord(at));
  return {
    features: replaceAt(features, fi, { ...f, points }),
    vertex: segment + 1,
  };
}

/** 删这个顶点之后还够不够这一类的下限。闭合环数的是不重复的顶点。 */
export function canDeleteVertex(f: EditFeature): boolean {
  const distinct = isClosedRing(f) ? f.points.length - 1 : f.points.length;
  return distinct - 1 >= minPoints(f.kind);
}

export function deleteVertex(
  features: EditFeature[],
  fi: number,
  vi: number,
): EditFeature[] | null {
  const f = features[fi];
  if (!f || vi < 0 || vi >= f.points.length) return null;
  if (!canDeleteVertex(f)) return null;
  const points = f.points.slice();
  if (isClosedRing(f)) {
    const last = points.length - 1;
    // 首尾是同一个点：删它就是删首点，再用新的首点把环闭上。
    points.splice(vi === last ? 0 : vi, 1);
    points[points.length - 1] = points[0];
  } else {
    points.splice(vi, 1);
  }
  return replaceAt(features, fi, { ...f, points });
}

export function addFeature(
  features: EditFeature[],
  f: EditFeature,
): { features: EditFeature[]; index: number } {
  return { features: [...features, f], index: features.length };
}

export function deleteFeature(
  features: EditFeature[],
  fi: number,
): EditFeature[] {
  if (fi < 0 || fi >= features.length) return features;
  return features.filter((_, i) => i !== fi);
}

/**
 * 改类别、代号、宽度。
 *
 * 代号两侧的空白收掉，空串存成 null —— 「没有代号」只有一种写法。宽度必须大于 0，否则
 * 返回 null（调用方显示错误、不改）。
 */
export function updateFeature(
  features: EditFeature[],
  fi: number,
  patch: Partial<Pick<EditFeature, "kind" | "name" | "width_m">>,
): EditFeature[] | null {
  const f = features[fi];
  if (!f) return null;
  const next: EditFeature = { ...f };
  if (patch.kind !== undefined) {
    if (!isKnownKind(patch.kind)) return null;
    next.kind = patch.kind;
  }
  if (patch.name !== undefined) {
    const name = patch.name?.trim() ?? "";
    next.name = name === "" ? null : name;
  }
  if (patch.width_m !== undefined) {
    if (
      patch.width_m !== null &&
      !(Number.isFinite(patch.width_m) && patch.width_m > 0)
    ) {
      return null;
    }
    next.width_m = patch.width_m;
  }
  if (
    next.kind === f.kind &&
    next.name === f.name &&
    next.width_m === f.width_m
  ) {
    return features;
  }
  return replaceAt(features, fi, next);
}

/**
 * 把一条画完的草稿变成要素。面要素首尾闭合（和 Ground 仓库里的面一样）。
 *
 * 点数不够这一类的下限时返回 null。
 */
export function finishDraft(kind: string, draft: LatLon[]): EditFeature | null {
  const points = draft.map(roundCoord);
  if (points.length < minPoints(kind)) return null;
  if (isPolygonKind(kind) && !samePoint(points[0], points[points.length - 1])) {
    points.push(points[0]);
  }
  return { kind, name: null, width_m: null, points };
}

/* ---------------------------------------------------------------------------
   校验：照 can-db `PUT …/ground` 的规则。
--------------------------------------------------------------------------- */

export type IssueCode = "kind" | "points" | "width" | "coords";

export interface Issue {
  feature: number;
  code: IssueCode;
}

export function validateFeature(f: EditFeature): IssueCode[] {
  const out: IssueCode[] = [];
  if (!isKnownKind(f.kind)) out.push("kind");
  if (f.points.length < minPoints(f.kind)) out.push("points");
  if (f.width_m !== null && !(Number.isFinite(f.width_m) && f.width_m > 0)) {
    out.push("width");
  }
  if (
    f.points.some(
      ([lat, lon]) =>
        !Number.isFinite(lat) ||
        !Number.isFinite(lon) ||
        Math.abs(lat) > 90 ||
        Math.abs(lon) > 180,
    )
  ) {
    out.push("coords");
  }
  return out;
}

export function validate(features: EditFeature[]): Issue[] {
  const out: Issue[] = [];
  features.forEach((f, feature) => {
    for (const code of validateFeature(f)) out.push({ feature, code });
  });
  return out;
}

/** 从 can-db 读回来的一条规整成编辑器的形状：缺的字段补 null。 */
export function normalizeFeature(raw: Partial<EditFeature>): EditFeature {
  return {
    kind: String(raw.kind ?? ""),
    name: raw.name ?? null,
    width_m: raw.width_m ?? null,
    points: (raw.points ?? []).map((p) => [p[0], p[1]] as LatLon),
  };
}

/* ---------------------------------------------------------------------------
   撤销 / 重做。存整份快照；「改没改」看当前快照是不是保存时的那一份。
--------------------------------------------------------------------------- */

export class EditHistory {
  private past: EditFeature[][] = [];
  private future: EditFeature[][] = [];
  private saved: EditFeature[];
  private now: EditFeature[];

  constructor(
    initial: EditFeature[],
    private readonly limit = 200,
  ) {
    this.now = initial;
    this.saved = initial;
  }

  get current(): EditFeature[] {
    return this.now;
  }

  get canUndo(): boolean {
    return this.past.length > 0;
  }

  get canRedo(): boolean {
    return this.future.length > 0;
  }

  /**
   * 有没有没保存的改动。撤销回到保存时的那一份就不算改过 —— 比的是快照引用，不是内容。
   */
  get dirty(): boolean {
    return this.now !== this.saved;
  }

  /** 记一步。和当前是同一份（操作没改任何东西）时不记。 */
  commit(next: EditFeature[]): void {
    if (next === this.now) return;
    this.past.push(this.now);
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
    this.now = next;
  }

  undo(): EditFeature[] {
    const prev = this.past.pop();
    if (prev) {
      this.future.push(this.now);
      this.now = prev;
    }
    return this.now;
  }

  redo(): EditFeature[] {
    const next = this.future.pop();
    if (next) {
      this.past.push(this.now);
      this.now = next;
    }
    return this.now;
  }

  /**
   * 保存成功：发出去的那一份就是库里的那一份。
   *
   * 传 `snapshot` 是因为保存是异步的 —— 请求在路上时又改了一笔，库里的是发出去的那份，
   * 不是此刻的这份。
   */
  markSaved(snapshot: EditFeature[] = this.now): void {
    this.saved = snapshot;
  }
}
