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
4. Create a Google Sheet with three tabs. For each one use **File → Import → Upload** → *Insert new sheet(s)*, then rename the tab:

   | Tab name | File |
   |---|---|
   | `Техкарти` | `data/techcards.csv` |
   | `Журнал` | `data/journal_template.csv` (header row only) |
   | `Кухарі` | `data/cooks_template.csv` |

   The tab names must match exactly. The bot looks the tabs up by name.
5. **Share** the sheet with the service account's email as **Editor**.

## 4. Import the workflow

1. In n8n: **Workflows → Import from file** → `workflows/sushi-qc-bot.json`.
2. Open each node that shows a credential warning and pick your credentials:
   - **Telegram** — the trigger, «Друкує…» and the reply nodes;
   - **OpenAI** — both Vision nodes;
   - **Google** — the four Sheets nodes.
3. In the four Google Sheets nodes, replace `REPLACE_WITH_YOUR_SPREADSHEET_ID` with your sheet ID. The ID is the part of the URL between `/d/` and `/edit`.
4. Save the workflow, then **Activate** it.

## 5. Let the cooks in

Each cook writes `/start` to the bot. Until they are on the list, the bot answers with their Telegram ID. Add that ID to the `Кухарі` tab with `active = TRUE`. Start with yourself.

## 6. Check it

Send these to the bot:

| Message | Expected reply |
|---|---|
| `/help` | usage instructions |
| photo + `Тех карта <the weight on the display>` | ✅ У нормі |
| photo + `Тех карта <weight − 30>` | ⛔️ БРАК |
| photo + `Тех карта <half the weight>` | 🔎 Перевірте фото (deviation over 30%) |
| a salmon roll photo + `Філадельфія з вугрем` | 🚫 Фото не схоже… |
| photo without a caption | auto by weight, or ⚠️ with candidates |
| the same photo again | ♻️ already checked |
| `/stats` | today's summary |

Every checked photo adds a row to `Журнал`.

## Tuning

**Recipe cards (the `Техкарти` tab):**
- **Tolerance** — the `tolerance_pct` column per dish. The default is 2.9%, used when the cell is empty and for «Тех карта N» captions. It is set by `DEFAULT_TOL` in `src/verdict.js`.
- **Packaging** — `pack_grams` per dish: the weight of the box or bowl a portion is usually weighed in. It is subtracted only when Vision sees a container and that brings the reading closer to the norm. Zeroing the scale with the empty container (TARE) is still the reliable way.
- **New dishes** — add a row. Give it:
  - a unique `dish_id`;
  - a few aliases cooks actually use. Don't give two dishes the same generic alias (such as «темпура»): leave such words out, and the weight or the candidate list will sort it out;
  - `must_have` — only what tells this dish apart (the fish or topping on top, the coating, baked or fried, the type);
  - `may_vary` — garnish and sauce that may or may not be there.
- **Hide a dish** — set `active` to `FALSE`.

**Bot logic (`src/verdict.js`):**
- **Thresholds** — `PLAUSIBLE` (30%: a bigger deviation becomes RECHECK), `MIN_DIGITS` (0.6) and `MIN_VISUAL` (0.7: the Vision confidence needed for MISMATCH).
- **Timezone** — workflow settings → Timezone (default `Europe/Kyiv`). It is also hard-coded in the `ts`/`date` formatting in `src/verdict.js` and `src/stats.js`.

## Changing the code

The Code nodes are built from `src/`. Edit there, then:

```bash
node tests/run-scenarios.js
```
```bash
node tools/build-workflow.js
```

Re-import `workflows/sushi-qc-bot.json`, or paste the changed file into the matching Code node.
