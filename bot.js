import TelegramBot from "node-telegram-bot-api";
import pkg from "pg";
const { Pool } = pkg;

// === Ключі (env-змінні на Railway) ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;
const DATABASE_URL = process.env.DATABASE_URL;

// Канал і група (куди постимо)
const CHANNEL = "@shopix_shop7";          // публічний канал
const CHANNEL_USERNAME = "shopix_shop7";  // без @, для посилання на пост
const GROUP_ID = -1001687590105;          // група міста (формат -100...)

if (!BOT_TOKEN) { console.error("НЕМА BOT_TOKEN"); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Бот запущено");

// Окремий бот для ПОСТИНГУ в канал/групу (той що вже адмін у каналі).
// Якщо CHANNEL_BOT_TOKEN не заданий — постимо основним ботом.
const CHANNEL_BOT_TOKEN = process.env.CHANNEL_BOT_TOKEN;
const posterBot = CHANNEL_BOT_TOKEN ? new TelegramBot(CHANNEL_BOT_TOKEN, { polling: false }) : bot;

// === База Neon ===
const pool = DATABASE_URL ? new Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } }) : null;
if (!pool) console.warn("⚠️ DATABASE_URL не заданий — база вимкнена");

// тимчасове сховище оброблених товарів (поки чекаємо вибір куди постити)
const pending = {};

// === Ціна: шкала + округлення до заманки (×99) ===
function calcPrice(buyPrice) {
  let mult;
  if (buyPrice <= 25) mult = 4;
  else if (buyPrice <= 50) mult = 2;
  else if (buyPrice <= 200) mult = 1.8;
  else if (buyPrice <= 600) mult = 1.7;
  else if (buyPrice <= 1000) mult = 1.45;
  else mult = 1.4;

  const raw = buyPrice * mult;
  // округлення до найближчої "красивої" ціни на 99 (49, 99, 149, 199...)
  let best = 49, bestDiff = Math.abs(raw - 49);
  for (let base = 50; base <= 100000; base += 50) {
    const c = base - 1;
    const d = Math.abs(raw - c);
    if (d < bestDiff) { bestDiff = d; best = c; }
  }
  return best;
}

