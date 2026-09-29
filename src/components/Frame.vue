<script setup lang="ts">
/**
 * 本站的网络外壳：can-ui 的 `CanFrame`，`layout="tool"`。
 *
 * 退出登录由 can-ui 的 AccountMenu 发：同源 `POST /api/v1/auth/signout`。反代把它
 * 转给 **can-api**，不是 can-db（`src/pages/api/v1/[...path].ts` 的 `AUTH_PATHS`），
 * 并原样带回 Set-Cookie。之后去 can-web 的 `/`（`afterSignOut="web"`）。
 *
 * 账户菜单多一项「隐藏 NAIP 数据」（`profileMenu` 插槽），aipAccess ≥ 3 才出。写进
 * cookie 后整页刷新：大部分数据是服务端渲染的，刷新是唯一一种让每一处都按新值重新
 * 取的办法。写不进去就把开关弹回去，不刷新。
 *
 * `origins`：构建期的 `PUBLIC_CAN_<SITE>_ORIGIN`（`originsFromEnv`），叠上服务端传
 * 进来的运行期覆盖（`SITE_ORIGINS`，`src/lib/nav.ts`）。
 */
import { ref } from "vue";
import {
  CanFrame,
  originsFromEnv,
  Toggle,
  type FrameUser,
  type NavItem,
  type NavSecondary,
  type SiteOrigins,
  type Workspace,
} from "@jianyuelab-org/can-ui";
import { writeHideNaip } from "@/lib/hideNaip";
import { createTranslator } from "@/lib/i18n";

const props = defineProps<{
  locale: string;
  pathname: string;
  nav: NavItem[];
  secondary?: NavSecondary;
  workspaces?: Workspace[];
  user: FrameUser | null;
  /** 「隐藏 NAIP 数据」开关出不出：成员 aipAccess ≥ 3。 */
  canHideNaip: boolean;
  /** 开关的当前值，服务端从 cookie 读出来的，免得水合对不上。 */
  hideNaip: boolean;
  messages: Record<string, unknown>;
  origins?: SiteOrigins;
}>();

const origins: SiteOrigins = {
  ...originsFromEnv(import.meta.env),
  ...props.origins,
};

const t = createTranslator(props.messages);

const hideNaip = ref(props.hideNaip);
function setHideNaip(on: boolean) {
  hideNaip.value = on;
  if (writeHideNaip(on)) window.location.reload();
  else hideNaip.value = !on;
}
</script>

<template>
  <CanFrame
    layout="tool"
    current="database"
    :locale="locale"
    :pathname="pathname"
    :nav="nav"
    :secondary="secondary"
    :workspaces="workspaces"
    active-workspace="controllers"
    :user="user"
    :messages="messages"
    :origins="origins"
    after-sign-out="web"
  >
    <template v-if="canHideNaip" #profileMenu>
      <div class="border-b border-subtle px-2.5 pb-2 pt-1">
        <Toggle
          :model-value="hideNaip"
          :label="t('hideNaip')"
          :description="t('hideNaipHint')"
          @update:model-value="setHideNaip"
        />
      </div>
    </template>
    <slot />
  </CanFrame>
</template>
