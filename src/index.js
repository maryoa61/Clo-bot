/**
 * دستیار کدنویسی تلگرام روی Cloudflare Workers
 * ----------------------------------------------
 * - از Cloudflare Workers AI (env.AI) برای فهم/ویرایش کد و خواندن عکس/اسکرین‌شات استفاده می‌کند
 * - از Brave Search API برای جستجوی خام در اینترنت استفاده می‌کند (بدون خلاصه‌سازی هوشمند)
 * - تاریخچه مکالمه هر کاربر در Cloudflare KV نگه‌داری می‌شود
 *
 * قبل از دیپلوی، اسم دقیق مدل‌های Workers AI را از این آدرس چک کن:
 * https://developers.cloudflare.com/workers-ai/models/
 */

// ------------------- تنظیمات مدل‌ها (در صورت نیاز، طبق مستندات رسمی به‌روزرسانی کن) -------------------
const TEXT_MODEL = "@cf/meta/llama-3.1-8b-instruct";
const VISION_MODEL = "@cf/llava-hf/llava-1.5-7b-hf";

const SYSTEM_PROMPT = `تو یک دستیار حرفه‌ای کدنویسی هستی که در تلگرام به کاربران کمک می‌کنی.
- کدها را واضح، با کامنت مناسب و بدون اشتباه بنویس.
- وقتی کاربر کد می‌فرستد و می‌خواهد ویرایش شود، فقط تغییرات لازم را با توضیح مختصر انجام بده.
- پاسخ‌ها را کوتاه و کاربردی نگه دار، مگر کاربر توضیح مفصل بخواهد.
- اگر مطمئن نیستی، صادقانه بگو مطمئن نیستی.
- در تلگرام از فرمت Markdown برای کد استفاده کن (سه بک‌تیک).`;

const MAX_HISTORY_MESSAGES = 12; // تعداد پیام‌های اخیر که برای حفظ context نگه داشته می‌شود

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // مسیر سلامت/تست ساده
    if (request.method === "GET" && url.pathname === "/") {
      return new Response("Telegram Code Assistant Worker is running.", { status: 200 });
    }

    // مسیر کمکی برای ثبت خودکار وب‌هوک تلگرام (فقط برای راه‌اندازی اولیه، یک‌بار صدا بزن)
    if (request.method === "GET" && url.pathname === "/setup-webhook") {
      return handleSetupWebhook(url, env);
    }

    // مسیر اصلی وب‌هوک تلگرام
    if (request.method === "POST" && url.pathname === "/webhook") {
      return handleTelegramWebhook(request, env, ctx);
    }

    return new Response("Not found", { status: 404 });
  },
};

// ===================== راه‌اندازی اولیه وب‌هوک =====================
async function handleSetupWebhook(url, env) {
  const workerUrl = `${url.protocol}//${url.host}/webhook`;
  const tgUrl = `https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/setWebhook`;

  const res = await fetch(tgUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      url: workerUrl,
      secret_token: env.TELEGRAM_WEBHOOK_SECRET,
      allowed_updates: ["message"],
    }),
  });
  const data = await res.json();
  return new Response(JSON.stringify(data, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8" },
  });
}

// ===================== پردازش اصلی وب‌هوک =====================
async function handleTelegramWebhook(request, env, ctx) {
  // اعتبارسنجی امنیتی: مطمئن شو درخواست واقعاً از تلگرام است
  const secretHeader = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
  if (secretHeader !== env.TELEGRAM_WEBHOOK_SECRET) {
    return new Response("Unauthorized", { status: 401 });
  }

  let update;
  try {
    update = await request.json();
  } catch {
    return new Response("Bad Request", { status: 400 });
  }

  const message = update.message;
  if (!message) {
    return new Response("OK"); // نوع آپدیت‌های دیگر (edited_message و...) را نادیده می‌گیریم
  }

  const chatId = message.chat.id;

  // پردازش را در پس‌زمینه انجام بده تا تلگرام سریع جواب 200 بگیرد (جلوگیری از timeout/retry)
  ctx.waitUntil(routeMessage(message, chatId, env));

  return new Response("OK");
}

// ===================== مسیریابی بر اساس نوع پیام =====================
async function routeMessage(message, chatId, env) {
  try {
    await sendChatAction(chatId, "typing", env);

    // ۱. دستورات (Commands)
    if (message.text && message.text.startsWith("/")) {
      return await handleCommand(message, chatId, env);
    }

    // ۲. عکس یا اسکرین‌شات
    if (message.photo && message.photo.length > 0) {
      return await handlePhoto(message, chatId, env);
    }

    // ۳. فایل/سند (مثلاً یک فایل کد .js/.py و ...)
    if (message.document) {
      return await handleDocument(message, chatId, env);
    }

    // ۴. پیام متنی معمولی → دستیار کدنویسی
    if (message.text) {
      return await handleTextMessage(message.text, chatId, env);
    }

    await sendMessage(chatId, "این نوع پیام را هنوز پشتیبانی نمی‌کنم 🙏", env);
  } catch (err) {
    console.error("routeMessage error:", err);
    await sendMessage(chatId, "⚠️ یه خطای داخلی پیش اومد. لطفاً دوباره امتحان کن.", env);
  }
}

