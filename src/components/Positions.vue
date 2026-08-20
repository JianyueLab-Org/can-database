<script setup lang="ts">
/**
 * 管制席位：按单位分组的扇区清单。
 *
 * **一个扇区就是一个席位。** 母区（区域管制区 / 进近管制区）不作为席位列出 —— 它们是外
 * 框，78 个里有 42 个连频率都没有；它们的高频昼夜频归单位，显示在单位那一行上。
 *
 * 594 个席位分在 79 个单位里，所以这一页和别的清单页一条规矩：**搜索框是主操作**。三个
 * 筛子对应三种问法：按类别（区域/进近）、按名字（「广州」「AP01」）、按机场（「哪些席位
 * 管 ZGGG 的跑道」—— 进近席位带着跑道绑定）。
 *
 * 单位默认收起，展开才列席位：79 个单位全展开是六百多行，而想看的通常是其中一个。
 */
import { computed, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import type { Unit } from "@/lib/canDb";

const props = defineProps<{
  messages: Record<string, unknown>;
  units: Unit[];
}>();
const t = createTranslator(props.messages);

const kind = ref<"" | "area" | "approach">("");
const query = ref("");
const open = ref<Set<string>>(new Set());

const keyOf = (u: Unit) => `${u.kind}/${u.name}`;

function toggle(u: Unit) {
  const k = keyOf(u);
  const next = new Set(open.value);
  if (next.has(k)) next.delete(k);
  else next.add(k);
  open.value = next;
}

const totals = computed(() => ({
  area: props.units
    .filter((u) => u.kind === "area")
    .reduce((n, u) => n + u.positions.length, 0),
  approach: props.units
    .filter((u) => u.kind === "approach")
    .reduce((n, u) => n + u.positions.length, 0),
}));

const matched = computed(() => {
  const needle = query.value.trim().toUpperCase();
  return props.units.filter((u) => {
    if (kind.value && u.kind !== kind.value) return false;
    if (!needle) return true;
    if (u.name.toUpperCase().includes(needle)) return true;
    return u.positions.some(
      (p) =>
        p.sector.toUpperCase().includes(needle) ||
        p.name.toUpperCase().includes(needle) ||
        // 按机场搜：「哪些席位管 ZGGG 的跑道」是这一页的第三种问法。
        p.runways.some((r) => r.toUpperCase().includes(needle)),
    );
  });
});

/** 频率印成一行：`主频 120.5 (H24)`。频率为空的不印数字 —— 汇编那一格就是空的。 */
function freqText(f: {
  label: string;
  freqMhz: number | null;
  openTime: string | null;
}) {
  const bits = [f.label];
  if (f.freqMhz) bits.push(String(f.freqMhz));
  if (f.openTime) bits.push(`(${f.openTime})`);
  return bits.join(" ");
}

/** 高度带：上限 0 是不封顶。单位是**米** —— 汇编按米发布。 */
function bandText(lowerM: number, upperM: number) {
  return `${lowerM}–${upperM || "∞"} m`;
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-48 flex-1">
        <label class="mb-1 block text-xs text-muted" for="pos-q">{{
          t("search")
        }}</label>
        <input
          id="pos-q"
          v-model="query"
          class="input w-full"
          type="search"
          autocomplete="off"
          :placeholder="String(t('searchHint'))"
        />
      </div>
      <div>
        <label class="mb-1 block text-xs text-muted" for="pos-kind">{{
          t("kind")
        }}</label>
        <select id="pos-kind" v-model="kind" class="input w-40">
          <option value="">{{ t("kindAll") }}</option>
          <option value="area">{{ t("area") }} ({{ totals.area }})</option>
          <option value="approach">
            {{ t("approach") }} ({{ totals.approach }})
          </option>
        </select>
      </div>
    </div>

    <p class="text-xs text-faint">
      {{
        t("summary", {
          units: String(matched.length),
          area: String(totals.area),
          approach: String(totals.approach),
        })
      }}
    </p>

    <ul class="space-y-1.5">
      <li v-for="u in matched" :key="keyOf(u)" class="card overflow-hidden">
        <button
          type="button"
          class="flex w-full items-baseline gap-2 p-3 text-left"
          @click="toggle(u)"
        >
          <span
            class="badge shrink-0"
            :class="u.kind === 'area' ? 'badge-info' : 'badge-success'"
          >
            {{ t(u.kind) }}
          </span>
          <span class="text-sm font-semibold text-ink">{{ u.name }}</span>
          <span class="shrink-0 text-xs text-muted">
            {{ t("seats", { n: String(u.positions.length) }) }}
          </span>
          <span
            v-if="u.unitFrequencies.length"
            class="min-w-0 flex-1 truncate text-right font-mono text-xs text-faint"
          >
            {{ u.unitFrequencies.map(freqText).join(" · ") }}
          </span>
          <span v-else class="flex-1"></span>
          <span class="shrink-0 text-xs text-faint">{{
            open.has(keyOf(u)) ? "−" : "+"
          }}</span>
        </button>

        <div
          v-if="open.has(keyOf(u))"
          class="scroll-shadow-x overflow-x-auto border-t border-line"
        >
          <table class="data-table w-full text-sm">
            <thead>
              <tr>
                <th>{{ t("sector") }}</th>
                <th>{{ t("name") }}</th>
                <th>{{ t("band") }}</th>
                <th>{{ t("frequencies") }}</th>
                <th>{{ t("runways") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="p in u.positions" :key="p.sector">
                <td :data-label="t('sector')" class="font-mono font-semibold">
                  {{ p.sector }}
                </td>
                <td :data-label="t('name')">{{ p.name }}</td>
                <td :data-label="t('band')" class="tnum text-xs">
                  {{ bandText(p.lowerM, p.upperM) }}
                </td>
                <td :data-label="t('frequencies')" class="font-mono text-xs">
                  <span v-if="!p.frequencies.length" class="text-faint">—</span>
                  <span
                    v-for="(f, i) in p.frequencies"
                    :key="i"
                    class="mr-2 whitespace-nowrap"
                  >
                    {{ freqText(f) }}
                  </span>
                </td>
                <td :data-label="t('runways')" class="font-mono text-xs">
                  {{ p.runways.length ? p.runways.join(" ") : "—" }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </li>
    </ul>

    <p v-if="!matched.length" class="card p-6 text-center text-sm text-muted">
      {{ t("none") }}
    </p>

    <!-- 汇编只到区域和进近。不说这一句，看的人会以为全网席位就这些。 -->
    <p class="text-xs text-faint">{{ t("scopeNote") }}</p>
  </div>
</template>
