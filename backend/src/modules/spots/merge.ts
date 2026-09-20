/**
 * 条目并发编辑的三路合并。
 *
 * 编辑页加载时记录基线快照（base），保存时若服务端内容已被他人改动（theirs），
 * 就把 base / theirs / yours（本次提交）三方按字段逐一对比：
 *
 * - 只有一方改过的字段 → 自动采用改动方，不打扰用户；
 * - 双方改了同一字段且结果不同 → 记为冲突，两份值都保留在冲突详情里，
 *   由编辑者在页面上逐项选择后带 resolveConflicts 重新提交；
 * - 位置（经纬度）与模糊设置（开关+半径）各自作为一个整体字段合并，
 *   避免出现"纬度用我的、经度用对方的"这种拼出来的坏坐标；
 * - 结构化属性按属性 key 逐个合并，互不影响的修改各自生效；
 * - 图片列表按集合合并（双方的增删都生效），合并后超出上限才整体冲突。
 *
 * 本模块不碰数据库，是纯粹的数据变换，方便单元测试覆盖各种并发组合。
 */

/** 与 createSpotSchema 对齐的表单字段，全部可选（partial 更新语义） */
export interface SpotFormState {
  categoryCode?: string;
  title?: string;
  description?: string;
  attributes?: Record<string, unknown>;
  lat?: number;
  lng?: number;
  fuzzEnabled?: boolean;
  fuzzRadiusM?: number;
  mediaUuids?: string[];
}

export interface FieldConflict {
  /** 字段标识：title / description / categoryCode / location / fuzz / mediaUuids / attributes.<key> */
  field: string;
  /** 三方各自的值；null 表示该侧没有这个值（例如属性被删除、描述被清空） */
  base: unknown;
  theirs: unknown;
  yours: unknown;
}

export interface MergeOutcome {
  /** 合并后的完整表单（无冲突时可直接落库；有冲突时供前端预填） */
  merged: SpotFormState;
  /** 双方都改且结果不同的字段，需要编辑者逐项确认 */
  conflicts: FieldConflict[];
  /** 因对方修改而被自动合并进来的字段，用于保存成功后的提示 */
  autoMergedFields: string[];
}

/** 与 createSpotSchema 中 mediaUuids 的上限保持一致 */
export const MAX_MEDIA_PER_SPOT = 6;

/**
 * 内部哨兵：区分"这个值不存在"（属性被删除、字段未提供）和"值为空"。
 * 不会出现在输出里——对外序列化时统一转成 null。
 */
const MISSING: unique symbol = Symbol("missing");
type Maybe<T> = T | typeof MISSING;

/** applyField 的"双方都没提供这个字段"标记，用 Symbol 避免和真实字段值撞车 */
const SKIP: unique symbol = Symbol("skip");
type FieldOutcome = Maybe<unknown> | typeof SKIP;

/** JSON 值的稳定序列化（对象 key 排序），用于深比较属性值 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => stableStringify(item)).join(",")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(",")}}`;
}

function valuesEqual(a: Maybe<unknown>, b: Maybe<unknown>): boolean {
  if (a === MISSING || b === MISSING) return a === b;
  if (Object.is(a, b)) return true;
  return stableStringify(a) === stableStringify(b);
}

function expose(value: Maybe<unknown>): unknown {
  return value === MISSING ? null : value;
}

type FieldMerge =
  | { kind: "clean"; value: Maybe<unknown>; fromTheirs: boolean }
  | { kind: "conflict"; base: Maybe<unknown>; theirs: Maybe<unknown>; yours: Maybe<unknown> };

/** 单个值的三路合并：yours 相对 base 没动就取 theirs，反之取 yours，都动了且不同则冲突 */
function mergeOne(
  base: Maybe<unknown>,
  theirs: Maybe<unknown>,
  yours: Maybe<unknown>,
  resolveConflicts: boolean,
): FieldMerge {
  if (valuesEqual(yours, base)) {
    return { kind: "clean", value: theirs, fromTheirs: !valuesEqual(theirs, base) };
  }
  if (valuesEqual(theirs, base) || valuesEqual(yours, theirs)) {
    return { kind: "clean", value: yours, fromTheirs: false };
  }
  // 编辑者已经在页面上逐项确认过取舍，提交值就是最终选择
  if (resolveConflicts) {
    return { kind: "clean", value: yours, fromTheirs: false };
  }
  return { kind: "conflict", base, theirs, yours };
}

