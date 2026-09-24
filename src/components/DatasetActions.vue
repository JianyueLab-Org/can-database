<script setup lang="ts">
/**
 * 一个数据集的管理操作：复制为新一期、生效、停用、修改门槛，以及去编辑页和修订记录的
 * 链接。
 *
 * **只对 5 级「管理/编辑」渲染** —— `datasets.astro` 按 `canManage` 决定挂不挂这个岛屿。
 * 这不是权限判断：写路由由 can-db 的 `withWrite` 把关，这里只是不给别人看点下去必然
 * 403 的按钮。
 *
 * 每一次成功之后整页重新加载，屏幕上显示的是 can-db 落下的结果，不是这里请求的值。
 */
import { computed, ref } from "vue";
import { Dialog } from "@jianyuelab-org/can-ui";
import { createTranslator } from "@/lib/i18n";
import { api, type AiracCalendar, type Dataset } from "@/lib/canDb";

const props = defineProps<{
  dataset: Pick<Dataset, "id" | "airac" | "state" | "minAccess">;
  /** SSR 取的 AIRAC 日历；can-db 答不上来时为 null。 */
  airac: AiracCalendar | null;
  messages: Record<string, unknown>;
}>();
const t = createTranslator(props.messages);

type Action = "clone" | "activate" | "supersede" | "threshold";
const open = ref<Action | null>(null);
const busy = ref(false);
const error = ref("");

const cloneAirac = ref("");
const threshold = ref(props.dataset.minAccess);

/** 预填的周期号如果正好是日历上的当前或下一期，就把生效日标出来。 */
const cloneEffective = computed(() => {
  const ident = cloneAirac.value.trim();
  const cycle = [props.airac?.next, props.airac?.current].find(
    (c) => c?.ident === ident,
  );
  return cycle
    ? t("cloneAiracEffective", { ident, date: cycle.effective })
    : "";
});

function show(action: Action) {
  error.value = "";
  if (action === "clone") cloneAirac.value = props.airac?.next.ident ?? "";
  if (action === "threshold") threshold.value = props.dataset.minAccess;
  open.value = action;
}

function close() {
  if (!busy.value) open.value = null;
}

async function run() {
  const base = `/api/v1/aip/datasets/${props.dataset.id}`;
  busy.value = true;
  error.value = "";
  let result;
  switch (open.value) {
    case "clone":
      result = await api(`/api/v1/aip/datasets/${props.dataset.id}/clone`, {
        method: "POST",
        body: JSON.stringify(
          cloneAirac.value.trim() ? { airac: cloneAirac.value.trim() } : {},
        ),
      });
      break;
    case "activate":
      result = await api(`/api/v1/aip/datasets/${props.dataset.id}/activate`, {
        method: "POST",
      });
      break;
    case "supersede":
      result = await api(`/api/v1/aip/datasets/${props.dataset.id}/supersede`, {
        method: "POST",
      });
      break;
    case "threshold":
      result = await api(base, {
        method: "PATCH",
        body: JSON.stringify({ minAccess: Number(threshold.value) }),
      });
      break;
    default:
      busy.value = false;
      return;
  }
  if (!result.ok) {
    busy.value = false;
    error.value = result.message;
    return;
  }
  window.location.reload();
}

const title = computed(() => {
  const airac = props.dataset.airac;
  switch (open.value) {
    case "clone":
      return t("cloneTitle", { airac });
    case "activate":
      return t("activateTitle", { airac });
    case "supersede":
      return t("supersedeTitle", { airac });
    case "threshold":
      return t("thresholdTitle", { airac });
  }
  return "";
});

const confirmLabel = computed(() => {
  switch (open.value) {
    case "clone":
      return t("cloneConfirm");
    case "activate":
      return t("activate");
    case "supersede":
      return t("supersede");
  }
  return t("save");
});

const LEVELS = [0, 1, 2, 3, 4];
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-sm">
    <button type="button" class="link" @click="show('clone')">
      {{ t("clone") }}
    </button>
    <button
      v-if="dataset.state !== 'active'"
      type="button"
      class="link"
      @click="show('activate')"
    >
      {{ t("activate") }}
    </button>
    <button
      v-if="dataset.state !== 'superseded'"
      type="button"
      class="link"
      @click="show('supersede')"
    >
      {{ t("supersede") }}
    </button>
    <button type="button" class="link" @click="show('threshold')">
      {{ t("threshold") }}
    </button>
    <a :href="`/datasets/${dataset.id}/edit`" class="link">{{ t("edit") }}</a>
    <a :href="`/datasets/${dataset.id}/revisions`" class="link">{{
      t("revisions")
    }}</a>

    <Dialog
      :open="open !== null"
      :title="title"
      :dismissible="!busy"
      size="sm"
      @update:open="(v: boolean) => (v ? null : close())"
    >
      <form id="dataset-action" @submit.prevent="run">
        <template v-if="open === 'clone'">
          <p class="mb-4 text-sm text-muted">{{ t("cloneHint") }}</p>
          <label class="mb-1 block text-xs text-muted" for="clone-airac">{{
            t("cloneAirac")
          }}</label>
          <input
            id="clone-airac"
            v-model="cloneAirac"
            class="input w-32 font-mono"
            inputmode="numeric"
            pattern="[0-9]{4}"
            maxlength="4"
            autocomplete="off"
          />
          <p v-if="cloneEffective" class="tnum mt-2 text-xs text-faint">
            {{ cloneEffective }}
          </p>
        </template>

        <p v-else-if="open === 'activate'" class="text-sm text-muted">
          {{ t("activateHint") }}
        </p>
        <p v-else-if="open === 'supersede'" class="text-sm text-muted">
          {{ t("supersedeHint") }}
        </p>

        <template v-else-if="open === 'threshold'">
          <p class="mb-4 text-sm text-muted">{{ t("thresholdHint") }}</p>
          <label class="mb-1 block text-xs text-muted" for="threshold-level">{{
            t("thresholdLevel")
          }}</label>
          <select
            id="threshold-level"
            v-model.number="threshold"
            class="input w-48"
          >
            <option v-for="level in LEVELS" :key="level" :value="level">
              {{ t(`level${level}`) }}
            </option>
          </select>
        </template>

        <p v-if="error" class="mt-4 text-sm text-danger" role="alert">
          {{ error }}
        </p>
      </form>

      <template #footer>
        <button
          type="button"
          class="btn btn-secondary"
          :disabled="busy"
          @click="close"
        >
          {{ t("cancel") }}
        </button>
        <button
          type="submit"
          form="dataset-action"
          :class="['btn', open === 'supersede' ? 'btn-danger' : 'btn-primary']"
          :disabled="busy"
        >
          {{ busy ? t("working") : confirmLabel }}
        </button>
      </template>
    </Dialog>
  </div>
</template>
