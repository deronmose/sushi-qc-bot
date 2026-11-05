#!/usr/bin/env node
// Assembles workflows/sushi-qc-bot.json from the Code node sources in src/.
// Credentials and the spreadsheet ID are placeholders — pick your own after importing into n8n.
//   node tools/build-workflow.js
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const src = (f) => fs.readFileSync(path.join(root, 'src', f), 'utf8');
const withLib = (f) => src('report-lib.js') + '\n' + src(f);

const SHEET = { __rl: true, mode: 'id', value: 'REPLACE_WITH_YOUR_SPREADSHEET_ID' };
const TG = { telegramApi: { id: 'REPLACE_TELEGRAM_CREDENTIAL_ID', name: 'Telegram bot' } };
const OPENAI = { openAiApi: { id: 'REPLACE_OPENAI_CREDENTIAL_ID', name: 'OpenAI' } };
const GOOGLE = { googleApi: { id: 'REPLACE_GOOGLE_SERVICE_ACCOUNT_CREDENTIAL_ID', name: 'Google Sheets (service account)' } };
const MSG = "$('Telegram Trigger').first().json.message";
const CHAT = `={{ ${MSG}.chat.id }}`;

const JOURNAL_COLUMNS = ['venue_id', 'venue', 'ts', 'date', 'chef', 'chat_id', 'dish_id', 'dish_name', 'match_source', 'portions', 'norm_grams', 'scale_grams', 'tare_grams', 'net_grams', 'deviation_pct', 'tol_under_pct', 'tol_over_pct', 'verdict', 'visual_check', 'visual_reason', 'digits_confidence', 'photo_uid', 'tg_message_id', 'demo'];

const cond = (id, leftValue, operator, rightValue = '') => ({ id, leftValue, rightValue, operator });
const conditions = (list, combinator = 'and') => ({ options: { caseSensitive: true, leftValue: '', typeValidation: 'loose', version: 2 }, conditions: list, combinator });
const isTrue = (id, expr) => conditions([cond(id, expr, { type: 'boolean', operation: 'true', singleValue: true })]);
const startsWith = (id, prefix) => ({ conditions: { ...conditions([cond(id, `={{ ${MSG}.text }}`, { type: 'string', operation: 'startsWith' }, prefix)]), options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 } }, renameOutput: true, outputKey: prefix.slice(1) });
const sheetRead = (id, name, sheet, pos, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, position: pos, alwaysOutputData: true, onError: 'continueRegularOutput', ...extra,
  parameters: { authentication: 'serviceAccount', resource: 'sheet', operation: 'read', documentId: SHEET, sheetName: { __rl: true, mode: 'name', value: sheet }, options: {} },
  credentials: GOOGLE,
});
const tgSend = (id, name, pos, text, chatId = CHAT, extra = {}) => ({
  id, name, type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: pos, ...extra,
  parameters: { resource: 'message', operation: 'sendMessage', chatId, text, additionalFields: { appendAttribution: false } },
  credentials: TG,
});
const code = (id, name, pos, jsCode, why, extra = { onError: 'continueErrorOutput' }) => ({
  id, name, type: 'n8n-nodes-base.code', typeVersion: 2, position: pos, ...extra, notes: 'Why Code: ' + why,
  parameters: { mode: 'runOnceForAllItems', jsCode },
});
const ifNode = (id, name, pos, conds) => ({ id, name, type: 'n8n-nodes-base.if', typeVersion: 2.2, position: pos, parameters: { conditions: conds, options: {} } });
const vision = (id, name, pos) => ({
  id, name, type: '@n8n/n8n-nodes-langchain.openAi', typeVersion: 1.8, position: pos, onError: 'continueErrorOutput', retryOnFail: true, maxTries: 2, waitBetweenTries: 1500,
  parameters: { resource: 'image', operation: 'analyze', modelId: { __rl: true, mode: 'list', value: 'gpt-4o', cachedResultName: 'gpt-4o' }, text: '={{ $json.vision_prompt }}', inputType: 'base64', binaryPropertyName: 'data', options: {} },
  credentials: OPENAI,
});
// «📍 Точка» buttons — built from data/venues.csv (rebuild after adding a kitchen; «/point V5» works regardless)
const VENUES = fs.readFileSync(path.join(root, 'data', 'venues.csv'), 'utf8').replace(/^﻿/, '').trim().split(/\r?\n/).slice(1)
  .map((l) => l.split(',')).filter((v) => v[4] !== 'FALSE').map((v) => ({ id: v[0], short: v[1].replace(/^Nori Lab\s*/, '') }));
