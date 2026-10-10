import type { ChatMessage, ChatResult, ModelProvider, Priority, TokenProbability } from "../models/provider.ts";
import type { DataTier, JudgmentEntry } from "../store/store.ts";

/** One fact per key, so a question never leans on a lumped description (the same discipline the project's other decision tooling uses). */
export type Facts = Record<string, string | number | boolean>;

export interface JudgeContext {
  tier: DataTier;
  priority: Priority;
  /** The family of question (same_story, pipe_ask), recorded on the judgment so each family's rows can be exported and trained as its own model. */
  lane?: string;
}

export interface YesNoQuestion {
  question: string;
  facts: Facts;
}

export interface YesNoVerdict {
  answer: boolean;
  /** P(yes), from the model's first-token probabilities when it reports them; 1 or 0 otherwise. */
  probability: number;
  /** False when the probability is only the parsed answer, not a measured one. */
  calibrated: boolean;
  model: string;
  /** How far the direct and the inverse phrasing of the question disagreed, 0 to 1, when the judge asks both. A high value means the answer leans on wording. */
  disagreement?: number;
}

export interface Option {
  id: string;
  facts: Facts;
}

export interface PickQuestion {
  question: string;
  options: Option[];
}

export interface PickVerdict {
  id: string;
  probabilities: Record<string, number>;
  calibrated: boolean;
  model: string;
}

export interface RankVerdict {
  /** Ids, best first. */
  order: string[];
  model: string;
}

/** The three kinds of decision Juhandu asks for (the same shapes Jev answers). An implementation may be an LLM, a trained local classifier or a hosted service. */
export interface Judge {
  yesNo(question: YesNoQuestion, context: JudgeContext): Promise<YesNoVerdict>;
  pickOne(question: PickQuestion, context: JudgeContext): Promise<PickVerdict>;
  rank(question: PickQuestion, context: JudgeContext): Promise<RankVerdict>;
}

export class JudgeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JudgeError";
  }
}

export interface LlmJudgeOptions {
  provider: ModelProvider;
  /** Receives every judgment so it can be stored as a labelled example. */
  onJudgment?: (entry: JudgmentEntry) => void;
}

function renderFacts(facts: Facts): string {
  return Object.entries(facts)
    .map(([key, value]) => `- ${key}: ${value}`)
    .join("\n");
}

function letter(index: number): string {
  return String.fromCharCode(65 + index);
}

/** Collapses the first-token candidates into probability mass per class; a token such as " Yes" or "YES" counts as "yes". */
export function classMass(tokens: TokenProbability[] | undefined, classes: Record<string, string[]>): Record<string, number> | null {
  if (!tokens?.length) return null;
  const mass: Record<string, number> = Object.fromEntries(Object.keys(classes).map((k) => [k, 0]));
  let total = 0;
  for (const t of tokens) {
    const word = t.token.trim().toLowerCase().replace(/[^a-z]/g, "");
    for (const [name, words] of Object.entries(classes)) {
      if (words.includes(word)) {
        const p = Math.exp(t.logprob);
        mass[name] = (mass[name] ?? 0) + p;
        total += p;
        break;
      }
    }
  }
  if (total < 0.5) return null;
  return Object.fromEntries(Object.entries(mass).map(([k, v]) => [k, v / total]));
}

const SYSTEM = "You are a careful judge. Use only the facts given. Reply with exactly one word and nothing else.";

export class LlmJudge implements Judge {
  private readonly provider: ModelProvider;
  private readonly onJudgment: ((entry: JudgmentEntry) => void) | undefined;

  constructor(options: LlmJudgeOptions) {
    this.provider = options.provider;
    this.onJudgment = options.onJudgment;
  }

  private async ask(messages: ChatMessage[], context: JudgeContext, extra: { json?: { name: string; schema: Record<string, unknown> }; logprobs?: number; maxTokens: number }): Promise<ChatResult> {
    return this.provider.chat({
      job: "judge",
      tier: context.tier,
      priority: context.priority,
      messages,
      temperature: 0,
      thinking: false,
      maxTokens: extra.maxTokens,
      ...(extra.json ? { json: extra.json } : {}),
      ...(extra.logprobs ? { firstTokenLogprobs: extra.logprobs } : {}),
    });
  }

  private record(kind: string, question: string, input: unknown, output: unknown, result: ChatResult, context: JudgeContext): void {
    this.onJudgment?.({ kind, question, input, output, model: result.model, provider: this.provider.name, priority: context.priority, tier: context.tier, ...(context.lane ? { lane: context.lane } : {}) });
  }

