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
 *
 * 一行一个「管理」菜单（can-ui `Popover`），不再把六个链接平铺在表格里 —— 数据集表本
 * 来就宽，六个链接在手机的卡片布局里要占三行。每个写操作都先开一个确认框：生效和停用
 * 改的是成员能看到什么，复制会建一整期数据，都不该一点就发。
 */
import { computed, ref } from "vue";
import { AlertBox, Dialog, Icon, Popover } from "@jianyuelab-org/can-ui";
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

const STATE_BADGE: Record<string, string> = {
  active: "badge-success",
  loading: "badge-warning",
  superseded: "badge-neutral",
};

interface MenuItem {
  action: Action;
  label: string;
  icon: string;
  danger?: boolean;
}

/** 菜单里的写操作。生效只给不在服务的，停用只给还没停用的。 */
const items = computed<MenuItem[]>(() => [
  { action: "clone", label: t("clone"), icon: "squaresPlus" },
  ...(props.dataset.state !== "active"
    ? [
        {
          action: "activate" as const,
          label: t("activate"),
          icon: "checkCircle",
        },
      ]
    : []),
  { action: "threshold", label: t("threshold"), icon: "shieldCheck" },
  ...(props.dataset.state !== "superseded"
    ? [
        {
          action: "supersede" as const,
          label: t("supersede"),
          icon: "xCircle",
          danger: true,
        },
      ]
    : []),
]);
</script>

<template>
  <div class="inline-flex">
    <Popover placement="bottom-end" width="14rem" :label="t('manage')">
      <template #trigger="{ toggle, open: menuOpen }">
        <button
          type="button"
          class="btn btn-ghost h-8 gap-1 px-2 text-xs"
          :aria-expanded="menuOpen"
          aria-haspopup="menu"
          @click="toggle"
        >
          {{ t("manage") }}
          <span class="sr-only font-mono">{{ dataset.airac }}</span>
          <Icon
            name="chevronDown"
            class="size-3.5 transition-transform"
            :class="menuOpen ? 'rotate-180' : ''"
          />
        </button>
      </template>

      <template #default="{ close: closeMenu }">
        <ul role="menu" class="space-y-0.5">
          <li v-for="item in items" :key="item.action" role="none">
            <button
              type="button"
              role="menuitem"
              :class="[
                'flex w-full items-center gap-2.5 rounded-control px-2.5 py-2 text-left text-sm transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none',
                item.danger ? 'text-danger' : 'text-ink',
              ]"
              @click="
                closeMenu();
                show(item.action);
              "
            >
              <Icon
                :name="item.icon"
                :class="['size-4 shrink-0', item.danger ? '' : 'text-faint']"
              />
              {{ item.label }}
            </button>
          </li>
          <li role="none" class="my-1 border-t border-subtle"></li>
          <li role="none">
            <a
              :href="`/datasets/${dataset.id}/edit`"
              role="menuitem"
              class="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-sm text-ink transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
            >
              <Icon name="pencilSquare" class="size-4 shrink-0 text-faint" />
              {{ t("edit") }}
            </a>
          </li>
          <li role="none">
            <a
              :href="`/datasets/${dataset.id}/revisions`"
              role="menuitem"
              class="flex items-center gap-2.5 rounded-control px-2.5 py-2 text-sm text-ink transition-colors hover:bg-surface-raised focus-visible:bg-surface-raised focus-visible:outline-none"
            >
              <Icon name="clock" class="size-4 shrink-0 text-faint" />
              {{ t("revisions") }}
            </a>
          </li>
        </ul>
      </template>
    </Popover>

    <Dialog
      :open="open !== null"
      :title="title"
      :dismissible="!busy"
      size="sm"
      @update:open="(v: boolean) => (v ? null : close())"
    >
      <form id="dataset-action" class="space-y-4" @submit.prevent="run">
        <!-- 操作的对象写在最上面：菜单是从一行里点开的，对话框盖住那一行之后，
             「我改的是哪一期」只剩这里看得到。 -->
        <p class="flex flex-wrap items-center gap-2 text-sm">
          <span class="font-mono text-ink">{{ dataset.airac }}</span>
          <span
            :class="['badge', STATE_BADGE[dataset.state] ?? 'badge-neutral']"
            >{{ dataset.state }}</span
          >
          <span class="text-faint">{{
            t("currentThreshold", { level: t(`level${dataset.minAccess}`) })
          }}</span>
        </p>

        <template v-if="open === 'clone'">
          <p class="text-sm text-muted">{{ t("cloneHint") }}</p>
          <div>
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
            <p class="tnum mt-1.5 text-xs text-faint">
              {{ cloneEffective || t("cloneAiracHint") }}
            </p>
          </div>
        </template>

        <p v-else-if="open === 'activate'" class="text-sm text-muted">
          {{ t("activateHint") }}
        </p>
        <p v-else-if="open === 'supersede'" class="text-sm text-muted">
          {{ t("supersedeHint") }}
        </p>

        <template v-else-if="open === 'threshold'">
          <p class="text-sm text-muted">{{ t("thresholdHint") }}</p>
          <fieldset>
            <legend class="mb-1.5 text-xs text-muted">
              {{ t("thresholdLevel") }}
            </legend>
            <div class="space-y-1">
              <label
                v-for="level in LEVELS"
                :key="level"
                :class="[
                  'flex cursor-pointer items-center gap-2.5 rounded-control border px-3 py-2 text-sm transition-colors',
                  threshold === level
                    ? 'border-strong bg-surface-raised text-ink'
                    : 'border-subtle text-muted hover:text-ink',
                ]"
              >
                <input
                  v-model.number="threshold"
                  type="radio"
                  name="threshold-level"
                  :value="level"
                />
                <span class="flex-1">{{ t(`level${level}`) }}</span>
                <span
                  v-if="level === dataset.minAccess"
                  class="text-xs text-faint"
                  >{{ t("thresholdNow") }}</span
                >
              </label>
            </div>
          </fieldset>
        </template>

        <AlertBox v-if="error" variant="danger">{{ error }}</AlertBox>
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
          :disabled="
            busy ||
            (open === 'threshold' && threshold === dataset.minAccess) ||
            (open === 'clone' &&
              !/^[0-9]{4}$/.test(cloneAirac.trim()) &&
              cloneAirac.trim() !== '')
          "
        >
          {{ busy ? t("working") : confirmLabel }}
        </button>
      </template>
    </Dialog>
  </div>
</template>