const VENUE_BUTTONS = [];
for (let i = 0; i < VENUES.length; i += 2) VENUE_BUTTONS.push({ row: { buttons: VENUES.slice(i, i + 2).map((v) => ({ text: `📍 ${v.id} · ${v.short}` })) } });
// the always-visible keyboard under the input field
const MAIN_KEYBOARD = { replyMarkup: 'replyKeyboard', replyKeyboard: { rows: [{ row: { buttons: [{ text: '📍 Точка' }, { text: '📊 Статистика' }] } }] }, replyKeyboardOptions: { resize_keyboard: true } };
const tgKeyboard = (id, name, pos, text, chatId, keyboard) => ({
  id, name, type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: pos,
  parameters: { resource: 'message', operation: 'sendMessage', chatId, text, ...keyboard, additionalFields: { appendAttribution: false } },
  credentials: TG,
});
const cacheCheck = (key, minutes) => `const sd = $getWorkflowStaticData('global');\nreturn [{ json: { fresh: !!(sd.${key} && Date.now() - sd.${key}.at < ${minutes} * 60 * 1000) } }];`;

const HELP = '👋 Бот контролю ваги страв за техкартою.\n\n'
  + '1. Обнуліть ваги з порожнім контейнером чи тарілкою (кнопка TARE / ТАРА).\n'
  + '2. Покладіть порцію і сфотографуйте так, щоб цифри на дисплеї було чітко видно — без бліку й розмиття.\n'
  + '3. У підписі до фото вкажіть назву або код страви — напр. «Філадельфія з вугрем» або «R02». Кілька порцій на вагах — допишіть «х2».\n'
  + '4. Бот відповість: ✅ у нормі, ⬇️ недовага, ⬆️ перевага, 🚫 фото не схоже на підпис, 🔎 перевірте фото, ⚠️ не вдалося визначити.\n\n'
  + 'Кнопки під полем вводу:\n📊 Статистика — ваша точка за сьогодні (/stats 7 — за тиждень · /stats all — за весь час)\n'
  + '📍 Точка — показати, куди йдуть ваші перевірки\n\n';
// the last block depends on who asks: the owner, a person with several kitchens, or a cook locked to one kitchen
const HELP_OWNER = 'Для власника мережі:\n/stats — усі точки поруч · /stats V2 — одна точка\n/report — щоденний звіт зараз\n/reload — перечитати техкарти й список кухарів\n'
  + '«📍 Точка» або код точки в підписі («R02 V3») — записати перевірку в іншу точку.';
const HELP_MULTI = 'Ви працюєте в кількох точках: перемкніть «📍 Точка» або допишіть код точки в підпис («R02 V3») — тоді ця перевірка піде у вказану точку.';
const HELP_LOCKED = ['Ваша точка — ', ' (за вашим Telegram ID). Усі ваші перевірки йдуть у неї; якщо в підписі код іншої точки — перевірку не буде записано.'];
const WHO = "$('Кухар').first().json.cook";
const HELP_TEXT = '=' + HELP + `{{ ${WHO}?.role === 'owner' ? ${JSON.stringify(HELP_OWNER)} : ${WHO}?.can_switch ? ${JSON.stringify(HELP_MULTI)} : `
  + `${JSON.stringify(HELP_LOCKED[0])} + ${WHO}?.venue_id + ' · ' + ${WHO}?.venue + ${JSON.stringify(HELP_LOCKED[1])} }}`;