// ===================== دستورات =====================
async function handleCommand(message, chatId, env) {
  const [cmd, ...rest] = message.text.trim().split(/\s+/);
  const argText = rest.join(" ");

  switch (cmd.toLowerCase()) {
    case "/start":
      await sendMessage(
        chatId,
        "سلام! 👋 من دستیار کدنویسی تو هستم.\n\n" +
          "• یه پیام متنی بفرست تا کمکت کنم (توضیح بده، سوال بپرس، یا کد بفرست تا ویرایشش کنم)\n" +
          "• یه عکس یا اسکرین‌شات از کد/خطا بفرست تا بخونمش\n" +
          "• یه فایل کد بفرست تا بررسیش کنم\n" +
          "• دستور /search <عبارت> برای جستجو در اینترنت\n" +
          "• دستور /clear برای پاک کردن حافظه مکالمه",
        env
      );
      break;

    case "/help":
      await sendMessage(
        chatId,
        "راهنما:\n" +
          "/search <عبارت> — جستجوی خام در اینترنت (بدون خلاصه‌سازی AI)\n" +
          "/clear — پاک کردن تاریخچه مکالمه فعلی\n" +
          "هر پیام دیگه‌ای به‌عنوان سوال/درخواست کدنویسی پردازش می‌شه.",
        env
      );
      break;

    case "/clear":
      await clearHistory(chatId, env);
      await sendMessage(chatId, "🧹 تاریخچه مکالمه پاک شد.", env);
      break;

    case "/search":
      if (!argText) {
        await sendMessage(chatId, "لطفاً بعد از /search عبارت جستجو رو بنویس.\nمثال: /search Cloudflare Workers AI", env);
        break;
      }
      await handleSearch(argText, chatId, env);
      break;

    default:
      await sendMessage(chatId, "دستور ناشناخته. برای راهنما /help رو بفرست.", env);
  }
}

