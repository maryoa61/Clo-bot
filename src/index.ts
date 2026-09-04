/**
 * Telegram Coding Bot — Cloudflare Worker
 *
 * ساپورت دو حالت:
 *  1) Cloudflare Workers AI (رایگان)
 *  2) هر API خارجی OpenAI-compatible (OpenRouter, Groq, Together, vLLM, ...)
 */

interface Env {
  TELEGRAM_BOT_TOKEN: string;

  // Cloudflare Workers AI
  CF_ACCOUNT_ID?: string;
  CF_API_TOKEN?: string;
  AI?: Ai;
  CF_DEFAULT_MODEL: string;
  CF_CODE_MODEL: string;
  CF_THINKING_MODEL: string;

  // Custom API
  AI_PROVIDER: string; // "cloudflare" | "custom"
  CUSTOM_API_BASE?: string;   // secret
  CUSTOM_API_KEY?: string;    // secret
  CUSTOM_MODEL?: string;      // secret or var
  CUSTOM_THINKING_MODEL?: string; // secret or var

  // Storage
  MAX_HISTORY: string;
  CHAT_HISTORY: KVNamespace;
}

interface TelegramMessage {
  message_id: number;
  from?: { id: number; first_name: string; is_bot: boolean };
  chat: { id: number; type: string };
  text?: string;
}

interface TelegramUpdate {
  update_id: number;
  message?: TelegramMessage;
}

interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

// ─── تشخیص نوع درخواست ───

const THINKING_PATTERNS =
  /\b(explain.*why|how does.*work|algorithm|complexity|trade-?off|compare.*difference|architecture|design pattern|eli5|چرا|چطور.*کار|الگوریتم|مقایسه|توضیح بده|معماری|پترن)\b/i;

const CODE_PATTERNS =
  /\b(code|write|implement|function|class|method|script|program|bug|error|fix|debug|compile|runtime|exception|stack.?trace|traceback|api|endpoint|database|query|sql|regex|css|html|json|yaml|dockerfile|git|کد|بنویس|پیاده‌سازی|تابع|کلاس|اسکریپت|باگ|خطا|دیباگ|اصلاح|درست کن|بساز)\b/i;

const CLEAR_PATTERNS =
  /^(clear|reset|start over|new chat|forget|پاک کن|از اول|شروع مجدد|فراموش کن|مکالمه جدید)$/i;

type Intent = "clear" | "thinking" | "code" | "chat";

function detectIntent(text: string): Intent {
  const t = text.trim();
  if (CLEAR_PATTERNS.test(t)) return "clear";
  if (t.includes("```") || (t.split("\n").length > 5 && /[{}\[\]();=]/.test(t))) return "code";
  if (CODE_PATTERNS.test(t)) return "code";
  if (THINKING_PATTERNS.test(t)) return "thinking";
  return "chat";
}

// ─── System Prompt ───

const SYSTEM_PROMPT = `You are an expert coding assistant in Telegram.

Capabilities:
- Write clean, well-commented code in any language
- Debug errors — explain WHY, not just the fix
- Review code for best practices, security, performance
- Explain concepts, algorithms, architecture
- Help with system design

Rules:
- Wrap code in fenced blocks with language tag (\`\`\`python etc.)
- Be concise — no filler like "Great question!"
- Respond in the user's language (Persian → Persian, English → English)
- Keep under 3500 chars for Telegram
- Error/stack trace? Analyze directly, don't ask what they were doing`;

// ─── Telegram helpers ───