const nodes = [
  // — who is writing —
  { id: 'tg_trigger', name: 'Telegram Trigger', type: 'n8n-nodes-base.telegramTrigger', typeVersion: 1.2, position: [-2380, 300], parameters: { updates: ['message'], additionalFields: { download: true } }, credentials: TG },
  code('cooks_cache', 'Кеш кухарів?', [-2160, 300], src('cooks-cache.js'), 'state across runs: the cook and kitchen lists are cached in workflow static data for 5 minutes to stay within the Google Sheets read quota; a sender missing from the cache re-reads at once.', {}),
  ifNode('cooks_fresh', 'Кухарі з кешу?', [-1940, 300], isTrue('cf', '={{ $json.fresh }}')),
  sheetRead('sheet_venues_cache', 'Точки — для кешу', 'Точки', [-1720, 440]),
  sheetRead('sheet_cooks', 'Кухарі — читання', 'Кухарі', [-1500, 440], { executeOnce: true }),
  code('cook', 'Кухар', [-1280, 300], src('cook.js'), 'looks up the sender (Telegram user ID → kitchen and role), checks that the kitchen is an active row of «Точки», and keeps both lists cached — state across runs.'),
  ifNode('known', 'Є в списку?', [-1060, 300], isTrue('kn', '={{ $json.found }}')),
  tgSend('no_access', 'Немає доступу', [-840, 560], `=👋 Вас ще немає в списку кухарів.\nВаш Telegram ID: {{ ${MSG}.from?.id ?? ${MSG}.chat.id }}\nПередайте його адміністратору — він додасть вас у лист «Кухарі» з вашою точкою.`),
  { id: 'router', name: 'Роутер', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [-840, 280],
    parameters: { rules: { values: [
      { conditions: { ...conditions([
        cond('r-stats', `={{ ${MSG}.text }}`, { type: 'string', operation: 'startsWith' }, '/stats'),
        cond('r-stats2', `={{ ${MSG}.text }}`, { type: 'string', operation: 'startsWith' }, '📊'),
      ], 'or'), options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 } }, renameOutput: true, outputKey: 'stats' },
      startsWith('r-report', '/report'),
      startsWith('r-reload', '/reload'),
      { conditions: { ...conditions([
        cond('r-pt1', `={{ ${MSG}.text }}`, { type: 'string', operation: 'startsWith' }, '/point'),
        cond('r-pt2', `={{ ${MSG}.text }}`, { type: 'string', operation: 'startsWith' }, '📍'),
        cond('r-pt3', `={{ ${MSG}.text }}`, { type: 'string', operation: 'startsWith' }, '/точка'),
      ], 'or'), options: { caseSensitive: false, leftValue: '', typeValidation: 'loose', version: 2 } }, renameOutput: true, outputKey: 'point' },
      { conditions: conditions([
        cond('r-photo', `={{ ${MSG}.photo }}`, { type: 'array', operation: 'exists', singleValue: true }),
        cond('r-doc', `={{ ${MSG}.document?.mime_type ?? '' }}`, { type: 'string', operation: 'startsWith' }, 'image/'),
      ], 'or'), renameOutput: true, outputKey: 'photo' },
    ] }, options: { fallbackOutput: 'extra', renameFallbackOutput: 'help' } } },

  // — reports and commands —
  sheetRead('sheet_log_read', 'Журнал — читання', 'Журнал', [-600, -360]),
  code('stats', 'Зведення', [-380, -360], withLib('stats.js'), 'role-aware report text: own kitchen for cooks and managers, the network or one kitchen for the owner, with per-verdict counts, averages and top dishes/cooks — one node instead of a Filter + Summarize + Sort + Aggregate + Set chain per report type.'),
  sheetRead('sheet_log_report', 'Журнал — для /report', 'Журнал', [-600, -180]),
  code('report_now', 'Звіт на вимогу', [-380, -180], withLib('report-now.js'), 'owner-only /report: builds today\'s network report with the same report-lib as the daily schedule.'),
  code('reset_cache', 'Скинути кеш', [-380, -20], src('reset-cache.js'), 'owner-only /reload: clears the cached recipe cards and cook list in workflow static data.'),
  tgSend('reply_stats', 'Відповідь статистики', [-140, -180], '={{ $json.reply }}', '={{ $json.chat_id }}'),

  // — «📍 Точка»: switch the kitchen the sender's checks are logged to —
  sheetRead('sheet_venues', 'Точки — читання', 'Точки', [-600, -620]),
  code('point', 'Точка', [-380, -620], src('point.js'), 'decides between the kitchen menu, a switch and a refusal from the sender\'s role, allowed_venues and the active kitchens; clears the cook cache on a switch (workflow static data).'),
  { id: 'point_action', name: 'Дія з точкою', type: 'n8n-nodes-base.switch', typeVersion: 3.2, position: [-160, -620],
    parameters: { rules: { values: ['set', 'menu'].map((a) => ({ conditions: conditions([cond('pa-' + a, '={{ $json.action }}', { type: 'string', operation: 'equals' }, a)]), renameOutput: true, outputKey: a })) }, options: { fallbackOutput: 'extra', renameFallbackOutput: 'deny' } } },
  { id: 'cook_update', name: 'Кухарі — змінити точку', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, position: [60, -760], onError: 'continueErrorOutput',
    parameters: { authentication: 'serviceAccount', resource: 'sheet', operation: 'update', documentId: SHEET, sheetName: { __rl: true, mode: 'name', value: 'Кухарі' },
      columns: { mappingMode: 'defineBelow', value: { chat_id: '={{ $json.chat_id }}', venue_id: '={{ $json.venue_id }}', venue: '={{ $json.venue }}' }, matchingColumns: ['chat_id'],
        schema: ['chat_id', 'venue_id', 'venue'].map((c) => ({ id: c, displayName: c, required: false, defaultMatch: c === 'chat_id', display: true, type: 'string', canBeUsedToMatch: true })) },
      options: { cellFormat: 'RAW' } },
    credentials: GOOGLE },
  tgKeyboard('point_done', 'Точку змінено', [280, -760], "={{ $('Точка').first().json.reply }}", CHAT, MAIN_KEYBOARD),
  tgKeyboard('point_menu', 'Меню точок', [60, -620], '={{ $json.reply }}', CHAT,
    { replyMarkup: 'replyKeyboard', replyKeyboard: { rows: VENUE_BUTTONS }, replyKeyboardOptions: { resize_keyboard: true } }),
  tgKeyboard('point_deny', 'Точка — відповідь', [60, -480], '={{ $json.reply }}', CHAT, MAIN_KEYBOARD),
  tgKeyboard('help', 'Допомога', [-600, 640], HELP_TEXT, CHAT, MAIN_KEYBOARD),

  // — photo check —
  { id: 'typing', name: 'Друкує…', type: 'n8n-nodes-base.telegram', typeVersion: 1.2, position: [-600, 120], onError: 'continueRegularOutput',
    parameters: { resource: 'message', operation: 'sendChatAction', chatId: CHAT, action: 'typing' }, credentials: TG },
  code('cards_cache', 'Кеш техкарт?', [-600, 300], cacheCheck('cards', 10), 'state across runs: recipe cards are cached in workflow static data for 10 minutes to stay within the Google Sheets read quota.', {}),
  ifNode('cards_fresh', 'Техкарти з кешу?', [-380, 300], isTrue('tf', '={{ $json.fresh }}')),
  sheetRead('sheet_cards', 'Техкарти — читання', 'Техкарти', [-160, 440]),
  code('match_caption', 'Підпис → кандидат', [60, 300], src('match-caption.js'), 'fuzzy matching of a free-text caption (UA/RU, aliases, R-codes, «х2») against the recipe cards, the card cache and re-sent-photo check (workflow static data) and the dynamic Vision prompt — no native node covers this.'),
  // stop before Vision: a locked cook coded another kitchen, the profile has no active kitchen, or the photo is a repeat
  ifNode('stop', 'Не записувати?', [280, 300], conditions([cond('st', '={{ $json.stop_reply }}', { type: 'string', operation: 'notEmpty', singleValue: true })])),
  tgSend('stop_reply', 'Відповідь: не записано', [500, 120], '={{ $json.stop_reply }}'),
  vision('vision', 'Vision — вага і ознаки', [500, 320]),
  // Empty answer or a refusal («I'm sorry, I can't help with that.») — anything without JSON goes to a second attempt.
  ifNode('empty', 'Порожня відповідь?', [720, 320], conditions([cond('em', "={{ String($json.content ?? '') }}", { type: 'string', operation: 'notContains' }, '{')])),
  code('retry_photo', 'Фото для повтору', [940, 480], "const p = $('Підпис → кандидат').first();\nreturn [{ json: { vision_prompt: p.json.vision_prompt_retry }, binary: p.binary }];", 'the Vision answer carries no binary — re-attach the photo from «Підпис → кандидат» and switch to the shorter retry prompt.'),
  vision('vision_retry', 'Vision — повтор', [1160, 480]),
  code('verdict', 'Вердикт', [1380, 300], src('verdict.js'), 'one node turns the Vision reading into the verdict: units, the decimal-point fix, container, portions, separate under/over tolerances, plausibility, visual confidence and the weight-based candidate search — a native chain would need a dozen IF / Set / Filter / Sort nodes.'),
  { id: 'sheet_log_append', name: 'Журнал — запис', type: 'n8n-nodes-base.googleSheets', typeVersion: 4.7, position: [1600, 300], onError: 'continueErrorOutput',
    parameters: { authentication: 'serviceAccount', resource: 'sheet', operation: 'append', documentId: SHEET, sheetName: { __rl: true, mode: 'name', value: 'Журнал' },
      columns: { mappingMode: 'autoMapInputData', value: {}, matchingColumns: [], schema: JOURNAL_COLUMNS.map((c) => ({ id: c, displayName: c, required: false, defaultMatch: false, display: true, type: 'string', canBeUsedToMatch: true })) },
      options: { cellFormat: 'RAW', handlingExtraData: 'ignoreIt' } },
    credentials: GOOGLE },
  tgSend('reply_chef', 'Відповідь кухарю', [1820, 220], "={{ $('Вердикт').item.json.reply }}"),
  tgSend('reply_nolog', 'Відповідь (журнал недоступний)', [1820, 400], "={{ $('Вердикт').item.json.reply }}\n\n⚠️ Запис у журнал не вдався — повідомте адміністратора."),
  tgSend('tech_error', 'Технічна помилка', [1380, 680], '⚠️ Технічна помилка — перевірку не виконано. Спробуйте ще раз за хвилину; якщо повторюється, повідомте адміністратора.'),

  // — daily report on a schedule —
  { id: 'daily_trigger', name: 'Щодня о 22:00', type: 'n8n-nodes-base.scheduleTrigger', typeVersion: 1.2, position: [-2160, 980],
    parameters: { rule: { interval: [{ field: 'days', daysInterval: 1, triggerAtHour: 22, triggerAtMinute: 0 }] } } },
  sheetRead('sheet_log_daily', 'Журнал — для звіту', 'Журнал', [-1940, 980], { onError: 'stopWorkflow' }),
  sheetRead('sheet_cooks_daily', 'Кухарі — для звіту', 'Кухарі', [-1720, 980], { onError: 'stopWorkflow', executeOnce: true }),
  code('daily', 'Щоденний звіт', [-1500, 980], withLib('daily.js'), 'one message per recipient: the network report for owners and the own-kitchen report for managers, built by the shared report-lib.', {}),
  tgSend('daily_send', 'Щоденний звіт — надіслати', [-1280, 980], '={{ $json.reply }}', '={{ $json.chat_id }}', { onError: 'continueRegularOutput' }),

  { id: 'note', name: 'Опис', type: 'n8n-nodes-base.stickyNote', typeVersion: 1, position: [-2200, -420], parameters: { width: 900, height: 380, content:
    '## 🍣 Sushi QC Bot — мережа кухонь, одна техкарта\n\n'
    + '**Фото:** хто пише (Telegram ID → лист «Кухарі» → точка і роль; точка має бути активною в «Точках») → код точки в підписі дозволено лише власнику та allowed_venues, закріпленому кухарю — «не записано» → фото страви на вагах (+ назва / код / «х2») → Vision читає вагу, одиниці, контейнер, звіряє ключові ознаки з техкартою → вердикт → рядок у спільний «Журнал» з точкою → відповідь кухарю.\n\n'
    + '**Вердикти:** OK · UNDER (недовага, допуск tol_under_pct) · OVER (перевага, tol_over_pct) · MISMATCH · RECHECK · LOWCONF · UNREADABLE.\n\n'
    + '**Звіти:** /stats (своя точка; власник — уся мережа або /stats V2), /report (власник, щоденний звіт зараз), щодня о 22:00 — власникам і менеджерам точок.\n'
    + '**Google Sheets:** «Техкарти», «Журнал», «Кухарі», «Точки», сторінки точок і «Мережа» (формули).\n'
    + '**Код нод** — у `src/*.js` репозиторію; цей JSON збирає `tools/build-workflow.js`.' } },
];

