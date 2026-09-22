/**
 * Minimal 5-field cron parser + "when does this fire next" search.
 *
 * Deliberately dependency-free: the bridge ships with a very small runtime
 * dependency set, and a scheduler that only ever needs "next fire after now"
 * does not justify pulling in a full cron library.
 *
 * Supported: `minute hour day-of-month month day-of-week`, each field taking
 * `*`, a number, `a-b`, a comma list, and any of those with a `/step`. Month
 * and day-of-week also accept three-letter names. `@hourly`, `@daily`,
 * `@midnight`, `@weekly`, `@monthly`, `@yearly` and `@annually` expand to the
 * usual equivalents.
 *
 * All evaluation is in the host's local timezone — the person typing
 * `/cron add "0 9 * * 1-5"` means 9am where they are, and the bridge runs on
 * their machine.
 */

export class CronParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CronParseError';
  }
}

export interface CronFields {
  minute: Set<number>;
  hour: Set<number>;
  dom: Set<number>;
  month: Set<number>;
  dow: Set<number>;
  /**
   * Standard cron oddity: when *both* day-of-month and day-of-week are
   * restricted, a day matches if *either* matches (not both). These flags say
   * which of the two were actually narrowed.
   */
  domRestricted: boolean;
  dowRestricted: boolean;
}

const ALIASES: Record<string, string> = {
  '@hourly': '0 * * * *',
  '@daily': '0 0 * * *',
  '@midnight': '0 0 * * *',
  '@weekly': '0 0 * * 0',
  '@monthly': '0 0 1 * *',
  '@yearly': '0 0 1 1 *',
  '@annually': '0 0 1 1 *',
};

const MONTH_NAMES = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
const DOW_NAMES = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

interface FieldSpec {
  name: string;
  min: number;
  max: number;
  names?: string[];
  /** Offset applied to a matched name index (months are 1-based). */
  nameOffset?: number;
}

const SPECS: FieldSpec[] = [
  { name: 'minute', min: 0, max: 59 },
  { name: 'hour', min: 0, max: 23 },
  { name: 'day-of-month', min: 1, max: 31 },
  { name: 'month', min: 1, max: 12, names: MONTH_NAMES, nameOffset: 1 },
  // 7 is accepted as a second spelling of Sunday and normalized to 0.
  { name: 'day-of-week', min: 0, max: 7, names: DOW_NAMES, nameOffset: 0 },
];

/** Parse a cron expression into per-field match sets. Throws {@link CronParseError}. */
export function parseCron(expression: string): CronFields {
  const normalized = expression.trim().toLowerCase();
  if (!normalized) throw new CronParseError('cron 表达式不能为空');
  const expanded = ALIASES[normalized] ?? normalized;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) {
    throw new CronParseError(
      `cron 表达式需要 5 个字段（分 时 日 月 周），收到 ${parts.length} 个：${expression}`,
    );
  }

  const sets = parts.map((part, index) => parseField(part, SPECS[index]!));
  const dow = new Set([...sets[4]!].map((value) => (value === 7 ? 0 : value)));
  return {
    minute: sets[0]!,
    hour: sets[1]!,
    dom: sets[2]!,
    month: sets[3]!,
    dow,
    domRestricted: parts[2] !== '*',
    dowRestricted: parts[4] !== '*',
  };
}

function parseField(raw: string, spec: FieldSpec): Set<number> {
  const out = new Set<number>();
  for (const segment of raw.split(',')) {
    if (!segment) throw new CronParseError(`${spec.name} 字段有空的取值：${raw}`);
    const [rangePart, stepPart, ...rest] = segment.split('/');
    if (rest.length > 0) throw new CronParseError(`${spec.name} 字段步长写法不合法：${segment}`);
    const step = stepPart === undefined ? 1 : Number(stepPart);
    if (!Number.isInteger(step) || step <= 0) {
      throw new CronParseError(`${spec.name} 字段步长必须是正整数：${segment}`);
    }

    let from: number;
    let to: number;
    if (rangePart === '*' || rangePart === undefined) {
      from = spec.min;
      to = spec.max;
    } else if (rangePart.includes('-')) {
      const [a, b, ...extra] = rangePart.split('-');
      if (extra.length > 0) throw new CronParseError(`${spec.name} 字段区间不合法：${segment}`);
      from = parseValue(a!, spec);
      to = parseValue(b!, spec);
      if (from > to) throw new CronParseError(`${spec.name} 字段区间起点大于终点：${segment}`);
    } else {
      from = parseValue(rangePart, spec);
      // A bare value with a step means "from here to the end of the field",
      // matching the behaviour of every mainstream cron implementation.
      to = stepPart === undefined ? from : spec.max;
    }

    for (let value = from; value <= to; value += step) out.add(value);
  }
  if (out.size === 0) throw new CronParseError(`${spec.name} 字段没有匹配到任何取值：${raw}`);
  return out;
}

