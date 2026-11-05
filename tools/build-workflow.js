#!/usr/bin/env node
// Assembles workflows/sushi-qc-bot.json from the Code node sources in src/.
// Credentials and the spreadsheet ID are placeholders — pick your own after importing into n8n.
//   node tools/build-workflow.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');

const SHEET = { __rl: true, mode: 'id', value: 'REPLACE_WITH_YOUR_SPREADSHEET_ID' };
const TG = { telegramApi: { id: 'REPLACE_TELEGRAM_CREDENTIAL_ID', name: 'Telegram bot' } };
const OPENAI = { openAiApi: { id: 'REPLACE_OPENAI_CREDENTIAL_ID', name: 'OpenAI' } };
const GOOGLE = { googleApi: { id: 'REPLACE_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID', name: 'Google Sheets (service account)' } };
const MSG = "$('Telegram Trigger').first().json.message";
const CHAT = `={{ ${MSG}.chat.id }}`;

const JOURNAL_COLUMNS = ['ts', 'date', 'chef', 'chat_id', 'dish_id', 'dish_name', 'match_source', 'portions', 'norm_grams', 'scale_grams', 'tare_grams', 'net_grams', 'deviation_pct', 'tolerance_pct', 'verdict', 'visual_check', 'visual_reason', 'digits_confidence', 'photo_uid', 'tg_message_id'];

const cond = (id, leftValue, operator, rightValue = '') => ({ id, leftValue, rightValue, operator });
const conditions = (list, combinator = 'and') => ({ options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: list, combinator });
const sheetRead = (id, name, sheet, pos) => ({
  id, name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, position: pos, alwaysOutputData: true, onError: 'continueRegularOutput',
  parameters: { authentication: 'serviceAccount', resource: 'sheet', operation: 'read', documentId: SHEET, sheetName: { __rl: true, mode: 'name', value: sheet }, options: {} },
  credentials: GOOGLE,
});
const tgSend = (id, name, pos, text, chatId = CHAT, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: pos, ...extra,
  parameters: { resource: 'message', operation: 'sendMessage', chatId, text, additionalFields: { appendAttribution: false } },
  credentials: TG,
});
const code = (id, name, pos, file, why) => ({
  id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, onError: 'continueErrorOutput', notes: 'Why Code: ' + why,
  parameters: { mode: 'runOnceForAllItems', jsCode: src(file) },
});
const vision = (id, name, pos) => ({
  id, name, type: '@n8n/n8n-nodes-langchain.openAi', typeVersion: 1.8, position: pos, onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 1500,
  parameters: { resource: 'image', operation: 'analyze', modelId: { __rl: true, mode: 'list', value: 'gpt-4o', cachedResultName: 'gpt-4o' }, text: '={{ $json.vision_prompt }}', inputType: 'base64', binaryPropertyName: 'data', options: {} },
  credentials: OPENAI,
});

const HELP = '👋 Бот контролю ваги страв за техкартою.\n\n'
  + '1. Обнуліть ваги з порожнім контейнером чи тарілкою (кнопка TARE / ТАРА).\n'
  + '2. Покладіть порцію і сфотографуйте так, щоб цифри на дисплеї було чітко видно — без бліку й розмиття.\n'
  + '3. У підписі до фото вкажіть назву або код страви — напр. «Філадельфія з вугрем» або «R02». Кілька порцій на вагах — допишіть «х2».\n'
  + '4. Бот відповість: ✅ у нормі, ⛔️ брак, 🚫 фото не схоже на підпис, 🔎 перевірте фото, ⚠️ не вдалося визначити.\n\n'
  + 'Команди:\n/stats — статистика за сьогодні\n/stats all — за весь час';

