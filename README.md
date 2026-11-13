# Наши ачивки — мини-приложение Telegram

Мини-приложение для пары: важные события в отношениях выглядят как игровые достижения.
У каждой ачивки есть круглое фото, редкость, дата и описание. Есть цели (закрытые ачивки),
уровень пары с очками опыта, счётчик «вместе N дней» и напоминание о ближайших годовщинах.

```
docs/     — само приложение (HTML/CSS/JS), выкладывается на GitHub Pages
worker/   — API на Cloudflare Workers + база D1 (ачивки, фото, настройки)
```

Всё бесплатно: GitHub Pages + бесплатный тариф Cloudflare.
Данные видят только два человека, чьи Telegram ID указаны в настройках сервера.

---

## Запуск (один раз, ~15 минут)

### 1. Бот в Telegram
1. Откройте @BotFather и отправьте `/newbot`, придумайте имя.
2. Сохраните **токен** (вида `123456:ABC...`). Никому его не показывайте.

### 2. API на Cloudflare
Нужен бесплатный аккаунт на https://dash.cloudflare.com.

```bash
cd worker
npm install
npx wrangler login                      # откроется браузер, нажмите «Allow»
npx wrangler d1 create love-achievements
```
Команда выведет `database_id`. Вставьте его в `worker/wrangler.toml` вместо `REPLACE_WITH_DATABASE_ID`.

```bash
npm run db:init:remote                  # создаст таблицы
npx wrangler secret put BOT_TOKEN       # вставьте токен бота
npx wrangler deploy
```
В конце будет адрес вида `https://love-achievements-api.<ваше-имя>.workers.dev`. Его нужно вписать в `docs/config.js`.

### 3. Приложение на GitHub Pages
1. Создайте репозиторий на GitHub и загрузите туда эту папку целиком
   (`.dev.vars` и `node_modules` в репозиторий не попадут, они перечислены в `.gitignore`).
2. Откройте Settings → Pages → Source: **Deploy from a branch**, ветка `main`, папка **`/docs`**.
3. Через минуту появится адрес вида `https://<логин>.github.io/<репозиторий>/`.

### 4. Подключить приложение к боту
В @BotFather: `/mybots` → ваш бот → **Bot Settings → Configure Mini App → Enable Mini App**,
вставьте адрес GitHub Pages. Теперь в профиле бота есть кнопка «Открыть».
Ещё можно добавить кнопку в меню чата: **Bot Settings → Menu Button**.

### 5. Доступ для вас двоих
1. Откройте приложение. Оно покажет «Это приватное приложение» и ваш ID.
2. Попросите партнёра сделать то же самое и прислать свой ID.
3. Впишите оба ID в `worker/wrangler.toml`:
   ```toml
   ALLOWED_USER_IDS = "123456789,987654321"
   ALLOWED_ORIGIN = "https://<логин>.github.io"
   ```
4. `npx wrangler deploy` и перезапустите приложение.

---

## Локальная разработка

```bash
cd worker
printf 'DEV_USER_ID=1\nBOT_TOKEN=dev\n' > .dev.vars
npm run db:init:local
npm run dev                                   # API на http://localhost:8787
python3 -m http.server 5173 --directory ../docs   # приложение на http://localhost:5173
```
На `localhost` приложение входит под тестовым пользователем без Telegram.
`DEV_USER_ID` задаётся только в `.dev.vars`. На сервер его не добавляйте.

## Как устроено
- **Авторизация:** Telegram подписывает данные пользователя (`initData`), сервер проверяет подпись токеном бота и пускает только ID из `ALLOWED_USER_IDS`.
- **Фото:** в приложении фото обрезается в круг (можно двигать и приближать) и сжимается до 900×900. Хранится в D1, отдаётся только авторизованным.
- **Очки опыта:** обычная +10, редкая +25, эпическая +50, легендарная +100. Каждый следующий уровень требует на 25% больше XP.
- **Бэкап базы:** `npx wrangler d1 export love-achievements --remote --output backup.sql`
