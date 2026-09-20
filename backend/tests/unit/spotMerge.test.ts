import { describe, expect, it } from "vitest";
import { mergeSpotInput, MAX_MEDIA_PER_SPOT, type SpotFormState } from "../../src/modules/spots/merge";

/**
 * 三路合并的基线场景：两人同时打开编辑页，各自改了内容再先后保存。
 * base = 双方打开页面时的内容，theirs = 对方已保存的内容，yours = 我方本次提交。
 */
function makeBase(overrides: Partial<SpotFormState> = {}): SpotFormState {
  return {
    categoryCode: "bench",
    title: "梧桐树下的长椅",
    description: "傍晚有树荫",
    attributes: { has_backrest: true, count: 2, shade: "full" },
    lat: 31.2304,
    lng: 121.4737,
    fuzzEnabled: true,
    fuzzRadiusM: 50,
    mediaUuids: ["img-a", "img-b"],
    ...overrides,
  };
}

describe("条目并发编辑的三路合并", () => {
  it("双方改了不同字段时自动合并，不产生冲突", () => {
    const base = makeBase();
    const theirs = makeBase({ title: "对方改的新标题" });
    const yours = makeBase({ description: "我方补充的描述" });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.title).toBe("对方改的新标题");
    expect(outcome.merged.description).toBe("我方补充的描述");
    expect(outcome.autoMergedFields).toContain("title");
    expect(outcome.autoMergedFields).not.toContain("description");
  });

  it("双方改同一字段且结果不同 → 冲突，两份值都保留", () => {
    const base = makeBase();
    const theirs = makeBase({ title: "对方的标题" });
    const yours = makeBase({ title: "我方的标题" });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([
      { field: "title", base: "梧桐树下的长椅", theirs: "对方的标题", yours: "我方的标题" },
    ]);
    // 冲突字段在 merged 里先预填我方值，供前端在此基础上逐项选择
    expect(outcome.merged.title).toBe("我方的标题");
  });

  it("双方改同一字段且结果相同 → 不算冲突", () => {
    const base = makeBase();
    const outcome = mergeSpotInput(base, makeBase({ title: "一样的标题" }), makeBase({ title: "一样的标题" }));

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.title).toBe("一样的标题");
  });

  it("只有我方改动时全部生效，autoMergedFields 为空", () => {
    const base = makeBase();
    const yours = makeBase({ title: "新标题", fuzzEnabled: false, fuzzRadiusM: 0 });

    const outcome = mergeSpotInput(base, makeBase(), yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.autoMergedFields).toEqual([]);
    expect(outcome.merged.title).toBe("新标题");
    expect(outcome.merged.fuzzEnabled).toBe(false);
  });

  it("resolveConflicts 时冲突字段以我方提交值为准", () => {
    const base = makeBase();
    const theirs = makeBase({ title: "对方的标题" });
    const yours = makeBase({ title: "我方的标题" });

    const outcome = mergeSpotInput(base, theirs, yours, { resolveConflicts: true });

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.title).toBe("我方的标题");
  });

  it("resolveConflicts 时我方未动的字段仍然自动合并对方的改动", () => {
    const base = makeBase();
    const theirs = makeBase({ title: "对方的标题", description: "对方的描述" });
    // 我方在页面上把标题冲突选成了对方的值，描述没碰
    const yours = makeBase({ title: "对方的标题" });

    const outcome = mergeSpotInput(base, theirs, yours, { resolveConflicts: true });

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.title).toBe("对方的标题");
    expect(outcome.merged.description).toBe("对方的描述");
  });

  it("结构化属性按 key 逐个合并：各改各的互不干扰", () => {
    const base = makeBase();
    const theirs = makeBase({ attributes: { has_backrest: false, count: 2, shade: "full" } });
    const yours = makeBase({ attributes: { has_backrest: true, count: 5, shade: "full" } });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.attributes).toEqual({ has_backrest: false, count: 5, shade: "full" });
    expect(outcome.autoMergedFields).toContain("attributes.has_backrest");
  });

  it("同一属性被双方改成不同值 → 按 key 冲突", () => {
    const base = makeBase();
    const theirs = makeBase({ attributes: { has_backrest: true, count: 2, shade: "none" } });
    const yours = makeBase({ attributes: { has_backrest: true, count: 2, shade: "partial" } });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([
      { field: "attributes.shade", base: "full", theirs: "none", yours: "partial" },
    ]);
  });

  it("我方删除的属性 vs 对方修改同一属性 → 冲突，删除侧以 null 呈现", () => {
    const base = makeBase();
    const theirs = makeBase({ attributes: { has_backrest: true, count: 8, shade: "full" } });
    const yours = makeBase({ attributes: { has_backrest: true, shade: "full" } });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([
      { field: "attributes.count", base: 2, theirs: 8, yours: null },
    ]);
  });

  it("我方删除的属性对方没动 → 删除生效", () => {
    const base = makeBase();
    const yours = makeBase({ attributes: { has_backrest: true, count: 2 } });

    const outcome = mergeSpotInput(base, makeBase(), yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.attributes).toEqual({ has_backrest: true, count: 2 });
  });

  it("位置作为整体合并：不会拼出「我的纬度 + 对方经度」的坏坐标", () => {
    const base = makeBase();
    const theirs = makeBase({ lat: 31.5, lng: 121.9 });
    const yours = makeBase({ description: "只改了描述" });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.lat).toBe(31.5);
    expect(outcome.merged.lng).toBe(121.9);
    expect(outcome.autoMergedFields).toContain("location");
  });

  it("双方都挪了位置 → 坐标整体冲突，而不是拆成两个字段", () => {
    const base = makeBase();
    const theirs = makeBase({ lat: 31.5, lng: 121.9 });
    const yours = makeBase({ lat: 30.1, lng: 120.1 });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]?.field).toBe("location");
    expect(outcome.conflicts[0]?.theirs).toEqual({ lat: 31.5, lng: 121.9 });
    expect(outcome.conflicts[0]?.yours).toEqual({ lat: 30.1, lng: 120.1 });
  });

  it("关闭模糊时半径归一为 0，不与对方的「关模糊」误判成冲突", () => {
    const base = makeBase();
    // 双方都关了模糊，一方带了残留半径 50，一方带了 0
    const theirs = makeBase({ fuzzEnabled: false, fuzzRadiusM: 0 });
    const yours = makeBase({ fuzzEnabled: false, fuzzRadiusM: 50 });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.fuzzEnabled).toBe(false);
    expect(outcome.merged.fuzzRadiusM).toBe(0);
  });

  it("图片列表按集合合并：双方各自新增都保留", () => {
    const base = makeBase();
    const theirs = makeBase({ mediaUuids: ["img-a", "img-b", "img-c"] });
    const yours = makeBase({ mediaUuids: ["img-a", "img-b", "img-d"] });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.mediaUuids).toEqual(["img-a", "img-b", "img-c", "img-d"]);
    expect(outcome.autoMergedFields).toContain("mediaUuids");
  });

  it("一方删图另一方没动 → 删除生效", () => {
    const base = makeBase();
    const theirs = makeBase({ mediaUuids: ["img-a"] });
    const yours = makeBase({ mediaUuids: ["img-a", "img-b", "img-c"] });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.mediaUuids).toEqual(["img-a", "img-c"]);
  });

  it("双方都加图导致合并后超限 → 整个列表冲突，交给编辑者二选一", () => {
    const fill = (prefix: string, count: number) => Array.from({ length: count }, (_, i) => `${prefix}-${i}`);
    const base = makeBase({ mediaUuids: [] });
    const theirs = makeBase({ mediaUuids: fill("t", MAX_MEDIA_PER_SPOT - 1) });
    const yours = makeBase({ mediaUuids: fill("y", MAX_MEDIA_PER_SPOT - 1) });

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toHaveLength(1);
    expect(outcome.conflicts[0]?.field).toBe("mediaUuids");
    expect(outcome.conflicts[0]?.theirs).toEqual(theirs.mediaUuids);
    expect(outcome.conflicts[0]?.yours).toEqual(yours.mediaUuids);
  });

  it("partial 更新：未提供的字段不参与合并，直接采用服务端当前值", () => {
    const base = makeBase();
    const theirs = makeBase({ title: "对方的标题" });
    // 调用方只带了 description（没碰标题），也没带 base 里的其他字段
    const yours: SpotFormState = { description: "只改描述" };
    const partialBase: SpotFormState = { description: "傍晚有树荫" };

    const outcome = mergeSpotInput(partialBase, theirs, yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.description).toBe("只改描述");
    expect(outcome.merged.title).toBeUndefined();
  });

  it("partial 更新：提交了基线但本次没带的字段，视为没改而自动采用对方的值", () => {
    const base = makeBase();
    const theirs = makeBase({ title: "对方的标题" });
    // 调用方给了完整基线，但本次提交只改了描述（脚本类调用方的常见写法）
    const yours: SpotFormState = { description: "只改描述" };

    const outcome = mergeSpotInput(base, theirs, yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.title).toBe("对方的标题");
    expect(outcome.merged.description).toBe("只改描述");
    expect(outcome.autoMergedFields).toContain("title");
  });

  it("描述清空（空字符串）与对方的修改能正常比较", () => {
    const base = makeBase();
    const yours = makeBase({ description: "" });

    const outcome = mergeSpotInput(base, makeBase(), yours);

    expect(outcome.conflicts).toEqual([]);
    expect(outcome.merged.description).toBe("");
  });
});