async function tgApi(token: string, method: string, body?: unknown) {
  return fetch(`https://api.telegram.org/bot${token}/${method}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: body ? JSON.stringify(body) : undefined,
  }).then((r) => r.json());
}

async function sendMsg(token: string, chatId: number, text: string, replyTo?: number) {
  for (const chunk of splitMsg(text, 4000)) {
    await tgApi(token, "sendMessage", {
      chat_id: chatId,
      text: chunk,
      parse_mode: "Markdown",
      reply_to_message_id: replyTo,
    });
  }
}

function splitMsg(text: string, max: number): string[] {
  if (text.length <= max) return [text];
  const parts: string[] = [];
  let rest = text;
  while (rest.length > 0) {
    if (rest.length <= max) { parts.push(rest); break; }
    let i = rest.lastIndexOf("\n", max);
    if (i < max * 0.3) i = max;
    parts.push(rest.slice(0, i));
    rest = rest.slice(i);
  }
  return parts;
}

// ─── Chat History (KV) ───

async function getHistory(kv: KVNamespace, chatId: number, max: number): Promise<ChatMessage[]> {
  const raw = await kv.get(`chat:${chatId}`);
  if (!raw) return [];
  try { return JSON.parse(raw).slice(-max); } catch { return []; }
}

async function saveHistory(kv: KVNamespace, chatId: number, msgs: ChatMessage[], max: number) {
  await kv.put(`chat:${chatId}`, JSON.stringify(msgs.slice(-max)), { expirationTtl: 604800 });
}

// ══════════════════════════════════════════════════════════════
//  انتخاب مدل بر اساس intent و پروایدر
// ══════════════════════════════════════════════════════════════

interface ModelConfig {
  provider: "cloudflare" | "custom";
  model: string;
  baseUrl?: string;
  apiKey?: string;
}

function resolveModel(intent: Intent, env: Env): ModelConfig {
  const hasCustomKey = !!(env.CUSTOM_API_KEY && env.CUSTOM_API_KEY.trim());
  const isCustom = env.AI_PROVIDER === "custom" || hasCustomKey;

  if (isCustom && hasCustomKey) {
    const base = (env.CUSTOM_API_BASE && env.CUSTOM_API_BASE.trim()) || "https://api.openai.com/v1";
    const key = env.CUSTOM_API_KEY!.trim();
    const thinking = env.CUSTOM_THINKING_MODEL || env.CUSTOM_MODEL || "gpt-4o-mini";
    const defaultM = env.CUSTOM_MODEL || "gpt-4o-mini";

    const model = intent === "thinking" ? thinking : defaultM;
    return { provider: "custom", model, baseUrl: base, apiKey: key };
  }

  const model = intent === "thinking"
    ? env.CF_THINKING_MODEL
    : intent === "code"
      ? env.CF_CODE_MODEL
      : env.CF_DEFAULT_MODEL;

  return { provider: "cloudflare", model };
}

// ══════════════════════════════════════════════════════════════
//  فراخوانی AI — Cloudflare یا Custom
// ══════════════════════════════════════════════════════════════

async function callAI(config: ModelConfig, env: Env, messages: ChatMessage[]): Promise<string> {
  // ── حالت Cloudflare Workers AI ──
  if (config.provider === "cloudflare") {
    if (env.AI) {
      try {
        const r: any = await env.AI.run(config.model as any, {
          messages,
          max_tokens: 4096,
          temperature: 0.3,
        });
        return r?.response ?? String(r);
      } catch { /* fallback to REST */ }
    }

    const resp = await fetch(
      `https://api.cloudflare.com/client/v4/accounts/${env.CF_ACCOUNT_ID}/ai/run/${config.model}`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${env.CF_API_TOKEN}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ messages, max_tokens: 4096, temperature: 0.3 }),
      }
    );
    if (!resp.ok) throw new Error(`CF AI ${resp.status}: ${await resp.text()}`);
    const d: any = await resp.json();
    return d.result?.response ?? d.result?.choices?.[0]?.message?.content ?? JSON.stringify(d.result);
  }

  // ── حالت Custom (OpenAI-compatible) ──
  if (!config.apiKey) throw new Error("CUSTOM_API_KEY not set");

  const url = `${config.baseUrl}/chat/completions`;
  const resp = await fetch(url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: config.model,
      messages,
      max_tokens: 4096,
      temperature: 0.3,
    }),
  });

  if (!resp.ok) throw new Error(`Custom API ${resp.status}: ${await resp.text()}`);
  const d: any = await resp.json();

  const content = d.choices?.[0]?.message?.content;
  if (content) return content;
  if (d.result?.response) return d.result.response;

  throw new Error("Unexpected response format from custom API");
}

// ─── فالبک ───

