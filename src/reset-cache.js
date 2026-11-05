// Code node «Скинути кеш» — /reload (owner only): forget the cached recipe cards and cook list,
// so edits in the sheet apply at once instead of within 5–10 minutes.
const msg = $('Telegram Trigger').first().json.message || {};
const chatId = String((msg.chat && msg.chat.id) ?? '');
const cook = $('Кухар').first().json.cook || {};
if (cook.role !== 'owner') return [{ json: { chat_id: chatId, reply: 'ℹ️ Команда /reload доступна лише власнику мережі.' } }];
const sd = $getWorkflowStaticData('global');
delete sd.cards; delete sd.cooks;
return [{ json: { chat_id: chatId, reply: '🔄 Кеш скинуто: наступне повідомлення прочитає техкарти й список кухарів із таблиці заново.' } }];