// === Завантаження сторінки: простий fetch -> Firecrawl ===
// прибирає дублі, лого/іконки, бере великі версії, лишає до 4
function dedupeImages(arr) {
  const seen = new Set();
  const out = [];
  for (let u of arr) {
    if (!u) continue;
    const low = u.toLowerCase();
    // відсіюємо лого, іконки, банери, favicon, плейсхолдери
    if (low.includes("logo") || low.includes("icon") || low.includes("sprite") ||
        low.includes("placeholder") || low.includes("favicon") || low.includes("/login") ||
        low.includes("footer") || low.includes("developer") || low.includes("visa") ||
        low.includes("delivery") || low.includes("/svg") || low.endsWith(".svg") ||
        low.includes("telegram-phone") || low.includes("login-bg")) {
      continue;
    }
    // opt-drop: підміняємо маленьку превʼю (/products/78/) на велику (/products/480/)
    u = u.replace(/\/products\/\d{1,3}\//, "/products/480/");
    // нормалізація для дедуплікації (прибираємо розмір)
    const key = u.replace(/\/\d+x\d+\//, "/").replace(/_\d+x\d+/, "").replace(/\/products\/\d+\//, "/products/").split("?")[0];
    if (!seen.has(key)) {
      seen.add(key);
      out.push(u);
    }
    if (out.length >= 4) break;
  }
  return out;
}

async function loadPage(url) {
  try {
    const res = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
      },
    });
    if (res.ok) {
      const html = await res.text();
      const text = html
        .replace(/<script[\s\S]*?<\/script>/gi, " ")
        .replace(/<style[\s\S]*?<\/style>/gi, " ")
        .replace(/<[^>]+>/g, " ")
        .replace(/&nbsp;/g, " ")
        .replace(/\s+/g, " ")
        .trim();
      if (text.length >= 500) {
        const images = [];
        const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        // додаємо og:image тільки якщо це НЕ лого
        if (ogImage && !/logo|icon|favicon/i.test(ogImage[1])) images.push(ogImage[1]);

        // ОБРІЗАЄМО html на блоках "рекомендовані/схожі" — щоб не брати чужі фото
        let htmlMain = html;
        const cutWords = [
          "Зверніть увагу", "Рекомендовані", "Схожі товари", "Схожі пропозиції",
          "З цим купують", "Разом дешевше", "Вам також", "Інші товари",
          "рекомендуємо", "схожі", "related", "recommend", "you may also",
          "similar-products", "related-products"
        ];
        let cutAt = htmlMain.length;
        for (const w of cutWords) {
          const idx = htmlMain.toLowerCase().indexOf(w.toLowerCase());
          if (idx > 500 && idx < cutAt) cutAt = idx;
        }
        htmlMain = htmlMain.slice(0, cutAt);

        // витягуємо <img src=""> ТІЛЬКИ з основної частини
        const imgTag = /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
        let im;
        while ((im = imgTag.exec(htmlMain)) !== null) {
          let u = im[1];
          if (u.startsWith("//")) u = "https:" + u;
          if (u.startsWith("http") && !u.includes("logo") && !u.includes("icon") && !u.includes("sprite") && !u.includes("placeholder")) {
            images.push(u);
          }
        }
        const uniq = dedupeImages(images);
        return { text: text.slice(0, 18000), images: uniq, image: uniq[0] || null, ok: true };
      }
    }
  } catch (e) {}

  if (!FIRECRAWL_API_KEY) return { ok: false, error: "Сайт не відкрився, Firecrawl не налаштований" };
  try {
    const fcRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false, waitFor: 2500 }),
    });
    const fcText = await fcRes.text();
    let fcData;
    try { fcData = JSON.parse(fcText); } catch { return { ok: false, error: "Firecrawl не JSON (ліміт?)" }; }
    if (!fcRes.ok || !fcData.success) return { ok: false, error: "Firecrawl: " + (fcData.error || fcRes.status) };
    const md = fcData.data?.markdown || "";
    const meta = fcData.data?.metadata || {};
    // обрізаємо markdown на блоках рекомендованих
    let mdMain = md;
    const cuts = ["Зверніть увагу", "Рекомендовані", "Схожі товари", "З цим купують", "Вам також", "Інші товари", "рекомендуємо"];
    let cutAt = mdMain.length;
    for (const w of cuts) {
      const idx = mdMain.toLowerCase().indexOf(w.toLowerCase());
      if (idx > 300 && idx < cutAt) cutAt = idx;
    }
    mdMain = mdMain.slice(0, cutAt);

    const imgs = (mdMain.match(/https?:\/\/[^\s"')]+\.(?:jpg|jpeg|png|webp)/gi) || [])
      .filter(u => !u.includes("logo") && !u.includes("icon") && !u.includes("sprite") && !u.includes("placeholder"));
    const all = [];
    if (meta.ogImage && !/logo|icon|favicon/i.test(meta.ogImage)) all.push(meta.ogImage);
    all.push(...imgs);
    const uniq = dedupeImages(all);
    return { text: md.slice(0, 18000), images: uniq, image: uniq[0] || null, ok: true };
  } catch (e) {
    return { ok: false, error: "Помилка завантаження: " + e.message };
  }
}

// === AI: робить пост ===
async function makePost(pageText) {
  const prompt = `Ти — SMM-копірайтер. На основі вмісту сторінки товару зроби ПРОДАЮЧИЙ пост для Instagram і Telegram УКРАЇНСЬКОЮ мовою.

ВМІСТ СТОРІНКИ:
${pageText}

Спочатку ЗНАЙДИ ціну товару на сторінці (грн) — ціна постачальника.

Поверни СТРОГО JSON без markdown:
{
  "title": "коротка чітка назва товару",
  "buy_price": число (ціна постачальника, тільки число),
  "post": "текст поста (формат нижче)",
  "tags": ["тег1","тег2","тег3","тег4","тег5"]
}

ФОРМАТ "post" (середній, з емодзі, БЕЗ ціни):
✨ <Назва товару>

<вступ 2-3 речення з емодзі — для кого, ключова перевага>

🔹 Переваги:
• <перевага 1>
• <перевага 2>
• <перевага 3>
• <перевага 4>

Правила:
- Тільки реальні дані, не вигадуй.
- Емодзі доречно.
- Без ціни (додам сам), без артикулів, без інфо про продавця.
- Теги ТІЛЬКИ українською мовою (дуже важливо!).`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 1500,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error("AI: " + t.slice(0, 150)); }
  const data = await res.json();
  let text = data.content.map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// формуємо фінальний текст поста
function buildFinalPost(result, sellPrice) {
  const tags = (result.tags || []).map(t => "#" + String(t).replace(/[^\wа-яіїєґА-ЯІЇЄҐ]/gi, "")).join(" ");
  let p = result.post + "\n\n";
  if (sellPrice) p += `💰 Ціна: ${sellPrice} грн\n`;
  p += `📩 Замовляй — пиши менеджеру @shopiX_mngr\n`;
  p += `🛍 Весь асортимент → @shopix_shop7\n\n${tags}`;
  return p;
}

// надсилає пост через вказаний бот (whichBot): альбом / одне фото / текст
async function sendPost(whichBot, chatId, images, caption) {
  const imgs = (images || []).filter(Boolean).slice(0, 4);
  if (imgs.length >= 2) {
    const media = imgs.map((u, i) => ({
      type: "photo",
      media: u,
      ...(i === 0 ? { caption } : {}),
    }));
    const sent = await whichBot.sendMediaGroup(chatId, media);
    return Array.isArray(sent) ? sent[0] : sent;
  } else if (imgs.length === 1) {
    return await whichBot.sendPhoto(chatId, imgs[0], { caption });
  } else {
    return await whichBot.sendMessage(chatId, caption);
  }
}

// генерує АКЦІЙНИЙ пост-оголошення (AI) з опису акції
async function makeSalePost(description) {
  const prompt = `Зроби ПРОДАЮЧИЙ пост-оголошення про АКЦІЮ/ЗНИЖКУ для Telegram-каналу магазину УКРАЇНСЬКОЮ.

ОПИС АКЦІЇ ВІД ВЛАСНИКА:
${description}

ФОРМАТ (з емодзі, яскраво, з терміновістю):
🔥 <ЗАГОЛОВОК АКЦІЇ великими> 🔥

<1-2 речення-гачок про акцію з емодзі>

<якщо є — деталі: на що знижка, скільки %>

⏰ <терміновість — скільки діє>

📩 Замовляй → @shopiX_mngr
🛍 Весь асортимент → @shopix_shop7

Правила:
- Яскраво, з емодзі, по-продажному (це реклама акції).
- Тільки те що в описі (не вигадуй товари/відсотки яких нема).
- Створюй терміновість і бажання купити.
- Поверни ТІЛЬКИ текст поста, без пояснень.`;

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-sonnet-4-5-20250929",
      max_tokens: 800,
      messages: [{ role: "user", content: prompt }],
    }),
  });
  if (!res.ok) { const t = await res.text(); throw new Error("AI: " + t.slice(0, 150)); }
  const data = await res.json();
  return data.content.map(c => c.text || "").join("").trim();
}

