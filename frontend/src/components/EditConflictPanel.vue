<script setup lang="ts">
import type { AttributeSchema, Category, EditConflict } from "@/api/types";
import { mediaUrl } from "@/api/client";

/**
 * 协同编辑冲突面板：同一字段的两份版本并排展示，
 * 编辑者逐项确认"保留当前"还是"采用对方修改"。
 */
const props = defineProps<{
  conflicts: EditConflict[];
  schema: AttributeSchema | null;
  categories: Category[];
  resolving?: boolean;
}>();

const emit = defineEmits<{
  (e: "resolve", conflict: EditConflict, choice: "current" | "proposed"): void;
}>();

function fieldLabel(field: string): string {
  if (field === "title") return "标题";
  if (field === "description") return "描述";
  if (field === "categoryCode") return "分类";
  if (field === "location") return "位置";
  if (field === "fuzz") return "位置模糊";
  if (field === "media") return "照片";
  if (field === "attributes") return "全部现场细节";
  if (field.startsWith("attributes.")) {
    const key = field.slice("attributes.".length);
    return props.schema?.properties[key]?.label ?? key;
  }
  return field;
}

function attributeLabel(key: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "（未填写）";
  const prop = props.schema?.properties[key];
  if (typeof value === "boolean") return value ? "是" : "否";
  if (Array.isArray(value)) {
    const labels = value.map((item) => prop?.items?.enumLabels?.[String(item)] ?? String(item));
    return labels.length > 0 ? labels.join("、") : "（未填写）";
  }
  if (typeof value === "string" && prop?.enumLabels?.[value]) return prop.enumLabels[value];
  return prop?.unit ? `${String(value)} ${prop.unit}` : String(value);
}

function formatValue(field: string, value: unknown): string {
  if (value === null || value === undefined || value === "") return "（空）";
  if (field === "categoryCode") {
    return props.categories.find((item) => item.code === value)?.name ?? String(value);
  }
  if (field === "location") {
    const loc = value as { lat?: number; lng?: number };
    return `纬度 ${Number(loc.lat).toFixed(5)}，经度 ${Number(loc.lng).toFixed(5)}`;
  }
  if (field === "fuzz") {
    const fuzz = value as { enabled?: boolean; radiusM?: number };
    return fuzz.enabled ? `模糊显示，半径 ${fuzz.radiusM} 米` : "不模糊（公开精确位置）";
  }
  if (field === "media") {
    const count = Array.isArray(value) ? value.length : 0;
    return `${count} 张照片`;
  }
  if (field === "attributes") {
    const entries = Object.entries((value as Record<string, unknown>) ?? {});
    if (entries.length === 0) return "（空）";
    return entries.map(([key, item]) => `${props.schema?.properties[key]?.label ?? key}：${attributeLabel(key, item)}`).join("；");
  }
  if (field.startsWith("attributes.")) return attributeLabel(field.slice("attributes.".length), value);
  return String(value);
}

function mediaThumbs(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.map(String);
}
</script>

<template>
  <el-card shadow="never" class="conflict-panel">
    <template #header>
      <div class="conflict-header">
        <span>有 {{ conflicts.length }} 个字段与他人同时修改，请逐项确认取舍</span>
      </div>
    </template>

    <p class="muted" style="margin: 0 0 12px">
      其余字段已自动合并。以下字段双方改成了不同的值，两份都保留着，请逐项选择最终采用哪一份。
    </p>

    <div v-for="conflict in conflicts" :key="conflict.uuid" class="conflict-item">
      <div class="conflict-field">{{ fieldLabel(conflict.field) }}</div>

      <div class="conflict-options">
        <div class="conflict-option">
          <div class="option-title">当前内容</div>
          <div class="option-value">{{ formatValue(conflict.field, conflict.current) }}</div>
          <div v-if="conflict.field === 'media'" class="option-thumbs">
            <el-image
              v-for="uuid in mediaThumbs(conflict.current)"
              :key="uuid"
              :src="mediaUrl(`/api/v1/media/${uuid}/thumb`)"
              fit="cover"
              class="thumb"
            />
          </div>
          <el-button size="small" :disabled="resolving" @click="emit('resolve', conflict, 'current')">
            保留当前
          </el-button>
        </div>

        <div class="conflict-option proposed">
          <div class="option-title">{{ conflict.proposer?.nickname ?? "对方" }} 的修改</div>
          <div class="option-value">{{ formatValue(conflict.field, conflict.proposed) }}</div>
          <div v-if="conflict.field === 'media'" class="option-thumbs">
            <el-image
              v-for="uuid in mediaThumbs(conflict.proposed)"
              :key="uuid"
              :src="mediaUrl(`/api/v1/media/${uuid}/thumb`)"
              fit="cover"
              class="thumb"
            />
          </div>
          <el-button size="small" type="primary" :disabled="resolving" @click="emit('resolve', conflict, 'proposed')">
            采用这份修改
          </el-button>
        </div>
      </div>
    </div>
  </el-card>
</template>

<style scoped>
.conflict-panel {
  margin-bottom: 12px;
  border-color: var(--el-color-warning);
}

.conflict-header {
  font-weight: 600;
  color: var(--el-color-warning-dark-2);
}

.conflict-item {
  border-top: 1px dashed var(--el-border-color);
  padding: 12px 0;
}

.conflict-item:first-of-type {
  border-top: none;
  padding-top: 0;
}

.conflict-field {
  font-weight: 600;
  margin-bottom: 8px;
}

.conflict-options {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 10px;
}

.conflict-option {
  border: 1px solid var(--el-border-color);
  border-radius: 6px;
  padding: 10px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  align-items: flex-start;
}

.conflict-option.proposed {
  border-color: var(--el-color-primary-light-5);
  background: var(--el-color-primary-light-9);
}

.option-title {
  font-size: 12px;
  color: var(--el-text-color-secondary);
}

.option-value {
  white-space: pre-wrap;
  word-break: break-word;
}

.option-thumbs {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
}

.thumb {
  width: 56px;
  height: 56px;
  border-radius: 4px;
}

@media (max-width: 640px) {
  .conflict-options {
    grid-template-columns: 1fr;
  }
}
</style>
