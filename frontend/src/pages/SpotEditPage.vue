<script setup lang="ts">
import { computed, onMounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { ElMessage } from "element-plus";
import { api, ApiError } from "@/api/client";
import type { AttributeSchema, Category, EditConflict, MergeInfo, Spot } from "@/api/types";
import { useAuthStore } from "@/stores/auth";
import { useCatalogStore } from "@/stores/catalog";
import { DEFAULT_CENTER } from "@/config/map";
import AttributeForm from "@/components/AttributeForm.vue";
import EditConflictPanel from "@/components/EditConflictPanel.vue";
import LocationPicker from "@/components/LocationPicker.vue";
import PhotoUploader from "@/components/PhotoUploader.vue";

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

// 协同编辑：打开页面时的内容版本，保存时回传给服务端做三方合并
const contentVersion = ref<number | null>(null);
const editConflicts = ref<EditConflict[]>([]);
const resolvingConflict = ref(false);

const category = computed<Category | undefined>(() => catalog.byCode(form.value.categoryCode));
const schema = computed<AttributeSchema | null>(() => category.value?.schema ?? null);

watch(
  () => form.value.fuzzEnabled,
  (enabled) => {
    if (!enabled) form.value.fuzzRadiusM = 0;
    else if (form.value.fuzzRadiusM === 0) form.value.fuzzRadiusM = 50;
  },
);

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
    contentVersion.value = spot.contentVersion;

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

    // 待处理的协同编辑冲突：别人与我同时改了同一字段，需要逐项确认
    const conflicts = await api
      .get<{ items: EditConflict[] }>(`/spots/${uuid.value}/edit-conflicts`, { status: "open" })
      .catch(() => ({ items: [] }));
    editConflicts.value = conflicts.items;

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
  /** 保存成功后的条目 uuid；发生冲突时为 null */
  uuid: string | null;
  /** 与他人同时修改了同一字段，需要先在页面上逐项确认取舍 */
  hasConflict: boolean;
}

async function saveDraft(): Promise<SaveOutcome> {
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
    // 带上打开页面时的版本号，服务端据此做字段级三方合并
    ...(contentVersion.value !== null ? { baseVersion: contentVersion.value } : {}),
  };

  if (isEdit.value && uuid.value) {
    try {
      const result = await api.patch<Spot & { merge?: MergeInfo }>(`/spots/${uuid.value}`, payload);
      contentVersion.value = result.contentVersion;
      if (result.merge?.merged) {
        // 别人的改动已并入，表单必须刷新成最新内容，
        // 否则下次保存会把旧表单当全量状态覆盖掉刚合并来的修改
        ElMessage.info("已自动合并他人对其他字段的修改，表单已刷新为最新内容");
        await loadExisting();
      }
      return { uuid: uuid.value, hasConflict: false };
    } catch (error) {
      if (error instanceof ApiError && error.code === "EDIT_CONFLICT") {
        const details = error.details as { reason?: string } | undefined;
        if (details?.reason) {
          ElMessage.warning("页面内容已过期，已为你刷新，请确认后重新保存");
        } else {
          ElMessage.warning("这些字段同时被他人修改，请逐项确认取舍");
        }
        // 无冲突字段已被服务端自动合并，刷新表单与冲突列表
        await loadExisting();
        return { uuid: null, hasConflict: true };
      }
      throw error;
    }
  }

  const created = await api.post<Spot>("/spots", payload);
  // 新建后路由只是 replace 到编辑页，组件不会重挂载，
  // 版本号要在这里就接住，否则这次会话的后续保存拿不到三方合并保护
  contentVersion.value = created.contentVersion;
  return { uuid: created.uuid, hasConflict: false };
}

async function onSaveDraft() {
  saving.value = true;
  try {
    const result = await saveDraft();
    if (result.hasConflict) return;
    ElMessage.success("草稿已保存");
    if (result.uuid && !isEdit.value) {
      void router.replace({ name: "spot-edit", params: { uuid: result.uuid } });
    }
  } catch (error) {
    ElMessage.error((error as Error).message);
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
    const saved = await saveDraft();
    if (saved.hasConflict || !saved.uuid) return;
    const id = saved.uuid;

    const result = await api.post<{
      status: string;
      autoCheck: { passed: boolean; issues: Array<{ code: string; message: string }> };
      canRequestManualReview: boolean;
    }>(`/spots/${id}/submit`);

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
    ElMessage.error((error as Error).message);
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

/** 逐项确认取舍：选定后服务端落库对应字段，随后刷新表单与剩余冲突 */
async function onResolveConflict(conflict: EditConflict, choice: "current" | "proposed") {
  if (!uuid.value) return;
  resolvingConflict.value = true;
  try {
    await api.post(`/spots/${uuid.value}/edit-conflicts/${conflict.uuid}/resolve`, { choice });
    ElMessage.success(choice === "proposed" ? "已采用这份修改" : "已保留当前内容");
    await loadExisting();
  } catch (error) {
    if (error instanceof ApiError && error.code === "EDIT_CONFLICT_STALE") {
      ElMessage.warning(error.message);
      await loadExisting();
    } else {
      ElMessage.error((error as Error).message);
    }
  } finally {
    resolvingConflict.value = false;
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

    <EditConflictPanel
      v-if="editConflicts.length > 0"
      :conflicts="editConflicts"
      :schema="schema"
      :categories="catalog.categories"
      :resolving="resolvingConflict"
      @resolve="onResolveConflict"
    />

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
