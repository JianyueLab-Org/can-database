/// <reference types="astro/client" />

import type { NoAccessReason } from "@jianyuelab-org/can-ui";
import type { SessionUser } from "@/server/canApi";

declare global {
  namespace App {
    interface Locals {
      /** 中间件从 can-api 解出来的成员；没登录是 null。 */
      user: SessionUser | null;
      /** 没有控制台权限时由中间件写入；`src/pages/denied.astro` 按它渲染 NoAccess。 */
      noAccess?: NoAccessReason;
    }
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_CAN_API_ORIGIN?: string;
  readonly PUBLIC_CAN_WEB_ORIGIN?: string;
  readonly PUBLIC_CAN_PORTAL_ORIGIN?: string;
  readonly PUBLIC_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
