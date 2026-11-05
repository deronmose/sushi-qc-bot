// Code node «Точка» — «📍 Точка», «/point» or «/point V2»: show the kitchen buttons or switch the sender's kitchen.
// Input: rows of the «Точки» sheet. Output: { action: menu | set | deny, chat_id, reply, venue_id?, venue? }.
// The owner may switch to any active kitchen; others only to the kitchens in their allowed_venues column.
const readErr = $input.all().find((i) => i.json && i.json.error);
if (readErr) throw new Error('Точки: ' + readErr.json.error);
const msg = $('Telegram Trigger').first().json.message || {};
const cook = $('Кухар').first().json.cook || {};
// the sender's Telegram user ID — the key of their row in «Кухарі»
const chatId = cook.chat_id || String((msg.from && msg.from.id) ?? (msg.chat && msg.chat.id) ?? '');
const isActive = (v) => v === true || ['TRUE', '1', 'ТАК', 'YES'].includes(String(v ?? '').trim().toUpperCase());
const venues = $input.all().map((i) => i.json)
  .filter((v) => v && v.venue_id && isActive(v.active))
  .map((v) => ({ id: String(v.venue_id).trim().toUpperCase(), name: String(v.name || v.venue_id) }));
const allowedIds = cook.role === 'owner' ? venues.map((v) => v.id) : (cook.allowed || []);
const current = venues.find((v) => v.id === cook.venue_id);
const now = '📍 Зараз ваші перевірки йдуть у ' + (current ? current.id + ' · ' + current.name : (cook.venue_id || '—')) + '.';

const m = String(msg.text || '').match(/(?:^|\s|📍)\s*[vв]\s?(\d{1,2})(?!\d)/i);
const want = m ? 'V' + Number(m[1]) : null;
if (!want) {
  if (allowedIds.length < 2) return [{ json: { action: 'deny', chat_id: chatId, reply: now + '\nВас закріплено за цією точкою. Якщо вас перевели на іншу — попросіть адміністратора змінити її у списку кухарів.' } }];
  const list = venues.filter((v) => allowedIds.includes(v.id)).map((v) => (v.id === cook.venue_id ? '• ' : '  ') + v.id + ' · ' + v.name);
  return [{ json: { action: 'menu', chat_id: chatId, reply: now + '\n\nОберіть точку кнопкою нижче:\n' + list.join('\n') } }];
}
const target = venues.find((v) => v.id === want);
if (!target) return [{ json: { action: 'deny', chat_id: chatId, reply: 'Точки ' + want + ' немає серед активних у листі «Точки».' } }];
if (!allowedIds.includes(want)) return [{ json: { action: 'deny', chat_id: chatId, reply: '⛔ Ви не можете надсилати перевірки від імені ' + want + '. ' + now } }];
if (want === cook.venue_id) return [{ json: { action: 'deny', chat_id: chatId, reply: now + ' Нічого не змінено.' } }];
const sd = $getWorkflowStaticData('global');
delete sd.cooks; // the cook list changes — re-read it on the next message
return [{ json: { action: 'set', chat_id: chatId, venue_id: target.id, venue: target.name,
  reply: '✅ Точку змінено: тепер ваші перевірки йдуть у ' + target.id + ' · ' + target.name + '.\nЩоб повернутися — «📍 Точка».' } }];