async function callWithFallback(
  config: ModelConfig,
  env: Env,
  messages: ChatMessage[]
): Promise<string> {
  try {
    return await callAI(config, env, messages);
  } catch (primaryErr: any) {
    console.error("Primary model failed:", primaryErr.message);

    if (config.provider === "custom") throw primaryErr;

    try {
      const fallback = { ...config, model: env.CF_DEFAULT_MODEL };
      const reply = await callAI(fallback, env, messages);
      return `⚠️ مدل اصلی در دسترس نبود.\n\n${reply}`;
    } catch (fallbackErr: any) {
      throw fallbackErr;
    }
  }
}

// ─── پیام خوش‌آمد ───

const WELCOME =
  `سلام! 👋 من دستیار کدنویسی‌ات هستم.\n\n` +
  `فقط کافیه سوالت رو بنویسی:\n\n` +
  `💻 \`یه تابع پایتون بنویس برای فاکتوریل\`\n` +
  `🐛 \`این خطا چیه؟ TypeError: ...\`\n` +
  `📖 \`الگوریتم BFS رو توضیح بده\`\n` +
  `🏗️ \`یه REST API با Express طراحی کن\`\n\n` +
  `هر زبونی بنویسی جواب می‌دم — فارسی یا انگلیسی 🚀`;

// ══════════════════════════════════════════════════════════════
//  Main Worker
// ══════════════════════════════════════════════════════════════

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // Health
    if (request.method === "GET" && url.pathname === "/") {
      const provider = env.AI_PROVIDER === "custom" ? "Custom API" : "Cloudflare Workers AI";
      return new Response(`🤖 Coding bot running (${provider})`);
    }

    // Setup webhook
    if (request.method === "GET" && url.pathname === "/setup") {
      const hook = `${url.origin}/webhook/${env.TELEGRAM_BOT_TOKEN}`;
      const r = await tgApi(env.TELEGRAM_BOT_TOKEN, "setWebhook", {
        url: hook,
        allowed_updates: ["message"],
        drop_pending_updates: true,
      });
      return Response.json({ webhook: hook, result: r });
    }

    // Telegram webhook
    if (request.method !== "POST" || url.pathname !== `/webhook/${env.TELEGRAM_BOT_TOKEN}`)
      return new Response("Not Found", { status: 404 });

    try {
      const update: TelegramUpdate = await request.json();
      const msg = update.message;
      if (!msg?.text || !msg.from) return new Response("OK");

      const chatId = msg.chat.id;
      const text = msg.text.trim();
      const token = env.TELEGRAM_BOT_TOKEN;
      const maxH = parseInt(env.MAX_HISTORY) || 20;

      const intent = detectIntent(text);

      if (intent === "clear") {
        await env.CHAT_HISTORY.delete(`chat:${chatId}`);
        await sendMsg(token, chatId, "✅ مکالمه پاک شد. هر وقت خواستی شروع کن!");
        return new Response("OK");
      }

      if (/^(\/start|\/help|سلام|hi|hello|hey)\b/i.test(text)) {
        await sendMsg(token, chatId, WELCOME, msg.message_id);
        return new Response("OK");
      }

      await tgApi(token, "sendChatAction", { chat_id: chatId, action: "typing" });

      const config = resolveModel(intent, env);

      const history = await getHistory(env.CHAT_HISTORY, chatId, maxH);
      const messages: ChatMessage[] = [
        { role: "system", content: SYSTEM_PROMPT },
        ...history,
        { role: "user", content: text },
      ];

      let reply: string;
      try {
        reply = await callWithFallback(config, env, messages);
      } catch (e: any) {
        await sendMsg(token, chatId, `❌ خطا:\n\`${e.message}\``, msg.message_id);
        return new Response("OK");
      }

      const updated = [
        ...history,
        { role: "user" as const, content: text },
        { role: "assistant" as const, content: reply },
      ];
      await saveHistory(env.CHAT_HISTORY, chatId, updated, maxH);

      await sendMsg(token, chatId, reply, msg.message_id);

      return new Response("OK");
    } catch (err: any) {
      console.error("Webhook error:", err);
      return new Response("Error", { status: 500 });
    }
  },
};
