// Code node «Звіт на вимогу» — /report (owner only): today's daily report right now, to the owner who asked.
// Input: rows of the «Журнал» sheet. report-lib (RL) is inlined above by the build.
const msg = $('Telegram Trigger').first().json.message || {};
const chatId = String((msg.chat && msg.chat.id) ?? '');
const cook = $('Кухар').first().json.cook || {};
if (cook.role !== 'owner') return [{ json: { chat_id: chatId, reply: 'ℹ️ Команда /report доступна лише власнику мережі.' } }];
const readErr = $input.all().find((i) => i.json && i.json.error);
if (readErr) throw new Error('Журнал: ' + readErr.json.error);
const rows = $input.all().map((i) => i.json);
const t = RL.today();
const reply = '🗓 Щоденний звіт\n\n' + RL.networkReport(RL.filterRows(rows, { from: t }), 'за сьогодні (' + t + ')');
return [{ json: { chat_id: chatId, reply: reply.slice(0, 3900) } }];