// ===================== جستجوی اینترنت (بدون AI) =====================
async function handleSearch(query, chatId, env) {
  if (!env.BRAVE_SEARCH_API_KEY) {
    await sendMessage(chatId, "⚠️ کلید API سرچ تنظیم نشده. با دستور `wrangler secret put BRAVE_SEARCH_API_KEY` اضافه‌اش کن.", env);
    return;
  }

  try {
    const res = await fetch(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=5`,
      {
        headers: {
          Accept: "application/json",
          "X-Subscription-Token": env.BRAVE_SEARCH_API_KEY,
        },
      }
    );

    if (!res.ok) {
      await sendMessage(chatId, "❌ خطا در دریافت نتایج جستجو.", env);
      return;
    }

    const data = await res.json();
    const results = data?.web?.results || [];

    if (results.length === 0) {
      await sendMessage(chatId, "نتیجه‌ای پیدا نشد.", env);
      return;
    }

    let text = `🔎 نتایج جستجو برای «${query}»:\n\n`;
    results.slice(0, 5).forEach((r, i) => {
      const title = stripHtml(r.title || "بدون عنوان");
      const desc = stripHtml(r.description || "");
      text += `${i + 1}. *${title}*\n${desc}\n${r.url}\n\n`;
    });

    await sendMessage(chatId, text, env, "Markdown");
  } catch (err) {
    console.error("search error:", err);
    await sendMessage(chatId, "❌ خطا در جستجو.", env);
  }
}

function stripHtml(str) {
  return str.replace(/<[^>]*>/g, "");
}

// ===================== پردازش عکس/اسکرین‌شات (Vision) =====================
async function handlePhoto(message, chatId, env) {
  const photo = message.photo[message.photo.length - 1]; // بزرگ‌ترین سایز
  const fileUrl = await getTelegramFileUrl(photo.file_id, env);

  if (!fileUrl) {
    await sendMessage(chatId, "❌ نتونستم عکس رو دریافت کنم.", env);
    return;
  }

  const imgRes = await fetch(fileUrl);
  const imgBuffer = await imgRes.arrayBuffer();
  const imgArray = [...new Uint8Array(imgBuffer)];

  const userCaption = message.caption || "این تصویر (که ممکن است کد یا خطای برنامه‌نویسی باشد) را دقیق بخوان و توضیح بده.";

  try {
    const aiResponse = await env.AI.run(VISION_MODEL, {
      image: imgArray,
      prompt: userCaption,
      max_tokens: 1024,
    });

    const resultText = aiResponse?.description || aiResponse?.response || "نتونستم چیزی از تصویر استخراج کنم.";
    await appendHistory(chatId, "user", "[کاربر یک تصویر فرستاد] " + userCaption, env);
    await appendHistory(chatId, "assistant", resultText, env);

    await sendMessage(chatId, resultText, env);
  } catch (err) {
    console.error("vision error:", err);
    await sendMessage(chatId, "❌ خطا در پردازش تصویر با مدل Vision.", env);
  }
}

// ===================== پردازش فایل/سند =====================
async function handleDocument(message, chatId, env) {
  const doc = message.document;
  const allowedExt = [".js", ".ts", ".py", ".jsx", ".tsx", ".json", ".html", ".css", ".txt", ".md", ".java", ".c", ".cpp", ".go", ".rs", ".php"];
  const isTextFile = allowedExt.some((ext) => (doc.file_name || "").toLowerCase().endsWith(ext));

  if (!isTextFile || doc.file_size > 200000) {
    await sendMessage(chatId, "⚠️ فقط فایل‌های متنی/کد کوچک‌تر از ۲۰۰ کیلوبایت پشتیبانی می‌شود.", env);
    return;
  }

  const fileUrl = await getTelegramFileUrl(doc.file_id, env);
  const fileRes = await fetch(fileUrl);
  const fileContent = await fileRes.text();

  const caption = message.caption || "این کد را بررسی کن، مشکلات احتمالی را بگو و در صورت نیاز پیشنهاد اصلاح بده.";

  const prompt = `فایل: ${doc.file_name}\n\nمحتوای فایل:\n\`\`\`\n${fileContent.slice(0, 6000)}\n\`\`\`\n\nدرخواست کاربر: ${caption}`;

  await runTextAssistant(prompt, chatId, env, { skipHistoryUserText: `[فایل ${doc.file_name} ارسال شد] ${caption}` });
}

// ===================== پیام متنی معمولی (دستیار کدنویسی) =====================
async function handleTextMessage(text, chatId, env) {
  await runTextAssistant(text, chatId, env, { skipHistoryUserText: text });
}

async function runTextAssistant(userPrompt, chatId, env, { skipHistoryUserText } = {}) {
  const history = await getHistory(chatId, env);

  const messages = [
    { role: "system", content: SYSTEM_PROMPT },
    ...history,
    { role: "user", content: userPrompt },
  ];

  try {
    const aiResponse = await env.AI.run(TEXT_MODEL, {
      messages,
      max_tokens: 1500,
    });

    const resultText = aiResponse?.response || "متاسفانه نتونستم جواب مناسبی بسازم.";

    await appendHistory(chatId, "user", skipHistoryUserText || userPrompt, env);
    await appendHistory(chatId, "assistant", resultText, env);

    await sendLongMessage(chatId, resultText, env);
  } catch (err) {
    console.error("text model error:", err);
    await sendMessage(chatId, "❌ خطا در پردازش پیام با مدل هوش مصنوعی.", env);
  }
}

// ===================== توابع کمکی تلگرام =====================
async function getTelegramFileUrl(fileId, env) {
  const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getFile?file_id=${fileId}`);
  const data = await res.json();
  if (!data.ok) return null;
  return `https://api.telegram.org/file/bot${env.TELEGRAM_BOT_TOKEN}/${data.result.file_path}`;
}

async function sendMessage(chatId, text, env, parseMode) {
  const body = {
    chat_id: chatId,
    text: text,
  };
  if (parseMode) body.parse_mode = parseMode;

  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

// تلگرام محدودیت ~۴۰۹۶ کاراکتر برای هر پیام دارد؛ پیام‌های طولانی را تکه‌تکه می‌فرستیم
async function sendLongMessage(chatId, text, env) {
  const MAX_LEN = 3500;
  if (text.length <= MAX_LEN) {
    await sendMessage(chatId, text, env, "Markdown");
    return;
  }
  for (let i = 0; i < text.length; i += MAX_LEN) {
    await sendMessage(chatId, text.slice(i, i + MAX_LEN), env, "Markdown");
  }
}

async function sendChatAction(chatId, action, env) {
  await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendChatAction`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, action }),
  });
}

// ===================== مدیریت تاریخچه مکالمه (KV) =====================
async function getHistory(chatId, env) {
  const raw = await env.CHAT_KV.get(`history:${chatId}`);
  if (!raw) return [];
  try {
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

async function appendHistory(chatId, role, content, env) {
  const history = await getHistory(chatId, env);
  history.push({ role, content });
  const trimmed = history.slice(-MAX_HISTORY_MESSAGES);
  await env.CHAT_KV.put(`history:${chatId}`, JSON.stringify(trimmed), {
    expirationTtl: 60 * 60 * 24 * 3, // ۳ روز نگه‌داری خودکار حافظه
  });
}

async function clearHistory(chatId, env) {
  await env.CHAT_KV.delete(`history:${chatId}`);
}
