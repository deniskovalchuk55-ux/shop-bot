import TelegramBot from "node-telegram-bot-api";

// === Ключі (беруться зі змінних оточення на Fly.io) ===
const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const FIRECRAWL_API_KEY = process.env.FIRECRAWL_API_KEY;

if (!BOT_TOKEN) { console.error("НЕМА BOT_TOKEN"); process.exit(1); }

const bot = new TelegramBot(BOT_TOKEN, { polling: true });
console.log("🤖 Бот запущено");

// === Ціна: шкала націнки + округлення до заманки (×99) ===
function calcPrice(buyPrice) {
  let mult;
  if (buyPrice <= 25) mult = 4;
  else if (buyPrice <= 50) mult = 2;
  else if (buyPrice <= 200) mult = 1.8;
  else mult = 1.35;

  const raw = buyPrice * mult;

  // округлення до НАЙБЛИЖЧОЇ "красивої" ціни на 99 (199, 299, 499, 999...)
  const candidates = [];
  for (let base = 50; base <= 100000; base += 50) {
    candidates.push(base - 1);     // 49, 99, 149, 199...
  }
  let best = candidates[0];
  let bestDiff = Math.abs(raw - best);
  for (const c of candidates) {
    const d = Math.abs(raw - c);
    if (d < bestDiff) { bestDiff = d; best = c; }
  }
  return best;
}

