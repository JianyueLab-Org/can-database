/**
 * 岛屿怎么跟 can-db 说话。
 *
 * 浏览器安全：没有密钥，不 import `src/server` 下的任何东西。
 *
 * 打的是**同源**的 `/api/v1/aip/...`，由本站的反代转进集群
 * （`src/pages/api/v1/[...path].ts`）。can-db 在集群外没有地址，所以这不是「顺手
 * 避开 CORS」，这是唯一的通路。
 *
 * 导出的形状和 can-web / can-portal 的 `canApi.ts` 一致，因为 can-db 的响应用的
 * 是同一个 `{status, data, timestamp}` 信封 —— 抄同一份读法比发明第二种省事，也
 * 省得下一个人去猜哪个站用哪种。
 */

export interface ApiFailure {
  ok: false;
  status: number;
  error: string;
  message: string;
}
export type ApiResult<T> = { ok: true; data: T } | ApiFailure;

/**
 * 调 can-db。
 *
 * 失败**不抛异常**：绝大多数失败是「没权限」或者「这个机场没数据」，那句话该出现
 * 在页面上而不是一个 500；真正的网络故障是 status 0，调用方分得出来。
 */
export async function api<T = unknown>(
  path: string,
  init: RequestInit = {},
): Promise<ApiResult<T>> {
  let response: Response;
  try {
    response = await fetch(path, {
      ...init,
      credentials: "same-origin",
      headers: {
        ...(init.body ? { "Content-Type": "application/json" } : {}),
        ...init.headers,
      },
    });
  } catch {
    return {
      ok: false,
      status: 0,
      error: "network",
      message: "网络连接失败，请稍后再试。",
    };
  }

  const body = (await response.json().catch(() => ({}))) as Record<
    string,
    unknown
  >;

  if (!response.ok) {
    return {
      ok: false,
      status: response.status,
      error: String(body.error ?? "http_error"),
      message: String(body.message ?? `请求失败（${response.status}）`),
    };
  }

  const data = "data" in body ? body.data : body;
  return { ok: true, data: data as T };
}

/* ---------------------------------------------------------------------------
   can-db 的返回形状。手写而不是从 Go 生成：两个仓库各自发布，一个生成步骤会把它
   们的发布节奏绑在一起，而这几个结构一年也未必动一次。字段名和 Go 那边的 json
   标签逐字对应 —— 改一边要改两边。
--------------------------------------------------------------------------- */

export interface Dataset {
  id: number;
  source: string;
  airac: string;
  state: "loading" | "active" | "superseded";
  redistributable: boolean;
  note: string | null;
  createdAt: string;
  activatedAt: string | null;
  airports: number;
}

/**
 * 总览 —— can-db 现在在服务什么。
 *
 * **这些数字是 can-db 算的，不是这一页算的。** 从前这一页取全部 dataset 然后自己
 * filter 出 active、把机场数加起来、把来源去重 —— 那是一条关于这批数据的规则
 * （「什么叫在服务」）住在一个 Astro frontmatter 块里，没有测试盯着，而第二个消费者
 * 只能把它再实现一遍。
 *
 * `datasets` 是**全部**数量而不是 active 的数量：控制台要靠它区分「还没导入」和
 * 「导入了但没激活」，只看 active 的话这两种状态长得一模一样。
 */
export interface Overview {
  datasets: number;
  active: Dataset[];
  liveAirac: string | null;
  airports: number;
  sources: string[];
}

export interface Airport {
  icao: string;
  fir: string | null;
  name: string | null;
  lat: number;
  lon: number;
  elev: number | null;
  variation: number | null;
  airac: string;
  source: string;
}

export interface Runway {
  id: string;
  opposite: string | null;
  hdg: number | null;
  lat: number;
  lon: number;
  endLat: number;
  endLon: number;
}

export interface Stand {
  name: string;
  lat: number;
  lon: number;
  hdg: number | null;
  span: number | null;
}

export interface Procedure {
  kind: "sid" | "star";
  name: string;
  runway: string | null;
  points: string[];
}

export interface AirportDetail extends Airport {
  runways: Runway[];
  stands: Stand[];
  procedures: Procedure[];
}

export interface Fix {
  ident: string;
  lat: number;
  lon: number;
  fir: string | null;
}