const nodes = [
  { id: 'tg_trigger', name: 'Telegram Trigger', type: 'n8n-nodes-base.telegramTrigger', typeVersion: 1.2, position: [-1700, 300], parameters: { updates: ['message'], additionalFields: { download: true } }, credentials: TG },
  sheetRead('sheet_cooks', 'Кухарі — читання', 'Кухарі', [-1480, 300]),
  { id: 'cooks_active', name: 'Активні кухарі', type: 'n8n-nodes-base.filter', typeVersion: 2.2, position: [-1260, 300],
    parameters: { conditions: conditions([cond('ca', '={{ String($json.active).trim().toUpperCase() }}', { type: 'string', operation: 'equals' }, 'TRUE')]), options: {} } },
  { id: 'cooks_ids', name: 'Список ID', type: 'n8n-nodes-base.aggregate', typeVersion: 1, position: [-1040, 300], alwaysOutputData: true,
    parameters: { aggregate: 'aggregateIndividualFields', fieldsToAggregate: { fieldToAggregate: [{ fieldToAggregate: 'chat_id' }] }, options: {} } },
  { id: 'access', name: 'Доступ?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [-820, 300],
    parameters: { conditions: conditions([cond('ac', '={{ ($json.chat_id || []).map(String) }}', { type: 'array', operation: 'contains', rightType: 'any' }, `={{ String(${MSG}.chat.id) }}`)]), options: {} } },
  tgSend('no_access', 'Немає доступу', [-600, 520], `=👋 Вас ще немає в списку кухарів.\nВаш Telegram ID: {{ ${MSG}.chat.id }}\nПередайте його адміністратору — після цього надсилайте фото страв на вагах.`),
  { id: 'router', name: 'Роутер', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [-600, 280],
    parameters: { rules: { values: [
      { conditions: { ...conditions([cond('r-stats', `={{ ${MSG}.text }}`, { type: 'string', operation: 'startsWith' }, '/stats')]), options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 } }, renameOutput: true, outputKey: 'stats' },
      { conditions: conditions([
        cond('r-photo', `={{ ${MSG}.photo }}`, { type: 'array', operation: 'exists', singleValue: true }),
        cond('r-doc', `={{ ${MSG}.document?.mime_type ?? '' }}`, { type: 'string', operation: 'startsWith' }, 'image/'),
      ], 'or'), renameOutput: true, outputKey: 'photo' },
    ] }, options: { fallbackOutput: 'extra', renameFallbackOutput: 'help' } } },
  { id: 'typing', name: 'Друкує…', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [-360, 120], onError: 'continueRegularOutput',
    parameters: { resource: 'message', operation: 'sendChatAction', chatId: CHAT, action: 'typing' }, credentials: TG },
  sheetRead('sheet_cards', 'Техкарти — читання', 'Техкарти', [-360, 300]),
  code('match_caption', 'Підпис → кандидат', [-140, 300], 'match-caption.js', 'fuzzy matching of a free-text caption (UA/RU, aliases, R-codes, «х2») against the recipe cards, the re-sent-photo check (workflow static data) and the dynamic Vision prompt — no native node covers this.'),
  { id: 'dup', name: 'Повтор фото?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [80, 300],
    parameters: { conditions: conditions([cond('dp', '={{ $json.duplicate_of }}', { type: 'string', operation: 'notEmpty', singleValue: true })]), options: {} } },
  tgSend('dup_reply', 'Відповідь: повтор', [300, 120], '=♻️ Це фото вже перевіряли ({{ $json.duplicate_of }}).\nЗважте порцію і сфотографуйте її ще раз.'),
  vision('vision', 'Vision — вага і ознаки', [300, 320]),
  // Empty answer or a refusal («I'm sorry, I can't help with that.») — anything without JSON goes to a second attempt.
  { id: 'empty', name: 'Порожня відповідь?', type: 'n8n-nodes-base.if', typeVersion: 2.2, position: [520, 320],
    parameters: { conditions: conditions([cond('em', "={{ String($json.content ?? '') }}", { type: 'string', operation: 'notContains' }, '{')]), options: {} } },
  { id: 'retry_photo', name: 'Фото для повтору', type: 'n8n-nodes-base.code', typeVersion: 2, position: [740, 480], onError: 'continueErrorOutput',
    notes: 'Why Code: the Vision answer carries no binary — re-attach the photo from «Підпис → кандидат» and switch to the shorter retry prompt.',
    parameters: { mode: 'runOnceForAllItems', jsCode: "const p = $('Підпис → кандидат').first();\nreturn [{ json: { vision_prompt: p.json.vision_prompt_retry }, binary: p.binary }];" } },
  vision('vision_retry', 'Vision — повтор', [960, 480]),
  code('verdict', 'Вердикт', [1180, 300], 'verdict.js', 'one node turns the Vision reading into the verdict: units, the decimal-point fix, container, portions, tolerance, plausibility, visual confidence and the weight-based candidate search — a native chain would need a dozen IF / Set / Filter / Sort nodes.'),
  { id: 'sheet_log_append', name: 'Журнал — запис', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, position: [1400, 300], onError: 'continueErrorOutput',
    parameters: { authentication: 'serviceAccount', resource: 'sheet', operation: 'append', documentId: SHEET, sheetName: { __rl: true, mode: 'name', value: 'Журнал' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: JOURNAL_COLUMNS.map((c) => ({ id: c, displayName: c, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true })) },
      options: { cellFormat: 'RAW', handlingExtraData: 'ignoreIt' } },
    credentials: GOOGLE },
  tgSend('reply_chef', 'Відповідь кухарю', [1620, 220], "={{ $('Вердикт').item.json.reply }}", "={{ $('Вердикт').item.json.chat_id }}"),
  tgSend('reply_nolog', 'Відповідь (журнал недоступний)', [1620, 400], "={{ $('Вердикт').item.json.reply }}\n\n⚠️ Запис у журнал не вдався — повідомте адміністратора.", "={{ $('Вердикт').item.json.chat_id }}"),
  sheetRead('sheet_log_read', 'Журнал — читання', 'Журнал', [-360, -120]),
  code('stats', 'Зведення', [-140, -120], 'stats.js', 'Summarize could count verdicts, but the reply also needs a today/all scope switch, per-verdict lines for problem checks and one formatted Telegram text — one short node instead of Filter + Summarize + Sort + Limit + Aggregate + Set.'),
  tgSend('reply_stats', 'Відповідь статистики', [80, -120], '={{ $json.reply }}', '={{ $json.chat_id }}'),
  tgSend('help', 'Допомога', [-360, 560], HELP),
  tgSend('tech_error', 'Технічна помилка', [1180, 620], '⚠️ Технічна помилка — перевірку не виконано. Спробуйте ще раз за хвилину; якщо повторюється, повідомте адміністратора.'),
  { id: 'note', name: 'Опис', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-1740, -340], parameters: { width: 820, height: 330, content:
    '## 🍣 Sushi QC Bot — контроль ваги за техкартою\n\n'
    + '**Флоу:** доступ за списком «Кухарі» → фото страви на вагах (+ назва / код / «х2» у підписі) → Vision читає вагу, одиниці й упевненість у цифрах, звіряє ключові ознаки з техкартою → вердикт → рядок у «Журнал» → відповідь кухарю.\n\n'
    + '**Вердикти:** OK · BRAK · MISMATCH (фото ≠ підпис) · RECHECK (цифри нечіткі або відхилення неправдоподібне) · LOWCONF · UNREADABLE.\n\n'
    + '**Google Sheets:** `Техкарти` (норма, допуск %, вага упаковки, ключові й допустимі ознаки), `Журнал`, `Кухарі` (chat_id, active).\n'
    + '**Код нод** зберігається в `src/*.js` репозиторію; цей JSON збирається `tools/build-workflow.js`.' } },
];

