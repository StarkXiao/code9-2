/**
 * 协同编辑的三方合并（three-way merge）。
 *
 * 三个状态：
 *   base     —— 编辑者打开页面时看到的版本（快照）
 *   current  —— 条目现在的样子（可能已被别人改过）
 *   proposed —— 编辑者这次提交的内容
 *
 * 逐字段比较：
 *   我没改（proposed == base）          → 保持 current，别人的改动自然保留
 *   对方没改（current == base）         → 采用我的
 *   双方改成一样（proposed == current） → 采用任意一边
 *   双方都改了且不一样                  → 冲突，两份都保留，交给页面逐项确认
 *
 * 这个模块是纯函数，不碰数据库，方便单测覆盖各种组合。
 */

/** 参与合并的完整可编辑状态。lat/lng、fuzz 开关与半径视为一个整体字段。 */
export interface EditableState {
  title: string;
  description: string | null;
  categoryCode: string;
  attributes: Record<string, unknown>;
  lat: number;
  lng: number;
  fuzzEnabled: boolean;
  fuzzRadiusM: number;
  mediaUuids: string[];
}

export interface FieldConflict {
  /** 字段标识：title / description / categoryCode / location / fuzz / media / attributes / attributes.<key> */
  field: string;
  base: unknown;
  current: unknown;
  proposed: unknown;
}

export interface MergeOutcome {
  /** 合并后的完整状态：无冲突字段已合并，冲突字段保持 current 原值 */
  state: EditableState;
  conflicts: FieldConflict[];
  /** 我改动过且被自动采纳的字段（用于前端提示"你的这些修改已并入"） */
  appliedFields: string[];
}

/** 键序无关的深比较，JSONB 读出来的对象键序不保证一致，不能用 JSON.stringify 比对 */
export function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => deepEqual(item, (b as unknown[])[index]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((key) => key in bObj && deepEqual(aObj[key], bObj[key]));
}

export function mergeSpotStates(
  base: EditableState,
  current: EditableState,
  proposed: EditableState,
): MergeOutcome {
  const conflicts: FieldConflict[] = [];
  const appliedFields: string[] = [];
  const state: EditableState = {
    ...current,
    attributes: { ...current.attributes },
    mediaUuids: [...current.mediaUuids],
  };

  function pick<T>(field: string, baseValue: T, currentValue: T, proposedValue: T, apply: (value: T) => void) {
    const mineChanged = !deepEqual(proposedValue, baseValue);
    const theirsChanged = !deepEqual(currentValue, baseValue);

    if (!mineChanged) return; // 我没动这个字段，对方改没改都以当前为准
    if (!theirsChanged || deepEqual(proposedValue, currentValue)) {
      apply(proposedValue);
      appliedFields.push(field);
      return;
    }
    conflicts.push({ field, base: baseValue, current: currentValue, proposed: proposedValue });
  }

  pick("title", base.title, current.title, proposed.title, (value) => {
    state.title = value;
  });
  pick("description", base.description, current.description, proposed.description, (value) => {
    state.description = value;
  });
  pick("categoryCode", base.categoryCode, current.categoryCode, proposed.categoryCode, (value) => {
    state.categoryCode = value;
  });

  // 经纬度必须同进同退，各合一半会得到一个谁都没选过的坐标
  pick(
    "location",
    { lat: base.lat, lng: base.lng },
    { lat: current.lat, lng: current.lng },
    { lat: proposed.lat, lng: proposed.lng },
    (value) => {
      state.lat = value.lat;
      state.lng = value.lng;
    },
  );

  pick(
    "fuzz",
    { enabled: base.fuzzEnabled, radiusM: base.fuzzRadiusM },
    { enabled: current.fuzzEnabled, radiusM: current.fuzzRadiusM },
    { enabled: proposed.fuzzEnabled, radiusM: proposed.fuzzRadiusM },
    (value) => {
      state.fuzzEnabled = value.enabled;
      state.fuzzRadiusM = value.radiusM;
    },
  );

  // 图片列表整体比较：一方删图（可能出于隐私考虑）不能被另一方的无操作"复活"，
  // 三方合并天然满足这一点——对方没动列表时才采用我的删减。
  pick("media", base.mediaUuids, current.mediaUuids, proposed.mediaUuids, (value) => {
    state.mediaUuids = value;
  });

  // 分类一致时属性逐 key 合并；分类不同说明字段含义已经变了，只能整体取舍
  if (current.categoryCode === proposed.categoryCode) {
    const keys = new Set([
      ...Object.keys(base.attributes),
      ...Object.keys(current.attributes),
      ...Object.keys(proposed.attributes),
    ]);
    for (const key of keys) {
      pick(
        `attributes.${key}`,
        base.attributes[key],
        current.attributes[key],
        proposed.attributes[key],
        (value) => {
          if (value === undefined) delete state.attributes[key];
          else state.attributes[key] = value;
        },
      );
    }
  } else {
    pick("attributes", base.attributes, current.attributes, proposed.attributes, (value) => {
      state.attributes = { ...value };
    });
  }

  return { state, conflicts, appliedFields };
}
