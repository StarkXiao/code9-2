<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api, ApiError } from "@/api/client";
import type {
  AttributeSchema,
  Category,
  ConflictDisplayItem,
  EditConflictDetails,
  EditConflictItem,
  Spot,
  SpotSaveResult,
} from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import { DEFAULT_CENTER } from "@/config/map";
import AttributeForm from "@/components/AttributeForm.vue";
import LocationPicker from "@/components/LocationPicker.vue";
import PhotoUploader from "@/components/PhotoUploader.vue";
import MergeConflictResolver from "@/components/MergeConflictResolver.vue";

const route = useRoute();
const router = useRouter();
const auth = useAuthStore();
const catalog = useCatalogStore();

const uuid = computed(() => (route.params.uuid ? String(route.params.uuid) : null));
const isEdit = computed(() => uuid.value !== null);

const form = ref({
  categoryCode: "",
  title: "",
  description: "",
  attributes: {} as Record<string, unknown>,
  lat: DEFAULT_CENTER[0],
  lng: DEFAULT_CENTER[1],
  fuzzEnabled: true,
  fuzzRadiusM: 50,
  mediaUuids: [] as string[],
});

const loading = ref(false);
const saving = ref(false);
const submitting = ref(false);
const spotStatus = ref<string>("draft");
const autoCheckIssues = ref<Array<{ code: string; message: string }>>([]);
const reviewFeedback = ref<string | null>(null);
const canRequestManualReview = ref(false);
const photoUploader = ref<InstanceType<typeof PhotoUploader> | null>(null);

// 并发编辑合并：加载时的版本标记与表单快照，保存时带回服务端做三路合并
const baseUpdatedAt = ref<string | null>(null);
const baseSnapshot = ref<Record<string, unknown> | null>(null);
const resolvingConflict = ref(false);
const conflictRaw = ref<EditConflictItem[]>([]);
const conflictItems = ref<ConflictDisplayItem[]>([]);

const category = computed<Category | undefined>(() => catalog.byCode(form.value.categoryCode));
const schema = computed<AttributeSchema | null>(() => category.value?.schema ?? null);

watch(
  () => form.value.fuzzEnabled,
  (enabled) => {
    if (!enabled) form.value.fuzzRadiusM = 0;
    else if (form.value.fuzzRadiusM === 0) form.value.fuzzRadiusM = 50;
  },
);

function snapshotForm(): Record<string, unknown> {
  return {
    categoryCode: form.value.categoryCode,
    // 与保存时发送的内容保持一致（服务端存的是 trim 后的值），
    // 否则首尾空格会被误判成"对方又改了一次"
    title: form.value.title.trim(),
    description: form.value.description.trim(),
    attributes: JSON.parse(JSON.stringify(form.value.attributes)) as Record<string, unknown>,
    lat: form.value.lat,
    lng: form.value.lng,
    fuzzEnabled: form.value.fuzzEnabled,
    fuzzRadiusM: form.value.fuzzEnabled ? form.value.fuzzRadiusM : 0,
    mediaUuids: [...form.value.mediaUuids],
  };
}

/** 记录合并基线：版本标记 + 表单快照，之后每次保存都带回服务端 */
function captureBaseline(updatedAt: string) {
  baseUpdatedAt.value = updatedAt;
  baseSnapshot.value = snapshotForm();
}

