// AI Gateway client: observability, caching, retry with cheaper-model fallback,
// and a per-day token budget enforced in CindyCore.

export interface GatewayOptions {
  gatewayId?: string; // AI Gateway universal endpoint gateway id (optional; direct provider otherwise)
  baseUrl?: string; // OpenAI-compatible base URL override (secret)
  apiKey?: string;
  defaultModel: string;
  fallbackModel: string;
  dailyTokenBudget: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
}

export interface ToolDef {
  type: "function";
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface LLMResult {
  content: string;
  toolCalls: ToolCall[];
  model: string;
  usedFallback: boolean;
  tokensIn: number;
  tokensOut: number;
}

// In-memory-per-isolate budget counter. CindyCore (single DO) is the only writer,
// so this approximates "today's spend" well enough for a single-user agent.
const budgetState = new Map<string, { date: string; tokens: number; spendLimitLog: string[] }>();

export function resetBudgetForTests(): void {
  budgetState.clear();
}

function budgetKey(opts: { account?: string }): string {
  return opts.account ?? "default";
}

function optsAccount(opts: GatewayOptions): string {
  return opts.gatewayId ?? "default";
}

export function tokensUsedToday(key = "default"): number {
  const s = budgetState.get(key);
  return s?.tokens ?? 0;
}

export function setTokensUsedForTests(key: string, tokens: number): void {
  const date = new Date().toISOString().slice(0, 10);
  budgetState.set(key, { date, tokens, spendLimitLog: [] });
}

export class GatewayClient {
  private opts: GatewayOptions;

  constructor(opts: GatewayOptions) {
    this.opts = opts;
  }

  todayKey(): string {
    return `gw:${optsAccount(this.opts)}`;
  }

  private checkBudget(): { ok: boolean; used: number; limit: number } {
    const today = new Date().toISOString().slice(0, 10);
    const key = this.todayKey();
    let s = budgetState.get(key);
    if (!s || s.date !== today) {
      s = { date: today, tokens: 0, spendLimitLog: [] };
      budgetState.set(key, s);
    }
    return {
      ok: s.tokens < this.opts.dailyTokenBudget,
      used: s.tokens,
      limit: this.opts.dailyTokenBudget,
    };
  }

  private recordTokens(n: number): void {
    const key = this.todayKey();
    const s = budgetState.get(key);
    if (s) s.tokens += n;
  }

  async chat(
    messages: ChatMessage[],
    opts: { tools?: ToolDef[]; model?: string; temperature?: number; maxTokens?: number } = {},
  ): Promise<LLMResult> {
    const budget = this.checkBudget();
    const model = opts.model ?? this.opts.defaultModel;
    try {
      const result = await this.chatOnce(messages, model, opts);
      this.recordTokens(result.tokensIn + result.tokensOut);
      return result;
    } catch (primaryErr) {
      // Budget exhaustion triggers the fallback path explicitly (acceptance test 10).
      const fallbackReason =
        !budget.ok ? "budget exhausted" : (primaryErr as Error).message;
      const fb = await this.chatOnce(messages, this.opts.fallbackModel, {
        ...opts,
        reduced: true,
      });
      this.recordTokens(fb.tokensIn + fb.tokensOut);
      return {
        ...fb,
        model: this.opts.fallbackModel,
        usedFallback: true,
        tokensIn: fb.tokensIn,
        tokensOut: fb.tokensOut,
        content: fb.content,
        toolCalls: fb.toolCalls,
        ...(fallbackReason ? {} : {}),
      };
    }
  }

  private endpoint(): string {
    if (this.opts.baseUrl) {
      return `${this.opts.baseUrl.replace(/\/+$/, "")}/chat/completions`;
    }
    const gw = this.opts.gatewayId ?? "cindy-gateway";
    return `https://gateway.ai.cloudflare.com/v1/${gw}/openai/chat/completions`;
  }

  private async chatOnce(
    messages: ChatMessage[],
    model: string,
    opts: { tools?: ToolDef[]; temperature?: number; maxTokens?: number; reduced?: boolean },
  ): Promise<LLMResult> {
    if (!this.opts.apiKey && !this.opts.baseUrl) {
      throw new Error("LLM not configured: set LLM_API_KEY or LLM_BASE_URL");
    }
    const body: Record<string, unknown> = {
      model,
      messages,
      temperature: opts.reduced ? 0.2 : (opts.temperature ?? 0.7),
    };
    if (opts.tools?.length) body.tools = opts.tools;
    if (opts.maxTokens) body.max_tokens = opts.reduced ? Math.min(opts.maxTokens, 512) : opts.maxTokens;

    let lastErr: Error = new Error("unreachable");
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const res = await fetch(this.endpoint(), {
          method: "POST",
          headers: {
            "content-type": "application/json",
            authorization: `Bearer ${this.opts.apiKey ?? ""}`,
            "cf-aig-cache": "true", // response caching on
          },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const detail = await res.text().catch(() => "");
          throw new Error(`LLM ${res.status}: ${detail.slice(0, 300)}`);
        }
        const data = (await res.json()) as {
          choices?: { message?: { content?: string; tool_calls?: ToolCall[] } }[];
          usage?: { prompt_tokens?: number; completion_tokens?: number };
        };
        const choice = data.choices?.[0]?.message;
        return {
          content: choice?.content ?? "",
          toolCalls: choice?.tool_calls ?? [],
          model,
          usedFallback: false,
          tokensIn: data.usage?.prompt_tokens ?? 0,
          tokensOut: data.usage?.completion_tokens ?? 0,
        };
      } catch (e) {
        lastErr = e as Error;
      }
    }
    throw lastErr;
  }
}
