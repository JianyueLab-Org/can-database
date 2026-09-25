import { describe, expect, test } from "bun:test";
import {
  EditHistory,
  addFeature,
  canDeleteVertex,
  deleteFeature,
  deleteVertex,
  finishDraft,
  handleIndices,
  hitFeature,
  hitSegment,
  hitVertex,
  insertVertex,
  isClosedRing,
  moveVertex,
  updateFeature,
  validate,
  type EditFeature,
  type LatLon,
  type Project,
} from "@/lib/groundEdit";

/** 测试用投影：纬度 → y（向下为正取反），经度 → x，1 度 = 1000 像素。 */
const project: Project = ([lat, lon]) => ({ x: lon * 1000, y: -lat * 1000 });

const f = (
  kind: string,
  points: LatLon[],
  name: string | null = null,
): EditFeature => ({ kind, name, width_m: null, points });

const square: LatLon[] = [
  [0, 0],
  [0, 1],
  [1, 1],
  [1, 0],
  [0, 0],
];

describe("命中判断", () => {
  const features = [
    f("aerodrome", [
      [-1, -1],
      [-1, 3],
      [3, 3],
      [3, -1],
      [-1, -1],
    ]),
    f("apron", square),
    f("taxiway", [
      [0.5, 2],
      [0.5, 2.5],
    ]),
    f("holding_position", [[2, 2]]),
  ];

  test("顶点在容差内才命中，取最近的", () => {
    expect(hitVertex(features, project, { x: 1003, y: -1000 }, 8)).toEqual({
      feature: 1,
      vertex: 2,
    });
    expect(hitVertex(features, project, { x: 1020, y: -1000 }, 8)).toBeNull();
  });

  test("只看选中的那一条", () => {
    expect(
      hitVertex(features, project, { x: 2000, y: -500 }, 8, [1]),
    ).toBeNull();
    expect(hitVertex(features, project, { x: 2000, y: -500 }, 8, [2])).toEqual({
      feature: 2,
      vertex: 0,
    });
  });

  test("闭合环的尾点不单独算把手", () => {
    expect(handleIndices(features[1])).toEqual([0, 1, 2, 3]);
    expect(hitVertex(features, project, { x: 0, y: 0 }, 8, [1])).toEqual({
      feature: 1,
      vertex: 0,
    });
  });

  test("线段命中带比例位置", () => {
    const hit = hitSegment(features, project, { x: 2250, y: -503 }, 8);
    expect(hit?.feature).toBe(2);
    expect(hit?.segment).toBe(0);
    expect(hit?.t).toBeCloseTo(0.5, 5);
  });

  test("单点要素按点命中", () => {
    expect(hitFeature(features, project, { x: 2004, y: -2000 }, 8)).toBe(3);
  });

  test("线先于面", () => {
    expect(hitFeature(features, project, { x: 2250, y: -500 }, 8)).toBe(2);
  });

  test("面的内部命中最小的那块", () => {
    expect(hitFeature(features, project, { x: 500, y: -500 }, 8)).toBe(1);
    expect(hitFeature(features, project, { x: 2500, y: -2500 }, 8)).toBe(0);
  });

  test("空白处不命中", () => {
    expect(hitFeature(features, project, { x: 9000, y: 9000 }, 8)).toBeNull();
  });
});

