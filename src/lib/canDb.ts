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
   * 看这批数据要多少级 aipAccess。**1 = 公开，3 = 受限（官方汇编）。**
   *
   * 下限跟着**来源**走，而不是一条笼统的范围检查：naip 的数据集不许降到 3 以下，其余至
   * 少 1。**公开的下限是 1 不是 0** —— 0 是「无权访问」，不是「一种公开」。
   *
   * 钉住它的是 can-db 那边的两处，一处挡人一处兜底：`aip.SetDatasetMinAccess` 里按来源
   * 判的那道下限（改门槛那条路由和 `aip-import` 都走它），加上迁移
   * `0027_min_access_floor.sql` 加的 CHECK 约束。**要的就是两处** —— 前者能给出一句人
   * 看得懂的话，后者管住任何绕开它的写法（手写 SQL 也算）。
   *
   * 这一段从前写的是「由 CHECK 钉住（迁移 0025）」，而 0025 是
   * `0025_ils_and_airport_comm.sql`，和 min_access 毫无关系 —— 那时候根本没有约束。一
   * 句凭空的「已经有人管了」比没有这句更糟：它会让下一个人省掉去确认的那一步。
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

/** 一条航路整体的属性 —— 航段表只有一段段的连接，没有这一层。 */
export interface AirwayMeta {
  /**
   * 汇编给的类型（'国内对外开放航路' 之类）。要按类型分色就用它，**别按 designator 的
   * 字母猜** —— 猜出来的分色在图上一样好看，错了没人会发现。
   */
  locType: string | null;
  lengthKm: number | null;
  lengthNm: number | null;
  /** **米**，整条航路的最低超障高度。 */
  mtcaM: number | null;
  note: string | null;
}

/**
 * 航路网的一段。
 *
 * **这是一个对象，不是三元组。** 这里从前写的是 `[string, string, string]`，而 can-db
 * 一直给的是这六个字段 —— 见下面 `AirwayGraph` 上那段。
 */
export interface AirwaySegment {
  airway: string;
  from: string;
  to: string;
  /**
   * `both` | `forward`（只能 from→to）| `backward`（只能 to→from）。
   *
   * **方向不是装饰。** 少了它这张图就是无向的，规划器会逆着单向航路排出一条图上好看、
   * 报不上去的航路。不过规划在 can-db（`internal/aip/route.go`），这个站只画，而一条单
   * 向航路和一条双向的在图上是同一条线 —— 所以这个字段今天**没有用到**。
   */
  dir: "both" | "forward" | "backward";
  /** 英尺。来源没发布高度带时是 null（Go 那边是 `*int`，nil 序列化成 `null`）。 */
  minAlt: number | null;
  maxAlt: number | null;
}

/**
 * 全国航路网。
 *
 * `fixes` 是 ident → [lat, lon]，`segments` 是一段段的连接。一次取整张图而不是按 FIR
 * 切：一条 ZGGG→ZBAA 的航路跨四个 FIR，在边界上切开的图只能规划到那一块的边缘。
 *
 * **`segments` 从前在这里被写成 `Array<[string, string, string]>`，而它一直是对象。**
 * 那不是一处笔误可以带过的事：`NetworkMap.vue` 照着这份声明对每一段做数组解构，而对着
 * 一个普通对象解构会抛 `TypeError: … is not iterable` —— 航路图层一条线都画不出来，而
 * 且因为那一下同样发生在 `moveend`/`zoomend` 的处理里，之后每一次平移缩放都把航路名和
 * 航路点名字一起带走。CI 全绿，因为**漂移的正是手写的这一半**：`vue-tsc` 拿着错的声明
 * 去校验用它的代码，两边自洽。
 *
 * 所以这一段的教训不是「小心一点」，是文件抬头那句话要当真：**字段名和 Go 的 json 标
 * 签逐字对应，改一边要改两边**（can-db 的 `internal/aip/store.go`，`AirwayGraph` /
 * `AirwaySegment` / `AirwayMeta` 三个结构）。
 */
export interface AirwayGraph {
  fixes: Record<string, [number, number]>;
  /**
   * designator → 这条航路整体的属性。**这个站今天一个字段都没读**，写在这里是因为接口
   * 确实给 —— 一份「只写用得到的字段」的手写类型正是上面那个 bug 的来路。
   */
  airways: Record<string, AirwayMeta>;
  segments: AirwaySegment[];
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
  speedLimitKt: number | null;
  speedLimitBelowFt: number | null;

  runways: Runway[];
  runwayDetails: RunwayDetail[];
  stands: Stand[];
  procedures: Procedure[];
}

/** 一个管制席位的频率。`label` 是汇编给的类型：主频 / 备频 / 中低空日频…… */
export interface PositionFrequency {
  label: string;
  freqMhz: number | null;
  openTime: string | null;
}

/**
 * 一个管制席位 —— 就是一个扇区。
 *
 * 母区（区域管制区 / 进近管制区）不在这里：它们是外框，78 个里有 42 个连频率都没有。
 * 母区的高频昼夜频挂在单位上（`Unit.unitFrequencies`）。
 */
