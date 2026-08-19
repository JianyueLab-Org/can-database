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
  airac: string;
  state: "loading" | "active" | "superseded";
  redistributable: boolean;
  createdAt: string;
  activatedAt: string | null;
  airports: number;
  /**
   * 看这批数据要多少级 aipAccess。0 = 公开（对任何进得来控制台的人），3 = 受限。
   *
   * **控制台要把它显示出来。** 一个校对数据的人应该分得清手上这条是官方汇编还是面向模拟
   * 的派生物 —— 两者的权威性和可再分发性都不一样，而它们在页面上长得一模一样。
   */
  minAccess: number;
}

/** 受限数据的门槛，和 can-api 的 AIPRestrictedRead 对齐。 */
export const RESTRICTED_ACCESS = 3;

/** 这批数据是不是受限的。 */
export function isRestricted(minAccess: number | undefined): boolean {
  return (minAccess ?? 0) >= RESTRICTED_ACCESS;
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
}

/**
 * 机场索引的一行：一个机场加上它的机位数。
 *
 * **和 AirportDetail 分开是必须的**，不是整理癖：详情里 `stands` 是一个数组，这里是
 * 一个计数，两者用同一个 JSON 名字。Go 那边把它们放进同一个结构体时，编码器会静默地
 * 挑浅的那一个，于是详情页的机位列表变成一个数字 —— 那个 bug 就是这么来的。
 */
export interface AirportSummary extends Airport {
  stands: number;
}

/** 跑道的**物理**数据 —— 没有坐标，那份汇编不给。几何在 `Runway` 里，两者按代号拼。 */
export interface RunwayDetail {
  ident: string;
  pair: string | null;
  /** 米，全部。 */
  lengthM: number | null;
  widthM: number | null;
  stripLengthM: number | null;
  stripWidthM: number | null;
  surface: string | null;
  strength: string | null;
  strengthDesc: string | null;
  trueBrg: number | null;
  slope: string | null;
  elevM: number | null;
  thrElevM: number | null;
  thrDisplaceM: number | null;
  stopwayM: number | null;
  clearwayM: number | null;
  takeoffM: number | null;
  landingM: number | null;
  asdaM: number | null;
  note: string | null;
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

/**
 * 程序上的一个航路点。
 *
 * **lat/lon 可以是 null，而且这不是边角情况**：2608 里 41144 个程序点有 311 个引用了
 * 任何来源都不认识的代号。代号本身仍然属于那条飞行计划航路，所以它被保留、坐标留空 ——
 * 画图的一方要自己跳过这些点，而不是指望它们不存在。
 */
export interface ProcedurePoint {
  /** 空串表示这条腿**没有定位点** —— CA/VI 这类终止在高度或航向上的腿。 */
  ident: string;
  lat: number | null;
  lon: number | null;

  /** 下面这些只有 AIP 编码图那一份给得出，别的来源是 null。 */
  path: string | null;
  transition: string | null;
  routeType: string | null;
  /** ARINC 424 的编码字符串原样（`05910B03940A`），**没有解码**。 */
  alt: string | null;
  speedKt: number | null;
  speedKind: string | null;
  turn: string | null;
  courseMag: number | null;
  vpaDeg: number | null;
  flyover: boolean | null;
  isMap: boolean | null;
  /** 进近的三段：final / missed / transition。SID/STAR 是 null。 */
  part: string | null;
}

export interface Procedure {
  kind: "sid" | "star" | "approach";
  name: string;
  runway: string | null;
  /** 这条程序服务的全部跑道，逗号分隔 —— 一条 SID 常常服务好几条。 */
  runways: string | null;
  chart: string | null;
  variant: string | null;
  /** 有序代号，印出来的程序清单读的是这一串。 */
  points: string[];
  /** 同一串，带坐标。`path[i].ident === points[i]`，长度也一定相同。 */
  path: ProcedurePoint[];
}

/**
 * 全国航路网。
 *
 * `fixes` 是 ident → [lat, lon]，`segments` 是 [airway, from, to]。一次取整张图而不是
 * 按 FIR 切：一条 ZGGG→ZBAA 的航路跨四个 FIR，在边界上切开的图只能规划到那一块的边缘。
 */
export interface AirwayGraph {
  fixes: Record<string, [number, number]>;
  segments: Array<[string, string, string]>;
}

export interface AirportDetail extends Airport {
  /** 汇编才有的属性，别的来源给不了就是 null。 */
  iata: string | null;
  /** 米 —— 中国管制按米发布，这两个不换算成英尺。 */
  transitionAltM: number | null;
  transitionLevelM: number | null;
  bureau: string | null;
  isInternational: boolean | null;
  milOps: string | null;
  longestRwyM: number | null;
  note: string | null;

  runways: Runway[];
  runwayDetails: RunwayDetail[];
  stands: Stand[];
  procedures: Procedure[];
}

export interface Fix {
  ident: string;
  lat: number;
  lon: number;
  fir: string | null;
}