function parseValue(token: string, spec: FieldSpec): number {
  const trimmed = token.trim();
  if (!trimmed) throw new CronParseError(`${spec.name} 字段有空的取值`);
  const named = spec.names?.indexOf(trimmed);
  if (named !== undefined && named >= 0) return named + (spec.nameOffset ?? 0);
  const value = Number(trimmed);
  if (!Number.isInteger(value) || value < spec.min || value > spec.max) {
    throw new CronParseError(
      `${spec.name} 字段取值超出范围（${spec.min}-${spec.max}）：${token}`,
    );
  }
  return value;
}

/**
 * Hard cap on the day-by-day search. Five years is far past any expression a
 * human writes on purpose, and it keeps a pathological one (`0 0 30 2 *` —
 * February 30th) from spinning forever.
 */
const MAX_SEARCH_DAYS = 366 * 5;

/**
 * First firing time strictly after `from`, or `undefined` when the expression
 * can never match (e.g. February 30th).
 *
 * Walks calendar fields rather than minutes so a yearly expression costs a few
 * thousand iterations instead of half a million.
 */
export function nextCronTime(fields: CronFields, from: Date): Date | undefined {
  const cursor = new Date(from.getTime());
  cursor.setSeconds(0, 0);
  cursor.setMinutes(cursor.getMinutes() + 1);

  for (let day = 0; day <= MAX_SEARCH_DAYS; ) {
    if (!fields.month.has(cursor.getMonth() + 1)) {
      cursor.setMonth(cursor.getMonth() + 1, 1);
      cursor.setHours(0, 0, 0, 0);
      day++;
      continue;
    }
    if (!dayMatches(fields, cursor)) {
      cursor.setDate(cursor.getDate() + 1);
      cursor.setHours(0, 0, 0, 0);
      day++;
      continue;
    }
    if (!fields.hour.has(cursor.getHours())) {
      cursor.setHours(cursor.getHours() + 1, 0, 0, 0);
      // Rolling past midnight lands on a new day; the loop re-checks it.
      continue;
    }
    if (!fields.minute.has(cursor.getMinutes())) {
      cursor.setMinutes(cursor.getMinutes() + 1, 0, 0);
      continue;
    }
    return cursor;
  }
  return undefined;
}

function dayMatches(fields: CronFields, date: Date): boolean {
  const domHit = fields.dom.has(date.getDate());
  const dowHit = fields.dow.has(date.getDay());
  if (fields.domRestricted && fields.dowRestricted) return domHit || dowHit;
  if (fields.domRestricted) return domHit;
  if (fields.dowRestricted) return dowHit;
  return true;
}

/** Parse and compute in one step; returns `undefined` for an unsatisfiable expression. */
export function nextCronTimeFor(expression: string, from: Date = new Date()): Date | undefined {
  return nextCronTime(parseCron(expression), from);
}

/**
 * Human-readable gloss for the common shapes, falling back to the raw
 * expression. Used in `/cron list` so a card doesn't force the reader to parse
 * cron syntax in their head.
 */
export function describeCron(expression: string): string {
  const normalized = expression.trim().toLowerCase();
  const expanded = ALIASES[normalized] ?? normalized;
  const parts = expanded.split(/\s+/);
  if (parts.length !== 5) return expression;
  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string];
  const isNumber = (value: string): boolean => /^\d+$/.test(value);
  const time = isNumber(minute) && isNumber(hour)
    ? `${hour.padStart(2, '0')}:${minute.padStart(2, '0')}`
    : undefined;

  if (time && dom === '*' && month === '*' && dow === '*') return `每天 ${time}`;
  if (time && dom === '*' && month === '*' && dow === '1-5') return `工作日 ${time}`;
  if (time && dom === '*' && month === '*' && isNumber(dow)) {
    const names = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
    return `每${names[Number(dow) % 7]} ${time}`;
  }
  if (time && month === '*' && dow === '*' && isNumber(dom)) return `每月 ${dom} 日 ${time}`;
  if (minute === '0' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return '每小时整点';
  }
  if (/^\*\/\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return `每 ${minute.slice(2)} 分钟`;
  }
  return expression;
}