export interface Position {
  unit: string;
  kind: "area" | "approach";
  /** 席位号：'11'、'AP01(南)'、'TM01(北)1'。 */
  sector: string;
  name: string;
  /** 米。上限 0 表示不封顶。 */
  lowerM: number;
  upperM: number;
  frequencies: PositionFrequency[];
  /** 这个进近席位负责的跑道方向，`ZGGG/01` 的形式。区域席位是空的。 */
  runways: string[];
}

/**
 * **我们实际开的**一个席位，来自扇区包的 `[POSITIONS]`。
 *
 * 和 `Position`（汇编发布的管制扇区）不是一回事：那边是官方怎么划的，这边是成员登录时用
 * 的呼号和频率 —— 塔台、地面、放行、ATIS 只有这边有。
 */
export interface NetworkPosition {
  callsign: string;
  radioName: string | null;
  freqMhz: number | null;
  /** 扇区归属表引用的标识。呼号**不唯一** —— 一个区调呼号常带十几条，各管一个扇区。 */
  identifier: string | null;
  middleLetter: string | null;
  prefix: string | null;
  /** DEL/GND/TWR/APP/DEP/CTR/FSS/ATIS/GCA/RMP */
  facility: string;
  squawkStart: string | null;
  squawkEnd: string | null;
  package: string;
  /** 定义了这个席位的全部包，逗号分隔。多于一个是正常的 —— 每个包都带邻区的席位。 */
  packages: string | null;
  visibilityPoints: number;
}

export interface Unit {
  name: string;
  kind: "area" | "approach";
  positions: Position[];
  unitFrequencies: PositionFrequency[];
}

export interface Fix {
  ident: string;
  lat: number;
  lon: number;
  fir: string | null;
}

/**
 * 一个机场的地面线画，从航图上抠出来的。
 *
 * `rgb` 是**图上的原色**，不是语义。图上的线没有语义 —— can-db 那边只存得到颜色和线
 * 宽，没有一个字说哪条是滑行道中线、哪条是机坪边界。要按语义用，得自己再判一层。
 */
export interface GroundLines {
  icao: string;
  /**
   * 手工做的地面要素：分好类、带代号、米级，但只有 90 个机场。
   *
   * **有它就该用它** —— `lines` 只是那张航图的画面，没有语义也没有名字。两份并起来
   * 121 个机场。
   */
  features: GroundFeature[];
  /**
   * 署名。**有值就必须显示** —— OSM 的数据按 ODbL 发布，署名是硬要求。
   *
   * 由 can-db 按数据决定：只有真返回了 OSM 来源的要素才有值。
   */
  attribution?: string;
  /** 这批线该信到几米。**不是**残差 —— 见 can-db 的 `chart_georef.accuracy_m`。 */
  accuracyM: number;
  /** 有几条跑道核对过配准。0 表示没核对上，那时 accuracyM 是个保守下限。 */
  runways: number;
  lines: GroundLine[];
}

export interface GroundFeature {
  /** `sector` = 扇区包手工做的；`osm` = OpenStreetMap（ODbL）。 */
  source: string;
  /** taxiway / parking_position / holding_position / apron / terminal / runway / aerodrome */
  kind: string;
  /** 代号，例如滑行道的 `W9`。多数机位没有。 */
  name?: string;
  widthM?: number;
  /** [纬, 经]。**可能只有一个点** —— 等待位置和一部分机位本来就是点。 */
  points: [number, number][];
}

export interface GroundLine {
  rgb: string;
  widthM: number;
  /**
   * 这条引导线的滑行道编号，从航图上印的标注绑来的。
   *
   * **空是常态**：全库 43701 条引导线里 4060 条有编号（83 个机场、526 种）。绑不上就
   * 不绑 —— can-db 那边三条规则都往「宁可不绑」那侧倒，因为绑错了不会被屏幕出卖：名字
   * 挂错的线仍然画在对的位置、颜色也对。
   *
   * **可信度比 `kind` 低。** `kind` 是颜色，图自己说的；`ref` 是「这个字离这条线最近」，
   * 是启发式，而真实命中率没被量准。当参考，别当权威。
   */
  ref?: string;
  /**
   * 航图**把那个编号印在哪儿**。[纬] 和 [经] 各一个字段，缺就是 0。
   *
   * **画标注要用它，不要用线的中点。** 只拿名字的话唯一能放的地方是中点，而这些线中位
   * 130–230 米、90 分位 800–1400 米、最长 4.5 公里 —— 挪到中点实测差 32–41 米（中位），
   * 90 分位 170–250 米，最大 2.6 公里。
   */
  refLat?: number;
  refLon?: number;
  /**
   * `guidance` = 画在地上给航空器循的引导线（跑道中线 + 滑行道中线 + 机坪引导线）。
   *
   * **不是「滑行道」**：它没有滑行道名字，也没有把跑道摘出去。判据是颜色，逐个机场拿
   * 手工数据验过 —— 最吻合的那一类永远是同一个色。位置准到几米要看 `accuracyM`。
   */
  kind?: "guidance";
  /** [纬, 经] */
  points: [number, number][];
}
