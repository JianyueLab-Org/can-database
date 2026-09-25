<script setup lang="ts">
/**
 * 站点侧的外框：把 can-ui 的 `AppShell` 包一层，只为了接住 `@signout`。
 *
 * can-ui 的 AppShell 不再自己调 can-api —— 一个知道网络鉴权端点在哪的设计系统
 * 不是设计系统。退出登录现在是一个事件，而「发哪个请求」和「之后把人送去哪」
 * 本来就只有站点知道，所以那一行留在这里。
 *
 * 这一层还有个绕不开的理由：Astro 的岛屿没法从 `.astro` 模板上挂 Vue 的事件
 * 监听器，`@signout` 只能写在一个 Vue 组件里。所以 AppLayout.astro 渲染的是
 * 这个组件，不是 AppShell 本身。
 */
import { computed, ref } from "vue";
import {
  AppShell,
  Toggle,
  type NavItem,
  type NavSecondary,
  type Workspace,
} from "@jianyuelab-org/can-ui";
import { api } from "@/lib/canDb";
import { writeHideNaip } from "@/lib/hideNaip";
import { createTranslator } from "@/lib/i18n";

const props = defineProps<{
  navigation: NavItem[];
  pathname: string;
  messages?: Record<string, unknown>;
  locale?: string;
  secondary?: NavSecondary;
  workspaces?: Workspace[];
  activeWorkspace?: string;
  userName?: string;
  userId?: string;
  /** 「隐藏 NAIP 数据」开关出不出：成员 aipAccess ≥ 3。 */
  canHideNaip?: boolean;
  /** 开关的当前值，服务端从 cookie 读出来的，免得水合对不上。 */
  hideNaip?: boolean;
}>();

const t = createTranslator(props.messages ?? {});
/** 交给 AppShell 的那部分 —— 开关的两个属性是这一层自己的。 */
const shellProps = computed(() => {
  const { canHideNaip: _can, hideNaip: _on, ...rest } = props;
  void _can;
  void _on;
  return rest;
});

/**
 * 整个控制台的「隐藏 NAIP 数据」。写进 cookie 后整页刷新：大部分数据是服务端渲染的，
 * 岛屿里取过的也各有缓存，刷新是唯一一种让每一处都按新值重新取的办法。
 * 写不进去（浏览器禁了 cookie）就把开关弹回去，不刷新。
 */
const hideNaip = ref(props.hideNaip ?? true);
function setHideNaip(on: boolean) {
  hideNaip.value = on;
  if (writeHideNaip(on)) window.location.reload();
  else hideNaip.value = !on;
}

/**
 * 退出登录打的是 **can-api**，不是 can-db。
 *
 * 会话是 can-api 签的，清 cookie 也只能是它 —— 一个属性对不上的 Set-Cookie 只会
 * 让浏览器同时留着两份。本站的反代为此单开了一条到 can-api 的通路（见
 * `src/pages/api/v1/[...path].ts` 的 AUTH_PATHS），那是它唯一一条不指向 can-db
 * 的转发。
 */
function handleSignOut() {
  // 清 cookie 是 can-api 的事 —— 属性是它定的，一个对不上的 Set-Cookie 只会让
  // 浏览器同时留着两份。跳转是我们的事，而且请求成不成都要跳：一个按了退出的人
  // 不该因为请求失败就留在一个还显示着已登录的页面上。
  api("/api/v1/auth/signout", { method: "POST" }).finally(() => {
    window.location.assign("/");
  });
}
</script>

<template>
  <AppShell v-bind="shellProps" @signout="handleSignOut">
    <template v-if="canHideNaip" #profileMenu>
      <div class="border-b border-subtle px-4 py-3">
        <Toggle
          :model-value="hideNaip"
          :label="String(t('hideNaip'))"
          :description="String(t('hideNaipHint'))"
          @update:model-value="setHideNaip"
        />
      </div>
    </template>
    <slot />
  </AppShell>
</template>
