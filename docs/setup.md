# Setup

You need n8n 2.x (self-hosted or Cloud), a Telegram bot, an OpenAI API key and a Google Cloud project.

## 1. Telegram bot

Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token. Then in n8n: **Credentials → New → Telegram API** → paste the token. Telegram allows only **one webhook per bot**, so deactivate any other workflow that uses it.

## 2. OpenAI

In n8n: **Credentials → New → OpenAI** → paste an API key. The workflow uses `gpt-4o` for image analysis.

## 3. Google Sheets via a service account

1. In [Google Cloud Console](https://console.cloud.google.com): **APIs & Services → Library → Google Sheets API → Enable**.
2. **IAM & Admin → Service Accounts → Create** → **Keys → Add key → JSON**. Keep the file private and never commit it.
3. In n8n: **Credentials → New → Google Service Account API**. Enter the `client_email` and `private_key` from the JSON.
4. Create a Google Sheet and **share** it with the service account's email as **Editor**.

## 4. Fill the sheet

**Data tabs.** For each file: **File → Import → Upload** → *Insert new sheet(s)* → rename the tab exactly:

| Tab | File |
|---|---|
| `Техкарти` | `data/techcards.csv` |
| `Точки` | `data/venues.csv` |
| `Кухарі` | `data/cooks_template.csv` (replace the example rows with your people) |
| `Журнал` | `data/demo_journal.csv` for the demo, or `data/journal_template.csv` (header only) |

**Formula pages.**
1. Generate the pages for your sheet's locale. Use `;` for Ukrainian, Russian and most European locales, and `,` for English:

   ```bash
   node tools/sheet-pages.js ";"
   ```

2. Import `data/pages/page-network.csv` first and rename its tab to **`Мережа`**. The other pages read its cell B2, the demo switch.
3. Then import `page-V1.csv` … `page-V4.csv`; the tab names are free. Keep «Convert text to numbers, dates and formulas» on.
4. If you have more or fewer kitchens, edit `data/venues.csv` before generating the pages.

The bot finds tabs by name: `Техкарти`, `Журнал`, `Кухарі`, `Точки` must match exactly.

## 5. Import the workflow

1. In n8n: **Workflows → Import from file** → `workflows/sushi-qc-bot.json`.
2. Pick your credentials in every node that shows a warning:
   - **Telegram** — the trigger, «Друкує…» and the reply and report nodes;
   - **OpenAI** — both Vision nodes;
   - **Google** — all Sheets nodes.
3. In every Google Sheets node, replace `REPLACE_WITH_YOUR_SPREADSHEET_ID` with your sheet ID (the part of the URL between `/d/` and `/edit`).
4. Check the workflow timezone (Settings → Timezone, default `Europe/Kyiv`). The daily report runs at 22:00 in it; to change the time, edit the «Щодня о 22:00» node.
5. Save and **Activate**.

## 6. Let people in

Each person writes `/start` to the bot and gets their Telegram ID back. Add a row to `Кухарі`:
- `chat_id` — the ID from the bot (the person's Telegram user ID — this is what ties them to a kitchen);
- `venue_id` — `V1` … `V4`, an active row of `Точки`;
- `venue` — the kitchen name (the bot takes the name from `Точки` anyway);
- `role` — `cook`, `manager` or `owner`;
- `active` — `TRUE`;
- `allowed_venues` — optional, for people who work in several kitchens: `V3;V4`. Leave it empty to lock the person to `venue_id`.

Start with yourself as `owner`. A newly added person is recognised from their next message. Changes to existing rows apply within 5 minutes (the list is cached); the owner can send `/reload` to apply them at once.

## 7. Check it

| Message | Expected reply |
|---|---|
| `/help` | usage instructions for your role, with the «📍 Точка» and «📊 Статистика» buttons |
| «📍 Точка» (owner) | buttons for all kitchens; tapping one switches where your checks go |
| photo + `R25 V3` from a cook locked to V2 | ⛔ not logged, the bot names the cook's kitchen |
| photo + `Тех карта <the weight on the display>` | ✅ У нормі |
| photo + `Тех карта <weight + 10%>` | ⬆️ ПЕРЕВАГА |
| photo + `Тех карта <weight − 5%>` | ⬇️ НЕДОВАГА |
| a salmon roll photo + `Філадельфія з вугрем` | 🚫 Фото не схоже… |
| the same photo again | ♻️ already checked |
| `/stats` (owner) | all kitchens side by side |
| `/stats V2` (owner) | one kitchen |
| `/report` (owner) | today's daily report |

Every checked photo adds a row to `Журнал` with the sender's kitchen.

## Tuning

**Recipe cards and reports:**
- **Tolerances** — `tol_under_pct` and `tol_over_pct` per dish. Defaults when empty: 2.9% / 5% (`DEFAULT_UNDER`, `DEFAULT_OVER` in `src/verdict.js`).
- **Packaging** — `pack_grams` per dish. It is subtracted only when Vision sees a container and that brings the reading closer to the norm; zeroing the scale (TARE) is the reliable way.
- **New dishes** — a unique `dish_id`, aliases cooks really use (no generic alias shared by two dishes), `must_have` (what tells the dish apart) and `may_vary` (garnish, sauce).
- **Demo rows in reports** — `INCLUDE_DEMO` in `src/report-lib.js`; on the sheet pages, cell `Мережа!B2` (ТАК / НІ). For a real kitchen, start the journal from the header-only template.

**Thresholds** in `src/verdict.js`: `PLAUSIBLE` (30%), `MIN_DIGITS` (0.6), `MIN_VISUAL` (0.7).

## Changing the code

The Code nodes are built from `src/`. Edit there, then:

```bash
node tests/run-scenarios.js
```
```bash
node tools/build-workflow.js
```

Re-import `workflows/sushi-qc-bot.json` (or paste the changed file into the matching Code node). Regenerate the demo journal with `node tools/gen-demo-history.js --end YYYY-MM-DD`.