describe("编辑操作", () => {
  const line = f("taxiway", [
    [0, 0],
    [0, 1],
    [0, 2],
  ]);

  test("移动顶点：新数组，没动的要素复用", () => {
    const other = f("taxiway", [
      [5, 5],
      [5, 6],
    ]);
    const before = [line, other];
    const after = moveVertex(before, 0, 1, [0.123456789, 1]);
    expect(after).not.toBe(before);
    expect(after[1]).toBe(other);
    expect(after[0].points[1]).toEqual([0.1234568, 1]);
    expect(before[0].points[1]).toEqual([0, 1]);
  });

  test("闭合环挪首点，尾点跟着走", () => {
    const [ring] = moveVertex([f("apron", square)], 0, 0, [-0.5, -0.5]);
    expect(ring.points[0]).toEqual([-0.5, -0.5]);
    expect(ring.points[4]).toEqual([-0.5, -0.5]);
    expect(isClosedRing(ring)).toBe(true);
  });

  test("在线段上插点", () => {
    const r = insertVertex([line], 0, 0, [0, 0.5]);
    expect(r?.vertex).toBe(1);
    expect(r?.features[0].points).toEqual([
      [0, 0],
      [0, 0.5],
      [0, 1],
      [0, 2],
    ]);
    expect(insertVertex([line], 0, 2, [0, 3])).toBeNull();
  });

  test("删顶点守住每一类的下限", () => {
    const two = f("taxiway", [
      [0, 0],
      [0, 1],
    ]);
    expect(canDeleteVertex(two)).toBe(false);
    expect(deleteVertex([two], 0, 0)).toBeNull();
    expect(deleteVertex([line], 0, 1)?.[0].points).toEqual([
      [0, 0],
      [0, 2],
    ]);
    expect(deleteVertex([f("holding_position", [[1, 1]])], 0, 0)).toBeNull();
  });

  test("闭合环删首点后重新闭合；三角形不能再删", () => {
    const [ring] = deleteVertex([f("apron", square)], 0, 0)!;
    expect(ring.points).toEqual([
      [0, 1],
      [1, 1],
      [1, 0],
      [0, 1],
    ]);
    expect(canDeleteVertex(ring)).toBe(false);
  });

  test("加、删要素", () => {
    const { features, index } = addFeature(
      [line],
      f("holding_position", [[1, 1]]),
    );
    expect(index).toBe(1);
    expect(features).toHaveLength(2);
    expect(deleteFeature(features, 0)).toEqual([features[1]]);
  });

  test("改类别、代号、宽度", () => {
    const [a] = updateFeature([line], 0, {
      kind: "runway",
      name: "  W9 ",
      width_m: 45,
    })!;
    expect(a).toMatchObject({ kind: "runway", name: "W9", width_m: 45 });
    expect(updateFeature([line], 0, { name: "   " })![0].name).toBeNull();
    expect(updateFeature([line], 0, { width_m: 0 })).toBeNull();
    expect(updateFeature([line], 0, { kind: "road" })).toBeNull();
  });

  test("什么都没改时返回同一份（不进撤销栈）", () => {
    const before = [line];
    expect(updateFeature(before, 0, { name: "" })).toBe(before);
  });

  test("画完的草稿：面自动闭合，点数不够不成", () => {
    const poly = finishDraft("apron", [
      [0, 0],
      [0, 1],
      [1, 1],
    ]);
    expect(poly?.points).toHaveLength(4);
    expect(isClosedRing(poly!)).toBe(true);
    expect(finishDraft("taxiway", [[0, 0]])).toBeNull();
    expect(finishDraft("holding_position", [[0, 0]])?.points).toEqual([[0, 0]]);
  });
});

describe("校验", () => {
  test("照 can-db 的规则", () => {
    const issues = validate([
      f("apron", [
        [0, 0],
        [0, 1],
      ]),
      f("road", [[0, 0]]),
      { ...f("taxiway", square), width_m: -1 },
      f("holding_position", [[95, 0]]),
      f("parking_position", [[0, 0]]),
    ]);
    expect(issues).toEqual([
      { feature: 0, code: "points" },
      { feature: 1, code: "kind" },
      { feature: 2, code: "width" },
      { feature: 3, code: "coords" },
    ]);
  });
});

describe("撤销 / 重做", () => {
  test("撤销回保存时的那一份就不算改过", () => {
    const initial = [f("holding_position", [[0, 0]])];
    const h = new EditHistory(initial);
    expect(h.dirty).toBe(false);
    h.commit(moveVertex(h.current, 0, 0, [1, 1]));
    expect(h.dirty).toBe(true);
    expect(h.canUndo).toBe(true);
    expect(h.undo()).toBe(initial);
    expect(h.dirty).toBe(false);
    h.redo();
    expect(h.current[0].points[0]).toEqual([1, 1]);
    h.markSaved();
    expect(h.dirty).toBe(false);
  });

  test("新的一步清掉重做；同一份不记", () => {
    const h = new EditHistory([]);
    const a = [f("holding_position", [[0, 0]])];
    h.commit(a);
    h.undo();
    expect(h.canRedo).toBe(true);
    h.commit([f("holding_position", [[1, 1]])]);
    expect(h.canRedo).toBe(false);
    const cur = h.current;
    h.commit(cur);
    h.undo();
    expect(h.current).toEqual([]);
  });

  test("保存的是发出去的那一份，请求在路上时的改动仍算未保存", () => {
    const h = new EditHistory([]);
    h.commit([f("holding_position", [[0, 0]])]);
    const sent = h.current;
    h.commit([f("holding_position", [[1, 1]])]);
    h.markSaved(sent);
    expect(h.dirty).toBe(true);
    h.undo();
    expect(h.dirty).toBe(false);
  });

  test("撤销栈有上限", () => {
    const h = new EditHistory([], 3);
    for (let i = 0; i < 5; i++) h.commit([f("holding_position", [[i, i]])]);
    let n = 0;
    while (h.canUndo) {
      h.undo();
      n++;
    }
    expect(n).toBe(3);
  });
});
