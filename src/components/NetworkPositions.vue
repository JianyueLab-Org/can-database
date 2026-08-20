<script setup lang="ts">
/**
 * 本网实际开的席位 —— 扇区包 `[POSITIONS]` 里的那一份。
 *
 * **和汇编那份分开显示，因为它们回答的不是同一个问题。** 汇编那边是官方怎么划扇区（594
 * 个，只有区域和进近）；这一份是成员登录时用的呼号、频率、二次雷达码段，塔台、地面、放
 * 行、ATIS 只有这边有。合成一张表会让「有多少个席位」这个问题答不清楚。
 *
 * ## 呼号不唯一，这不是脏数据
 *
 * `RJTG_CTR` 有 19 条，标识 TG/T01…T27 各管一个扇区 —— EuroScope 靠标识把扇区归属解析回
 * 呼号。所以按呼号分组显示：一行是一个呼号，展开才看它下面的标识和频率。
 */
import { computed, ref } from "vue";
import { createTranslator } from "@/lib/i18n";
import type { NetworkPosition } from "@/lib/canDb";

const props = defineProps<{
  messages: Record<string, unknown>;
  positions: NetworkPosition[];
}>();
const t = createTranslator(props.messages);

/** 席位类型按管制链条排，不按字母 —— 放行、地面、塔台、进近、区域是它的自然顺序。 */
const FACILITY_ORDER = [
  "DEL",
  "GND",
  "RMP",
  "TWR",
  "APP",
  "DEP",
  "GCA",
  "CTR",
  "FSS",
  "ATIS",
];

const facility = ref("");
const pkg = ref("");
const query = ref("");
const open = ref<Set<string>>(new Set());

const facilities = computed(() => {
  const seen = new Map<string, number>();
  for (const p of props.positions)
    seen.set(p.facility, (seen.get(p.facility) ?? 0) + 1);
  return FACILITY_ORDER.filter((f) => seen.has(f)).map((f) => ({
    key: f,
    count: seen.get(f) ?? 0,
  }));
});

const packages = computed(() =>
  [...new Set(props.positions.map((p) => p.package))].sort(),
);

/** 按呼号分组：一个呼号一行，下面挂它的标识。 */
const groups = computed(() => {
  const needle = query.value.trim().toUpperCase();
  const byCallsign = new Map<string, NetworkPosition[]>();

  for (const p of props.positions) {
    if (facility.value && p.facility !== facility.value) continue;
    if (pkg.value && !(p.packages ?? p.package).split(",").includes(pkg.value))
      continue;
    if (
      needle &&
      !p.callsign.toUpperCase().includes(needle) &&
      !(p.radioName ?? "").toUpperCase().includes(needle) &&
      !(p.identifier ?? "").toUpperCase().includes(needle) &&
      !String(p.freqMhz ?? "").includes(needle)
    ) {
      continue;
    }
    const list = byCallsign.get(p.callsign);
    if (list) list.push(p);
    else byCallsign.set(p.callsign, [p]);
  }

  return [...byCallsign.entries()]
    .map(([callsign, list]) => ({ callsign, list }))
    .sort((a, b) => a.callsign.localeCompare(b.callsign));
});

const shownSeats = computed(() =>
  groups.value.reduce((n, g) => n + g.list.length, 0),
);

function toggle(callsign: string) {
  const next = new Set(open.value);
  if (next.has(callsign)) next.delete(callsign);
  else next.add(callsign);
  open.value = next;
}

/** 一个呼号下的频率：一个就直接印，多个印「N 个频率」—— 那是分扇区的区调。 */
function freqSummary(list: NetworkPosition[]): string {
  const freqs = [...new Set(list.map((p) => p.freqMhz).filter(Boolean))];
  if (freqs.length === 1) return String(freqs[0]);
  return String(t("nFreqs", { n: String(freqs.length) }));
}
</script>

<template>
  <div class="flex flex-col gap-4">
    <div class="flex flex-wrap items-end gap-3">
      <div class="min-w-48 flex-1">
        <label class="mb-1 block text-xs text-muted" for="np-q">{{
          t("search")
        }}</label>
        <input
          id="np-q"
          v-model="query"
          class="input w-full"
          type="search"
          autocomplete="off"
          :placeholder="String(t('searchHint'))"
        />
      </div>
      <div>
        <label class="mb-1 block text-xs text-muted" for="np-fac">{{
          t("facility")
        }}</label>
        <select id="np-fac" v-model="facility" class="input w-36">
          <option value="">{{ t("all") }}</option>
          <option v-for="f in facilities" :key="f.key" :value="f.key">
            {{ f.key }} ({{ f.count }})
          </option>
        </select>
      </div>
      <div>
        <label class="mb-1 block text-xs text-muted" for="np-pkg">{{
          t("package")
        }}</label>
        <select id="np-pkg" v-model="pkg" class="input w-32">
          <option value="">{{ t("all") }}</option>
          <option v-for="p in packages" :key="p" :value="p">{{ p }}</option>
        </select>
      </div>
    </div>

    <p class="text-xs text-faint">
      {{
        t("showing", {
          callsigns: String(groups.length),
          seats: String(shownSeats),
        })
      }}
    </p>

    <ul class="space-y-1.5">
      <li v-for="g in groups" :key="g.callsign" class="card overflow-hidden">
        <button
          type="button"
          class="flex w-full items-baseline gap-3 p-3 text-left"
          :disabled="g.list.length === 1"
          @click="toggle(g.callsign)"
        >
          <span class="badge badge-neutral shrink-0">{{
            g.list[0].facility
          }}</span>
          <span class="font-mono text-sm font-semibold text-ink">{{
            g.callsign
          }}</span>
          <span class="min-w-0 flex-1 truncate text-xs text-muted">{{
            g.list[0].radioName
          }}</span>
          <span class="tnum shrink-0 font-mono text-xs text-ink">{{
            freqSummary(g.list)
          }}</span>
          <!-- 一个呼号带多个标识 = 分扇区的区调，这一点值得在收起时就看得见。 -->
          <span v-if="g.list.length > 1" class="shrink-0 text-xs text-faint">
            {{ t("nSectors", { n: String(g.list.length) }) }}
            {{ open.has(g.callsign) ? "−" : "+" }}
          </span>
        </button>

        <div
          v-if="open.has(g.callsign) && g.list.length > 1"
          class="scroll-shadow-x overflow-x-auto border-t border-line"
        >
          <table class="data-table w-full text-sm">
            <thead>
              <tr>
                <th>{{ t("identifier") }}</th>
                <th>{{ t("freq") }}</th>
                <th>{{ t("squawk") }}</th>
                <th>{{ t("package") }}</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(p, i) in g.list" :key="i">
                <td :data-label="t('identifier')" class="font-mono">
                  {{ p.identifier ?? "—" }}
                </td>
                <td :data-label="t('freq')" class="tnum font-mono">
                  {{ p.freqMhz ?? "—" }}
                </td>
                <td :data-label="t('squawk')" class="tnum font-mono text-xs">
                  {{ p.squawkStart ? `${p.squawkStart}–${p.squawkEnd}` : "—" }}
                </td>
                <td :data-label="t('package')" class="text-xs text-faint">
                  {{ p.packages ?? p.package }}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </li>
    </ul>

    <p v-if="!groups.length" class="card p-6 text-center text-sm text-muted">
      {{ t("none") }}
    </p>
  </div>
</template>