// === Завантаження сторінки: спершу простий fetch, не вийшло -> Firecrawl ===
async function loadPage(url) {
  // 1. Простий fetch
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
        const ogImage = html.match(/<meta[^>]+property=["']og:image["'][^>]+content=["']([^"']+)["']/i);
        const images = extractImages(html);
        return { text: text.slice(0, 18000), image: ogImage ? ogImage[1] : (images[0] || null), images, ok: true };
      }
    }
  } catch (e) { /* пробуємо Firecrawl */ }

  // 2. Firecrawl (для захищених сайтів)
  if (!FIRECRAWL_API_KEY) return { ok: false, error: "Сайт не відкрився, а Firecrawl не налаштований" };
  try {
    const fcRes = await fetch("https://api.firecrawl.dev/v1/scrape", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${FIRECRAWL_API_KEY}` },
      body: JSON.stringify({ url, formats: ["markdown"], onlyMainContent: false, waitFor: 2500 }),
    });
    const fcText = await fcRes.text();
    let fcData;
    try { fcData = JSON.parse(fcText); } catch { return { ok: false, error: "Firecrawl повернув не JSON (ліміт?)" }; }
    if (!fcRes.ok || !fcData.success) return { ok: false, error: "Firecrawl: " + (fcData.error || fcRes.status) };
    const md = fcData.data?.markdown || "";
    const meta = fcData.data?.metadata || {};
    const imgs = (md.match(/https?:\/\/[^\s"')]+\.(?:jpg|jpeg|png|webp)/gi) || [])
      .filter(u => !u.includes("logo") && !u.includes("icon") && !u.includes("sprite"));
    return { text: md.slice(0, 18000), image: meta.ogImage || imgs[0] || null, images: imgs, ok: true };
  } catch (e) {
    return { ok: false, error: "Помилка завантаження: " + e.message };
  }
}

// витяг фото з html
function extractImages(html) {
  const imgs = [];
  const re = /<img[^>]+src=["']([^"']+\.(?:jpg|jpeg|png|webp)[^"']*)["']/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    let u = m[1];
    if (u.startsWith("//")) u = "https:" + u;
    if (u.startsWith("http") && !u.includes("logo") && !u.includes("icon") && !u.includes("sprite")) imgs.push(u);
  }
  return [...new Set(imgs)];
}

// === AI: робить пост для соцмереж ===
async function makePost(pageText) {
  const prompt = `Ти — SMM-копірайтер. На основі вмісту сторінки товару зроби ПРОДАЮЧИЙ пост для Instagram і Telegram УКРАЇНСЬКОЮ мовою.

ВМІСТ СТОРІНКИ:
${pageText}

Спочатку ЗНАЙДИ ціну товару на сторінці (у гривнях) — це ціна постачальника.

Поверни СТРОГО JSON без markdown:
{
  "title": "коротка чітка назва товару",
  "buy_price": число (ціна постачальника з сторінки, тільки число, без грн),
  "post": "готовий текст поста (див. формат нижче)",
  "tags": ["тег1", "тег2", "тег3", "тег4", "тег5"]
}

ФОРМАТ "post" (середній за обсягом, з емодзі, БЕЗ ціни — ціну додам окремо):
✨ <Назва товару>

<Короткий вступ 2-3 речення про товар з емодзі — для кого, ключова перевага>

🔹 Переваги:
• <перевага 1>
• <перевага 2>
• <перевага 3>
• <перевага 4>

Правила:
- Тільки реальні дані зі сторінки, не вигадуй.
- Емодзі доречно, не перебір.
- Без ціни (її підставлю сам), без артикулів, без інфо про продавця.
- Жвавий продаючий тон.`;

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
  if (!res.ok) {
    const t = await res.text();
    throw new Error("AI: " + t.slice(0, 150));
  }
  const data = await res.json();
  let text = data.content.map(c => c.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(text);
}

// === Обробка повідомлень ===
bot.on("message", async (msg) => {
  const chatId = msg.chat.id;
  const text = (msg.text || "").trim();

  if (text === "/start") {
    bot.sendMessage(chatId, "👋 Привіт! Кидай посилання на товар — зроблю готовий пост для соцмереж з ціною.");
    return;
  }

  // перевірка що це посилання
  if (!text.startsWith("http")) {
    bot.sendMessage(chatId, "Надішли посилання на товар (http...)");
    return;
  }

  const wait = await bot.sendMessage(chatId, "⏳ Обробляю товар...");

  try {
    // 1. завантажуємо сторінку
    const page = await loadPage(text);
    if (!page.ok) {
      bot.editMessageText("⚠️ " + page.error, { chat_id: chatId, message_id: wait.message_id });
      return;
    }

    // 2. AI робить пост
    const result = await makePost(page.text);

    // 3. рахуємо ціну
    const buyPrice = Number(result.buy_price) || 0;
    const sellPrice = buyPrice > 0 ? calcPrice(buyPrice) : null;

    // 4. формуємо фінальний пост
    const tags = (result.tags || []).map(t => "#" + String(t).replace(/[^\wа-яіїєґ]/gi, "")).join(" ");
    let finalPost = result.post + "\n\n";
    if (sellPrice) finalPost += `💰 Ціна: ${sellPrice} грн\n`;
    finalPost += `📩 Замовляй — пиши в Direct!\n\n${tags}`;

    // 5. надсилаємо з фото
    bot.deleteMessage(chatId, wait.message_id).catch(() => {});
    if (page.image) {
      await bot.sendPhoto(chatId, page.image, { caption: finalPost }).catch(async () => {
        // якщо фото не відправилось — шлемо текстом
        await bot.sendMessage(chatId, finalPost);
        await bot.sendMessage(chatId, "🖼 Фото: " + page.image);
      });
    } else {
      await bot.sendMessage(chatId, finalPost);
    }

    // показуємо розрахунок ціни окремо (для тебе)
    if (sellPrice) {
      bot.sendMessage(chatId, `ℹ️ Закупка: ${buyPrice} грн → продаж: ${sellPrice} грн`);
    }
  } catch (e) {
    bot.editMessageText("❌ Помилка: " + e.message, { chat_id: chatId, message_id: wait.message_id }).catch(() => {
      bot.sendMessage(chatId, "❌ Помилка: " + e.message);
    });
  }
});

bot.on("polling_error", (e) => console.error("polling:", e.message));
