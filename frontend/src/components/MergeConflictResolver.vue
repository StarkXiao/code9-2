<script setup lang="ts">
import { ref, watch } from "vue";
import type { ConflictDisplayItem } from "@/api/types";

/**
 * 并发编辑冲突的逐项确认面板。
 * 每个冲突字段并列展示"我的改动"与"对方的改动"两份值，
 * 编辑者逐项选择后统一保存；未冲突的字段服务端已自动合并。
 */

const props = defineProps<{
  items: ConflictDisplayItem[];
  saving?: boolean;
}>();

const emit = defineEmits<{
  (event: "confirm", selections: Record<string, "yours" | "theirs">): void;
  (event: "discard"): void;
}>();

const selections = ref<Record<string, "yours" | "theirs">>({});

// 默认全部选"我的改动"——编辑者刚写完的内容通常是他想保留的
watch(
  () => props.items,
  (items) => {
    selections.value = Object.fromEntries(items.map((item) => [item.field, "yours" as const]));
  },
  { immediate: true },
);

function confirm() {
  emit("confirm", { ...selections.value });
}
</script>

<template>
  <el-card shadow="never" class="merge-resolver">
    <template #header>
      <span class="merge-resolver__title">这条记录在你编辑期间被他人修改了</span>
    </template>

    <p class="muted" style="margin: 0 0 12px">
      以下 {{ items.length }} 处双方改法不同，请逐项选择保留哪一份；其余字段的改动已自动合并，保存后生效。
    </p>

    <div v-for="item in items" :key="item.field" class="merge-resolver__item">
      <p class="merge-resolver__label">{{ item.label }}</p>
      <el-radio-group v-model="selections[item.field]" class="merge-resolver__group">
        <el-radio value="yours" class="merge-resolver__option">
          <span class="merge-resolver__side">我的改动</span>
          <span class="merge-resolver__value">{{ item.mine }}</span>
        </el-radio>
        <el-radio value="theirs" class="merge-resolver__option">
          <span class="merge-resolver__side">对方的改动</span>
          <span class="merge-resolver__value">{{ item.theirs }}</span>
        </el-radio>
      </el-radio-group>
    </div>

    <div class="merge-resolver__actions">
      <el-button :disabled="saving" @click="emit('discard')">放弃我的修改，加载最新版</el-button>
      <el-button type="primary" :loading="saving" @click="confirm">按我的选择保存</el-button>
    </div>
  </el-card>
</template>

<style scoped>
.merge-resolver {
  border-color: var(--color-warning, #e6a23c);
  margin-bottom: 16px;
}

.merge-resolver__title {
  font-weight: 600;
}

.merge-resolver__item {
  padding: 10px 0;
  border-top: 1px dashed var(--color-border);
}

.merge-resolver__label {
  margin: 0 0 6px;
  font-weight: 600;
  font-size: 14px;
}

.merge-resolver__group {
  display: flex;
  flex-direction: column;
  gap: 6px;
}

.merge-resolver__option {
  height: auto;
  white-space: normal;
  align-items: flex-start;
  margin-right: 0;
}

.merge-resolver__option :deep(.el-radio__label) {
  display: flex;
  gap: 8px;
  align-items: baseline;
  line-height: 1.5;
}

.merge-resolver__side {
  flex-shrink: 0;
  font-size: 13px;
  color: var(--color-text-soft);
}

.merge-resolver__value {
  word-break: break-all;
}

.merge-resolver__actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 14px;
}
</style>
