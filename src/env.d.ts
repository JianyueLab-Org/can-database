/// <reference types="astro/client" />

import type { SessionUser } from "@/server/canApi";

declare global {
  namespace App {
    interface Locals {
      /** 中间件从 can-api 解出来的成员；没登录是 null。 */
      user: SessionUser | null;
    }
  }
}

interface ImportMetaEnv {
  readonly PUBLIC_CAN_API_ORIGIN?: string;
  readonly PUBLIC_CAN_WEB_ORIGIN?: string;
  readonly PUBLIC_ORIGIN?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}

export {};
