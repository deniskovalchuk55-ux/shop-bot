# 🤖 Shop Bot — Telegram-бот для постів

Кидаєш боту посилання на товар → отримуєш готовий пост для соцмереж (укр, з ціною по шкалі + заманка, з фото).

## Як працює
1. Кидаєш посилання на товар у бота
2. Бот завантажує сторінку (спершу простий fetch, не вийшло → Firecrawl)
3. AI (Claude) робить пост: назва, вступ, переваги, теги
4. Бот рахує ціну: шкала націнки + округлення до заманки (×99)
5. Присилає готовий пост + фото

## Шкала ціни
- до 25 грн → ×4
- 25–50 грн → ×2
- 50–200 грн → ×1.8
- понад 200 → ×1.35
- + округлення до найближчої «гарної» ціни (99, 199, 299...)

## Потрібні ключі (env-змінні)
- `BOT_TOKEN` — від @BotFather
- `ANTHROPIC_API_KEY` — Claude
- `FIRECRAWL_API_KEY` — Firecrawl (для захищених сайтів)

---

## 🚀 Деплой на Fly.io (безкоштовно)

### 1. Підготовка
- Створи бота: у Telegram @BotFather → `/newbot` → отримай `BOT_TOKEN`
- Зареєструйся на https://fly.io (треба картка для верифікації, free tier не списує)
- Встанови flyctl: https://fly.io/docs/flyctl/install/

### 2. Логін
```
fly auth login
```

### 3. Запуск застосунку (в папці бота)
```
fly launch --no-deploy
```
(коли спитає назву — придумай унікальну, напр. `denys-shop-bot`; регіон лиши waw)

### 4. Додай ключі (секрети)
```
fly secrets set BOT_TOKEN="твій_токен_бота"
fly secrets set ANTHROPIC_API_KEY="твій_ключ_claude"
fly secrets set FIRECRAWL_API_KEY="твій_ключ_firecrawl"
```

### 5. Деплой
```
fly deploy
```

### 6. Перевір
- Відкрий бота в Telegram → `/start` → кинь посилання на товар

### Корисне
- Логи: `fly logs`
- Перезапуск: `fly apps restart`
- Статус: `fly status`

---

## Локальний запуск (для тесту)
```
npm install
BOT_TOKEN=... ANTHROPIC_API_KEY=... FIRECRAWL_API_KEY=... node bot.js
```