const link = (node) => ({ node, type: 'main', index: 0 });
const connections = {
  'Telegram Trigger': { main: [[link('Кеш кухарів?')]] },
  'Кеш кухарів?': { main: [[link('Кухарі з кешу?')]] },
  'Кухарі з кешу?': { main: [[link('Кухар')], [link('Точки — для кешу')]] },
  'Точки — для кешу': { main: [[link('Кухарі — читання')]] },
  'Кухарі — читання': { main: [[link('Кухар')]] },
  'Кухар': { main: [[link('Є в списку?')], [link('Технічна помилка')]] },
  'Є в списку?': { main: [[link('Роутер')], [link('Немає доступу')]] },
  'Роутер': { main: [[link('Журнал — читання')], [link('Журнал — для /report')], [link('Скинути кеш')], [link('Точки — читання')], [link('Друкує…'), link('Кеш техкарт?')], [link('Допомога')]] },
  'Точки — читання': { main: [[link('Точка')]] },
  'Точка': { main: [[link('Дія з точкою')], [link('Технічна помилка')]] },
  'Дія з точкою': { main: [[link('Кухарі — змінити точку')], [link('Меню точок')], [link('Точка — відповідь')]] },
  'Кухарі — змінити точку': { main: [[link('Точку змінено')], [link('Технічна помилка')]] },
  'Журнал — читання': { main: [[link('Зведення')]] },
  'Зведення': { main: [[link('Відповідь статистики')], [link('Технічна помилка')]] },
  'Журнал — для /report': { main: [[link('Звіт на вимогу')]] },
  'Звіт на вимогу': { main: [[link('Відповідь статистики')], [link('Технічна помилка')]] },
  'Скинути кеш': { main: [[link('Відповідь статистики')], [link('Технічна помилка')]] },
  'Кеш техкарт?': { main: [[link('Техкарти з кешу?')]] },
  'Техкарти з кешу?': { main: [[link('Підпис → кандидат')], [link('Техкарти — читання')]] },
  'Техкарти — читання': { main: [[link('Підпис → кандидат')]] },
  'Підпис → кандидат': { main: [[link('Не записувати?')], [link('Технічна помилка')]] },
  'Не записувати?': { main: [[link('Відповідь: не записано')], [link('Vision — вага і ознаки')]] },
  'Vision — вага і ознаки': { main: [[link('Порожня відповідь?')], [link('Технічна помилка')]] },
  'Порожня відповідь?': { main: [[link('Фото для повтору')], [link('Вердикт')]] },
  'Фото для повтору': { main: [[link('Vision — повтор')], [link('Технічна помилка')]] },
  'Vision — повтор': { main: [[link('Вердикт')], [link('Технічна помилка')]] },
  'Вердикт': { main: [[link('Журнал — запис')], [link('Технічна помилка')]] },
  'Журнал — запис': { main: [[link('Відповідь кухарю')], [link('Відповідь (журнал недоступний)')]] },
  'Щодня о 22:00': { main: [[link('Журнал — для звіту')]] },
  'Журнал — для звіту': { main: [[link('Кухарі — для звіту')]] },
  'Кухарі — для звіту': { main: [[link('Щоденний звіт')]] },
  'Щоденний звіт': { main: [[link('Щоденний звіт — надіслати')]] },
};

