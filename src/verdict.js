// Code node «Вердикт» — runs once for all items (input: the OpenAI Vision answer).
// Turns the Vision reading into a verdict and the reply text. Output: one journal row (+ reply, chat_id).
//   OK · BRAK · MISMATCH (photo ≠ caption) · RECHECK (digits unclear / implausible deviation) · LOWCONF · UNREADABLE

const N = '\n';
const DEFAULT_TOL = 2.9;   // % — used when a card has no tolerance and for «Тех карта N» captions
const PLAUSIBLE = 30;      // % — a bigger deviation is more likely a misread, a container or several portions
const MIN_DIGITS = 0.6;    // below this digits_confidence the weight is not trusted
const MIN_VISUAL = 0.7;    // MISMATCH only when Vision is at least this sure

const pre = $('Підпис → кандидат').first().json;
const msg = $('Telegram Trigger').first().json.message || {};
const cards = pre.cards || [];
const portions = pre.portions || 1;

// ---- Vision answer ----
const v = $input.first().json || {};
const vt = typeof v === 'string' ? v : (v.content ?? v.text ?? v.output ?? (v.message && v.message.content) ?? JSON.stringify(v));
let vp = {}; try { const m = String(vt).match(/\{[\s\S]*\}/); if (m) vp = JSON.parse(m[0]); } catch (e) {}
const visionEmpty = !('display_value' in vp) && !('scale_grams' in vp) && !('readable' in vp);
const toNum = x => Number(String(x ?? '').replace(',', '.'));
let value = toNum(vp.display_value ?? vp.scale_grams);
if (vp.display_value == null && vp.scale_grams == null || !Number.isFinite(value) || value <= 0) value = null;
const unit = String(vp.unit || '').toLowerCase();
const digitsConf = Number.isFinite(toNum(vp.digits_confidence)) && vp.digits_confidence !== null && vp.digits_confidence !== '' ? toNum(vp.digits_confidence) : 0.8;
const inContainer = vp.in_container === true;
const looks = String(vp.looks_like || '').slice(0, 200);
const vmatch = vp.visual_match === true ? true : (vp.visual_match === false ? false : null);
const vconf = Number.isFinite(toNum(vp.visual_confidence)) && vp.visual_confidence !== null ? toNum(vp.visual_confidence) : 0.5;
const vreason = String(vp.visual_reason || '').slice(0, 200);

// ---- weight helpers ----
const round1 = x => Math.round(x * 10) / 10;
const grams = value == null ? null : ((unit === 'kg' || unit === 'кг' || value < 10) ? round1(value * 1000) : value);
const fixDecimal = (s, n) => (s != null && n && s >= n * 3 && s / 10 >= n * 0.5 && s / 10 <= n * 1.5) ? round1(s / 10) : s;
const tolOf = c => (Number.isFinite(c.tolerance_pct) && c.tolerance_pct > 0) ? c.tolerance_pct : DEFAULT_TOL;
// Compare the reading with a norm; subtract the container only when Vision sees one AND it brings the weight closer.
const evaluate = (normTotal, pack, tol) => {
  const scale = fixDecimal(grams, normTotal);
  const devNet = (scale - normTotal) / normTotal * 100;
  let tare = 0, dev = devNet;
  if (inContainer && pack > 0) {
    const devTare = (scale - pack - normTotal) / normTotal * 100;
    if (Math.abs(devTare) < Math.abs(devNet)) { tare = pack; dev = devTare; }
  }
  return { scale, tare, net: round1(scale - tare), dev, within: Math.abs(dev) <= tol, tol };
};

// ---- which dish ----
const KINDS = [
  { re: /поке|боул|миск/, cats: ['поке'] },
  { re: /нігірі|нигири/, cats: ['нігірі'] },
  { re: /гункан|човник/, cats: ['гункани'] },
  { re: /рол|макі|маки|сет/, cats: ['роли', 'запечені роли', 'темпура роли', 'макі', 'футомакі', 'сети'] },
];
const kindHit = KINDS.find(k => k.re.test(looks.toLowerCase()));
const kindOk = c => !kindHit || kindHit.cats.includes(c.category);