async function loadExisting() {
  if (!uuid.value) {
    form.value.categoryCode = catalog.categories[0]?.code ?? "";
    return;
  }

  loading.value = true;
  try {
    const spot = await api.get<Spot>(`/spots/${uuid.value}`);
    form.value.categoryCode = spot.category.code;
    form.value.title = spot.title;
    form.value.description = spot.description ?? "";
    form.value.attributes = { ...spot.attributes };
    form.value.lat = spot.location.lat;
    form.value.lng = spot.location.lng;
    form.value.fuzzEnabled = spot.location.fuzzed || spot.location.radiusMeters > 0;
    form.value.fuzzRadiusM = spot.location.radiusMeters || 50;
    form.value.mediaUuids = spot.media.map((asset) => asset.uuid);
    spotStatus.value = spot.status;
    captureBaseline(spot.updatedAt);

    // 把审核意见直接展示在编辑页，用户不用来回切换页面
    const revisions = await api
      .get<{ items: Array<{ review: { decisionReason: string | null; reasonCode: string | null } | null }> }>(
        `/spots/${uuid.value}/revisions`,
      )
      .catch(() => ({ items: [] }));

    const latestReview = revisions.items[0]?.review;
    if (latestReview?.decisionReason) {
      reviewFeedback.value = latestReview.decisionReason;
    }

    setTimeout(() => {
      photoUploader.value?.setExisting(
        spot.media.map((asset) => ({
          uuid: asset.uuid,
          variants: asset.variants,
          privacyStatus: asset.privacyStatus,
          variantVersion: asset.variantVersion,
          width: asset.width,
          height: asset.height,
        })),
      );
    }, 50);
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    loading.value = false;
  }
}

function validateBeforeSubmit(): string | null {
  if (!form.value.categoryCode) return "请选择分类";
  if (form.value.title.trim().length < 2) return "请填写标题（至少 2 个字）";

  const required = schema.value?.required ?? [];
  for (const key of required) {
    const value = form.value.attributes[key];
    if (value === undefined || value === null || value === "") {
      return `请填写「${schema.value?.properties[key]?.label ?? key}」`;
    }
  }
  return null;
}

function onLocationUpdate(payload: { lat: number; lng: number }) {
  form.value.lat = payload.lat;
  form.value.lng = payload.lng;
}

interface SaveOutcome {
  id: string;
  merge: { autoMergedFields: string[] } | null;
  updatedAt: string | null;
}

async function saveDraft(): Promise<SaveOutcome | null> {
  const payload = {
    categoryCode: form.value.categoryCode,
    title: form.value.title.trim(),
    description: form.value.description.trim(),
    attributes: form.value.attributes,
    lat: form.value.lat,
    lng: form.value.lng,
    fuzzEnabled: form.value.fuzzEnabled,
    fuzzRadiusM: form.value.fuzzEnabled ? form.value.fuzzRadiusM : 0,
    mediaUuids: form.value.mediaUuids,
  };

  if (isEdit.value && uuid.value) {
    const result = await api.patch<SpotSaveResult>(`/spots/${uuid.value}`, {
      ...payload,
      baseUpdatedAt: baseUpdatedAt.value ?? undefined,
      base: baseSnapshot.value ?? undefined,
      resolveConflicts: resolvingConflict.value || undefined,
    });
    return { id: uuid.value, merge: result.merge ?? null, updatedAt: result.updatedAt ?? null };
  }

  const created = await api.post<Spot>("/spots", payload);
  // 新建成功后立即记录基线，接下来的 PATCH 就具备并发合并能力
  if (created.updatedAt) captureBaseline(created.updatedAt);
  return { id: created.uuid, merge: null, updatedAt: created.updatedAt ?? null };
}

// ---------------------------------------------------------------- 并发编辑合并

const FIXED_FIELD_LABELS: Record<string, string> = {
  title: "标题",
  description: "描述",
  categoryCode: "分类",
  location: "位置",
  fuzz: "位置模糊设置",
  mediaUuids: "照片",
};

function fieldLabel(field: string): string {
  if (field in FIXED_FIELD_LABELS) return FIXED_FIELD_LABELS[field];
  if (field.startsWith("attributes.")) {
    const key = field.slice("attributes.".length);
    return schema.value?.properties[key]?.label ?? key;
  }
  return field;
}