interface MergeContext {
  resolveConflicts: boolean;
  conflicts: FieldConflict[];
  autoMergedFields: string[];
}

/** 应用单字段合并结果；返回 SKIP 表示双方都没提供该字段（保持 partial 语义，不碰它） */
function applyField(ctx: MergeContext, field: string, base: Maybe<unknown>, theirs: Maybe<unknown>, yours: Maybe<unknown>): FieldOutcome {
  if (base === MISSING && yours === MISSING) return SKIP;
  // 字段没提交 = 调用方没改它，回落到基线值参与三路对比
  const effectiveYours = yours === MISSING ? base : yours;
  const result = mergeOne(base, theirs, effectiveYours, ctx.resolveConflicts);
  if (result.kind === "conflict") {
    ctx.conflicts.push({
      field,
      base: expose(result.base),
      theirs: expose(result.theirs),
      yours: expose(result.yours),
    });
    // 冲突字段先填编辑者自己的值，前端在此基础上逐项调整
    return result.yours;
  }
  if (result.fromTheirs) ctx.autoMergedFields.push(field);
  return result.value;
}

function normalizeFuzz(enabled: Maybe<boolean>, radius: Maybe<number>): Maybe<{ enabled: boolean; radius: number }> {
  if (enabled === MISSING || radius === MISSING) return MISSING;
  // 关闭模糊时半径没有意义，归一为 0，避免"关模糊但半径 50"这种组合被误判成差异
  return enabled ? { enabled: true, radius } : { enabled: false, radius: 0 };
}

function mergeAttributes(
  ctx: MergeContext,
  base: Record<string, unknown> | undefined,
  theirs: Record<string, unknown>,
  yours: Record<string, unknown> | undefined,
): Record<string, unknown> | typeof SKIP {
  if (base === undefined && yours === undefined) return SKIP;
  const baseAttrs = base ?? {};
  // 整个 attributes 没提交 = 整组没改；提交了但缺某个 key = 删掉了那个 key
  const yoursAttrs = yours ?? baseAttrs;

  const keys = new Set([...Object.keys(baseAttrs), ...Object.keys(theirs), ...Object.keys(yoursAttrs)]);
  const merged: Record<string, unknown> = {};

  for (const key of keys) {
    const baseValue = key in baseAttrs ? baseAttrs[key] : MISSING;
    const theirsValue = key in theirs ? theirs[key] : MISSING;
    const yoursValue = key in yoursAttrs ? yoursAttrs[key] : MISSING;

    const result = mergeOne(baseValue, theirsValue, yoursValue, ctx.resolveConflicts);
    if (result.kind === "conflict") {
      ctx.conflicts.push({
        field: `attributes.${key}`,
        base: expose(result.base),
        theirs: expose(result.theirs),
        yours: expose(result.yours),
      });
      if (result.yours !== MISSING) merged[key] = result.yours;
      continue;
    }
    if (result.fromTheirs) ctx.autoMergedFields.push(`attributes.${key}`);
    if (result.value !== MISSING) merged[key] = result.value;
  }

  return merged;
}