let card = pre.card || null, source = pre.match_source || '', candidates = [], ev = null;
const readable = grams !== null && vp.readable !== false;
if (readable && !card && (pre.caption_candidates || []).length) {
  const tied = cards.filter(c => pre.caption_candidates.includes(c.dish_id));
  const ok = tied.map(c => ({ c, e: evaluate(c.norm_grams * portions, c.pack_grams, tolOf(c)) })).filter(x => x.e.within);
  if (ok.length === 1) { card = ok[0].c; source = 'caption'; } else candidates = tied.slice(0, 3);
} else if (!card && (pre.caption_candidates || []).length) {
  candidates = cards.filter(c => pre.caption_candidates.includes(c.dish_id)).slice(0, 3);
}
if (readable && !card && !pre.norm_from_caption && !candidates.length) {
  const sc = cards.map(c => ({ c, e: evaluate(c.norm_grams * portions, c.pack_grams, tolOf(c)) }));
  const within = sc.filter(x => x.e.within && kindOk(x.c));
  if (within.length === 1) { card = within[0].c; source = 'weight'; }
  else {
    const pool = within.length ? within : sc.filter(x => Math.abs(x.e.dev) <= 25);
    candidates = pool.slice().sort((a, b) => (kindOk(b.c) - kindOk(a.c)) || (Math.abs(a.e.dev) - Math.abs(b.e.dev))).slice(0, 3).map(x => x.c);
  }
}

// ---- verdict ----
let normTotal = null, verdict, recheckWhy = '';
const strongMismatch = !!pre.card && vmatch === false && vconf >= MIN_VISUAL;
const doubtMismatch = !!pre.card && vmatch === false && !strongMismatch;
if (visionEmpty || !readable) verdict = 'UNREADABLE';
else if (card || pre.norm_from_caption) {
  normTotal = (card ? card.norm_grams : pre.norm_from_caption) * portions;
  ev = evaluate(normTotal, card ? card.pack_grams : 0, card ? tolOf(card) : DEFAULT_TOL);
  if (!card) source = 'norm';
  if (strongMismatch) verdict = 'MISMATCH';
  else if (digitsConf < MIN_DIGITS) { verdict = 'RECHECK'; recheckWhy = 'digits'; }
  else if (Math.abs(ev.dev) > PLAUSIBLE) { verdict = 'RECHECK'; recheckWhy = 'implausible'; }
  else verdict = ev.within ? 'OK' : 'BRAK';
} else verdict = digitsConf < MIN_DIGITS ? 'RECHECK' : 'LOWCONF';
if (verdict === 'RECHECK' && !recheckWhy) recheckWhy = 'digits';

// ---- reply ----
// Near the tolerance edge show two decimals, so «+2.94%» is not displayed as «+2.9%» next to a BRAK.
const devShown = d => (ev && Math.abs(round1(d)) === ev.tol) ? Math.round(d * 100) / 100 : round1(d);
const pct = d => (d > 0 ? '+' : '') + devShown(d) + '%';
const title = card ? card.dish_id + ' · ' + card.dish_name + (portions > 1 ? ' × ' + portions : '')
  : (pre.norm_from_caption ? 'Норма з підпису: ' + pre.norm_from_caption + ' г' + (portions > 1 ? ' × ' + portions : '') : '');