// Without parse_mode the Telegram node sends legacy Markdown, so an underscore in a name («@night_cook»),
// a dish or a Vision reason makes Telegram reject the message. Send HTML and escape every text instead.
const escHtml = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const escExpr = (e) => `{{ String((${e.trim()}) ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;') }}`;
for (const n of nodes) {
  if (n.type !== 'n8n-nodes-base.telegram' || n.parameters.operation !== 'sendMessage') continue;
  const t = n.parameters.text;
  n.parameters.text = t.startsWith('=')
    ? '=' + t.slice(1).split(/\{\{([\s\S]*?)\}\}/).map((part, i) => (i % 2 ? escExpr(part) : escHtml(part))).join('')
    : escHtml(t);
  n.parameters.additionalFields.parse_mode = 'HTML';
}

const workflow = {
  name: 'Sushi QC Bot — dish weight control for a network of kitchens',
  nodes, connections,
  settings: { executionOrder: 'v1', timezone: 'Europe/Kyiv', saveDataErrorExecution: 'all', saveDataSuccessExecution: 'all' },
  pinData: {}, meta: { templateCredsSetupCompleted: false },
};
const out = path.join(root, 'workflows', 'sushi-qc-bot.json');
fs.writeFileSync(out, JSON.stringify(workflow, null, 2) + '\n');
console.log(`built ${nodes.length} nodes -> ${path.relative(root, out)}`);
