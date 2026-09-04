# 🤖 دستیار کدنویسی تلگرام — Cloudflare Worker

ربات تلگرامی که با **Cloudflare Workers AI** (بدون نیاز به API خارجی هوش مصنوعی) کار می‌کند و:
- به سوالات کدنویسی جواب می‌دهد و کد می‌نویسد/ویرایش می‌کند
- عکس و اسکرین‌شات (مثلاً از کد یا پیام خطا) را می‌خواند (Vision)
- فایل‌های کد ارسالی را بررسی می‌کند
- در اینترنت جستجوی خام انجام می‌دهد (`/search`)
- حافظه مکالمه کوتاه‌مدت دارد (در Cloudflare KV)

---

## ۱) پیش‌نیازها
- حساب Cloudflare (رایگان کافی است، ولی Workers AI ممکن است سقف مصرف رایگان محدودی داشته باشد)
- Node.js نصب‌شده + `npm install -g wrangler`
- یک ربات تلگرام ساخته‌شده از طریق [@BotFather](https://t.me/BotFather) و توکن آن
- (اختیاری ولی توصیه‌شده) یک کلید API از [Brave Search API](https://brave.com/search/api/) برای قابلیت `/search` — پلن رایگان دارد

## ۲) نصب
```bash
npm install
```
(اگر `package.json` ندارید، فقط به `wrangler` نیاز دارید، نیازی به وابستگی دیگری نیست.)

## ۳) ساخت namespace برای KV (حافظه مکالمه)
```bash
npx wrangler kv namespace create CHAT_KV
```
خروجی این دستور یک `id` می‌دهد؛ آن را داخل `wrangler.jsonc` جای `PUT_YOUR_KV_NAMESPACE_ID_HERE` بگذارید.

## ۴) فعال‌سازی Workers AI
نیازی به تنظیم دستی جدا نیست — کافی است بخش `"ai": { "binding": "AI" }` در `wrangler.jsonc` باشد (که هست). Workers AI به‌صورت خودکار برای حساب شما فعال می‌شود.

## ۵) تنظیم Secretها (توکن‌ها — هرگز داخل کد یا Git قرار نگیرند)
```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
# توکنی که از BotFather گرفتید را وارد کنید

npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
# یک رشته تصادفی و طولانی خودتان بسازید (مثلاً با: openssl rand -hex 32)

npx wrangler secret put BRAVE_SEARCH_API_KEY
# (اختیاری) کلید Brave Search API — اگر نمی‌خواهید /search کار کند، رد کنید
```

## ۶) دیپلوی
```bash
npx wrangler deploy
```
بعد از دیپلوی، آدرس Worker شما چیزی شبیه این است:
`https://telegram-code-assistant.<your-subdomain>.workers.dev`

## ۷) ثبت خودکار وب‌هوک تلگرام
فقط کافی است یک‌بار این آدرس را در مرورگر باز کنید (یا با `curl` بزنید):
```
https://telegram-code-assistant.<your-subdomain>.workers.dev/setup-webhook
```
اگر پاسخ `"ok": true` گرفتید، وب‌هوک با موفقیت ثبت شده و ربات آماده استفاده است.

## ۸) اجرای محلی برای تست (اختیاری)
```bash
npx wrangler dev
```
توجه: برای تست محلی وب‌هوک، باید Worker از طریق اینترنت در دسترس تلگرام باشد (مثلاً با `wrangler dev --remote` یا با دیپلوی مستقیم).

---

## 🔧 نکات فنی مهم

- **اسم مدل‌های AI**: در بالای فایل `src/index.js`، دو ثابت `TEXT_MODEL` و `VISION_MODEL` تعریف شده‌اند. قبل از دیپلوی نهایی، حتماً از فهرست رسمی و به‌روز مدل‌ها مطمئن شوید:
  https://developers.cloudflare.com/workers-ai/models/
  (ممکن است نام دقیق مدل‌ها از زمان نوشتن این کد تغییر کرده باشد.)

- **حافظه مکالمه**: فقط ۱۲ پیام اخیر هر کاربر نگه‌داری می‌شود و بعد از ۳ روز بی‌فعالیتی خودکار پاک می‌شود (قابل تغییر در `MAX_HISTORY_MESSAGES` و `expirationTtl`).

- **امنیت وب‌هوک**: هر درخواست ورودی، هدر `X-Telegram-Bot-Api-Secret-Token` را با مقدار secret شما مقایسه می‌کند تا از جعل درخواست جلوگیری شود.

- **محدودیت طول پیام تلگرام**: پیام‌های طولانی خودکار به چند بخش تقسیم می‌شوند.

- **هزینه**: Cloudflare Workers AI دارای سهمیه رایگان روزانه است؛ بعد از آن بر اساس نرخ‌نامه رسمی Cloudflare هزینه محاسبه می‌شود. برای پروژه شخصی/تست معمولاً سهمیه رایگان کافی است.

## 📂 ساختار پروژه
```
telegram-code-assistant/
├── src/
│   └── index.js       # کل منطق ربات
├── wrangler.jsonc      # تنظیمات Worker، KV و AI binding
├── .github/workflows/deploy.yml  # دیپلوی خودکار با GitHub Actions
└── README.md
```

---

## 🚀 روش جایگزین: دیپلوی فقط با گوشی، بدون کامپیوتر (GitHub Actions)

اگر به کامپیوتر دسترسی نداری، می‌توانی کل مراحل بالا را با گوشی و از طریق مرورگر/اپ گیت‌هاب انجام دهی؛ دیپلوی هر بار خودکار توسط GitHub Actions انجام می‌شود.

### مرحله ۱: توکن API و Account ID را از داشبورد Cloudflare بگیر (مرورگر گوشی)
1. وارد [dash.cloudflare.com](https://dash.cloudflare.com) شو
2. My Profile → API Tokens → Create Token → از قالب **"Edit Cloudflare Workers"** استفاده کن → Continue → Create Token
3. توکن ساخته‌شده را کپی کن (فقط یک‌بار نشان داده می‌شود)
4. Account ID را از صفحه اصلی Workers & Pages (سمت راست صفحه) کپی کن

⚠️ این توکن جدید را در هیچ چتی (حتی اینجا) نفرست — فقط داخل GitHub Secrets (مرحله ۴) وارد می‌شود.

### مرحله ۲: فضای KV را از داشبورد بساز (بدون نیاز به CLI)
1. در داشبورد Cloudflare: Workers & Pages → KV → Create a namespace
2. اسمش را `CHAT_KV` بگذار → Add
3. `id` ساخته‌شده را کپی کن

### مرحله ۳: یک ریپازیتوری گیت‌هاب بساز و فایل‌ها را آپلود کن
1. در اپ یا مرورگر گیت‌هاب، یک ریپو جدید (خصوصی یا عمومی) بساز
2. تمام فایل‌های این پروژه (شامل پوشه مخفی `.github`) را در همان ساختار آپلود کن
3. فایل `wrangler.jsonc` را مستقیم در گیت‌هاب ویرایش کن (آیکون مداد) و `PUT_YOUR_KV_NAMESPACE_ID_HERE` را با `id` مرحله ۲ جایگزین و Commit کن

### مرحله ۴: Secretهای ریپو را اضافه کن
در ریپو: Settings → Secrets and variables → Actions → New repository secret، و این‌ها را یکی‌یکی اضافه کن:
- `CLOUDFLARE_API_TOKEN` (از مرحله ۱)
- `CLOUDFLARE_ACCOUNT_ID` (از مرحله ۱)
- `TELEGRAM_BOT_TOKEN` (از BotFather)
- `TELEGRAM_WEBHOOK_SECRET` (یک رشته تصادفی دلخواه خودت بساز، مثلاً چند کلمه/عدد ترکیبی)
- `BRAVE_SEARCH_API_KEY` (اختیاری)

### مرحله ۵: دیپلوی خودکار را ببین
به محض ذخیره‌ی commit مرحله ۳ (یا هر commit بعدی)، تب **Actions** در ریپو خودکار workflow را اجرا می‌کند و Worker را دیپلوی می‌کند. اگر تیک سبز دیدی، یعنی موفق بوده. آدرس نهایی Worker در پیام‌های همان اجرای Action یا در داشبورد Cloudflare (Workers & Pages) قابل مشاهده است.

### مرحله ۶: وب‌هوک را ثبت کن
همان آدرس Worker را با `/setup-webhook` در آخرش، در مرورگر گوشی باز کن. دیدن `"ok": true` یعنی ربات آماده است.