const via = { caption: 'за підписом', norm: 'норма з підпису', weight: 'визначено за вагою — якщо страва інша, вкажіть назву або код у підписі' }[source] || '';
const weightLines = () => ev ? [
  'Норма: ' + normTotal + ' г ±' + ev.tol + '%',
  'На вагах: ' + ev.scale + ' г' + (ev.tare ? ' (мінус контейнер ' + ev.tare + ' г = ' + ev.net + ' г)' : ''),
  'Відхилення: ' + pct(ev.dev),
] : [];
const candLines = () => candidates.length ? ['Можливо:'].concat(candidates.map(c => '• ' + c.dish_id + ' ' + c.dish_name + ' — ' + c.norm_grams + ' г')) : [];
const doubtLine = doubtMismatch ? '⚠️ Можлива невідповідність фото підпису: ' + (vreason || 'перевірте страву') + '.' : '';
let lines;
if (verdict === 'OK') lines = ['✅ У нормі', title].concat(weightLines(), ['(' + via + ')', doubtLine]);
else if (verdict === 'BRAK') lines = ['⛔️ БРАК — поза допуском', title].concat(weightLines(), ['(' + via + ')', doubtLine, 'Записано в журнал.']);
else if (verdict === 'MISMATCH') lines = ['🚫 Фото не схоже на «' + card.dish_name + '»', 'Причина: ' + (vreason || 'ключові ознаки не збігаються з техкартою')].concat(weightLines(), ['Перевірте страву або підпис. Записано в журнал.']);
else if (verdict === 'RECHECK' && recheckWhy === 'implausible') lines = ['⚠️ Перевірте, будь ласка', title, 'На вагах: ' + ev.scale + ' г при нормі ' + normTotal + ' г (' + pct(ev.dev) + ').',
  'Можливі причини:', '• цифри прочитано неправильно — перезніміть дисплей ближче;', '• на вагах кілька порцій — допишіть «х2»;', '• зважено з посудом — обнуліть ваги з порожнім контейнером (TARE).', doubtLine, 'Записано в журнал як «перевірити».'];
else if (verdict === 'RECHECK') lines = ['⚠️ Цифри на вагах видно нечітко' + (grams != null ? ' (прочитано: ' + grams + ' г)' : '') + '.', 'Перезніміть дисплей ближче, без бліку і розмиття. Записано в журнал як «перевірити».'];
else if (verdict === 'LOWCONF') lines = ['⚠️ Не вдалося визначити позицію', (pre.caption && !pre.card && !pre.norm_from_caption && !(pre.caption_candidates || []).length) ? 'У техкарті не знайдено «' + pre.caption + '».' : '', 'На вагах: ' + (grams != null ? grams + ' г' : '—')].concat(candLines(), ['Вкажіть у підписі назву або код страви (напр. «R01»). Записано в журнал.']);
else if (visionEmpty) lines = ['❓ Сервіс розпізнавання не відповів.', 'Надішліть фото ще раз.'];
else lines = ['❓ Не вдалося зчитати цифри на вагах.', 'Сфотографуйте так, щоб дисплей ваг було чітко видно.', pre.card && vmatch === false ? 'Також фото не схоже на «' + pre.card.dish_name + '»: ' + (vreason || 'ознаки не збігаються') + '.' : '', 'Записано в журнал.'];
const reply = lines.filter(Boolean).join(N);

// ---- remember the photo (not when Vision returned nothing — the cook should resend the same photo) ----
const now = new Date();
const ts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Europe/Kyiv', dateStyle: 'short', timeStyle: 'medium' }).format(now);
if (pre.photo_uid && !visionEmpty) {
  const sd = $getWorkflowStaticData('global');
  sd.seen = sd.seen || {};
  sd.seen[pre.photo_uid] = ts;
  const keys = Object.keys(sd.seen);
  if (keys.length > 500) for (const k of keys.slice(0, keys.length - 500)) delete sd.seen[k];
}

const from = msg.from || {};
const chef = [from.first_name, from.last_name].filter(Boolean).join(' ') + (from.username ? ' (@' + from.username + ')' : '');
const visual_check = pre.card ? (vmatch === true ? 'match' : strongMismatch ? 'mismatch' : doubtMismatch ? 'doubt' : 'unsure') : 'n/a';
return [{ json: {
  ts, date: ts.slice(0, 10), chef, chat_id: String((msg.chat && msg.chat.id) ?? from.id ?? ''),
  dish_id: card ? card.dish_id : '', dish_name: card ? card.dish_name : (looks || pre.caption || ''),
  match_source: source, portions,
  norm_grams: normTotal, scale_grams: ev ? ev.scale : grams, tare_grams: ev ? ev.tare : null, net_grams: ev ? ev.net : null,
  deviation_pct: ev ? devShown(ev.dev) : null, tolerance_pct: ev ? ev.tol : null,
  verdict, visual_check,
  visual_reason: visionEmpty ? (v.content ? 'vision: відповідь без JSON — ' + String(v.content).slice(0, 80) : 'vision: порожня відповідь') : (vreason || looks),
  digits_confidence: grams != null ? digitsConf : null, photo_uid: pre.photo_uid || '',
  tg_message_id: String(msg.message_id ?? ''), reply,
} }];
