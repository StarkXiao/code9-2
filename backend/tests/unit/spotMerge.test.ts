import { describe, expect, it } from "vitest";
import { deepEqual, mergeSpotStates, type EditableState } from "../../src/modules/spots/merge";

function state(overrides: Partial<EditableState> = {}): EditableState {
  return {
    title: "梧桐树下的长椅",
    description: "傍晚有树荫",
    categoryCode: "bench",
    attributes: { has_backrest: true, count: 3, condition: "good" },
    lat: 31.23,
    lng: 121.47,
    fuzzEnabled: true,
    fuzzRadiusM: 50,
    mediaUuids: ["m1", "m2"],
    ...overrides,
  };
}

describe("deepEqual", () => {
  it("键序不同的对象视为相等", () => {
    expect(deepEqual({ a: 1, b: [1, 2] }, { b: [1, 2], a: 1 })).toBe(true);
  });

  it("数组顺序不同则不相等", () => {
    expect(deepEqual([1, 2], [2, 1])).toBe(false);
  });

  it("null 与 undefined 不相等", () => {
    expect(deepEqual(null, undefined)).toBe(false);
  });
});

describe("三方合并：无冲突自动合并", () => {
  it("双方各改不同字段时，两份修改都保留", () => {
    const base = state();
    const current = state({ title: "别人改的标题" });
    const proposed = state({ description: "我改的描述" });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.state.title).toBe("别人改的标题");
    expect(outcome.state.description).toBe("我改的描述");
    expect(outcome.appliedFields).toContain("description");
  });

  it("双方改成一样的值不算冲突", () => {
    const base = state();
    const current = state({ title: "同一个标题" });
    const proposed = state({ title: "同一个标题" });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.state.title).toBe("同一个标题");
  });

  it("我没动的字段保留对方的修改", () => {
    const base = state();
    const current = state({ fuzzEnabled: false, fuzzRadiusM: 0 });
    const proposed = state({ title: "只改标题" });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.state.fuzzEnabled).toBe(false);
    expect(outcome.state.title).toBe("只改标题");
  });

  it("属性逐 key 合并：各改各的属性互不干扰", () => {
    const base = state();
    const current = state({ attributes: { has_backrest: false, count: 3, condition: "good" } });
    const proposed = state({ attributes: { has_backrest: true, count: 5, condition: "good" } });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.state.attributes).toEqual({ has_backrest: false, count: 5, condition: "good" });
  });

  it("一方删除属性 key、另一方没动，删除生效", () => {
    const base = state();
    const current = state();
    const proposed = state({ attributes: { has_backrest: true, condition: "good" } });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.state.attributes).not.toHaveProperty("count");
  });

  it("一方删图、另一方没动图片，删除不会被复活", () => {
    const base = state();
    const current = state({ title: "别人只改标题" });
    const proposed = state({ mediaUuids: ["m1"] });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(0);
    expect(outcome.state.mediaUuids).toEqual(["m1"]);
  });
});

describe("三方合并：冲突字段双方各留一份", () => {
  it("同一字段双方改成不同值 → 冲突，合并结果保持当前值", () => {
    const base = state();
    const current = state({ title: "别人的标题" });
    const proposed = state({ title: "我的标题" });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]).toMatchObject({
      field: "title",
      base: "梧桐树下的长椅",
      current: "别人的标题",
      proposed: "我的标题",
    });
    // 冲突字段在合并结果里保持当前值，等编辑者确认后再定
    expect(outcome.state.title).toBe("别人的标题");
  });

  it("同一属性 key 双方改不同值 → 按 attributes.<key> 记录冲突", () => {
    const base = state();
    const current = state({ attributes: { has_backrest: true, count: 4, condition: "good" } });
    const proposed = state({ attributes: { has_backrest: true, count: 6, condition: "good" } });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]?.field).toBe("attributes.count");
    expect(outcome.state.attributes.count).toBe(4);
  });

  it("经纬度作为整体冲突，不会出现各取一半的坐标", () => {
    const base = state();
    const current = state({ lat: 31.5, lng: 121.6 });
    const proposed = state({ lat: 30.1, lng: 120.2 });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]?.field).toBe("location");
    expect(outcome.state.lat).toBe(31.5);
    expect(outcome.state.lng).toBe(121.6);
  });

  it("双方都改了图片列表 → 整体冲突而不是胡乱并集", () => {
    const base = state();
    const current = state({ mediaUuids: ["m1", "m3"] });
    const proposed = state({ mediaUuids: ["m2", "m4"] });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]?.field).toBe("media");
    expect(outcome.state.mediaUuids).toEqual(["m1", "m3"]);
  });

  it("分类不一致时属性整体取舍，不混用两套 schema 的字段", () => {
    const base = state();
    // 双方都改了分类且改得不一样 → 分类本身冲突，属性也只能整体取舍
    const current = state({ categoryCode: "drinking_water", attributes: { water_type: "direct" } });
    const proposed = state({ categoryCode: "quiet_corner", attributes: { quiet_level: "high" } });

    const outcome = mergeSpotStates(base, current, proposed);

    const fields = outcome.conflicts.map((conflict) => conflict.field);
    expect(fields).toContain("categoryCode");
    expect(fields).toContain("attributes");
    expect(fields.some((field) => field.startsWith("attributes."))).toBe(false);
    expect(outcome.state.categoryCode).toBe("drinking_water");
  });

  it("多个字段同时冲突时全部列出", () => {
    const base = state();
    const current = state({ title: "别人的标题", description: "别人的描述" });
    const proposed = state({ title: "我的标题", description: "我的描述" });

    const outcome = mergeSpotStates(base, current, proposed);

    expect(outcome.conflicts.map((conflict) => conflict.field).sort()).toEqual(["description", "title"]);
  });
});