function formatConflictValue(field: string, value: unknown): string {
  if (value === null || value === undefined) return "（未填写）";
  if (field === "categoryCode") return catalog.byCode(String(value))?.name ?? String(value);
  if (field === "location") {
    const point = value as { lat: number; lng: number };
    return `纬度 ${point.lat.toFixed(5)}，经度 ${point.lng.toFixed(5)}`;
  }
  if (field === "fuzz") {
    const fuzz = value as { enabled: boolean; radius: number };
    return fuzz.enabled ? `模糊显示，半径 ${fuzz.radius} 米` : "不模糊，对外显示精确位置";
  }
  if (field === "mediaUuids") return `${(value as string[]).length} 张图片`;
  if (field.startsWith("attributes.")) {
    const property = schema.value?.properties[field.slice("attributes.".length)];
    if (typeof value === "boolean") return value ? "是" : "否";
    if (Array.isArray(value)) {
      const labels = value.map((item) => property?.items?.enumLabels?.[String(item)] ?? String(item));
      return labels.length > 0 ? labels.join("、") : "（未填写）";
    }
    if (property?.enumLabels) return property.enumLabels[String(value)] ?? String(value);
    return String(value);
  }
  return String(value);
}

function isEditConflict(error: unknown): error is ApiError {
  return error instanceof ApiError && error.code === "EDIT_CONFLICT";
}

function openConflictResolver(details: EditConflictDetails | undefined) {
  if (!details || !Array.isArray(details.conflicts) || details.conflicts.length === 0) {
    ElMessage.error("这条记录在你编辑期间被他人修改了，请刷新获取最新内容后再改");
    return;
  }
  conflictRaw.value = details.conflicts;
  conflictItems.value = details.conflicts.map((item) => ({
    field: item.field,
    label: fieldLabel(item.field),
    mine: formatConflictValue(item.field, item.yours),
    theirs: formatConflictValue(item.field, item.theirs),
  }));
}

/** 把编辑者在冲突面板上选定的值写回表单对应字段 */
function applyConflictValue(field: string, value: unknown) {
  if (field === "title") form.value.title = typeof value === "string" ? value : "";
  else if (field === "description") form.value.description = typeof value === "string" ? value : "";
  else if (field === "categoryCode" && typeof value === "string") form.value.categoryCode = value;
  else if (field === "location" && value && typeof value === "object") {
    const point = value as { lat: number; lng: number };
    form.value.lat = point.lat;
    form.value.lng = point.lng;
  } else if (field === "fuzz" && value && typeof value === "object") {
    const fuzz = value as { enabled: boolean; radius: number };
    form.value.fuzzEnabled = fuzz.enabled;
    form.value.fuzzRadiusM = fuzz.enabled ? fuzz.radius : 0;
  } else if (field === "mediaUuids" && Array.isArray(value)) {
    form.value.mediaUuids = [...(value as string[])];
  } else if (field.startsWith("attributes.")) {
    const key = field.slice("attributes.".length);
    const next = { ...form.value.attributes };
    if (value === null || value === undefined) delete next[key];
    else next[key] = value;
    form.value.attributes = next;
  }
}

/**
 * 保存成功后的收尾：
 * - 发生了自动合并 → 表单与服务端已不一致，整体重新加载并提示合并了哪些字段；
 * - 否则只推进基线版本，表单就是最新内容。
 */
async function afterSave(outcome: SaveOutcome) {
  if (outcome.merge && outcome.merge.autoMergedFields.length > 0) {
    const names = outcome.merge.autoMergedFields.map(fieldLabel).join("、");
    ElMessage.info(`已自动合并他人同时修改的字段：${names}`);
    await loadExisting();
    return;
  }
  if (outcome.updatedAt) captureBaseline(outcome.updatedAt);
}