function mergeMediaList(
  ctx: MergeContext,
  base: string[] | undefined,
  theirs: string[],
  yours: string[] | undefined,
): string[] | typeof SKIP {
  if (base === undefined && yours === undefined) return SKIP;
  const baseList = base ?? [];
  const yoursList = yours ?? baseList;

  if (valuesEqual(yoursList, baseList)) {
    if (!valuesEqual(theirs, baseList)) ctx.autoMergedFields.push("mediaUuids");
    return [...theirs];
  }
  if (valuesEqual(theirs, baseList) || valuesEqual(yoursList, theirs)) return [...yoursList];

  // 双方都动了图片列表：按集合合并——任何一方的删除都生效，双方的新增都保留。
  // 顺序上以对方当前列表为骨架，我方新增的图片追加在后。
  const removed = new Set(baseList.filter((uuid) => !yoursList.includes(uuid) || !theirs.includes(uuid)));
  const mergedList = theirs.filter((uuid) => !removed.has(uuid));
  for (const uuid of yoursList) {
    if (!baseList.includes(uuid) && !mergedList.includes(uuid)) mergedList.push(uuid);
  }

  if (mergedList.length > MAX_MEDIA_PER_SPOT) {
    // 合并后超过上限，无法自动取舍，整个列表交给编辑者二选一
    ctx.conflicts.push({ field: "mediaUuids", base: baseList, theirs, yours: yoursList });
    return [...yoursList];
  }

  ctx.autoMergedFields.push("mediaUuids");
  return mergedList;
}

export interface MergeOptions {
  /** 编辑者已在页面上逐项确认过取舍，冲突字段直接采用提交值 */
  resolveConflicts?: boolean;
}

export function mergeSpotInput(
  base: SpotFormState,
  theirs: SpotFormState,
  yours: SpotFormState,
  options: MergeOptions = {},
): MergeOutcome {
  const ctx: MergeContext = {
    resolveConflicts: options.resolveConflicts === true,
    conflicts: [],
    autoMergedFields: [],
  };
  const merged: SpotFormState = {};

  const scalar = (value: string | undefined): Maybe<unknown> => (value === undefined ? MISSING : value);

  const categoryCode = applyField(ctx, "categoryCode", scalar(base.categoryCode), scalar(theirs.categoryCode), scalar(yours.categoryCode));
  if (categoryCode !== SKIP && categoryCode !== MISSING) merged.categoryCode = categoryCode as string;

  const title = applyField(ctx, "title", scalar(base.title), scalar(theirs.title), scalar(yours.title));
  if (title !== SKIP && title !== MISSING) merged.title = title as string;

  const description = applyField(ctx, "description", scalar(base.description), scalar(theirs.description), scalar(yours.description));
  if (description !== SKIP && description !== MISSING) merged.description = description as string;

  // 经纬度作为一个整体合并，不拆开
  const locate = (state: SpotFormState): Maybe<{ lat: number; lng: number }> =>
    state.lat === undefined || state.lng === undefined ? MISSING : { lat: state.lat, lng: state.lng };
  const location = applyField(ctx, "location", locate(base), locate(theirs), locate(yours));
  if (location !== SKIP && location !== MISSING) {
    const point = location as { lat: number; lng: number };
    merged.lat = point.lat;
    merged.lng = point.lng;
  }

  // 模糊开关与半径作为一个整体合并
  const fuzz = applyField(
    ctx,
    "fuzz",
    normalizeFuzz(base.fuzzEnabled === undefined ? MISSING : base.fuzzEnabled, base.fuzzRadiusM === undefined ? MISSING : base.fuzzRadiusM),
    normalizeFuzz(theirs.fuzzEnabled === undefined ? MISSING : theirs.fuzzEnabled, theirs.fuzzRadiusM === undefined ? MISSING : theirs.fuzzRadiusM),
    normalizeFuzz(yours.fuzzEnabled === undefined ? MISSING : yours.fuzzEnabled, yours.fuzzRadiusM === undefined ? MISSING : yours.fuzzRadiusM),
  );
  if (fuzz !== SKIP && fuzz !== MISSING) {
    const value = fuzz as { enabled: boolean; radius: number };
    merged.fuzzEnabled = value.enabled;
    merged.fuzzRadiusM = value.radius;
  }

  const attributes = mergeAttributes(ctx, base.attributes, theirs.attributes ?? {}, yours.attributes);
  if (attributes !== SKIP) merged.attributes = attributes;

  const mediaUuids = mergeMediaList(ctx, base.mediaUuids, theirs.mediaUuids ?? [], yours.mediaUuids);
  if (mediaUuids !== SKIP) merged.mediaUuids = mediaUuids;

  return { merged, conflicts: ctx.conflicts, autoMergedFields: ctx.autoMergedFields };
}
