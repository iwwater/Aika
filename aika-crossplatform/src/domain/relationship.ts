/**
 * 关系状态。
 *
 * 移植自 Android `CompanionPromptBuilder` 的关系判定，但按开发方案改为多因子：
 * 消息条数不等于亲密度，一天狂聊一百条不该等于认识三个月。
 *
 * 设计红线：这里没有衰减。长时间不聊天不会降级，也不会产生任何“好久不见”类信号。
 */

export type RelationshipStage = "new" | "familiar" | "close";

/** 三个原始因子，来自消息时间戳，不含任何主观打分。 */
export interface RelationshipSignals {
  /** 相识天数：第一条消息与今天之间的日历天差。 */
  daysKnown: number;
  /** 连续互动天数：以最近一个有互动的日历日结尾的连续段长度。 */
  consecutiveActiveDays: number;
  /** 消息总数，用户与 Aika 双方合计。 */
  totalMessageCount: number;
}

export interface RelationshipState extends RelationshipSignals {
  stage: RelationshipStage;
  /** 0～1，仅用于阶段判定与调试，不对用户展示为“亲密度分数”。 */
  familiarity: number;
  /** 注入 system prompt 的一句关系描述。 */
  description: string;
}

const DAYS_FULL_WEIGHT = 14;
const STREAK_FULL_WEIGHT = 7;
const MESSAGES_FULL_WEIGHT = 200;

const DAYS_SHARE = 0.45;
const STREAK_SHARE = 0.25;
const MESSAGES_SHARE = 0.3;

const FAMILIAR_THRESHOLD = 0.3;
const CLOSE_THRESHOLD = 0.7;

const DAY_MS = 24 * 60 * 60 * 1000;

const STAGE_DESCRIPTIONS: Record<RelationshipStage, string> = {
  new: "刚开始熟悉，亲切但不要过度亲密",
  familiar: "已经比较熟悉，可以自然地开玩笑和延续旧话题",
  close: "关系亲近，语气放松，但仍尊重对方的边界和现实生活",
};

export const EMPTY_RELATIONSHIP_SIGNALS: RelationshipSignals = {
  daysKnown: 0,
  consecutiveActiveDays: 0,
  totalMessageCount: 0,
};

function ratio(value: number, full: number): number {
  return Math.min(Math.max(value, 0) / full, 1);
}

/** 本地时区的日历日序号，用于按“天”而不是按 24 小时切分。 */
function localDayIndex(timestamp: number): number {
  const date = new Date(timestamp);
  return Math.floor(
    Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / DAY_MS,
  );
}

export function computeRelationship(signals: RelationshipSignals): RelationshipState {
  const familiarity =
    ratio(signals.daysKnown, DAYS_FULL_WEIGHT) * DAYS_SHARE +
    ratio(signals.consecutiveActiveDays, STREAK_FULL_WEIGHT) * STREAK_SHARE +
    ratio(signals.totalMessageCount, MESSAGES_FULL_WEIGHT) * MESSAGES_SHARE;

  const stage: RelationshipStage =
    familiarity >= CLOSE_THRESHOLD ? "close"
      : familiarity >= FAMILIAR_THRESHOLD ? "familiar"
        : "new";

  return {
    ...signals,
    stage,
    familiarity: Number(familiarity.toFixed(4)),
    description: STAGE_DESCRIPTIONS[stage],
  };
}

/** 从消息时间戳（毫秒）推导三个因子。顺序无所谓，内部会排序。 */
export function deriveRelationshipSignals(
  timestamps: readonly number[],
  now: number = Date.now(),
): RelationshipSignals {
  if (timestamps.length === 0) return EMPTY_RELATIONSHIP_SIGNALS;

  const days = [...new Set(timestamps.map(localDayIndex))].sort((a, b) => a - b);
  const firstDay = days[0];
  const lastDay = days[days.length - 1];

  let consecutiveActiveDays = 1;
  for (let index = days.length - 1; index > 0; index -= 1) {
    if (days[index] - days[index - 1] !== 1) break;
    consecutiveActiveDays += 1;
  }

  return {
    daysKnown: Math.max(localDayIndex(now), lastDay) - firstDay,
    consecutiveActiveDays,
    totalMessageCount: timestamps.length,
  };
}