// === Обробка ФОТО (банер для акції з підписом «акція ...») ===
bot.on("photo", async (msg) => {
  const chatId = msg.chat.id;
  const caption = (msg.caption || "").trim();
  // реагуємо тільки якщо в підписі є "акція"/"akcia"/"sale"/"знижк"
  if (!/акці|akci|sale|знижк/i.test(caption)) {
    bot.sendMessage(chatId, "Щоб зробити акцію з банером — додай у підпис до фото слово «акція» та опис.\nНапр: «акція на літні товари -10%, 3 дні»");
    return;
  }
  const desc = caption.replace(/^\/?(акція|akcia|sale)/i, "").trim() || caption;
  // беремо найбільше фото (банер)
  const fileId = msg.photo[msg.photo.length - 1].file_id;

  const wait = await bot.sendMessage(chatId, "🔥 Роблю акційний пост з банером...");
  try {
    const salePost = await makeSalePost(desc);
    const key = `sale_${chatId}_${wait.message_id}`;
    pending[key] = { post: salePost, images: [], bannerFileId: fileId };
    bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    await bot.sendPhoto(chatId, fileId, { caption: salePost }).catch(() => bot.sendMessage(chatId, salePost));
    await bot.sendMessage(chatId, "Постимо?", {
      reply_markup: { inline_keyboard: [
        [{ text: "📢 Канал", callback_data: `post_channel_${key}` }],
        [{ text: "🏙 Група", callback_data: `post_group_${key}` }],
        [{ text: "✅ Обидва", callback_data: `post_both_${key}` }],
        [{ text: "❌ Скасувати", callback_data: `post_cancel_${key}` }],
      ]},
    });
  } catch (e) {
    bot.editMessageText("❌ " + e.message, { chat_id: chatId, message_id: wait.message_id });
  }
});

