// Code node «Підпис → кандидат» — runs once for all items. Input: rows of the «Техкарти» sheet, or one
// {fresh: true} item when the cached cards (workflow static data, refreshed every 10 minutes or by /reload) are valid.
// Picks the kitchen (profile or a code in the caption, with the lock check), matches the cook's caption to a recipe
// card, parses portions («х2»), checks for a re-sent photo and builds the Vision prompt.
// Output: one item with the photo binary passed through; a non-empty stop_reply means «answer this, log nothing».

const sd = $getWorkflowStaticData('global');
const inRows = $input.all().map(i => i.json);
const readErr = inRows.find(r => r && r.error);
if (readErr) throw new Error('Техкарти: ' + readErr.error);
let sheetRows;
if (inRows.some(r => r && r.dish_id)) { sheetRows = inRows; sd.cards = { at: Date.now(), rows: inRows }; }
else if (sd.cards && sd.cards.rows) sheetRows = sd.cards.rows;
else throw new Error('Техкарти: немає даних');

const trig = $('Telegram Trigger').first();
const msg = trig.json.message || {};
const rawCaption = String(msg.caption || '').trim();
let cook = null;
try { cook = $('Кухар').first().json.cook || null; } catch (e) { /* only in offline tests */ }

// Which kitchen gets this check. By default — the kitchen in the sender's profile (Telegram ID → «Кухарі»).
// A kitchen code in the caption («R02 V3») sends this one check elsewhere, but only for the owner and for people
// who have that kitchen in allowed_venues. A cook locked to one kitchen who writes another kitchen's code gets a
// warning and nothing is logged — so the wrong kitchen's statistics are not spoiled and no duplicate appears later.
const VENUE_RE = /(?:^|[\s,;:(])📍?\s*[VvВв](\d{1,2})(?![\d\p{L}])/u;
const vm = rawCaption.match(VENUE_RE);
const wantVenue = vm ? 'V' + Number(vm[1]) : null;
let venueId = cook ? cook.venue_id : '', venueName = cook ? cook.venue : '', stopReply = '';
if (cook) {
  const known = cook.venues && cook.venues.length ? cook.venues : null;
  const own = cook.venue_id + (cook.venue ? ' · ' + cook.venue : '');
  const target = known && wantVenue ? known.find((v) => v.id === wantVenue) : null;
  if (cook.venue_ok === false) {
    stopReply = '⛔ Ваш профіль не прив\'язано до активної точки (у листі «Кухарі»: «' + (cook.venue_id || '—') + '»).\nПеревірку не записано — зверніться до адміністратора.';
  } else if (wantVenue && wantVenue !== cook.venue_id) {
    if (known && !target) stopReply = '⛔ Точки ' + wantVenue + ' немає серед активних.\nПеревірку не записано. Надішліть фото без коду точки — воно піде у вашу точку (' + own + ').';
    else if (cook.role === 'owner' || (cook.allowed || []).includes(wantVenue)) { venueId = wantVenue; venueName = target ? target.name : wantVenue; }
    else stopReply = '⛔ Ви закріплені за точкою ' + own + ', а в підписі вказано ' + wantVenue + (target ? ' · ' + target.name : '') + '.\n'
      + 'Перевірку не записано, щоб не зіпсувати статистику точок. Надішліть фото ще раз без коду точки — воно піде у вашу точку.';
  }
}

const isActive = v => v === true || ['TRUE', '1', 'ТАК', 'YES'].includes(String(v ?? '').trim().toUpperCase());
const num = v => (v === '' || v == null) ? NaN : Number(String(v).replace(',', '.'));
const cards = sheetRows
  .filter(c => c && c.dish_id && c.dish_name && isActive(c.active))
  .map(c => ({
    dish_id: String(c.dish_id).trim().toUpperCase(),
    dish_name: String(c.dish_name).trim(),
    aliases: String(c.aliases || ''),
    category: String(c.category || ''),
    norm_grams: num(c.norm_grams),
    tol_under: num(c.tol_under_pct ?? c.tolerance_pct),
    tol_over: num(c.tol_over_pct ?? c.tolerance_pct),
    pack_grams: Number.isFinite(num(c.pack_grams)) ? num(c.pack_grams) : 0,
    must_have: String(c.must_have || c.visual_features || ''),
    may_vary: String(c.may_vary || ''),
  }))
  .filter(c => Number.isFinite(c.norm_grams) && c.norm_grams > 0);
if (!cards.length) throw new Error('Техкарти: немає жодної активної позиції');

// Portions: «х2», «x2», «2х», «2 порції» → the norm is multiplied.
const PORTIONS_RE = /(?:^|\s)(?:[xх×*]\s?(\d{1,2})|(\d{1,2})\s?[xх×])(?=\s|$)|(\d{1,2})\s*(?:порц\S*|porc\S*)/i;
const noVenue = vm ? rawCaption.replace(VENUE_RE, ' ').trim() : rawCaption;
const pm = noVenue.match(PORTIONS_RE);
const pn = pm ? Number(pm[1] || pm[2] || pm[3]) : 1;
const portions = pn >= 1 && pn <= 10 ? pn : 1;
const caption = pm ? noVenue.replace(PORTIONS_RE, ' ').trim() : noVenue;

// Ukrainian and Russian spellings fold to one form: «Філадельфія» = «Филадельфия», «Зелений» = «Зеленый».
const norm = s => String(s || '').toLowerCase()
  .replace(/[іїийы]/g, 'и').replace(/[єэё]/g, 'е').replace(/ґ/g, 'г').replace(/[ьъ'’`]/g, '')
  .replace(/[^a-zа-я0-9]+/g, ' ').replace(/\s+/g, ' ').trim();
const toks = s => norm(s).split(' ').filter(w => w.length >= 3 && !/\d/.test(w));
const names = c => [c.dish_name].concat(c.aliases.split(';')).map(norm).filter(Boolean);
const sameWord = (w, x) => x === w || x.startsWith(w) || w.startsWith(x) || (w.length >= 4 && x.includes(w));

let card = null, captionCandidates = [], normFromCaption = null, idGiven = false;
if (caption) {
  const capN = norm(caption);
  const idm = caption.match(/(?:^|[^a-zа-яіїєґ])[rр]\s?-?(\d{1,3})(?!\d)/i);
  if (idm) { idGiven = true; const id = 'R' + String(Number(idm[1])).padStart(2, '0'); card = cards.find(c => c.dish_id === id) || null; }
  if (!card) card = cards.find(c => names(c).includes(capN)) || null;
  if (!card) {
    const capW = toks(caption);
    if (capW.length) {
      const need = Math.max(1, Math.ceil(capW.length * 0.5));
      let bestS = 0, best = [];
      for (const c of cards) {
        const nt = names(c).flatMap(n => n.split(' ')).filter(w => w.length >= 3);
        let s = 0; for (const w of capW) if (nt.some(x => sameWord(w, x))) s++;
        if (s > bestS) { bestS = s; best = [c]; } else if (s === bestS && s > 0) best.push(c);
      }
      if (bestS >= need) { if (best.length === 1) card = best[0]; else captionCandidates = best.map(c => c.dish_id); }
    }
  }
  if (!card && !captionCandidates.length && !idGiven) {
    const gm = caption.match(/(\d{2,4})(?:[.,]\d+)?\s*(?:г|гр|g)?(?![\d])/i);
    if (gm) { const n = Number(gm[1]); if (n >= 20 && n <= 5000) normFromCaption = n; }
  }
}

// Same photo FILE sent again? Telegram gives every new camera shot its own file_unique_id, so identical-looking
// portions never collide — only a re-sent file does. A re-sent file with a different caption (or after an
// unfinished check) is a correction and is checked again; the same file with the same caption after a final
// verdict is stopped. Entries are recorded by «Вердикт».
const photos = msg.photo || [];
const photoUid = String((photos.length ? photos[photos.length - 1].file_unique_id : (msg.document && msg.document.file_unique_id)) || '');
const seenRaw = photoUid ? (sd.seen || {})[photoUid] : null;
// older records are a bare timestamp without caption or verdict — treat them as unfinished, so they can be re-checked
const seen = seenRaw ? (typeof seenRaw === 'string' ? { ts: seenRaw, caption: null, final: false } : seenRaw) : null;
const sameCaption = seen && (seen.caption === null || norm(seen.caption) === norm(rawCaption));
const duplicateOf = !stopReply && seen && seen.final && sameCaption ? seen.ts : '';
const recheckOf = seen && !duplicateOf ? seen.ts : '';
if (duplicateOf) stopReply = '♻️ Це саме фото з тим самим підписом уже перевіряли (' + duplicateOf + ').\n'
  + 'Нова порція — сфотографуйте її ще раз. Помилилися з підписом — надішліть це фото з правильним підписом, і бот перевірить його знову.';

const base = 'Ти допомагаєш кухні ресторану контролювати вагу порцій: на фото — страва, яку кухар зважив на кухонних вагах. '
  + '1) Дисплей ваг: перепиши показання у display_text (з крапкою чи комою, напр. 384.8 або 0.410) і поверни число в display_value. '
  + 'unit — g або kg (позначка kg або число на кшталт 0.410 — це kg). '
  + 'digits_confidence від 0 до 1 — наскільки чітко видно кожну цифру. Якщо фото розмите, стиснуте, під кутом або цифри частково закриті бліком — низька впевненість; не вгадуй цифри. '
  + 'Якщо ваг або дисплея на фото немає — це нормально: readable=false, display_value=null, решту полів заповни. '
  + '2) Коротко опиши страву українською (looks_like): тип (рол / макі / нігірі / гункан / сет / поке), що зверху, колір, сира риба чи запечена / у клярі. '
  + '3) in_container — true, якщо страва лежить у контейнері, коробці чи мисці.';
const check = card
  ? ' 4) Кухар підписав фото як «' + card.dish_name + '». Ключові ознаки цієї страви: ' + card.must_have + '. '
    + 'Допустимі відмінності (НЕ причина невідповідності): ' + (card.may_vary || '—') + '; також будь-який додатковий гарнір, соус, зелень, посипка чи упаковка. '
    + 'visual_match=false, якщо частину страви, де має бути ключова ознака, ВИДНО, але там інше (інша риба чи топінг, інше покриття, запечене замість сирого, інший тип страви). '
    + 'visual_match=null лише якщо цю частину страви НЕ видно на фото (закрито, поза кадром, надто темно). '
    + 'visual_confidence від 0 до 1 — наскільки ти впевнений у visual_match.'
  : ' 4) Підпису зі стравою немає: visual_match=null.';
const fmt = ' Відповідай ЛИШЕ валідним JSON одним рядком без markdown: {"display_text": "<як на дисплеї>", "display_value": <число або null>, "unit": "g|kg", "digits_confidence": <0..1>, "readable": <true|false>, "in_container": <true|false>, "looks_like": "<короткий опис>", "visual_match": <true|false|null>, "visual_confidence": <0..1>, "visual_reason": "<коротко чому, або порожньо>"}.';
// Shorter wording for the second attempt, so a refusal of the first prompt is not simply repeated.
const retryPrompt = 'Фото з кухні ресторану: порція страви на кухонних вагах (ваг може й не бути в кадрі). '
  + 'Відповідай ЛИШЕ JSON одним рядком: {"display_text": "<цифри на дисплеї або порожньо>", "display_value": <число або null>, "unit": "g|kg", "digits_confidence": <0..1>, "readable": <true якщо цифри видно>, "in_container": <true|false>, "looks_like": "<що за страва, українською>", '
  + (card ? '"visual_match": <true якщо схоже на «' + card.dish_name + '» (' + card.must_have + '), false якщо видно, що ні, null якщо не видно>, "visual_confidence": <0..1>, "visual_reason": "<коротко>"}.'
    : '"visual_match": null, "visual_confidence": 0, "visual_reason": ""}.');

return [{
  json: {
    caption: rawCaption, card, portions,
    match_source: card ? 'caption' : (normFromCaption ? 'norm' : ''),
    caption_candidates: captionCandidates, norm_from_caption: normFromCaption,
    photo_uid: photoUid, duplicate_of: duplicateOf, recheck_of: recheckOf,
    venue_id: venueId, venue: venueName, stop_reply: stopReply,
    cards, vision_prompt: base + check + fmt, vision_prompt_retry: retryPrompt,
  },
  binary: trig.binary,
}];