async function onResolveConflicts(selections: Record<string, "yours" | "theirs">) {
  for (const conflict of conflictRaw.value) {
    if (selections[conflict.field] === "theirs") {
      applyConflictValue(conflict.field, conflict.theirs);
    }
    // 选"我的改动"时表单里本来就是我的值，无需处理
  }

  resolvingConflict.value = true;
  saving.value = true;
  try {
    const outcome = await saveDraft();
    conflictRaw.value = [];
    conflictItems.value = [];
    ElMessage.success("已按你的选择保存");
    if (outcome) await afterSave(outcome);
  } catch (error) {
    // 确认期间对方又保存了 → 用最新的冲突信息刷新面板，再确认一轮
    if (isEditConflict(error)) openConflictResolver(error.details as EditConflictDetails | undefined);
    else ElMessage.error((error as Error).message);
  } finally {
    resolvingConflict.value = false;
    saving.value = false;
  }
}

async function onDiscardConflicts() {
  conflictRaw.value = [];
  conflictItems.value = [];
  await loadExisting();
  ElMessage.info("已加载最新内容，你未保存的修改已放弃");
}

function handleSaveError(error: unknown) {
  if (isEditConflict(error)) {
    openConflictResolver(error.details as EditConflictDetails | undefined);
  } else {
    ElMessage.error((error as Error).message);
  }
}

async function onSaveDraft() {
  saving.value = true;
  try {
    const outcome = await saveDraft();
    ElMessage.success("草稿已保存");
    if (outcome && !isEdit.value) {
      void router.replace({ name: "spot-edit", params: { uuid: outcome.id } });
    } else if (outcome) {
      await afterSave(outcome);
    }
  } catch (error) {
    handleSaveError(error);
  } finally {
    saving.value = false;
  }
}

async function onSubmit() {
  const error = validateBeforeSubmit();
  if (error) {
    ElMessage.warning(error);
    return;
  }

  submitting.value = true;
  try {
    const outcome = await saveDraft();
    if (!outcome) return;

    // 保存时若自动合并了他人的改动，先同步表单与基线再提交，
    // 提交的是服务端的合并结果，内容不会丢
    if (outcome.merge && outcome.merge.autoMergedFields.length > 0) {
      const names = outcome.merge.autoMergedFields.map(fieldLabel).join("、");
      ElMessage.info(`已自动合并他人同时修改的字段：${names}`);
      await loadExisting();
    } else if (outcome.updatedAt) {
      captureBaseline(outcome.updatedAt);
    }

    const result = await api.post<{
      status: string;
      autoCheck: { passed: boolean; issues: Array<{ code: string; message: string }> };
      canRequestManualReview: boolean;
    }>(`/spots/${outcome.id}/submit`);

    spotStatus.value = result.status;
    autoCheckIssues.value = result.autoCheck.issues;
    canRequestManualReview.value = result.canRequestManualReview;

    if (result.autoCheck.passed) {
      ElMessage.success("已提交审核，结果会通过站内通知告诉你");
      void router.push({ name: "me" });
    } else {
      ElMessage.warning("提交前有几处需要先处理，请看下方提示");
    }
  } catch (error) {
    handleSaveError(error);
  } finally {
    submitting.value = false;
  }
}

async function requestManualReview() {
  if (!uuid.value) return;
  submitting.value = true;
  try {
    const result = await api.post<{ status: string }>(`/spots/${uuid.value}/request-manual-review`);
    ElMessage.success("已转人工复核，审核员会尽快处理");
    spotStatus.value = result.status;
    void router.push({ name: "me" });
  } catch (error) {
    ElMessage.error((error as Error).message);
  } finally {
    submitting.value = false;
  }
}

onMounted(async () => {
  await catalog.load();

  // 新建条目时采用用户在设置里选定的默认模糊半径，
  // 否则"默认设置"这一项在界面上等于摆设。
  if (!isEdit.value && auth.user?.settings) {
    form.value.fuzzRadiusM = auth.user.settings.defaultFuzzRadius;
  }

  await loadExisting();
});
</script>