// === Обробка повідомлень ===
bot.on("message", async (msg) => {
  if (!msg.text) return;
  const chatId = msg.chat.id;
  const text = msg.text.trim();

  if (text === "/start") {
    bot.sendMessage(chatId, "👋 Кидай посилання на товар — зроблю пост.\n\n🔍 Напиши слово — знайду товар у базі.\n\n🔥 /акція <опис> — зроблю акційний пост. Або скинь банер з підписом «акція ...».");
    return;
  }

  // АКЦІЯ (текстом, без банера)
  if (text.startsWith("/акція") || text.startsWith("/akcia") || text.startsWith("/sale")) {
    const desc = text.replace(/^\/(акція|akcia|sale)/, "").trim();
    if (!desc) {
      bot.sendMessage(chatId, "Напиши опис акції: /акція на всі літні товари знижка 10%, 3 дні");
      return;
    }
    const wait = await bot.sendMessage(chatId, "🔥 Роблю акційний пост...");
    try {
      const salePost = await makeSalePost(desc);
      const key = `sale_${chatId}_${wait.message_id}`;
      pending[key] = { post: salePost, images: [] };
      bot.deleteMessage(chatId, wait.message_id).catch(() => {});
      await bot.sendMessage(chatId, salePost);
      await bot.sendMessage(chatId, "Постимо?", {
        reply_markup: { inline_keyboard: [
          [{ text: "📢 Канал", callback_data: `post_channel_${key}` }],
          [{ text: "🏙 Група", callback_data: `post_group_${key}` }],
          [{ text: "✅ Обидва", callback_data: `post_both_${key}` }],
          [{ text: "❌ Скасувати", callback_data: `post_cancel_${key}` }],
        ]},
      });
    } catch (e) {
      bot.editMessageText("❌ " + e.message, { chat_id: chatId, message_id: wait.message_id });
    }
    return;
  }
  if (!text.startsWith("http")) {
    // ПОШУК за назвою в базі
    if (!pool) {
      bot.sendMessage(chatId, "База не підключена (немає DATABASE_URL).");
      return;
    }
    try {
      const res = await pool.query(
        `SELECT title, price, post_url, source_url, created_at
         FROM products
         WHERE title ILIKE $1 OR tags ILIKE $1
         ORDER BY created_at DESC LIMIT 10`,
        [`%${text}%`]
      );
      if (res.rows.length === 0) {
        bot.sendMessage(chatId, `🔍 Нічого не знайшов за «${text}».`);
        return;
      }
      let out = `🔍 Знайдено (${res.rows.length}):\n\n`;
      for (const r of res.rows) {
        out += `📦 ${r.title}\n`;
        if (r.price) out += `💰 ${r.price} грн\n`;
        if (r.post_url) out += `🔗 Пост: ${r.post_url}\n`;
        if (r.source_url) out += `🌐 Сайт: ${r.source_url}\n`;
        out += `\n`;
      }
      bot.sendMessage(chatId, out, { disable_web_page_preview: true });
    } catch (e) {
      bot.sendMessage(chatId, "Помилка пошуку: " + e.message);
    }
    return;
  }

  const wait = await bot.sendMessage(chatId, "⏳ Обробляю товар...");
  try {
    const page = await loadPage(text);
    if (!page.ok) {
      bot.editMessageText("⚠️ " + page.error, { chat_id: chatId, message_id: wait.message_id });
      return;
    }
    const result = await makePost(page.text);
    const buyPrice = Number(result.buy_price) || 0;
    const sellPrice = buyPrice > 0 ? calcPrice(buyPrice) : null;
    const finalPost = buildFinalPost(result, sellPrice);

    // зберігаємо в pending під ключем (chatId+messageId)
    const key = `${chatId}_${wait.message_id}`;
    pending[key] = {
      title: result.title || "",
      tags: (result.tags || []).join(", "),
      buyPrice, sellPrice,
      post: finalPost,
      image: page.image,
      images: page.images || [],
      source_url: text,
    };

    bot.deleteMessage(chatId, wait.message_id).catch(() => {});

    // показуємо пост (альбомом якщо кілька фото)
    try {
      await sendPost(bot, chatId, page.images, finalPost);
    } catch (e) {
      await bot.sendMessage(chatId, finalPost);
    }
    if (sellPrice) await bot.sendMessage(chatId, `ℹ️ Закупка ${buyPrice} → продаж ${sellPrice} грн (фото: ${(page.images||[]).length})`);

    await bot.sendMessage(chatId, "Куди постимо?", {
      reply_markup: {
        inline_keyboard: [
          [{ text: "📢 Канал", callback_data: `post_channel_${key}` }],
          [{ text: "🏙 Група міста", callback_data: `post_group_${key}` }],
          [{ text: "✅ І туди, і туди", callback_data: `post_both_${key}` }],
          [{ text: "❌ Скасувати", callback_data: `post_cancel_${key}` }],
        ],
      },
    });
  } catch (e) {
    bot.editMessageText("❌ Помилка: " + e.message, { chat_id: chatId, message_id: wait.message_id }).catch(() => {
      bot.sendMessage(chatId, "❌ Помилка: " + e.message);
    });
  }
});