  async yesNo(q: YesNoQuestion, context: JudgeContext): Promise<YesNoVerdict> {
    const result = await this.ask(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${q.question}\n\nFacts:\n${renderFacts(q.facts)}\n\nAnswer yes or no.` },
      ],
      context,
      { logprobs: 8, maxTokens: 3 },
    );
    const mass = classMass(result.firstToken, { yes: ["yes", "y"], no: ["no", "n"] });
    let verdict: YesNoVerdict;
    if (mass) {
      const probability = mass["yes"] ?? 0;
      verdict = { answer: probability >= 0.5, probability, calibrated: true, model: result.model };
    } else {
      const word = result.text.trim().toLowerCase().replace(/[^a-z]/g, "");
      if (word !== "yes" && word !== "no" && word !== "y" && word !== "n") throw new JudgeError(`The judge did not answer yes or no: ${result.text.slice(0, 40)}`);
      const answer = word.startsWith("y");
      verdict = { answer, probability: answer ? 1 : 0, calibrated: false, model: result.model };
    }
    this.record("yes_no", q.question, q.facts, verdict, result, context);
    return verdict;
  }

  async pickOne(q: PickQuestion, context: JudgeContext): Promise<PickVerdict> {
    if (q.options.length < 2 || q.options.length > 26) throw new JudgeError("pickOne needs between 2 and 26 options");
    const listing = q.options.map((o, i) => `${letter(i)}.\n${renderFacts(o.facts)}`).join("\n\n");
    const result = await this.ask(
      [
        { role: "system", content: SYSTEM },
        { role: "user", content: `${q.question}\n\nOptions:\n${listing}\n\nAnswer with the letter of the best option.` },
      ],
      context,
      { logprobs: 20, maxTokens: 3 },
    );
    const classes = Object.fromEntries(q.options.map((_, i) => [String(i), [letter(i).toLowerCase()]]));
    const mass = classMass(result.firstToken, classes);
    let probabilities: Record<string, number>;
    let calibrated = true;
    if (mass) {
      probabilities = Object.fromEntries(q.options.map((o, i) => [o.id, mass[String(i)] ?? 0]));
    } else {
      const word = result.text.trim().toLowerCase().replace(/[^a-z]/g, "");
      const index = word.length === 1 ? word.charCodeAt(0) - 97 : -1;
      if (index < 0 || index >= q.options.length) throw new JudgeError(`The judge did not pick an option: ${result.text.slice(0, 40)}`);
      probabilities = Object.fromEntries(q.options.map((o, i) => [o.id, i === index ? 1 : 0]));
      calibrated = false;
    }
    const best = Object.entries(probabilities).sort((a, b) => b[1] - a[1])[0] as [string, number];
    const verdict: PickVerdict = { id: best[0], probabilities, calibrated, model: result.model };
    this.record("pick_one", q.question, q.options, verdict, result, context);
    return verdict;
  }

  async rank(q: PickQuestion, context: JudgeContext): Promise<RankVerdict> {
    if (q.options.length < 2) throw new JudgeError("rank needs at least 2 items");
    const ids = q.options.map((o) => o.id);
    const listing = q.options.map((o) => `id ${o.id}:\n${renderFacts(o.facts)}`).join("\n\n");
    const result = await this.ask(
      [
        { role: "system", content: "You are a careful judge. Use only the facts given. Reply with JSON only." },
        { role: "user", content: `${q.question}\n\nItems:\n${listing}\n\nReturn every id exactly once in "order", best first.` },
      ],
      context,
      { json: { name: "ranking", schema: { type: "object", properties: { order: { type: "array", items: { type: "string", enum: ids } } }, required: ["order"], additionalProperties: false } }, maxTokens: 20 + ids.length * 12 },
    );
    let parsed: unknown;
    try {
      parsed = JSON.parse(result.text);
    } catch {
      throw new JudgeError("The judge did not return JSON");
    }
    const order = (parsed as { order?: unknown }).order;
    if (!Array.isArray(order) || order.length !== ids.length || new Set(order).size !== ids.length || !order.every((id) => ids.includes(String(id)))) throw new JudgeError("The judge returned an invalid order");
    const verdict: RankVerdict = { order: order.map(String), model: result.model };
    this.record("rank", q.question, q.options, verdict, result, context);
    return verdict;
  }
}