const link = (node, index = 0) => ({ node, type: 'main', index });
const connections = {
  'Telegram Trigger': { main: [[link('Кухарі — читання')]] },
  'Кухарі — читання': { main: [[link('Активні кухарі')]] },
  'Активні кухарі': { main: [[link('Список ID')]] },
  'Список ID': { main: [[link('Доступ?')]] },
  'Доступ?': { main: [[link('Роутер')], [link('Немає доступу')]] },
  'Роутер': { main: [[link('Журнал — читання')], [link('Друкує…'), link('Техкарти — читання')], [link('Допомога')]] },
  'Техкарти — читання': { main: [[link('Підпис → кандидат')]] },
  'Підпис → кандидат': { main: [[link('Повтор фото?')], [link('Технічна помилка')]] },
  'Повтор фото?': { main: [[link('Відповідь: повтор')], [link('Vision — вага і ознаки')]] },
  'Vision — вага і ознаки': { main: [[link('Порожня відповідь?')], [link('Технічна помилка')]] },
  'Порожня відповідь?': { main: [[link('Фото для повтору')], [link('Вердикт')]] },
  'Фото для повтору': { main: [[link('Vision — повтор')], [link('Технічна помилка')]] },
  'Vision — повтор': { main: [[link('Вердикт')], [link('Технічна помилка')]] },
  'Вердикт': { main: [[link('Журнал — запис')], [link('Технічна помилка')]] },
  'Журнал — запис': { main: [[link('Відповідь кухарю')], [link('Відповідь (журнал недоступний)')]] },
  'Журнал — читання': { main: [[link('Зведення')]] },
  'Зведення': { main: [[link('Відповідь статистики')], [link('Технічна помилка')]] },
};

const workflow = {
  name: 'Sushi QC Bot — dish weight control against recipe cards',
  nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' },
  pinData: {}, meta: { templateCredsSetupCompleted: false },
};
const out = path.join(root, 'workflows', 'sushi-qc-bot.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log(`built ${nodes.length} nodes -> ${path.relative(root, out)}`);