// === Обробка кнопок (куди постити) ===
bot.on("callback_query", async (q) => {
  const data = q.data || "";
  const chatId = q.message.chat.id;

  const m = data.match(/^post_(channel|group|both|cancel)_(.+)$/);
  if (!m) return;
  const action = m[1];
  const key = m[2];
  const item = pending[key];

  if (!item) {
    bot.answerCallbackQuery(q.id, { text: "Дані застаріли, надішли посилання знову" });
    return;
  }

  if (action === "cancel") {
    delete pending[key];
    bot.answerCallbackQuery(q.id, { text: "Скасовано" });
    bot.editMessageText("❌ Скасовано", { chat_id: chatId, message_id: q.message.message_id }).catch(() => {});
    return;
  }

  bot.answerCallbackQuery(q.id, { text: "Постимо..." });

  const targets = [];
  if (action === "channel" || action === "both") targets.push({ id: CHANNEL, type: "channel" });
  if (action === "group" || action === "both") targets.push({ id: GROUP_ID, type: "group" });

  let postUrl = null;
  const errors = [];

  for (const t of targets) {
    try {
      let sent;
      if (item.bannerFileId) {
        // акційний пост з банером
        sent = await posterBot.sendPhoto(t.id, item.bannerFileId, { caption: item.post });
      } else {
        sent = await sendPost(posterBot, t.id, item.images, item.post);
      }
      // посилання на пост — тільки для публічного каналу
      if (t.type === "channel" && sent?.message_id) {
        postUrl = `https://t.me/${CHANNEL_USERNAME}/${sent.message_id}`;
      }
    } catch (e) {
      errors.push(`${t.type}: ${e.message}`);
    }
  }

  // зберігаємо в базу (тільки товари, не акційні пости)
  if (pool && !item.bannerFileId && item.title) {
    try {
      await pool.query(
        `INSERT INTO products (title, price, buy_price, tags, post_url, source_url, photo_url)
         VALUES ($1,$2,$3,$4,$5,$6,$7)`,
        [item.title, item.sellPrice, item.buyPrice, item.tags, postUrl, item.source_url, item.image]
      );
    } catch (e) {
      errors.push("база: " + e.message);
    }
  }

  delete pending[key];

  let report = "✅ Запощено";
  if (postUrl) report += `\n🔗 ${postUrl}`;
  if (errors.length) report += `\n\n⚠️ Проблеми:\n` + errors.join("\n");
  bot.editMessageText(report, { chat_id: chatId, message_id: q.message.message_id }).catch(() => {
    bot.sendMessage(chatId, report);
  });
});

bot.on("polling_error", (e) => console.error("polling:", e.message));
