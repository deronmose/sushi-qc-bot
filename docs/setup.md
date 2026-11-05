# Setup

You need n8n 2.x (self-hosted or Cloud), a Telegram bot, an OpenAI API key and a Google Cloud project.

## 1. Telegram bot

Create a bot with [@BotFather](https://t.me/BotFather) (`/newbot`) and copy the token. Then in n8n: **Credentials → New → Telegram API** → paste the token.

Telegram allows only **one webhook per bot**. If another workflow already uses this bot, deactivate it first.

## 2. OpenAI

In n8n: **Credentials → New → OpenAI** → paste an API key. The workflow uses `gpt-4o` for image analysis.

## 3. Google Sheets via a service account

1. In [Google Cloud Console](https://console.cloud.google.com) select or create a project. Then **APIs & Services → Library → Google Sheets API → Enable**.
2. **IAM & Admin → Service Accounts → Create**. Open the account → **Keys → Add key → JSON**. Keep the file private and never commit it.
3. In n8n: **Credentials → New → Google Service Account API**. Enter the `client_email` and `private_key` from the JSON.
4. Create a Google Sheet with two tabs:
   - **`Техкарти`** — **File → Import → Upload** `data/techcards.csv` → *Insert new sheet(s)* → rename the tab to `Техкарти`.
   - **`Журнал`** — the same with `data/journal_template.csv` → rename the tab to `Журнал`.

   The tab names must match exactly. The bot looks the tabs up by name.
5. **Share** the sheet with the service account's email as **Editor**.

## 4. Import the workflow

1. In n8n: **Workflows → Import from file** → `workflows/sushi-qc-bot.json`.
2. Open each node that shows a credential warning and pick your credentials: Telegram (trigger and the four reply nodes), OpenAI (`Vision — вага і ознаки`), Google (the three Sheets nodes).
3. In the three Google Sheets nodes, replace `REPLACE_WITH_YOUR_SPREADSHEET_ID` with your sheet ID. The ID is the part of the URL between `/d/` and `/edit`.
4. Save the workflow, then **Activate** it.

## 5. Check it

Send these to the bot:

| Message | Expected reply |
|---|---|
| `/help` | usage instructions |
| photo + `Тех карта <the weight on the display>` | ✅ У нормі |
| photo + `Тех карта <weight − 30>` | ⛔️ БРАК |
| a salmon roll photo + `Філадельфія з вугрем` | 🚫 Фото не схоже… |
| photo without a caption | auto by weight, or ⚠️ with candidates |
| `/stats` | today's summary |

Every photo adds a row to `Журнал`.

## Tuning

- **Tolerance** — the `tolerance_pct` column per dish. The default is 2.9 %, used when the cell is empty and for "Тех карта N" captions. It is set by `DEFAULT_TOL` in the `Вердикт` node.
- **New dishes** — add a row to `Техкарти`. Give it a unique `dish_id`, a few aliases cooks actually use, and concrete `visual_features`. Mention colours, what's on top, sesame or sauce, raw vs. baked or fried.
- **Hide a dish** — set `active` to `FALSE`.
- **Timezone** — workflow settings → Timezone (default `Europe/Kyiv`). It is also hard-coded in the `ts`/`date` formatting of `Вердикт` and `Зведення`.