<template>
  <div class="page" v-loading="loading">
    <h1 class="page-title">
      {{ isEdit ? "编辑这条记录" : "记录一个公共空间细节" }}
    </h1>

    <el-alert
      v-if="reviewFeedback"
      type="warning"
      :closable="false"
      show-icon
      title="审核员给了修改建议"
      :description="reviewFeedback"
      style="margin-bottom: 16px"
    />

    <MergeConflictResolver
      v-if="conflictItems.length"
      :items="conflictItems"
      :saving="saving || submitting"
      @confirm="onResolveConflicts"
      @discard="onDiscardConflicts"
    />

    <el-alert
      v-if="autoCheckIssues.length"
      type="error"
      :closable="false"
      show-icon
      title="提交前需要先处理这些内容"
      style="margin-bottom: 16px"
    >
      <ul style="margin: 6px 0 0; padding-left: 18px">
        <li v-for="issue in autoCheckIssues" :key="issue.code">{{ issue.message }}</li>
      </ul>
      <el-button v-if="canRequestManualReview" size="small" style="margin-top: 8px" @click="requestManualReview">
        我认为是误判，转人工复核
      </el-button>
    </el-alert>

    <el-card shadow="never">
      <el-form label-position="top">
        <el-form-item label="这是哪一类细节" required>
          <el-radio-group v-model="form.categoryCode">
            <el-radio-button v-for="item in catalog.categories" :key="item.code" :value="item.code">
              {{ item.name }}
            </el-radio-button>
          </el-radio-group>
          <p v-if="category?.description" class="muted" style="margin: 6px 0 0">{{ category.description }}</p>
        </el-form-item>

        <el-form-item label="一句话标题" required>
          <el-input v-model="form.title" maxlength="40" show-word-limit placeholder="例如：梧桐树下带靠背的长椅" />
        </el-form-item>

        <el-form-item label="补充描述">
          <el-input
            v-model="form.description"
            type="textarea"
            :rows="4"
            maxlength="500"
            show-word-limit
            placeholder="什么时段适合来？有什么容易被忽略的细节？"
          />
        </el-form-item>
      </el-form>
    </el-card>

    <el-card shadow="never" style="margin-top: 12px">
      <template #header>
        <span>现场细节</span>
      </template>
      <AttributeForm v-model="form.attributes" :schema="schema" />
    </el-card>

    <el-card shadow="never" style="margin-top: 12px">
      <template #header>
        <span>位置</span>
      </template>

      <LocationPicker
        :lat="form.lat"
        :lng="form.lng"
        :fuzz-radius="form.fuzzRadiusM"
        :fuzz-enabled="form.fuzzEnabled"
        @update="onLocationUpdate"
      />

      <div style="margin-top: 12px; display: flex; align-items: center; gap: 12px; flex-wrap: wrap">
        <el-switch v-model="form.fuzzEnabled" />
        <span>对外模糊显示位置</span>
        <el-select v-model="form.fuzzRadiusM" :disabled="!form.fuzzEnabled" style="width: 140px">
          <el-option label="20 米" :value="20" />
          <el-option label="50 米" :value="50" />
          <el-option label="100 米" :value="100" />
        </el-select>
      </div>
      <p class="muted" style="margin: 6px 0 0">
        模糊后别人只能看到大致范围，精确坐标仅你本人和审核员可见。这是为了保护贡献者。
      </p>
    </el-card>

    <el-card shadow="never" style="margin-top: 12px">
      <template #header>
        <span>照片（可选）</span>
      </template>
      <PhotoUploader ref="photoUploader" v-model="form.mediaUuids" :max="6" />
    </el-card>

    <div class="edit-actions">
      <el-button @click="router.back()">取消</el-button>
      <el-button :loading="saving" @click="onSaveDraft">保存草稿</el-button>
      <el-button type="primary" :loading="submitting" @click="onSubmit">提交审核</el-button>
    </div>

    <p class="muted" style="margin-top: 8px">
      提交后会在 24 小时内出结果，结果会通过站内通知发给你，也可以在「我的记录」里查看状态。
    </p>
  </div>
</template>

<style scoped>
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 10px;
  margin-top: 16px;
}
</style>
