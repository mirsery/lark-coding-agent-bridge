// Natural-language phrasing for the `/coffee` easter egg — "来一杯咖啡",
// "整杯咖啡", "给 @同事 发杯咖啡" — so the card isn't gated behind knowing the
// exact slash command. Deliberately narrow (verb + 杯咖啡) to avoid firing on
// unrelated chat that merely mentions coffee (e.g. "喝咖啡", "咖啡因").
const COFFEE_NL_INTENT_RE = /(给\S{0,12})?(发|来|整|要)(一)?杯咖啡/;

/** Mentions a group or chat by name, e.g. "在 AI-bot军团 群". */
const NAMES_A_CHAT_RE = /群/;

export interface CoffeeMention {
  openId?: string;
  name?: string;
  isBot?: boolean;
}

export interface CoffeeRecipient {
  openId: string;
  name?: string;
}

export interface CoffeeRequest {
  /** People @-mentioned in the request; the card @-mentions them back. */
  recipients: CoffeeRecipient[];
}

/**
 * Who a coffee request in this chat is for, or null when the easter egg
 * should stay out of it. A plain request gets a card; one that @-mentions
 * people gets a card that @-mentions them. Bots are never recipients — an @
 * from the card would wake them and start a bot-to-bot loop. A request naming
 * a group ("在 X 群给 @Y 发杯咖啡") is a cross-chat task for the agent.
 */
export function parseCoffeeRequest(
  text: string,
  mentions: readonly CoffeeMention[] | undefined,
  selfOpenId: string | undefined,
): CoffeeRequest | null {
  if (!COFFEE_NL_INTENT_RE.test(text) || NAMES_A_CHAT_RE.test(text)) return null;
  return { recipients: coffeeRecipients(mentions, selfOpenId) };
}

/** Human @-mentions other than this bot, deduplicated in mention order. */
export function coffeeRecipients(
  mentions: readonly CoffeeMention[] | undefined,
  selfOpenId: string | undefined,
): CoffeeRecipient[] {
  const seen = new Set<string>();
  const recipients: CoffeeRecipient[] = [];
  for (const m of mentions ?? []) {
    if (!m.openId || m.isBot || m.openId === selfOpenId || seen.has(m.openId)) continue;
    seen.add(m.openId);
    recipients.push({ openId: m.openId, ...(m.name ? { name: m.name } : {}) });
  }
  return recipients;
}

/**
 * How long a coffee request that didn't @ the bot waits for a bare "@bot"
 * follow-up from the same person.
 */
export const COFFEE_LEAD_IN_TTL_MS = 2 * 60_000;

/**
 * Coffee requests that skipped the bot, kept until the same person follows up.
 * In a group that only answers @-mentions, "给 @同事 来杯咖啡" and a separate
 * bare "@bot" arrive as two messages: the first is dropped for not mentioning
 * the bot, the second has no text, so neither matched and the bare @ went to
 * the agent. The request is remembered per scope and sender; any other
 * unmentioned message from that sender replaces or clears it, so a bare @ only
 * picks up a request that was the sender's latest word.
 */
export class CoffeeLeadIns {
  private readonly pending = new Map<string, { recipients: CoffeeRecipient[]; at: number }>();

  constructor(
    private readonly ttlMs: number = COFFEE_LEAD_IN_TTL_MS,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record (or clear) what an unmentioned message from this sender asked for. */
  note(key: string, request: CoffeeRequest | null): void {
    if (request) this.pending.set(key, { recipients: request.recipients, at: this.now() });
    else this.pending.delete(key);
  }

  /** The recipients of a still-fresh request, consumed so it fires once. */
  take(key: string): CoffeeRecipient[] | undefined {
    const entry = this.pending.get(key);
    this.pending.delete(key);
    if (!entry || this.now() - entry.at > this.ttlMs) return undefined;
    return entry.recipients;
  }
}

export const coffeeLeadIns = new CoffeeLeadIns();

export function coffeeLeadInKey(scope: string, senderId: string, selfOpenId: string | undefined): string {
  return `${selfOpenId ?? ''}|${scope}|${senderId}`;
}
