(() => {
'use strict';
/* global api, Sound, I18N */
// Ayarlar ve Boss penceresi: bağımsız şeffaf pencere olarak animasyonlu açılır/kapanır.

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
const fmt1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
const EARLY = [[0, 'none'], [500, '0.5 s'], [1000, '1 s'], [2000, '2 s'], [3000, '3 s']];
const t = (x) => (typeof I18N !== 'undefined' ? I18N.t(x) : x);
const clock = (ms) => {
  const s = Math.floor((ms || 0) / 1000);
  const m = Math.floor(s / 60);
  return `${m}:${String(s % 60).padStart(2, '0')}`;
};
const short = (n) => (n >= 1e6 ? fmt1.format(n / 1e6) + 'M' : n >= 1e4 ? fmt1.format(n / 1e3) + 'K' : Math.round(n || 0).toLocaleString('en-US'));
const pct = (x) => ((x || 0) * 100).toFixed(1) + '%';
const localName = (n) => (n ? String(n) : t('Unknown'));

// Faz 8.13: yayıncı modu (yalnız gösterim; kayıtlar ve puanlama dosyası değişmez). Bayraklar her 'state' olayında güncellenir.
const masker = (typeof MASK !== 'undefined') ? MASK.createClient() : null; // tablo ana süreçten gelir (state.mask)
let streamer = false;
let recapOn = true;
let pbOn = true;
function dispName(name, cls, own) {
  if (!streamer || !masker) return localName(name);
  const lab = masker.alias(name, cls, !!own, t('Me'));
  const m = /^(.+?) (\d+)$/.exec(lab);
  return m ? t(m[1]) + ' ' + m[2] : lab;
}
const openDeaths = new Set(); // Faz 8.9: açık ölüm özeti satırları (oyuncu:zaman)

let data = null;
let customs = [];
let isOpen = false;

// ---------------------------------------------------------------------------
// Sekmeler ve Pencere Kontrolleri
// ---------------------------------------------------------------------------

let currentTab = 'general';
let lastBossState = null;
let lastBossEnc = null;

function isTabActive(name) {
  return currentTab === name;
}

function showTab(name) {
  currentTab = name;
  for (const b of document.querySelectorAll('.seg button')) b.classList.toggle('on', b.dataset.tab === name);
  for (const s of document.querySelectorAll('#drawer .tab')) s.classList.toggle('on', s.id === 'tab-' + name);
  if (name === 'boss') bossTabShown();
  if (name === 'timers') startTimers(); else stopTimers();
}
for (const b of document.querySelectorAll('.seg button')) b.onclick = () => showTab(b.dataset.tab);

// Ayarlar sekmesi: solda bölüm listesi, sağda seçili bölümün ayarları (liste ui/setsections.js)
function showSection(id) {
  const S = SETSECTIONS;
  if (!S.isSection(id)) id = S.DEFAULT_SECTION;
  for (const b of document.querySelectorAll('#setNav button')) { const on = b.dataset.sec === id; b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  for (const p of document.querySelectorAll('#setBody .set-pane')) p.hidden = p.dataset.pane !== id;
  const body = $('setBody');
  if (body) body.scrollTop = 0;
  try { localStorage.setItem('daeva.lastSection', id); } catch {}
}
{
  const nav = $('setNav');
  for (const s of SETSECTIONS.SECTIONS) {
    const b = document.createElement('button');
    b.type = 'button'; b.dataset.sec = s.id; b.textContent = s.label;
    if (s.last) b.classList.add('last');
    b.onclick = () => showSection(s.id);
    nav.appendChild(b);
    const pane = document.querySelector('#setBody .set-pane[data-pane="' + s.id + '"]');
    if (pane) {
      const h = document.createElement('div');
      h.className = 'sp-head';
      const t1 = document.createElement('h3'); t1.textContent = s.label;
      const t2 = document.createElement('p'); t2.textContent = s.desc;
      h.appendChild(t1); h.appendChild(t2);
      pane.insertBefore(h, pane.firstChild);
    }
  }
  let startSec = SETSECTIONS.DEFAULT_SECTION;
  try { startSec = SETSECTIONS.pickSection(localStorage.getItem('daeva.lastSection')); } catch {}
  showSection(startSec);
  const go = $('gotoSkills');
  if (go) go.onclick = () => showTab('skills');
  const gs = $('gotoSounds');
  if (gs) gs.onclick = () => { showTab('general'); showSection('sounds'); };
}

// ---------------------------------------------------------------------------
// Zamanlayıcılar sekmesi (Faz 8.3): saatler ana süreçte yerel hesaplanır, burada yalnız gösterilir
// ---------------------------------------------------------------------------
const TIMER_REGIONS = [
  ['asia-kr', 'Korea (Asia/Seoul)'], ['asia-tw', 'Taiwan (Asia/Taipei)'],
  ['global-asia', 'Global - Asia (Asia/Seoul)'],
  ['global-na-east', 'Global - North America East (America/New_York)'], ['global-na-west', 'Global - North America West (America/Los_Angeles)'],
  ['global-eu', 'Global - Europe (Europe/Berlin)'], ['global-sa', 'Global - South America (America/Sao_Paulo)'],
];
let timerPoll = null;
const timerRows = new Map();
const hms = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const p2 = (n) => String(n).padStart(2, '0');
  return h >= 24 ? `${Math.floor(h / 24)}d ${p2(h % 24)}:${p2(m)}:${p2(s % 60)}` : `${p2(h)}:${p2(m)}:${p2(s % 60)}`;
};
const localTime = (ms) => new Date(ms).toLocaleString(undefined, { weekday: 'short', hour: '2-digit', minute: '2-digit' });
function renderTimers(r) {
  if (!r) return;
  const alarms = (data && data.settings.timerAlarms) || {};
  const box = $('timerList');
  const skew = Date.now() - r.now;
  for (const ev of r.events) {
    let row = timerRows.get(ev.id);
    if (!row) {
      const el = document.createElement('label');
      el.className = 'tgl';
      el.innerHTML = '<input type="checkbox"><i></i><span><b></b><small></small></span><em class="num" style="margin-left:auto"></em>';
      el.querySelector('input').onchange = (e) => {
        const cur = { ...((data && data.settings.timerAlarms) || {}) };
        if (e.target.checked) cur[ev.id] = true; else delete cur[ev.id];
        if (data) data.settings.timerAlarms = cur;
        api.setSettings({ timerAlarms: cur });
      };
      row = { el, cb: el.querySelector('input'), b: el.querySelector('b'), small: el.querySelector('small'), em: el.querySelector('em') };
      timerRows.set(ev.id, row);
    }
    row.cb.checked = alarms[ev.id] === true;
    row.b.textContent = t(ev.name);
    row.ev = ev; row.skew = skew;
    row.el.title = t('Alarm');
  }
  // yaklaşan sırayla yeniden diz
  for (const ev of r.events) box.appendChild(timerRows.get(ev.id).el);
  $('timerReset').textContent = t('Daily reset') + ': ' + (r.reset.daily ? localTime(r.reset.daily) : '-') + ' · ' + t('Weekly reset') + ': ' + (r.reset.weekly ? localTime(r.reset.weekly) : '-');
  tickTimers();
}
function tickTimers() {
  const now = Date.now();
  let stale = false;
  for (const row of timerRows.values()) {
    const ev = row.ev;
    if (!ev) continue;
    const n = now - row.skew;
    if (ev.active && n < ev.active.end) { row.small.textContent = t('Active') + ' · ' + t('ends in') + ' ' + hms(ev.active.end - n); row.em.textContent = ''; continue; }
    if (ev.active) stale = true;
    if (ev.next == null) { row.small.textContent = '-'; row.em.textContent = ''; continue; }
    if (n >= ev.next) stale = true;
    row.small.textContent = localTime(ev.next);
    row.em.textContent = hms(ev.next - n);
  }
  if (stale) pollTimers();
}
async function pollTimers() {
  try { renderTimers(await api.getTimers()); } catch {}
}
function startTimers() {
  if (timerPoll) return;
  pollTimers();
  timerPoll = setInterval(tickTimers, 1000);
}
function stopTimers() {
  if (timerPoll) { clearInterval(timerPoll); timerPoll = null; }
}
{
  const sel = $('timerRegion');
  for (const [v, l] of TIMER_REGIONS) { const o = document.createElement('option'); o.value = v; o.textContent = t(l); sel.appendChild(o); }
  sel.onchange = async () => { await api.setSettings({ timerRegion: sel.value }); pollTimers(); };
  $('timersOn').onchange = () => { api.setSettings({ timersOn: $('timersOn').checked }); $('tab-timers').classList.toggle('dis', !$('timersOn').checked); };
}

// Faz 9: zamanlayıcı uyarı ayarları (tür, eşikler, ses, ses seviyesi, ekran kutusu, savaşta sessiz)
const TIMER_STEP_CHOICES = [[15, '15 min'], [10, '10 min'], [5, '5 min'], [1, '1 min'], [0, 'At start']];
const TIMER_SOUNDS = [['chime', 'Chime'], ['can', 'Bell'], ['gong', 'Gong'], ['ping', 'Ping'], ['soft', 'Soft'], ['alarm', 'Alarm'], ['horn', 'Horn'], ['harp', 'Harp'], ['bip', 'Beep'], ['yukselen', 'Rising']];
let timerSteps = new Set([10, 5, 1, 0]);
{
  const box = $('timerSteps');
  for (const [v, l] of TIMER_STEP_CHOICES) {
    const b = document.createElement('button');
    b.dataset.v = String(v);
    b.textContent = t(l);
    b.onclick = () => {
      if (timerSteps.has(v)) timerSteps.delete(v); else timerSteps.add(v);
      b.classList.toggle('on', timerSteps.has(v));
      b.setAttribute('aria-pressed', String(timerSteps.has(v)));
      const arr = [...timerSteps].sort((a, c) => c - a);
      if (data) data.settings.timerAlertSteps = arr;
      api.setSettings({ timerAlertSteps: arr });
    };
    box.appendChild(b);
  }
  const sel = $('timerSound');
  for (const [v, l] of TIMER_SOUNDS) { const o = document.createElement('option'); o.value = v; o.textContent = t(l); sel.appendChild(o); }
  const vol = () => Number($('timerVolume').value) / 100;
  sel.onchange = () => { api.setSettings({ timerSound: sel.value }); Sound.play(sel.value, vol()); };
  $('timerSoundTest').onclick = () => Sound.play(sel.value, vol());
  $('timerVolume').oninput = () => { $('timerVolumeV').textContent = $('timerVolume').value + '%'; };
  $('timerVolume').onchange = () => { api.setSettings({ timerVolume: Number($('timerVolume').value) }); Sound.play(sel.value, vol()); };
  $('timerAlertMode').onchange = () => { api.setSettings({ timerAlertMode: $('timerAlertMode').value }); syncTimerAlertUi(); };
  $('timerBeep').onchange = () => { api.setSettings({ timerBeep: $('timerBeep').checked }); syncTimerAlertUi(); };
  $('timerTts').onchange = () => { api.setSettings({ timerTts: $('timerTts').checked }); syncTimerAlertUi(); };
  $('timerToastMode').onchange = () => { api.setSettings({ timerToastMode: $('timerToastMode').value }); syncTimerAlertUi(); };
  $('timerToastSec').onchange = () => api.setSettings({ timerToastSec: Math.max(3, Math.min(300, Number($('timerToastSec').value) || 15)) });
  $('timerCombat').onchange = () => api.setSettings({ timerCombat: $('timerCombat').value });
  $('timerTest').onclick = () => api.timerTest();
}
// Bağımlı satırlar: üst ayar kapalıyken soluk ve tıklanamaz
function syncTimerAlertUi() {
  const mode = $('timerAlertMode').value;
  const snd = mode === 'sound' || mode === 'both';
  const txt = mode === 'text' || mode === 'both';
  const off = mode === 'off';
  $('timerStepsField').classList.toggle('dis', off);
  const beep = $('timerBeep').checked;
  $('timerBeepField').classList.toggle('dis', !snd);
  $('timerSoundField').classList.toggle('dis', !snd || !beep);
  $('timerVolumeField').classList.toggle('dis', !snd || (!beep && !$('timerTts').checked));
  $('timerTtsField').classList.toggle('dis', !snd);
  $('timerToastModeField').classList.toggle('dis', !txt);
  $('timerToastSecField').classList.toggle('dis', !txt || $('timerToastMode').value === 'hold');
  $('timerCombatField').classList.toggle('dis', off);
}
function loadTimerAlertUi(s) {
  $('timerAlertMode').value = s.timerAlertMode || 'off';
  timerSteps = new Set(Array.isArray(s.timerAlertSteps) ? s.timerAlertSteps : [10, 5, 1, 0]);
  for (const b of $('timerSteps').children) { const on = timerSteps.has(Number(b.dataset.v)); b.classList.toggle('on', on); b.setAttribute('aria-pressed', String(on)); }
  $('timerSound').value = s.timerSound || 'chime';
  $('timerVolume').value = typeof s.timerVolume === 'number' ? s.timerVolume : 70;
  $('timerVolumeV').textContent = $('timerVolume').value + '%';
  $('timerBeep').checked = s.timerBeep === true;
  $('timerTts').checked = s.timerTts === true;
  $('timerToastMode').value = s.timerToastMode || 'auto';
  $('timerToastSec').value = s.timerToastSec || 15;
  $('timerCombat').value = s.timerCombat || 'quiet';
  syncTimerAlertUi();
}

// ---------------------------------------------------------------------------
// Oyuncu değerlendirme ("Boss ve Oyuncular" ekranının sağ sütunu): yalnız bir boss/sabit kart seçilince görünür.
// Oyuncular defterden (rate-data) gelir; yerel dosya, ağ yok.
// ---------------------------------------------------------------------------
const RT_TAGS = [['good', 'Good', false], ['slow', 'Slow', true], ['afk', 'AFK', true], ['loot', 'Loot', true]]; // [kod, etiket, olumsuz mu]
const RT_COLORS = ['#e0b65c', '#7cc4e8', '#e2675c', '#6fd69a', '#b690e8'];
let plData = null;       // ana süreçten 'rate-data': { on, encs, total, rated, black, servers, mask }
let plNames = null;      // fk → oyuncu adları (arama için, tembel)
let rtFilter = 'all';    // all | todo | black
let rtScroll = false;    // bir sonraki çizimde seçili kartı/oyuncu satırını kaydır
let rtNoteKey = '';      // notu açık oyuncunun kimliği (ad|sunucu)
let rtNoteDraft = '';    // yazılmakta olan not (yeniden çizimde korunur)
let rtFocus = '';        // sağ tıkla gelen oyuncunun kimliği (ad|sunucu): satır vurgulanır ve görünür alana kaydırılır
let rtHtml = '';         // son çizilen oyuncu listesi (aynıysa DOM'a dokunulmaz: 4 Hz state odağı/kaydırmayı bozmasın)
// Sunucu etiketi (tablo ana süreçten gelir); yayıncı modunda yalnız oyuncu adı maskelenir
const srvLabel = (id) => (typeof SERVERS !== 'undefined' ? SERVERS.serverLabel(id, plData && plData.servers) : '?');
const srvNum = (v) => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : 0; };
const pairOf = (name, server) => String(name).toLowerCase() + '|' + (srvNum(server) || ''); // ratings.pairKey / ledger.pidOf ile aynı biçim
// Ad: yayıncı modunda ana sürecin gönderdiği tablo (plData.mask), yoksa state tablosu
function plDisp(name) {
  if (!streamer) return localName(name);
  const lab = plData && plData.mask ? plData.mask[MASK.keyOf(name)] : null;
  if (!lab) return dispName(name, null, false);
  const m = /^(.+?) (\d+)$/.exec(lab);
  return m ? t(m[1]) + ' ' + m[2] : (lab === 'Me' ? t('Me') : lab);
}
const dateText = (ms) => (ms ? new Date(ms).toLocaleDateString(I18N.getLang() === 'tr' ? 'tr-TR' : 'en-GB') : '');
const timeText = (ms) => new Date(ms).toLocaleTimeString(I18N.getLang() === 'tr' ? 'tr-TR' : 'en-GB', { hour: '2-digit', minute: '2-digit' });
const dayLabel = (ms) => {
  const d = new Date(ms); const n = new Date();
  const same = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
  if (same(d, n)) return t('Today');
  n.setDate(n.getDate() - 1);
  return same(d, n) ? t('Yesterday') : dateText(ms);
};
// Sabit kartlar: 'live' = şimdiki parti / sürmekte olan savaş, 'pick' = panelde sağ tıklanan oyuncu, 'rated' = puanlanan herkes
const rtTitle = (e) => (e.kind === 'live' ? t('Current party') + (e.boss ? ' · ' + e.boss : '') : e.kind === 'pick' ? t('Selected player') : e.kind === 'rated' ? t('All rated players') : e.boss);
const clsName = (c) => (typeof KEYSKILLS !== 'undefined' && KEYSKILLS.CLASS_NAMES[c] ? t(KEYSKILLS.CLASS_NAMES[c]) : '');
const rtShort = (srv) => srvLabel(srv).replace(/ \((.+)\)$/, ' · $1'); // "Siel (EU)" → "Siel · EU"
const rtEnc = () => (plData && plData.encs && bhSel ? plData.encs.find((e) => e.fk === bhSel) || null : null);
const rtShown = (p) => BOSSHIST.playerShown(p, rtFilter);
const RT_CHIPS = [['all', 'Show all'], ['todo', 'Unrated'], ['black', 'Blacklist']];
{
  const chips = $('rtChips');
  for (const [id] of RT_CHIPS) { const b = document.createElement('button'); b.dataset.f = id; chips.appendChild(b); }
  chips.onclick = (e) => { const b = e.target.closest('button'); if (b) { rtFilter = b.dataset.f; rtHtml = ''; rtRender(); } };
}
function rtRender() {
  const wrap = $('bcPlayersWrap');
  const box = $('rtPlayers');
  // Oyuncular yalnız bir boss / sabit kart seçiliyken görünür
  if (!BOSSHIST.playersVisible({ fk: bhSel, run: bhRunSel })) { wrap.hidden = true; rtHtml = ''; return; }
  wrap.hidden = false;
  const cur = rtEnc();
  const off = !!(plData && plData.on === false);
  $('rtChips').hidden = off || !cur;
  for (const b of $('rtChips').children) { b.classList.toggle('on', b.dataset.f === rtFilter); b.textContent = t(RT_CHIPS.find((c) => c[0] === b.dataset.f)[1]); }
  $('rtSelTitle').textContent = t('Players') + (cur ? ' · ' + cur.count : '');
  let html;
  if (off) { $('rtSummary').textContent = ''; html = '<p class="hint">' + esc(t('Player ratings are off. Turn them on in Settings.')) + '</p>'; }
  else if (!cur) { $('rtSummary').textContent = ''; html = '<p class="hint">' + esc(plData ? t('No players were recorded for this fight.') : t('Loading report…')) + '</p>'; }
  else {
    const rated = cur.players.filter((p) => p.rating > 0).length;
    $('rtSummary').textContent = t('Rated') + ' ' + rated + ' / ' + cur.count + ' · ' + t('Blacklist') + ' ' + cur.bl;
    const list = cur.players.filter(rtShown);
    html = !list.length ? '<p class="hint">' + esc(t('No players in this filter.')) + '</p>' : list.map((p) => {
      const nm = plDisp(p.n);
      const together = p.times > 1 ? p.times + '× ' + t('together') + ' · ' + t('avg.') + ' ' + (p.avg ? p.avg.toFixed(1) + ' ★' : t('unrated')) : t('First time met');
      const stars = [1, 2, 3, 4, 5].map((v) => '<button data-v="' + v + '" class="' + (v <= p.rating ? 'on' : '') + '" aria-label="' + v + ' ★">★</button>').join('');
      const tags = RT_TAGS.map(([g, l, bad]) => '<button data-g="' + g + '" class="' + (p.tags.includes(g) ? 'on' + (bad ? ' bad' : '') : '') + '">' + esc(t(l)) + '</button>').join('');
      const col = RT_COLORS[(p.c || 0) % RT_COLORS.length];
      const cn = clsName(p.c);
      return '<div class="rt-pl' + (p.bl ? ' bad' : '') + (p.key === rtFocus ? ' focus' : '') + '" data-n="' + esc(p.n) + '" data-s="' + srvNum(p.s) + '">'
        + (cn ? '<span class="rt-av ic" title="' + esc(cn) + '"><img src="../assets/classes/' + p.c + '.png" alt=""></span>' : '<span class="rt-av" style="background:' + col + '">' + esc(Array.from(nm)[0] || '?') + '</span>')
        + '<span class="rt-who"><span class="rt-nm"><b title="' + esc(nm) + '">' + esc(nm) + '</b>' + (p.s > 0 ? '<span class="pl-srv">' + esc(rtShort(p.s)) + '</span>' : '') + '</span><small>' + esc((cn ? cn + ' · ' : '') + together) + '</small></span>'
        + '<span class="rt-dmg num">' + short(p.d) + '</span>'
        + '<span class="rt-stars" title="' + esc(t('Rate this player (click the same star again to clear)')) + '">' + stars + '</span>'
        + '<span class="rt-tags">' + tags + '</span>'
        + '<span class="rt-acts"><button class="rt-notebtn' + (p.note ? ' on' : '') + '" data-note="1">' + esc(t(p.note ? 'Note (set)' : 'Note')) + '</button>'
        + '<button class="rt-bl' + (p.bl ? ' on' : '') + '" data-bl="1">' + esc(t(p.bl ? 'Blacklisted' : 'Add to blacklist')) + '</button></span>'
        + (p.key === rtNoteKey ? '<textarea class="rt-note" maxlength="300" rows="3" placeholder="' + esc(t('Write a note about this player (max 300 characters, saved automatically)')) + '">' + esc(rtNoteDraft) + '</textarea>' : '') + '</div>';
    }).join('');
  }
  if (html === rtHtml && !rtScroll) return;
  const hadNoteFocus = !!(document.activeElement && document.activeElement.classList && document.activeElement.classList.contains('rt-note'));
  if (html !== rtHtml) { box.innerHTML = html; rtHtml = html; }
  if (hadNoteFocus) { const ta = box.querySelector('.rt-note'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  // Sağ tıkla gelindiyse seçili kart ve oyuncu satırı görünür alana kaydırılır (bir kez)
  if (rtScroll) {
    rtScroll = false;
    const onCard = $('bhList').querySelector('.bh-card.on'); if (onCard) onCard.scrollIntoView({ block: 'nearest' });
    const f = box.querySelector('.rt-pl.focus'); if (f) f.scrollIntoView({ block: 'nearest' });
  }
}
$('rtPlayers').onclick = (ev) => {
  const b = ev.target.closest('button'); const row = ev.target.closest('.rt-pl');
  if (!b || !row) return;
  const enc = rtEnc();
  const p = enc && enc.players.find((x) => x.n === row.dataset.n && srvNum(x.s) === srvNum(row.dataset.s));
  if (!p) return;
  const base = { name: p.n, server: srvNum(p.s) };
  if (b.dataset.note) { rtNoteKey = rtNoteKey === p.key ? '' : p.key; rtNoteDraft = p.note || ''; rtHtml = ''; rtRender(); const ta = $('rtPlayers').querySelector('.rt-note'); if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); } }
  else if (b.dataset.bl) api.quickRate({ ...base, blacklist: !p.bl });
  else if (b.dataset.g) api.quickRate({ ...base, tags: { [b.dataset.g]: !p.tags.includes(b.dataset.g) } });
  else if (b.dataset.v) { const v = Number(b.dataset.v); api.quickRate({ ...base, rating: v === p.rating ? 0 : v }); }
};
// Oyuncu notu: yazarken kısa gecikmeyle otomatik kaydedilir (yeniden çizim yazıyı bozmaz: taslak korunur)
let rtNoteTimer = 0;
function rtNoteSave(row, val) {
  clearTimeout(rtNoteTimer); rtNoteTimer = 0;
  api.quickRate({ name: row.dataset.n, server: srvNum(row.dataset.s), note: val });
}
$('rtPlayers').addEventListener('input', (ev) => {
  const ta = ev.target.closest('.rt-note'); const row = ev.target.closest('.rt-pl');
  if (!ta || !row) return;
  rtNoteDraft = ta.value;
  clearTimeout(rtNoteTimer);
  rtNoteTimer = setTimeout(() => rtNoteSave(row, ta.value), 700);
});
$('rtPlayers').addEventListener('focusout', (ev) => {
  const ta = ev.target.closest && ev.target.closest('.rt-note'); const row = ev.target.closest && ev.target.closest('.rt-pl');
  if (ta && row && rtNoteTimer) rtNoteSave(row, ta.value);
});
// Oyuncu verisi (karşılaşmalar, puanlar, sunucu tablosu) güncel tutulur: sol kartlar, sunucu etiketi ve oyuncu listesi kullanır
async function refreshRatings() {
  try { plData = await api.rateData(); } catch { return false; }
  plNames = null;
  $('playerRatingsOn').checked = plData.on !== false;
  $('blacklistAlert').checked = plData.alert === true;
  bhSig = '';
  if (lastBossState) renderBossTab(lastBossState, lastBossEnc);
  return true;
}
// Panelde sağ tık "Rate player": o oyuncunun bulunduğu kart seçilir, oyuncu satırı vurgulanır
async function applyPrefill() {
  let pf = null;
  try { pf = await api.ratingsTakePrefill(); } catch { pf = null; }
  if (!pf) return;
  if (!(await refreshRatings())) return;
  const encs = (plData && plData.encs) || [];
  const k = pairOf(pf.name, pf.server);
  const lc = String(pf.name).toLowerCase();
  const rank = (e) => (e.kind === 'live' ? 0 : !e.kind ? 1 : e.kind === 'pick' ? 2 : 3);
  const find = (match) => encs.filter((x) => x.players.some(match)).sort((a, b) => rank(a) - rank(b))[0] || null;
  let e = find((p) => p.key === k);
  if (e) rtFocus = k;
  else {
    e = find((p) => p.n.toLowerCase() === lc);
    const q = e && e.players.find((p) => p.n.toLowerCase() === lc);
    if (q) rtFocus = q.key;
  }
  if (!e) return;
  bhSel = e.fk; bhRunSel = ''; rtFilter = 'all'; rtScroll = true; rtHtml = '';
  bhQ = ''; bhBoss = ''; bhKind = 'all'; $('bhSearch').value = '';
  // Kart kapalı bir zindan koşusunun içindeyse koşu açılır
  const r = BOSSHIST.groupRuns(BOSSHIST.merge(bhSaved, lastBossState && lastBossState.bosses)).find((x) => x.run && x.items.some((i) => i.fk === e.fk));
  if (r) bhOpen.add(r.key);
  bhSig = '';
  if (lastBossState) renderBossTab(lastBossState, lastBossEnc, true);
}
// Boss ve Oyuncular sekmesi her açıldığında: veriyi tazele, bekleyen sağ tık varsa uygula, panelden gelen "Boss raporu" için güncel boss'u seç
function bossTabShown() {
  if (lastBossState) renderBossTab(lastBossState, lastBossEnc, true);
  refreshRatings().then(() => applyPrefill());
}
$('playerRatingsOn').onchange = () => { api.setSettings({ playerRatingsOn: $('playerRatingsOn').checked }); };
$('blacklistAlert').onchange = () => { api.setSettings({ blacklistAlert: $('blacklistAlert').checked }); };
api.on('ratings-changed', () => { refreshRatings(); });
// Şimdiki parti kartı açıkken liste kendiliğinden tazelenir (parti değişebilir)
setInterval(() => { if (isOpen && currentTab === 'boss' && bhSel === 'live') refreshRatings(); }, 4000);

function open(tab) {
  // bilinmeyen sekme adı çekmeceyi boş açmasın: eşleşen düğme yoksa Beceriler sekmesi
  if (tab) { const tn = String(tab).replace(/[^a-z]/gi, ''); showTab(tn && document.querySelector('.seg button[data-tab="' + tn + '"]') ? tn : 'skills'); }
  isOpen = true;
  load();
  requestAnimationFrame(() => {
    document.body.classList.add('shown');
  });
}

function close() {
  isOpen = false;
  document.body.classList.remove('shown');
  setTimeout(() => {
    if (api.drawerClose) api.drawerClose();
    else if (api.drawer) api.drawer(false);
  }, 160);
}

$('dclose').onclick = close;
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });

api.on('tab', (tn) => { if (tn === 'boss') bhAuto = true; open(tn); }); // panelden gelen "Boss raporu" güncel boss'u seçer
api.on('drawer-closing', () => {
  document.body.classList.remove('shown');
});

// Taşıma: başlık çubuğundan pencereyi sürükle
if (window.enableDrag) {
  window.enableDrag('.dh', api.drag);
}

// ---------------------------------------------------------------------------
// Boss Sekmesi
// ---------------------------------------------------------------------------
const openBossActors = new Set();

// ---------------------------------------------------------------------------
// Geçmiş karşılaşmalar (kalıcı): özetler ana süreçten (userData/boss_gecmisi/index.jsonl), rapor tıklanınca okunur.
// Bu oturumun bellekteki boss kayıtları (state.bosses) aynı fk ile birleşir; seçilince canlı rapor akışı (selectBoss) kullanılır.
// Silme düğmesi yoktur: her şey kalıcıdır.
// ---------------------------------------------------------------------------
const BH_PAGE = 30;
let bhSaved = [];      // kalıcı özetler
let bhSel = '';        // seçili dövüş / sabit kart (fk); '' = seçili kart yok
let bhRunSel = '';     // seçili zindan koşusu başlığı (anahtar); önce içinden boss seçilir
let bhRunName = '';    // seçili koşunun zindan adı
let bhAuto = false;    // panelden "Boss raporu" ile gelindi: güncel boss kartı bir kez seçilir
let bhQ = '';          // arama (boss, zindan ya da oyuncu adı)
let bhBoss = '';       // boss süzgeci ('' = hepsi)
let bhKind = 'all';    // all | dungeon | world
let bhSort = 'new';    // new | dur | dps | own
let bhOpen = new Set(); // açık (genişletilmiş) zindan koşuları
let bhShow = BH_PAGE;  // gösterilen kart sayısı ("daha fazla göster")
let bhDetail = null;   // diskten okunan rapor { fk, enc, mask, missing, streamer }
let bhLoading = '';
let bhSig = '';
let stMask = null;     // state'ten gelen son ad tablosu (yayıncı modu)
const BH_RES = { k: ['k', 'Kill'], w: ['w', 'Wipe'], '': ['n', 'No kill'] };

// Yayıncı modu: diskten okunan raporun adları ana sürecin aynı maskesinden gelen tabloyla birleşir
function applyMask() {
  if (!masker) return;
  if (bhDetail && bhDetail.mask) masker.apply(Object.assign({}, stMask || {}, bhDetail.mask));
  else if (stMask) masker.apply(stMask);
}
async function loadBossLog() {
  try { const r = await api.bossLogList(); bhSaved = Array.isArray(r) ? r : []; } catch { return; }
  bhSig = '';
  if (lastBossState) renderBossTab(lastBossState, lastBossEnc);
}
function bhFetch(fk) {
  if (bhLoading === fk) return;
  bhLoading = fk;
  const done = (r) => {
    if (bhLoading !== fk) return;
    bhLoading = '';
    bhDetail = { fk, enc: r && r.enc ? r.enc : null, mask: r && r.mask ? r.mask : null, missing: !(r && r.enc), streamer };
    applyMask();
    if (lastBossState) renderBossTab(lastBossState, lastBossEnc, true);
  };
  api.bossLogGet(fk).then(done, () => done(null));
}
// Karta tıklanınca: o dövüş seçilir (rapor + oyuncular sağda açılır)
function bhPick(fk) {
  bhSel = fk; bhRunSel = ''; rtFocus = ''; rtNoteKey = ''; rtHtml = '';
  const s = lastBossState;
  const it = BOSSHIST.merge(bhSaved, s && s.bosses).find((x) => x.fk === fk);
  if (it && it.mi >= 0) api.selectBoss(it.mi);
  else if (s && s.selectedBoss !== null && s.selectedBoss !== undefined) api.selectBoss(null); // panel normal görünümüne döner
  bhSig = '';
  if (s) renderBossTab(s, lastBossEnc, true);
}
// Sabit kartlar (rate-data'daki kind'lı karşılaşmalar): şimdiki parti, seçilen oyuncu, puanlanan herkes
const pinnedEncs = () => (plData && plData.on !== false && plData.encs ? plData.encs.filter((e) => e.kind) : []);
// Arama için fk → oyuncu adları; yayıncı modunda oyuncu adı aranmaz (ekrana yansıyan ad takma ad)
function bhNames(fk) {
  if (streamer || !plData || !plData.encs) return '';
  if (!plNames) plNames = new Map(plData.encs.filter((e) => !e.kind).map((e) => [e.fk, e.players.map((p) => p.n).join(' ')]));
  return plNames.get(fk) || '';
}

// Kart listesi yalnız içerik değişince yeniden kurulur (4 Hz state odağı/kaydırmayı bozmasın)
function bhRenderList(items) {
  const pins = bhQ || bhBoss || bhKind !== 'all' ? [] : pinnedEncs();
  const list = BOSSHIST.viewRuns(items, { q: bhQ, boss: bhBoss, sort: bhSort, kind: bhKind, names: bhNames });
  const sig = [I18N.getLang(), pbOn, streamer, bhSel, bhRunSel, bhQ, bhBoss, bhKind, bhSort, bhShow, [...bhOpen].join(','), items.length,
    pins.map((p) => p.fk + ':' + p.count + ':' + (p.boss || '')).join(','), plNames ? 1 : 0,
    items.map((x) => x.fk + (x.code || '') + (x.mi >= 0 ? '*' : '') + x.res + x.n + ':' + Math.round(x.dps)).join(',')].join('|');
  if (sig === bhSig) return;
  bhSig = sig;
  $('bhCount').textContent = list.length === items.length ? items.length + ' ' + t('fights') : list.length + ' / ' + items.length + ' ' + t('fights');
  // Boss süzgeci (açılır liste) ve tür düğmeleri
  const bs = $('bhBossSel');
  bs.innerHTML = '<option value="">' + esc(t('All bosses')) + '</option>' + BOSSHIST.bossChips(items, 999, bhBoss).map((c) => '<option value="' + esc(c.name) + '">' + esc(c.name) + ' (' + c.n + ')</option>').join('');
  bs.value = bhBoss;
  for (const b of $('bhKinds').children) { b.classList.toggle('on', b.dataset.k === bhKind); b.setAttribute('aria-pressed', String(b.dataset.k === bhKind)); b.textContent = t(b.dataset.k === 'all' ? 'All types' : b.dataset.k === 'dungeon' ? 'Dungeon' : 'Open world'); }
  $('bhSort').value = bhSort;
  const box = $('bhList');
  const fa = document.activeElement;
  const refocus = fa && box.contains(fa) ? (fa.dataset.fk ? '[data-fk="' + fa.dataset.fk + '"]' : fa.dataset.run ? '[data-run="' + fa.dataset.run + '"]' : fa.classList.contains('bh-more') ? '.bh-more' : '') : '';
  const pinHtml = pins.map((p) => {
    const on = p.fk === bhSel;
    const live = p.kind === 'live';
    return '<div class="bh-card ' + (live ? 'live' : 'pin') + (on ? ' on' : '') + '" role="listitem"><button class="bh-main" data-fk="' + esc(p.fk) + '" aria-pressed="' + on + '">'
      + '<span class="bh-name" title="' + esc(rtTitle(p)) + '">' + esc(rtTitle(p)) + '</span>'
      + (live ? '<span class="bh-live-pill">' + esc(t('Live')) + '</span>' : '<span class="bh-res n">' + esc(p.count + ' ' + t('players')) + '</span>')
      + '<span class="bh-meta">' + esc((live ? p.count + ' ' + t('players') : '') + (p.bl ? (live ? ' · ' : '') + p.bl + ' ' + t('blacklisted') : '')) + '</span></button></div>';
  }).join('');
  if (!list.length) { box.innerHTML = pinHtml + '<p class="hint bh-none">' + esc(items.length || bhQ || bhBoss || bhKind !== 'all' ? t('No fights match this search.') : t('No boss fight recorded yet')) + '</p>'; return; }
  const shown = list.slice(0, bhShow);
  const card = (x) => {
    const res = BH_RES[x.res] || BH_RES[''];
    const on = x.fk === bhSel;
    const when = bhSort === 'new' ? timeText(x.at) : dayLabel(x.at) + ' ' + timeText(x.at);
    const meta = [when, clock(x.dur), x.n ? x.n + ' ' + t('players') : '', t('Party') + ' ' + short(x.dps) + ' DPS'].filter(Boolean).join(' · ');
    const o = x.own;
    const ownHtml = o
      ? '<span class="bh-own num" title="' + esc(t('Your damage') + ': ' + short(o.d)) + '"><span class="bh-rank' + (o.r === 1 ? ' top' : '') + '">#' + o.r + (x.n ? '/' + x.n : '') + '</span> ' + esc(t('You')) + ' <b>' + short(o.dps) + '</b></span>'
        + '<span class="bh-bar" aria-hidden="true"><i style="width:' + (x.top > 0 ? Math.max(2, Math.min(100, (o.d / x.top) * 100)) : 0).toFixed(1) + '%"></i></span>'
      : '<span class="bh-own dim">' + esc(t('You were not in this fight')) + '</span>';
    return '<div class="bh-card ' + res[0] + (on ? ' on' : '') + '" role="listitem">'
      + '<button class="bh-main" data-fk="' + esc(x.fk) + '" aria-pressed="' + on + '">'
      + '<span class="bh-name" title="' + esc(x.boss) + '">' + (pbOn && x.pb ? '<span class="bc-pb" title="' + esc(t('New record!')) + '">🏆</span> ' : '') + esc(x.boss || 'Boss') + (x.main ? ' <span class="bh-main-tag">' + esc(t('main boss')) + '</span>' : '') + '</span>'
      + '<span class="bh-res ' + res[0] + '">' + esc(t(res[1])) + '</span>'
      + '<span class="bh-meta">' + esc(meta) + '</span>'
      + ownHtml + '</button></div>';
  };
  const MODE = { e: 'Exploration', c: 'Conquest', h: 'Conquest Hard', t: 'Transcendence' };
  // Zindan koşusu: tek başlık kartı (zindan adı, mod rozeti, boss sayısı, tarih); tıklanınca açılır, önce içindeki boss seçilir
  const runCard = (r) => {
    const res = BH_RES[r.res] || BH_RES[''];
    const inside = r.items.some((x) => x.fk === bhSel);
    const sel = bhRunSel === r.key;
    const open = bhOpen.has(r.key) || inside;
    const when = bhSort === 'new' ? timeText(r.at) : dayLabel(r.at) + ' ' + timeText(r.at);
    const meta = [when, r.bosses + ' ' + t('bosses'), r.fights !== r.bosses ? r.fights + ' ' + t('fights') : '', t('Party') + ' ' + short(r.dps) + ' DPS'].filter(Boolean).join(' · ');
    const badge = r.mode && MODE[r.mode] ? '<span class="bh-mode ' + r.mode + '">' + esc(t(MODE[r.mode])) + '</span>' : '';
    return '<div class="bh-run-wrap" role="listitem"><div class="bh-card bh-run ' + res[0] + (inside || sel ? ' on' : '') + '">'
      + '<button class="bh-main bh-runhead" data-run="' + esc(r.key) + '" data-name="' + esc(r.dungeon) + '" aria-expanded="' + open + '">'
      + '<span class="bh-name" title="' + esc(r.dungeon) + '"><span class="bh-caret" aria-hidden="true">' + (open ? '▾' : '▸') + '</span> ' + esc(r.dungeon) + ' ' + badge + '</span>'
      + '<span class="bh-res ' + res[0] + '">' + esc(t(res[1])) + '</span>'
      + '<span class="bh-meta">' + esc(meta) + '</span></button></div>'
      + (open ? '<div class="bh-sub" role="list">' + r.items.map(card).join('') + '</div>' : '') + '</div>';
  };
  const entry = (e) => (e.run ? runCard(e) : card(e.item));
  let html = pinHtml;
  if (bhSort === 'new') {
    for (const g of BOSSHIST.groupDays(shown)) html += '<div class="rt-day bh-day">' + esc(dayLabel(g.at)) + '</div>' + g.items.map(entry).join('');
  } else html += shown.map(entry).join('');
  if (list.length > shown.length) html += '<button class="bh-more">' + esc(t('Show more')) + ' (' + (list.length - shown.length) + ')</button>';
  box.innerHTML = html;
  const want = refocus ? box.querySelector(refocus) : null;
  if (want) want.focus();
}
{
  const box = $('bhList');
  const redraw = (force) => { bhSig = ''; if (lastBossState) renderBossTab(lastBossState, lastBossEnc, force); };
  box.onclick = (ev) => {
    const b = ev.target.closest('button');
    if (!b) return;
    if (b.dataset.fk) { bhPick(b.dataset.fk); if (b.closest('.bh-card.live, .bh-card.pin')) refreshRatings(); }
    else if (b.dataset.run) {
      const r = BOSSHIST.clickCard({ fk: bhSel, run: bhRunSel }, { run: true, key: b.dataset.run }, bhOpen);
      bhOpen = r.open; bhSel = r.sel.fk; bhRunSel = r.sel.run; bhRunName = b.dataset.name || ''; rtHtml = '';
      redraw(true);
    } else if (b.classList.contains('bh-more')) { bhShow += BH_PAGE; redraw(true); }
  };
  box.tabIndex = -1;
  const reset = () => { bhShow = BH_PAGE; redraw(true); };
  $('bhSearch').oninput = () => { bhQ = $('bhSearch').value; reset(); };
  $('bhSearch').onkeydown = (ev) => { if (ev.key === 'Escape' && $('bhSearch').value) { ev.stopPropagation(); $('bhSearch').value = ''; bhQ = ''; reset(); } };
  $('bhSort').onchange = () => { bhSort = $('bhSort').value; reset(); };
  $('bhBossSel').onchange = () => { bhBoss = $('bhBossSel').value; reset(); };
  $('bhKinds').onclick = (ev) => { const b = ev.target.closest('button'); if (b) { bhKind = b.dataset.k || 'all'; reset(); } };
}
api.on('boss-log-changed', loadBossLog);
loadBossLog();
refreshRatings();

function renderBossTab(s, e, force = false) {
  lastBossState = s;
  lastBossEnc = e;
  if (!force && !isTabActive('boss')) return;

  // Hangi kartın raporu gösterilecek: bellekteki (canlı akış) ya da diskten okunan; sabit kartlar (şimdiki parti...) yalnız oyuncu listesi
  const mem = (s && s.bosses) || [];
  const curIdx = (s && s.selectedBoss !== null && s.selectedBoss !== undefined && s.selectedBoss < mem.length) ? s.selectedBoss : 0;
  const items = typeof BOSSHIST !== 'undefined' ? BOSSHIST.merge(bhSaved, mem) : [];
  if (bhAuto) { bhAuto = false; if (!bhSel && !bhRunSel && mem[curIdx]) bhSel = mem[curIdx].fk; } // panelden "Boss raporu": güncel boss kartı seçilir
  let pin = null;
  let pick = null;
  if (bhSel) {
    pin = pinnedEncs().find((x) => x.fk === bhSel) || null;
    if (!pin) pick = items.find((x) => x.fk === bhSel) || null;
    if (!pin && !pick && !(plData === null && bhSel === 'live')) bhSel = ''; // kart artık yok (örn. sabit kart kapandı)
  }
  const mode = BOSSHIST.rightMode({ fk: bhSel, run: bhRunSel });
  const emptyEl = $('bcEmpty');
  const pickEl = $('bcPickBoss');
  const repEl = $('bcReport');
  if (emptyEl) emptyEl.hidden = mode !== 'empty';
  if (pickEl) { pickEl.hidden = mode !== 'pick-boss'; $('bcPickTitle').textContent = bhRunName; }
  if (repEl) repEl.hidden = mode !== 'fight';
  if (mode !== 'fight') {
    if (bhDetail) { bhDetail = null; applyMask(); }
    bhRenderList(items);
    rtRender();
    return;
  }

  let shownAt = 0;
  let missing = false;
  let loading = false;
  if (pin) {
    shownAt = pin.at;
    if (bhDetail) { bhDetail = null; applyMask(); }
    if (!(pin.fk === 'live' && e && e.live)) e = null; // sürmekte olan boss savaşı varsa raporu da gösterilir
  } else if (pick && pick.mi >= 0) {
    if (pick.mi !== curIdx) { api.selectBoss(pick.mi); bhRenderList(items); return; } // sıra kaydı: yeni state gelince çizilir
    shownAt = pick.at;
    if (bhDetail) { bhDetail = null; applyMask(); }
  } else if (pick) {
    shownAt = pick.at;
    if (bhDetail && bhDetail.fk === pick.fk && (!streamer || bhDetail.streamer || !bhDetail.enc)) { e = bhDetail.enc; missing = bhDetail.missing; } else { e = null; loading = true; bhFetch(pick.fk); }
  } else { e = null; }
  bhRenderList(items);
  rtRender();

  const boss = e ? e.boss : null;
  const actors = e ? e.actors : [];

  const heroEl = document.querySelector('.bc-hero');
  const statsGrid = document.querySelector('.bc-stats-grid');
  const thEl = document.querySelector('.bc-table-header');
  const rowsBox = $('bcRows');
  const tlWrapEl = $('bcTimelineWrap');
  const msgEl = $('bcMsg');

  if (!boss) {
    if (msgEl) {
      msgEl.hidden = !(missing || loading);
      $('bcMsgTitle').textContent = missing ? t('This fight\'s report could not be loaded') : t('Loading report…');
      $('bcMsgDesc').textContent = missing ? t('The file may be missing or damaged. The players below are still saved.') : '';
    }
    if (heroEl) heroEl.hidden = true;
    if (statsGrid) statsGrid.hidden = true;
    if (thEl) thEl.hidden = true;
    if (rowsBox) rowsBox.innerHTML = '';
    if (tlWrapEl) tlWrapEl.hidden = true;
    $('bcStagger').hidden = true;
    renderDeaths([]);
    return;
  }

  if (msgEl) msgEl.hidden = true;
  if (heroEl) heroEl.hidden = false;
  if (statsGrid) statsGrid.hidden = false;
  if (thEl) thEl.hidden = false;
  // Bu savaştaki ölümler (yalnız boss raporunun içinde; en yeni üstte)
  renderDeaths(e && e.deathList ? e.deathList.slice().reverse() : []);

  const badgeEl = $('bcBadgeTag');
  if (badgeEl) {
    badgeEl.textContent = 'BOSS';
  }

  $('bcName').textContent = boss.name || 'Boss';
  const agoEl = $('bcTimeAgo');
  if (agoEl) agoEl.textContent = shownAt ? dayLabel(shownAt) + ' · ' + timeText(shownAt) : '';
  // Faz 8.14: kişisel rekor → altın kupa rozeti
  if (pbOn && boss.pb) {
    const trophy = document.createElement('span');
    trophy.className = 'bc-pb';
    trophy.textContent = ' 🏆';
    trophy.title = t('New record!') + (boss.pbPrev ? ' (' + short(boss.pbPrev) + ' DPS → ' + short(boss.dps) + ' DPS)' : '');
    $('bcName').appendChild(trophy);
  }
  // Sürüm 2.0: kırılma (stagger) özeti, 0x05e0 paketi geldiyse
  const sg = boss.stagger;
  const sgEl = $('bcStagger');
  if (sgEl) {
    sgEl.hidden = !(sg && (sg.breaks || sg.live));
    if (sg) {
      $('bcStgBreaks').textContent = String(sg.breaks || 0);
      $('bcStgBurst').textContent = short(sg.burstDmg || 0);
      $('bcStgTime').textContent = sg.staggeredMs ? (sg.staggeredMs / 1000).toFixed(1) + ' ' + t('s') : (sg.broken ? t('BROKEN') : '–');
    }
  }
  const sm = BOSSHIST.summary(e) || {};
  $('bcDur').textContent = sm.dur != null ? clock(sm.dur) : '–';
  $('bcTotal').textContent = sm.total != null ? short(sm.total) : '–';
  $('bcTotal').parentNode.title = sm.allTotal != null ? t('TOTAL ALL') + ': ' + short(sm.allTotal) : '';
  $('bcDps').textContent = sm.groupDps != null ? short(sm.groupDps) : '–';
  $('bcOwnDps').textContent = sm.ownDps != null ? short(sm.ownDps) : '–';
  const mainCode = (pick && pick.code) || (pin && pin.code) || (boss && boss.code) || 0;
  if (BOSSHIST.isMainBoss(mainCode)) {
    const mt = document.createElement('span');
    mt.className = 'bh-main-tag';
    mt.textContent = t('main boss');
    $('bcName').appendChild(mt);
  }

  const statusPill = $('bcStatusPill');
  const statusTxt = $('bcStatus');
  if (statusTxt) statusTxt.textContent = boss.killed ? t('Killed') : (boss.wiped ? t('Wiped') : t('Not killed'));
  if (statusPill) statusPill.className = 'bc-status-pill ' + (boss.killed ? 'killed' : 'wipe');

  if (!rowsBox) return;
  rowsBox.innerHTML = '';

  const maxTotal = (actors.length ? Math.max(...actors.map((a) => a.total || 0)) : 0) || 1; // hepsi 0 (hasarsız parti satırları) olsa da bölme güvenli

  actors.forEach((a, idx) => {
    const rank = idx + 1;
    let rankBadge = '';
    if (rank === 1) rankBadge = '<span class="bc-rank rank-1" title="MVP">👑 MVP</span>';
    else if (rank === 2) rankBadge = '<span class="bc-rank rank-2" title="2nd">🥈 2</span>';
    else if (rank === 3) rankBadge = '<span class="bc-rank rank-3" title="3rd">🥉 3</span>';
    else rankBadge = `<span class="bc-rank rank-other">${rank}</span>`;

    const r = document.createElement('div');
    const isExpanded = openBossActors.has(a.id);
    r.className = 'bc-row' + (a.own ? ' own' : '') + (isExpanded ? ' expanded' : '');

    const fillPct = Math.min(100, Math.max(0, (a.total / maxTotal) * 100)).toFixed(1);
    const ci = a.cls ? `<img class="cls" src="../assets/classes/${a.cls}.png" alt="">` : '';

    const topSkills = (a.skills || []).slice(0, 3).map((sk) => `
      <span class="bc-skill-pill" title="${esc(sk.name)}">
        <img src="${esc(sk.icon)}" alt="">
        <span class="bc-sk-name">${esc(sk.name)}</span>
        <b class="bc-sk-dmg num">${short(sk.total)}</b>
      </span>
    `).join('');

    const toggleBtn = (a.skills && a.skills.length > 0)
      ? `<span class="bc-toggle-skills" title="${t('Click to show all skills')}">${isExpanded ? '▲ ' + t('Hide') : '▼ ' + a.skills.length + ' ' + t('skills')}</span>`
      : '';

    let fullSkillsHtml = '';
    if (isExpanded && a.skills && a.skills.length > 0) {
      fullSkillsHtml = `
        <div class="bc-skills-full">
          <div class="bc-sf-header">
            <span>${t('Skill')}</span>
            <span>${t('Damage')}</span>
            <span>${t('DPS')}</span>
            <span>${t('Share')}</span>
            <span>${t('Hits')}</span>
            <span>${t('Crit')}</span>
            <span>${t('Avg')}</span>
          </div>
          <div class="bc-sf-list">
            ${a.skills.map((sk) => `
              <div class="bc-sf-row">
                <div class="bc-sf-name">
                  <img src="${esc(sk.icon)}" class="bc-sf-ico">
                  <span title="${esc(sk.name)}">${esc(sk.name)}</span>
                </div>
                <div class="bc-sf-val num"><b>${short(sk.total)}</b></div>
                <div class="bc-sf-val num dim">${short(sk.dps)}</div>
                <div class="bc-sf-bar-cell">
                  <div class="bc-sf-bar"><i style="width:${(sk.share * 100).toFixed(1)}%;"></i></div>
                  <span class="num">${pct(sk.share)}</span>
                </div>
                <div class="bc-sf-val num dim">${sk.hits}×</div>
                <div class="bc-sf-val num dim">${pct(sk.crit)}</div>
                <div class="bc-sf-val num dim">${short(sk.avg)}</div>
              </div>
            `).join('')}
          </div>
        </div>
      `;
    }

    // Oyuncu defteri: sunucu etiketi (puanlama Rate ekranında; kendin ve adı bilinmeyenler hariç)
    const showSrv = !!(plData && plData.on !== false && !a.own && a.name && !String(a.name).includes('#') && srvNum(a.server));
    const rateHtml = showSrv ? `<span class="bc-srv" title="${esc(t('Server'))}">${esc(srvLabel(a.server))}</span>` : '';
    r.innerHTML = `
      <div class="bc-row-fill" style="width: ${fillPct}%;"></div>
      <div class="bc-row-main">
        <div class="bc-player-info">
          ${rankBadge}
          ${ci}
          <span class="bc-player-name" title="${esc(dispName(a.name, a.cls, a.own))}">${(a.own ? `<span class="bc-own-tag">${t('YOU')}</span> ` : '') + esc(dispName(a.name, a.cls, a.own))}</span>
          ${rateHtml}
          ${toggleBtn}
        </div>
        <div class="bc-player-stats">
          <span class="bc-val-dmg num" title="${t('damage')}"><b>${short(a.total)}</b></span>
          <span class="bc-val-dps num dim" title="${t('DPS')}">${short(a.dps)} <small>DPS</small></span>
          <span class="bc-val-share num" title="${t('share')}"><b>${pct(a.share)}</b></span>
        </div>
      </div>
      ${!isExpanded && topSkills ? `<div class="bc-skills-bar">${topSkills}</div>` : ''}
      ${fullSkillsHtml}
    `;

    r.addEventListener('click', () => {
      if (openBossActors.has(a.id)) openBossActors.delete(a.id);
      else openBossActors.add(a.id);
      renderBossTab(s, e);
    });

    rowsBox.appendChild(r);
  });

  const tlWrap = $('bcTimelineWrap');
  if (tlWrap) {
    const replay = (e && e.replay) || (s && s.bossEnc && s.bossEnc.replay) || (s && s.enc && s.enc.replay) || null;
    if (replay && ((replay.casts && replay.casts.length) || (replay.consumables && replay.consumables.length))) {
      tlWrap.hidden = false;
      renderTimeline(replay, boss, actors);
    } else {
      tlWrap.hidden = true;
      tlTeardown();
    }
  }
}

let selectedTlPlayer = 'all';

// Beceri rotasyonu (Öneri A: zoom'lu şerit): her oyuncu ayrı satır, 28px ikon, tekerlekle imleç noktasında zoom, sürükleyerek kaydırma.
const TL_PAD = 84;       // sol etiket alanı (px)
const TL_RPAD = 16;      // sağ boşluk (px)
const TL_GAP = 30;       // aynı alt satırda iki ikon arası asgari mesafe (px)
const TL_ROW = 32;       // alt satır aralığı (px)
const TL_ROWS = 3;       // oyuncu başına en çok alt satır (aşılırsa küçük kademeli kayma)
const TL_MAX_ZOOM = 60;
let tlZoom = 1;
let tlKey = '';
let tlCleanup = null;

// Dinleyicileri ve gözlemciyi bırak (yeniden çizimde, sekme gizlenince ve pencere kapanırken)
function tlTeardown() {
  if (tlCleanup) { const fn = tlCleanup; tlCleanup = null; fn(); }
}
window.addEventListener('pagehide', tlTeardown);

function renderTimeline(replay, boss, actors) {
  const pFilter = $('bcTlPlayerFilter');
  const view = $('bcTlTracks');
  const canvasEl = $('bcTlCanvas');
  const streamEl = $('bcTlStream');
  const axisEl = $('bcTlAxis');
  const apmEl = $('bcTlApm');
  if (!streamEl || !axisEl || !view || !canvasEl) return;
  tlTeardown();

  // 1. Oyuncu filtresi dropdown güncelle
  if (pFilter) {
    const prevVal = selectedTlPlayer;
    let opts = `<option value="all">${t('All Players')}</option>`;
    for (const a of (actors || [])) {
      const aName = (a.own ? t('YOU') + ' - ' : '') + esc(dispName(a.name, a.cls, a.own));
      opts += `<option value="${a.id}" ${prevVal == a.id ? 'selected' : ''}>${aName}</option>`;
    }
    pFilter.innerHTML = opts;
    pFilter.onchange = () => {
      selectedTlPlayer = pFilter.value;
      renderTimeline(replay, boss, actors);
    };
  }

  // 2. Olayları filtrele
  const allCasts = replay.casts || [];
  const allConsumables = replay.consumables || [];
  const filteredCasts = selectedTlPlayer === 'all'
    ? allCasts
    : allCasts.filter((c) => String(c.actor) === String(selectedTlPlayer));
  const filteredConsumables = selectedTlPlayer === 'all'
    ? allConsumables
    : allConsumables.filter((c) => String(c.actor) === String(selectedTlPlayer));

  // başka dövüş / başka oyuncu seçildiyse zoom sıfırlanır
  const key = (replay.start || 0) + ':' + allCasts.length + ':' + allConsumables.length + ':' + selectedTlPlayer;
  if (key !== tlKey) { tlKey = key; tlZoom = 1; view.scrollLeft = 0; view.scrollTop = 0; }

  // 3. APM hesapla
  const totalActions = filteredCasts.length + filteredConsumables.length;
  const durSec = Math.max(1, (replay.duration || (boss && boss.dur) || 1000) / 1000);
  const apm = Math.round((totalActions / durSec) * 60);
  if (apmEl) apmEl.textContent = `${apm} APM`;

  const totalMs = durSec * 1000;
  const startT = replay.start || (filteredCasts[0] ? filteredCasts[0].t : 0);

  // Aktör adları haritası
  const actorMap = new Map();
  const ownIds = new Set();
  for (const a of (actors || [])) { actorMap.set(String(a.id), a.name); if (a.own) ownIds.add(String(a.id)); }

  // Bütün olayları birleştir ve zamana göre sırala (sıra korunur)
  const allEvents = [];
  for (const c of filteredCasts) {
    allEvents.push({ t: c.t, isPotion: false, skill: c.skill, name: c.name, icon: c.icon, actor: c.actor });
  }
  for (const u of filteredConsumables) {
    allEvents.push({ t: u.t, isPotion: true, skill: u.itemSkill, name: u.name, icon: u.icon, actor: u.actor });
  }
  allEvents.sort((a, b) => a.t - b.t);

  // Sadece dövüş aralığındaki olayları filtrele (öncesindeki çöp yaratık atımlarını eler)
  const events = allEvents.filter((ev) => ev.t >= startT - 1500 && ev.t <= startT + totalMs + 2500);

  // Oyuncu başına bir şerit: önce oyuncu listesi sırası, sonra listede olmayanlar
  const laneMap = new Map();
  for (const ev of events) {
    const k = String(ev.actor);
    if (!laneMap.has(k)) laneMap.set(k, []);
    laneMap.get(k).push(ev);
  }
  const laneIds = [];
  for (const a of (actors || [])) if (laneMap.has(String(a.id))) laneIds.push(String(a.id));
  for (const k of laneMap.keys()) if (!laneIds.includes(k)) laneIds.push(k);

  const draw = () => {
    const vw = Math.max(320, view.clientWidth);
    const trackW = Math.max(100, vw - TL_PAD - TL_RPAD) * tlZoom;
    const pxPerMs = trackW / totalMs;
    canvasEl.style.width = Math.round(TL_PAD + trackW + TL_RPAD) + 'px';

    // zaman ekseni: işaretler arası en az ~56px kalacak en küçük adım
    axisEl.innerHTML = '';
    const pxPerSec = pxPerMs * 1000;
    let step = 300;
    for (const c of [1, 2, 5, 10, 15, 30, 60, 120, 300]) { if (c * pxPerSec >= 56) { step = c; break; } }
    for (let sec = 0; sec <= durSec; sec += step) {
      const tick = document.createElement('span');
      tick.className = 'bc-tl-axis-tick';
      tick.style.left = Math.round(TL_PAD + sec * pxPerSec) + 'px';
      tick.textContent = clock(sec * 1000);
      axisEl.appendChild(tick);
    }

    streamEl.innerHTML = '';

    // Kırılma (stagger) pencereleri: gerçek dövüş anlarına göre altın sarısı vurgu
    if (replay.stagger && (replay.stagger.breaks > 0 || replay.stagger.staggeredMs > 0)) {
      const windows = (replay.stagger.windows && replay.stagger.windows.length > 0)
        ? replay.stagger.windows
        : (replay.stagger.staggeredMs > 0 ? [{ start: startT + Math.max(0, totalMs * 0.25), dur: replay.stagger.staggeredMs }] : []);
      windows.forEach((win) => {
        const winOffset = Math.max(0, (win.start || startT) - startT);
        const durMs = Math.max(800, win.dur || replay.stagger.staggeredMs || 3000);
        const x = Math.min(totalMs * 0.96, winOffset) * pxPerMs;
        const w = Math.min(trackW - x, Math.max(durMs * pxPerMs, 26));
        const stgZone = document.createElement('div');
        stgZone.className = 'bc-tl-stagger-zone';
        stgZone.style.left = Math.round(TL_PAD + x) + 'px';
        stgZone.style.width = Math.round(w) + 'px';
        stgZone.title = `${t('Stagger Window')} (~${(durMs / 1000).toFixed(1)}s)`;
        stgZone.innerHTML = `<span class="bc-tl-stagger-tag">${t('Stagger')}</span>`;
        streamEl.appendChild(stgZone);
      });
    }

    for (const id of laneIds) {
      const lane = document.createElement('div');
      lane.className = 'bc-tl-lane' + (ownIds.has(id) ? ' own' : '');
      const label = dispName(actorMap.get(id) || ('#' + id), null, false);
      const nm = document.createElement('span');
      nm.className = 'bc-tl-lane-name';
      nm.textContent = label;
      nm.title = label;
      lane.appendChild(nm);

      // alt satır tahsisi: aynı satırda ikonlar en az TL_GAP px arayla; hepsi doluysa en az dolu satıra küçük kayma ile biner
      const lastX = new Array(TL_ROWS).fill(-9999);
      let usedRows = 1;
      for (const ev of laneMap.get(id)) {
        const offsetMs = Math.max(0, ev.t - startT);
        const x = TL_PAD + Math.min(totalMs, offsetMs) * pxPerMs;
        let row = -1;
        for (let r = 0; r < TL_ROWS; r++) { if (x - lastX[r] >= TL_GAP) { row = r; break; } }
        let nudge = 0;
        if (row < 0) {
          row = 0;
          for (let r = 1; r < TL_ROWS; r++) if (lastX[r] < lastX[row]) row = r;
          nudge = 4;
        }
        lastX[row] = x;
        if (row + 1 > usedRows) usedRows = row + 1;

        const pill = document.createElement('div');
        pill.className = `bc-tl-pill${ev.isPotion ? ' potion' : ''}`;
        pill.style.left = x.toFixed(1) + 'px';
        pill.style.top = (4 + row * TL_ROW + nudge) + 'px';
        pill.title = `[${clock(offsetMs)}] ${ev.name} (${dispName(actorMap.get(String(ev.actor)) || ('#' + ev.actor), null, false)})`;
        if (ev.icon) {
          const img = document.createElement('img');
          img.src = ev.icon;
          img.alt = ev.name;
          img.onerror = () => { img.style.display = 'none'; };
          pill.appendChild(img);
        } else {
          pill.textContent = '✦';
        }
        lane.appendChild(pill);
      }
      lane.style.height = (usedRows * TL_ROW + 12) + 'px';
      streamEl.appendChild(lane);
    }
  };

  // zoom: anchorX = görünüm içindeki imleç x'i; o noktadaki zaman sabit kalır
  const setZoom = (nz, anchorX) => {
    nz = Math.min(TL_MAX_ZOOM, Math.max(1, nz));
    if (nz === tlZoom) return;
    const vw = Math.max(320, view.clientWidth);
    const baseW = Math.max(100, vw - TL_PAD - TL_RPAD);
    const ax = anchorX == null ? view.clientWidth / 2 : anchorX;
    const frac = Math.min(1, Math.max(0, (view.scrollLeft + ax - TL_PAD) / (baseW * tlZoom)));
    const top = view.scrollTop;
    tlZoom = nz;
    draw();
    view.scrollLeft = nz <= 1 ? 0 : TL_PAD + frac * baseW * nz - ax;
    view.scrollTop = top;
  };

  const onWheel = (ev) => {
    ev.preventDefault();
    const rect = view.getBoundingClientRect();
    setZoom(tlZoom * (ev.deltaY < 0 ? 1.25 : 0.8), ev.clientX - rect.left);
  };
  let drag = null;
  const onDown = (ev) => {
    if (ev.button !== 0) return;
    drag = { x: ev.clientX, y: ev.clientY, sl: view.scrollLeft, st: view.scrollTop, id: ev.pointerId };
    try { view.setPointerCapture(ev.pointerId); } catch (_) { /* yoksay */ }
    view.classList.add('drag');
  };
  const onMove = (ev) => {
    if (!drag) return;
    view.scrollLeft = drag.sl - (ev.clientX - drag.x);
    view.scrollTop = drag.st - (ev.clientY - drag.y);
  };
  const onUp = () => {
    if (!drag) return;
    try { view.releasePointerCapture(drag.id); } catch (_) { /* yoksay */ }
    drag = null;
    view.classList.remove('drag');
  };
  view.addEventListener('wheel', onWheel, { passive: false });
  view.addEventListener('pointerdown', onDown);
  view.addEventListener('pointermove', onMove);
  view.addEventListener('pointerup', onUp);
  view.addEventListener('pointercancel', onUp);

  const zin = $('bcTlZoomIn');
  const zout = $('bcTlZoomOut');
  const zfit = $('bcTlFit');
  if (zin) zin.onclick = () => setZoom(tlZoom * 1.6);
  if (zout) zout.onclick = () => setZoom(tlZoom / 1.6);
  if (zfit) zfit.onclick = () => { tlZoom = 1; draw(); view.scrollLeft = 0; };

  // pencere boyu değişirse (ve görünürse) aynı zoom ile yeniden diz
  let lastVw = view.clientWidth;
  let ro = null;
  if (typeof ResizeObserver !== 'undefined') {
    ro = new ResizeObserver(() => {
      const w = view.clientWidth;
      if (w <= 0 || w === lastVw) return;
      lastVw = w;
      const sl = view.scrollLeft;
      draw();
      view.scrollLeft = sl;
    });
    ro.observe(view);
  }

  const sl0 = view.scrollLeft;
  const st0 = view.scrollTop;
  draw();
  view.scrollLeft = sl0;
  view.scrollTop = st0;

  tlCleanup = () => {
    view.removeEventListener('wheel', onWheel);
    view.removeEventListener('pointerdown', onDown);
    view.removeEventListener('pointermove', onMove);
    view.removeEventListener('pointerup', onUp);
    view.removeEventListener('pointercancel', onUp);
    view.classList.remove('drag');
    drag = null;
    if (ro) { ro.disconnect(); ro = null; }
    if (zin) zin.onclick = null;
    if (zout) zout.onclick = null;
    if (zfit) zfit.onclick = null;
    if (pFilter) pFilter.onchange = null;
  };
}



const THEME_MAP = {
  gold: '242, 179, 61',
  ice: '94, 196, 255',
  purple: '177, 132, 255',
  neon: '96, 240, 150',
};

function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const h = hex.replace('#', '').trim();
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return `${r}, ${g}, ${b}`;
  }
  if (h.length === 6) {
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return `${r}, ${g}, ${b}`;
  }
  return null;
}

function rgbToHex(rgbStr) {
  if (!rgbStr || typeof rgbStr !== 'string') return '#f2b33d';
  const parts = rgbStr.split(',').map((x) => parseInt(x.trim(), 10));
  if (parts.length < 3 || parts.some(isNaN)) return '#f2b33d';
  const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`;
}

function applyTheme(acc, customRgb, customHex) {
  let rgb = '242, 179, 61';
  let isCustom = acc === 'custom';
  if (acc && THEME_MAP[acc]) {
    rgb = THEME_MAP[acc];
    isCustom = false;
  } else if (acc === 'custom' && customRgb) {
    rgb = customRgb;
    isCustom = true;
  } else if (typeof acc === 'string' && acc.includes(',')) {
    rgb = acc.trim();
    isCustom = !Object.values(THEME_MAP).includes(rgb);
  }

  document.documentElement.style.setProperty('--acc-rgb', rgb);
  document.documentElement.style.setProperty('--own', `rgb(${rgb})`);
  document.documentElement.style.setProperty('--warn', `rgb(${rgb})`);

  const activeKey = isCustom ? 'custom' : (Object.keys(THEME_MAP).find((k) => THEME_MAP[k] === rgb) || acc);
  const sw = $('accent');
  if (sw) {
    for (const el of sw.children) {
      if (el.tagName === 'BUTTON') {
        el.classList.toggle('on', el.dataset.v === activeKey);
      } else if (el.classList.contains('custom-swatch-wrap')) {
        const btn = el.querySelector('button');
        if (btn) btn.classList.toggle('on', activeKey === 'custom');
      }
    }
  }

  const customBtn = $('customColorBtn');
  const customInput = $('customColorInput');
  if (customBtn && isCustom) {
    customBtn.style.setProperty('--c', rgb);
  }
  if (customInput) {
    if (customHex) customInput.value = customHex;
    else if (isCustom && rgb) customInput.value = rgbToHex(rgb);
  }
}

function applyOpacity(val) {
  const num = typeof val === 'number' ? val : parseFloat(val);
  if (!isNaN(num) && num > 0) {
    document.documentElement.style.setProperty('--alpha', num);
  }
}

function applyLang(l) {
  const newLang = l === 'tr' ? 'tr' : 'en';
  if (typeof I18N !== 'undefined') {
    I18N.setLang(newLang);
    I18N.applyDom();
  }
  const sel = $('langSel');
  if (sel) {
    for (const b of sel.children) {
      b.classList.toggle('on', b.dataset.v === newLang);
    }
  }
  if (data && data.settings) {
    data.settings.lang = newLang;
  }
}

api.on('state', (st) => {
  if (!st) return;
  if (st.ui) {
    if (st.ui.opacity !== undefined) applyOpacity(st.ui.opacity);
    if (st.ui.accent) applyTheme(st.ui.accent);
    if (st.ui.lang && typeof I18N !== 'undefined' && st.ui.lang !== I18N.getLang()) {
      applyLang(st.ui.lang);
    }
    if (st.ui.zoom && document.documentElement.style.zoom !== String(st.ui.zoom)) {
      document.documentElement.style.zoom = st.ui.zoom;
    }
  }
  streamer = !!(st.ui && st.ui.streamerMode);
  if (st.mask) { stMask = st.mask; applyMask(); }
  recapOn = !(st.ui && st.ui.deathRecap === false);
  pbOn = !!(st.ui && st.ui.personalBest === true);
  renderBossTab(st, st.bossEnc || null);
});

// ---------------------------------------------------------------------------
// Sürüm 2.0: Bu savaştaki ölümler (boss raporunun içinde; son 10 sn'de alınan darbeler, öldüren beceri, yerde kalma süresi)
// ---------------------------------------------------------------------------
let deathSig = '';
function agoText(at) {
  const s = Math.max(0, Math.round((Date.now() - at) / 1000));
  if (s < 60) return s + ' ' + t('s') + ' ' + t('ago');
  const m = Math.floor(s / 60);
  return m < 60 ? m + ' dk ' + t('ago') : Math.floor(m / 60) + ' sa ' + t('ago');
}
// Faz 8.9: ölüm kartına tıklayınca özet açılır / kapanır (yeniden çizim gerekmez)
document.addEventListener('click', (ev) => {
  const card = ev.target && ev.target.closest ? ev.target.closest('.dl-card.has-recap') : null;
  if (!card) return;
  const k = card.dataset.k;
  const box = card.querySelector('.dl-recap');
  if (!box) return;
  const open = box.hidden;
  box.hidden = !open;
  card.classList.toggle('open', open);
  if (open) openDeaths.add(k); else openDeaths.delete(k);
});
function renderDeaths(list) {
  const box = $('dlList');
  const wrap = $('bcDeathsWrap');
  if (!box || !wrap) return;
  wrap.hidden = !list.length;
  if (!list.length) { deathSig = ''; box.innerHTML = ''; return; }
  $('bcDeathsCount').textContent = String(list.length);
  const sig = (streamer ? 'S' : 'N') + (recapOn ? 'R' : 'r') + list.map((d) => d.player + ':' + d.t + ':' + (d.fatalAmount || 0)).join('|');
  if (sig !== deathSig) {
    deathSig = sig;
    box.innerHTML = list.map((d) => {
      const span = 10;
      const max = Math.max(1, ...d.timeline.map((x) => x.amount));
      const bars = d.timeline.map((x, i) => {
        const left = Math.max(0, Math.min(100, ((x.dt + span) / span) * 100));
        const h = Math.max(8, Math.round((x.amount / max) * 100));
        const fatal = i === d.timeline.length - 1;
        return `<i class="${fatal ? 'fatal' : x.dot ? 'dot' : ''}" style="left:${left.toFixed(1)}%;height:${h}%" title="${esc(x.name)} · ${short(x.amount)} · ${x.dt.toFixed(1)} ${t('s')}"></i>`;
      }).join('');
      const rows = d.taken.slice(0, 6).map((k) => `<span>${esc(k.name)}</span><span>${short(k.amount)}</span><span>${k.hits}×</span>`).join('');
      const dead = d.deadFor === null || d.deadFor === undefined ? t('still dead') : (d.deadFor / 1000).toFixed(1) + ' ' + t('s');
      const dkey = d.player + ':' + d.t;
      // Faz 8.9: ölüm özeti zaman tüneli (kim / hangi beceri / ne kadar; öldüren vuruş vurgulu)
      let recap = '';
      if (recapOn && d.timeline && d.timeline.length) {
        const open = openDeaths.has(dkey);
        recap = `<div class="dl-recap"${open ? '' : ' hidden'}><div class="dl-rh"><span>${t('Time')}</span><span>${t('Hit by')}</span><span>${t('Skill')}</span><span>${t('Damage')}</span></div>`
          + d.timeline.map((x) => `<div class="dl-rr${x.fatal ? ' fatal' : ''}${x.dot ? ' dot' : ''}"><span class="num">${x.dt.toFixed(1)} ${t('s')}</span><span>${esc(x.who ? localName(x.who) : '–')}</span><span>${x.fatal ? '☠ ' : ''}${esc(x.name || '')}</span><span class="num">${short(x.amount)}</span></div>`).join('') + '</div>';
      }
      return `<div class="dl-card${d.own ? ' own' : ''}${recap ? ' has-recap' : ''}${recap && openDeaths.has(dkey) ? ' open' : ''}" data-k="${esc(dkey)}">
        <div class="dl-head"><span class="dl-name">☠ ${esc(dispName(d.name, d.cls, d.own))}</span><span class="dl-ago">${agoText(d.at)}</span></div>
        <div class="dl-kill">${t('Killed by')}: <b>${esc(d.skillName || t('unknown'))}</b>${d.fatalAmount ? ` <span class="num">(${short(d.fatalAmount)})</span>` : ''}${d.killerName ? ' · ' + esc(d.killerName) : ''}</div>
        <div class="dl-meta"><span>${t('Last 10 s')}: <b>${short(d.total)}</b> ${t('damage taken')}</span><span>${t('dead for')}: <b class="dl-dead-time">${dead}</b></span></div>
        <div class="dl-tl">${bars}<div class="ax"><span>-10 ${t('s')}</span><span>-5</span><span>0</span></div></div>
        <div class="dl-rows">${rows}</div>${recap}
      </div>`;
    }).join('');
  } else {
    const cards = box.querySelectorAll('.dl-card');
    list.forEach((d, idx) => {
      const card = cards[idx];
      if (card) {
        const deadEl = card.querySelector('.dl-dead-time');
        const dead = d.deadFor === null || d.deadFor === undefined ? t('still dead') : (d.deadFor / 1000).toFixed(1) + ' ' + t('s');
        if (deadEl && deadEl.textContent !== dead) deadEl.textContent = dead;
        const agoEl = card.querySelector('.dl-ago');
        if (agoEl) {
          const ago = agoText(d.at);
          if (agoEl.textContent !== ago) agoEl.textContent = ago;
        }
      }
    });
  }
}

window.Drawer = {
  open, close, toggle: () => (isOpen ? close() : open()), get isOpen() { return isOpen; },
  refresh: () => {
    if (data) {
      renderOwn();
      renderSkills(data.skills);
      refreshUiScale();
      applyLang(typeof I18N !== 'undefined' ? I18N.getLang() : 'en');
    }
  }
};

// İlk açılış
open();

// ---------------------------------------------------------------------------
// Veriler
// ---------------------------------------------------------------------------

// Deneysel özellikler kartı: sadece geliştirme sürümünde (get-settings 'labs' alanını yalnız orada döndürür)
const LABS_TEXT = {
  buffs: ['Buff / debuff + shield report', 'Who had which effect up, and for how long'],
  threat: ['Threat estimate + boss target', 'The boss target is observed; the threat order is an estimate'],
  items: ['Consumables report', 'Potions, scrolls, food, drinks, resurrection'],
  build: ['Builds + gear', 'Skill specialty codes, level, GS, CP'],
  timeline: ['Fight timeline', 'Health curves, skills, healing, breaks, deaths'],
  positions: ['Positions + boss hits', 'Everyone\'s path and where the boss hit them'],
  archive: ['Fight / dungeon archive', 'Finished boss fights are saved to disk, grouped by run'],
  playback: ['Recording playback', 'Play a recording on the panel at x1, x4 or full speed'],
  map: ['Map + position layer', 'Live radar: you, the group, the boss, nearby'],
  timers: ['Event timers', 'Rift, Festival, Invasion, Siege, Nahma, Kaira, resets'],
};
function renderLabsCard(info) {
  const el = $('labsCard');
  if (!el || !info) { if (el) el.hidden = true; return; }
  el.hidden = false;
  el.innerHTML = `<div class="sc-header"><h4>${t('Experimental (dev only)')}</h4><button id="labsOpenBtn" class="sc-reset-link" type="button">${t('Open experimental window')}</button></div>` +
    info.features.map((k) => `<label class="tgl"><input type="checkbox" data-labs="${k}" ${info.flags[k] !== false ? 'checked' : ''}><i></i><span>${t(LABS_TEXT[k][0])}<small>${t(LABS_TEXT[k][1])}</small></span></label>`).join('');
  for (const cb of el.querySelectorAll('input[data-labs]')) cb.onchange = () => api.labsSet({ flags: { [cb.dataset.labs]: cb.checked } });
  $('labsOpenBtn').onclick = () => api.labsOpen();
}

async function load() {
  data = await api.getSettings();
  renderLabsCard(data.labs);
  customs = data.settings.customSounds || [];
  Sound.setCustomSounds(customs);
  const s = data.settings;
  applyOpacity(s.opacity);
  applyTheme(s.accent || 'gold', s.customAccentRgb, s.customAccent);
  $('charName').value = s.charName || '';
  $('opacity').value = s.opacity;
  showPct();
  refreshUiScale();
  $('volume').value = s.volume;
  $('volume2').value = s.volume;
  $('idleSec').value = s.idleSec;
  if ($('autoHideSec')) { $('autoHideSec').value = s.autoHideSec == null ? 30 : s.autoHideSec; $('autoHideField').classList.toggle('dis', s.autoShowWithGame === false); }
  $('maxRows').value = s.maxRows;
  $('onlyMine').checked = s.onlyMine;
  $('viewSel').value = s.view || 'auto';
  $('showCooldowns').checked = s.showCooldowns;
  if ($('cdViewModeField')) $('cdViewModeField').hidden = !s.showCooldowns;
  if ($('cdOnlyOnCooldownField')) $('cdOnlyOnCooldownField').hidden = !s.showCooldowns;
  if ($('cdOnlyOnCooldown')) $('cdOnlyOnCooldown').checked = !!s.cdOnlyOnCooldown;
  const cdMode = s.cdViewMode || 'icons';
  if ($('cdViewModeSel')) {
    for (const b of $('cdViewModeSel').children) b.classList.toggle('on', b.dataset.v === cdMode);
  }
  $('showTarget').checked = s.showTarget === true;
  $('showGS').checked = s.showGS === true;
  $('bossTarget').checked = s.bossTarget === true;
  if ($('bossView')) $('bossView').checked = s.bossView !== false;
  $('deathRecap').checked = s.deathRecap !== false;
  $('personalBest').checked = s.personalBest === true;
  if ($('blacklistAlert')) $('blacklistAlert').checked = s.blacklistAlert === true;
  $('streamerMode').checked = !!s.streamerMode;
  $('autoShowWithGame').checked = s.autoShowWithGame !== false;
  $('showCP').checked = s.showCP === true;
  $('showIdleParty').checked = s.showIdleParty === true;
  applyLang(s.lang || (typeof I18N !== 'undefined' ? I18N.getLang() : 'en'));
  $('combatOnlySound').checked = s.combatOnlySound;
  if ($('soundStagger')) $('soundStagger').checked = s.soundStagger === true;
  if ($('soundLowHp')) $('soundLowHp').checked = s.soundLowHp === true;
  if ($('soundPotion')) $('soundPotion').checked = s.soundPotion === true;
  if ($('visualToasts')) $('visualToasts').checked = s.visualToasts === true;
  if ($('itemTts')) $('itemTts').value = s.itemTts || 'off';

  updateCombatSoundChoices();
  $('autoStart').checked = !!s.autoStart;
  $('screenProtect').checked = s.screenProtect === true;
  $('timersOn').checked = s.timersOn === true;
  $('tab-timers').classList.toggle('dis', s.timersOn !== true);
  if ($('timerRegion').value !== s.timerRegion) $('timerRegion').value = s.timerRegion || 'global-eu';
  loadTimerAlertUi(s);
  for (const g of document.querySelectorAll('.seg2[data-k]')) for (const b of g.children) b.classList.toggle('on', String(s[g.dataset.k]) === b.dataset.v);
  renderShortcuts(s.shortcuts);
  $('ver').textContent = 'Version ' + data.version + ' · data: ' + data.dataDir;
  renderOwn();
  renderSkills(data.skills);
}

function renderOwn() {
  const id = data.ownId;
  const manual = data.settings.ownManual;
  const char = data.settings.charName;
  $('ownLine').innerHTML = id
    ? `<span class="ok">●</span> ${char ? esc(char) + ' (#' + id + ')' : 'Character #' + id}${manual ? ' · set manually' : ' · detected'}`
    : (char
      ? `<span class="ok">●</span> ${esc(char)} · ${t('waiting for combat')}`
      : '<span class="no">●</span> Character not found yet. Use a skill, or right-click your row.');
}

const COMBAT_ALERT_CHOICES = [
  { id: 'soundChoiceStagger', setting: 'soundChoiceStagger', default: 'stagger', alert: 'stagger' },
  { id: 'soundChoiceLowHp', setting: 'soundChoiceLowHp', default: 'lowhp', alert: 'lowhp' },
  { id: 'soundChoicePotion', setting: 'soundChoicePotion', default: 'potion', alert: 'potion' },
];

function updateCombatSoundChoices() {
  const s = (data && data.settings) || {};
  for (const item of COMBAT_ALERT_CHOICES) {
    const el = $(item.id);
    if (el) {
      const cur = (s && s[item.setting]) || item.default;
      el.innerHTML = combatSoundOptions(cur);
      el.value = cur;
      const row = el.closest('.sound-alert-row');
      const btn = row && row.querySelector('.btn-snd-test');
      if (btn) btn.dataset.sound = cur;
      el.onchange = async () => {
        await api.setSettings({ [item.setting]: el.value });
        if (data && data.settings) data.settings[item.setting] = el.value;
        if (btn) btn.dataset.sound = el.value;
      };
    }
  }
}

function combatSoundOptions(sel) {
  const presets = [
    { id: 'stagger', name: 'Boss Stagger (Gong/Break)' },
    { id: 'lowhp', name: 'Low HP Pulse (Heartbeat)' },
    { id: 'threat', name: 'Threat Alert (Double Warn)' },
    { id: 'potion', name: 'Potion Drop' },
    { id: 'can', name: 'Bell' },
    { id: 'bip', name: 'Beep' },
    { id: 'cift', name: 'Double beep' },
    { id: 'yukselen', name: 'Rising' },
    { id: 'damla', name: 'Drop' },
    { id: 'gong', name: 'Gong' },
    { id: 'oku', name: 'Text-to-Speech (TTS)' },
  ];
  const opts = presets.map((o) => `<option value="${o.id}"${o.id === sel ? ' selected' : ''}>${esc(t(o.name))}</option>`);
  for (const c of customs) opts.push(`<option value="${c.id}"${c.id === sel ? ' selected' : ''}>♪ ${esc(c.name)}</option>`);
  return opts.join('');
}

function soundOptions(sel) {
  const opts = Sound.SOUNDS.map((o) => `<option value="${o.id}"${o.id === sel ? ' selected' : ''}>${esc(t(o.name))}</option>`);
  for (const c of customs) opts.push(`<option value="${c.id}"${c.id === sel ? ' selected' : ''}>♪ ${esc(c.name)}</option>`);
  opts.push('<option value="__add">Add file…</option>');
  return opts.join('');
}

function metaText(s) {
  const parts = [];
  parts.push(`<span class="smeta-tag">${s.uses ? s.uses + (s.uses === 1 ? ' ' + t('use') : ' ' + t('uses')) : t('not used yet')}</span>`);
  if (s.passive) parts.push(`<span class="smeta-tag" style="color:#d49f57;">${t('passive proc')}</span>`);
  else if (s.via === 'hedefsiz') parts.push(`<span class="smeta-tag">${t('untargeted / buff')}</span>`);
  else if (s.via === 'vuruş') parts.push(`<span class="smeta-tag">${t('from hits')}</span>`);

  if (s.defaultMs) {
    parts.push(`<span class="smeta-tag official">${t('default')} ${fmt1.format(s.defaultMs / 1000)}s</span>`);
  } else if (s.learnedMs) {
    parts.push(`<span class="smeta-tag learned">${t('learned')} ${fmt1.format(s.learnedMs / 1000)}s</span>`);
    parts.push(`<a class="smeta-act" data-act="use" title="${t('Use the learned value')}">${t('use')}</a>`);
    parts.push(`<a class="smeta-act danger" data-act="forget" title="${t('Forget learned value')}">×</a>`);
  }

  const c = s.cfg || {};
  if (c.cdMs && (s.defaultMs || s.learnedMs)) {
    parts.push(`<a class="smeta-act" data-act="reset-default" title="${t('Reset to default cooldown')}">↺ ${t('Reset to default')}</a>`);
  }
  return parts.join(' ');
}

function renderSkillCard(s) {
  const c = s.cfg || {};
  const on = !!c.on;
  const cdSec = c.cdMs ? fmt1.format(c.cdMs / 1000) : '';
  const defMs = s.defaultMs || (s.src === 'sunucu' ? s.cdMs : s.learnedMs) || 0;
  const placeholder = defMs ? fmt1.format(defMs / 1000) : '–';
  const fallbackSrc = '../assets/icon.png';
  return `<div class="skc${on ? ' on' : ''}" data-base="${s.base}">
    <div class="top">
      <div class="sico-wrap">
        ${s.icon
          ? `<img class="sico" src="${esc(s.icon)}" alt="">`
          : `<img class="sico" src="${fallbackSrc}" alt="">`}
      </div>
      <div class="ti">
        <div class="sname">${esc(s.name)}</div>
        <div class="smeta">${metaText(s)}</div>
      </div>
      <button class="play" data-act="test" title="${t('Preview sound')}"><svg viewBox="0 0 12 12"><path d="M3 1.5v9l7.5-4.5z"/></svg></button>
      <label class="sw" title="${t('Track')}"><input type="checkbox" data-k="on"${on ? ' checked' : ''}><span></span></label>
    </div>
    <div class="opts">
      <label>${t('Cooldown')}<span class="cdin"><input type="text" inputmode="decimal" data-k="cd" value="${cdSec}" placeholder="${placeholder}"> s</span></label>
      <label>${t('Warn early')}<select data-k="early">${EARLY.map(([v, l]) => `<option value="${v}"${(c.earlyMs || 0) === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label>
      <label>${t('Sound')}<select data-k="sound">${soundOptions(c.sound || 'can')}</select></label>
    </div>
  </div>`;
}

function renderSkills(list) {
  const only = $('onlyTracked').checked;
  const hidePassives = $('hidePassives') ? $('hidePassives').checked : true;

  const all = (list || []).filter((s) => !only || (s.cfg && s.cfg.on));
  const activeRows = all.filter((s) => !s.passive);
  const passiveRows = all.filter((s) => s.passive);

  activeRows.sort((a, b) => (Number(!!(b.cfg && b.cfg.on)) - Number(!!(a.cfg && a.cfg.on)))
    || (b.lastCast - a.lastCast) || a.name.localeCompare(b.name));

  passiveRows.sort((a, b) => (Number(!!(b.cfg && b.cfg.on)) - Number(!!(a.cfg && a.cfg.on)))
    || (b.lastCast - a.lastCast) || a.name.localeCompare(b.name));

  const rows = hidePassives ? activeRows : [...activeRows, ...passiveRows];
  $('noSkills').hidden = (activeRows.length + passiveRows.length) > 0;

  const pg = $('passiveGroup');
  const pgBox = $('passiveSkills');
  const pgCount = $('pgCount');
  if (pg && pgBox) {
    if (hidePassives && passiveRows.length > 0) {
      pg.hidden = false;
      if (pgCount) pgCount.textContent = passiveRows.length;
      pgBox.innerHTML = passiveRows.map(renderSkillCard).join('');
    } else {
      pg.hidden = true;
      pgBox.innerHTML = '';
    }
  }

  const scWrap = $('showcaseWrap');
  const scBox = $('skillShowcase');
  if (scWrap && scBox) {
    const scList = (list || []).filter((s) => !s.passive && s.icon);
    scWrap.hidden = scList.length === 0;
    if (scList.length > 0) {
      scBox.innerHTML = '';
      scList.forEach((s) => {
        const on = !!(s.cfg && s.cfg.on);
        const item = document.createElement('div');
        item.className = 'sc-item' + (on ? ' on' : '');
        item.dataset.base = s.base;
        const durSec = s.cfg && s.cfg.cdMs ? Math.round(s.cfg.cdMs / 1000) : s.defaultMs ? Math.round(s.defaultMs / 1000) : 0;
        const cdTxt = durSec > 0 ? `${durSec}s` : '';
        item.title = `${s.name}${cdTxt ? ' (' + cdTxt + ')' : ''} · ${on ? t('Active') : t('Inactive')}`;
        item.innerHTML = `
          <img src="${esc(s.icon)}" alt="">
          ${cdTxt ? `<span class="sc-cd">${cdTxt}</span>` : ''}
          <span class="sc-badge">✓</span>
        `;
        item.onclick = async () => {
          await api.setSkill(s.base, { on: !on });
          data = await api.getSettings();
          renderSkills(data.skills);
        };
        scBox.appendChild(item);
      });
    }
  }

  $('skills').innerHTML = rows.map(renderSkillCard).join('');
}

async function saveRow(card, patch) {
  const base = Number(card.dataset.base);
  const cfg = await api.setSkill(base, patch);
  const item = data.skills.find((s) => s.base === base);
  if (item) item.cfg = cfg;
  card.classList.toggle('on', !!(cfg && cfg.on));
}

const box = $('tab-skills');
box.addEventListener('change', async (ev) => {
  const el = ev.target;
  const card = el.closest('.skc');
  if (!card) return;
  const k = el.dataset.k;
  const soundSel = card.querySelector('[data-k=sound]');
  if (k === 'on') await saveRow(card, { on: el.checked, sound: soundSel.value === '__add' ? 'can' : soundSel.value });
  else if (k === 'cd') {
    const rawVal = el.value.trim().replace(',', '.');
    const v = parseFloat(rawVal);
    const newCd = v > 0 ? Math.round(v * 1000) : 0;
    await saveRow(card, { cdMs: newCd });
    el.value = newCd > 0 ? fmt1.format(v) : '';
    const updated = await api.skills();
    data.skills = updated;
    renderSkills(data.skills);
  } else if (k === 'early') await saveRow(card, { earlyMs: Number(el.value) });
  else if (k === 'sound') {
    if (el.value === '__add') {
      const entry = await api.pickSound();
      if (entry) {
        customs.push(entry);
        Sound.setCustomSounds(customs);
        await saveRow(card, { sound: entry.id });
        data = await api.getSettings();
        renderSkills(data.skills);
        updateCombatSoundChoices();
      } else {
        const item = data.skills.find((s) => s.base === Number(card.dataset.base));
        el.value = (item && item.cfg && item.cfg.sound) || 'can';
      }
      return;
    }
    await saveRow(card, { sound: el.value });
    Sound.play(el.value, Number($('volume').value), card.querySelector('.sname').textContent);
  }
});
box.addEventListener('click', async (ev) => {
  const a = ev.target.closest('[data-act]');
  if (!a) return;
  const card = a.closest('.skc');
  const base = Number(card.dataset.base);
  const item = data.skills.find((s) => s.base === base);
  if (a.dataset.act === 'test') Sound.play(card.querySelector('[data-k=sound]').value, Number($('volume').value), item ? item.name : '');
  if (a.dataset.act === 'use' && item && item.learnedMs) {
    card.querySelector('[data-k=cd]').value = fmt1.format(item.learnedMs / 1000);
    await saveRow(card, { cdMs: item.learnedMs });
    const updated = await api.skills();
    data.skills = updated;
    renderSkills(data.skills);
  }
  if (a.dataset.act === 'forget') {
    await api.forgetLearned(base);
    if (item) item.learnedMs = 0;
    const updated = await api.skills();
    data.skills = updated;
    renderSkills(data.skills);
  }
  if (a.dataset.act === 'reset-default') {
    await api.resetSkill(base);
    const updated = await api.skills();
    data.skills = updated;
    renderSkills(data.skills);
  }
});
$('onlyTracked').onchange = () => renderSkills(data.skills);
if ($('hidePassives')) $('hidePassives').onchange = () => renderSkills(data.skills);

// genel
const bindRange = (id, key, alsoId) => {
  $(id).oninput = () => {
    const v = Number($(id).value);
    if (alsoId) $(alsoId).value = v;
    if (key === 'opacity') applyOpacity(v);
    api.setSettings({ [key]: v });
  };
};
bindRange('opacity', 'opacity');
// kaydırıcıların yanında yüzde
function showPct() {
  $('opacityV').textContent = Math.round(Number($('opacity').value) * 100) + '%';
}
$('opacity').addEventListener('input', showPct);
$('opacity').addEventListener('input', () => {
  applyOpacity(Number($('opacity').value));
});
function refreshUiScale() {
  if (!data) return;
  const s = data.settings;
  const z = data.zoom || 1;
  const isAuto = s.uiScale === 'auto' || typeof s.uiScale !== 'number';
  const val = isAuto ? 'auto' : Number(s.uiScale);
  const sel = $('uiScaleSel');
  if (!sel) return;
  for (const b of sel.children) {
    if (b.dataset.v === 'auto') {
      b.classList.toggle('on', isAuto);
      b.title = t('Match screen height') + ' (' + Math.round(z * 100) + '%)';
    } else {
      b.classList.toggle('on', !isAuto && Math.abs(Number(b.dataset.v) - val) < 0.06);
    }
  }
}
$('uiScaleSel').addEventListener('click', async (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  for (const x of $('uiScaleSel').children) x.classList.toggle('on', x === b);
  const v = b.dataset.v;
  const val = v === 'auto' ? 'auto' : Number(v);
  await api.setSettings({ uiScale: val });
  data = await api.getSettings();
  refreshUiScale();
});

bindRange('volume', 'volume', 'volume2');
bindRange('volume2', 'volume', 'volume');
$('idleSec').onchange = () => api.setSettings({ idleSec: Math.max(3, Math.min(60, Number($('idleSec').value) || 8)) });
$('autoHideSec').onchange = () => { const v = Math.max(10, Math.min(300, Math.round(Number($('autoHideSec').value) || 30))); $('autoHideSec').value = v; api.setSettings({ autoHideSec: v }); };
$('maxRows').onchange = () => api.setSettings({ maxRows: Math.max(1, Math.min(24, Number($('maxRows').value) || 8)) });
for (const id of ['onlyMine', 'showCooldowns', 'showTarget', 'showGS', 'showCP', 'bossTarget', 'bossView', 'deathRecap', 'personalBest', 'streamerMode', 'autoShowWithGame', 'combatOnlySound', 'autoStart', 'showIdleParty', 'cdOnlyOnCooldown', 'soundStagger', 'soundLowHp', 'soundPotion', 'visualToasts']) {
  const el = $(id);
  if (el) el.onchange = () => {
    api.setSettings({ [id]: el.checked });
    if (id === 'autoShowWithGame' && $('autoHideField')) $('autoHideField').classList.toggle('dis', !el.checked);
    if (id === 'showCooldowns') {
      if ($('cdViewModeField')) $('cdViewModeField').hidden = !el.checked;
      if ($('cdOnlyOnCooldownField')) $('cdOnlyOnCooldownField').hidden = !el.checked;
    }
  };
}
const playSoundPreview = (btn) => {
  if (!btn) return;
  const row = btn.closest('.sound-alert-row');
  const alertKind = btn.dataset.alert || (row && row.dataset.alert);
  let snd = btn.dataset.sound;
  if (row) {
    const sel = row.querySelector('.snd-choice');
    if (sel && sel.value) snd = sel.value;
  }
  if (!snd) return;
  const volInput = $('volume') || $('volume2');
  let vol = volInput && !Number.isNaN(Number(volInput.value)) && Number(volInput.value) >= 0
    ? Number(volInput.value)
    : ((data && data.settings && typeof data.settings.volume === 'number' && data.settings.volume >= 0) ? data.settings.volume : 0.8);

  btn.classList.add('playing');
  setTimeout(() => btn.classList.remove('playing'), 350);

  if (typeof Sound !== 'undefined' && Sound.play) {
    if (typeof Sound.ac === 'function') {
      try {
        const c = Sound.ac();
        if (c && (c.state === 'suspended' || c.state === 'interrupted')) c.resume().catch(() => {});
      } catch {}
    }
    const ttsText = (alertKind && typeof Sound.getAlertTts === 'function') ? Sound.getAlertTts(alertKind) : snd;
    Sound.play(snd, vol, (snd === 'oku' ? ttsText : snd), alertKind);
  }
};

const alertsGrid = document.querySelector('.sound-alerts-grid');
if (alertsGrid) {
  alertsGrid.addEventListener('click', (e) => {
    const btn = e.target.closest('.btn-snd-test');
    if (!btn) return;
    e.preventDefault();
    e.stopPropagation();
    playSoundPreview(btn);
  });
}
if ($('cdViewModeSel')) {
  $('cdViewModeSel').addEventListener('click', async (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of $('cdViewModeSel').children) x.classList.toggle('on', x === b);
    await api.setSettings({ cdViewMode: b.dataset.v });
  });
}
$('record').onclick = () => {
  api.startRecording();
  $('record').textContent = 'Recording…';
  $('record').disabled = true;
  setTimeout(() => { $('record').textContent = 'Record traffic (90 s)'; $('record').disabled = false; }, 90000);
};
$('screenProtect').onchange = () => api.setSettings({ screenProtect: $('screenProtect').checked });
for (const g of document.querySelectorAll('.seg2[data-k]')) {
  g.addEventListener('click', (e) => {
    const b = e.target.closest('button');
    if (!b) return;
    for (const x of g.children) x.classList.toggle('on', x === b);
    const v = b.dataset.v;
    api.setSettings({ [g.dataset.k]: v });
  });
}
$('accent').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (!b) return;
  const themeKey = b.dataset.v;
  if (themeKey === 'custom') {
    const customInput = $('customColorInput');
    if (customInput) {
      if (customInput.showPicker) {
        try { customInput.showPicker(); } catch { customInput.click(); }
      } else {
        customInput.click();
      }
    }
    return;
  }
  applyTheme(themeKey);
  api.setSettings({ accent: themeKey });
});

const customColorInput = $('customColorInput');
if (customColorInput) {
  const onColorPick = (e) => {
    const hex = e.target.value;
    const rgb = hexToRgb(hex);
    if (!rgb) return;
    if (data && data.settings) {
      data.settings.accent = 'custom';
      data.settings.customAccent = hex;
      data.settings.customAccentRgb = rgb;
    }
    applyTheme('custom', rgb, hex);
    api.setSettings({ accent: 'custom', customAccent: hex, customAccentRgb: rgb });
  };
  customColorInput.addEventListener('input', onColorPick);
  customColorInput.addEventListener('change', onColorPick);
}

// ---------------------------------------------------------------------------
// Kısayol Tuşları Yönetimi
// ---------------------------------------------------------------------------
const DEFAULT_SHORTCUTS = {
  toggle: 'CommandOrControl+Shift+D',
  clickThrough: 'CommandOrControl+Shift+L',
  reset: 'CommandOrControl+Shift+R',
  posLock: 'CommandOrControl+Shift+K',
};

function formatAcceleratorHtml(acc) {
  if (!acc) return '<span class="dim">–</span>';
  const parts = acc.split('+').map((p) => p.trim());
  return parts.map((p) => {
    let label = p;
    if (p === 'CommandOrControl' || p === 'CmdOrCtrl') label = 'Ctrl';
    return `<kbd>${label}</kbd>`;
  }).join('');
}

function renderShortcuts(sc) {
  const cur = sc || DEFAULT_SHORTCUTS;
  if ($('scKeysToggle')) $('scKeysToggle').innerHTML = formatAcceleratorHtml(cur.toggle || DEFAULT_SHORTCUTS.toggle);
  if ($('scKeysClickThrough')) $('scKeysClickThrough').innerHTML = formatAcceleratorHtml(cur.clickThrough || DEFAULT_SHORTCUTS.clickThrough);
  if ($('scKeysPosLock')) $('scKeysPosLock').innerHTML = formatAcceleratorHtml(cur.posLock || DEFAULT_SHORTCUTS.posLock);
  if ($('scKeysReset')) $('scKeysReset').innerHTML = formatAcceleratorHtml(cur.reset || DEFAULT_SHORTCUTS.reset);
}

let recordingAction = null;

function startRecordingShortcut(action, btn) {
  if (recordingAction) cancelRecordingShortcut();
  recordingAction = action;
  btn.classList.add('recording');
  const combo = btn.querySelector('.sc-combo');
  if (combo) combo.innerHTML = `<span class="sc-rec-msg">${typeof I18N !== 'undefined' ? I18N.t('Press keys...') : 'Press keys...'}</span>`;
}

function cancelRecordingShortcut() {
  if (!recordingAction) return;
  const btn = document.querySelector(`.sc-record-btn[data-k="${recordingAction}"]`);
  if (btn) {
    btn.classList.remove('recording');
    const sc = (data && data.settings && data.settings.shortcuts) || DEFAULT_SHORTCUTS;
    const cur = sc[recordingAction] || DEFAULT_SHORTCUTS[recordingAction];
    const combo = btn.querySelector('.sc-combo');
    if (combo) combo.innerHTML = formatAcceleratorHtml(cur);
  }
  recordingAction = null;
}

for (const btn of document.querySelectorAll('.sc-record-btn')) {
  btn.addEventListener('click', (e) => {
    e.stopPropagation();
    const action = btn.dataset.k;
    if (recordingAction === action) {
      cancelRecordingShortcut();
    } else {
      startRecordingShortcut(action, btn);
    }
  });
}

if ($('scResetDefaultsBtn')) {
  $('scResetDefaultsBtn').addEventListener('click', () => {
    const defaults = { ...DEFAULT_SHORTCUTS };
    if (data && data.settings) data.settings.shortcuts = defaults;
    renderShortcuts(defaults);
    api.setSettings({ shortcuts: defaults });
  });
}

window.addEventListener('keydown', (e) => {
  if (!recordingAction) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    e.stopPropagation();
    cancelRecordingShortcut();
    return;
  }

  // Modifiers alone do not finish shortcut
  if (['Control', 'Shift', 'Alt', 'Meta'].includes(e.key)) return;

  e.preventDefault();
  e.stopPropagation();

  const parts = [];
  if (e.ctrlKey || e.metaKey) parts.push('CommandOrControl');
  if (e.altKey) parts.push('Alt');
  if (e.shiftKey) parts.push('Shift');

  let key = e.key;
  if (key.length === 1) {
    key = key.toUpperCase();
  } else if (/^F\d+$/i.test(key)) {
    key = key.toUpperCase();
  } else if (key === 'ArrowUp') key = 'Up';
  else if (key === 'ArrowDown') key = 'Down';
  else if (key === 'ArrowLeft') key = 'Left';
  else if (key === 'ArrowRight') key = 'Right';
  else if (key === ' ') key = 'Space';

  // Require modifier unless function key
  if (parts.length === 0 && !/^F\d+$/.test(key)) {
    return;
  }

  parts.push(key);
  const accelerator = parts.join('+');
  const action = recordingAction;
  recordingAction = null;

  const btn = document.querySelector(`.sc-record-btn[data-k="${action}"]`);
  if (btn) {
    btn.classList.remove('recording');
    const combo = btn.querySelector('.sc-combo');
    if (combo) combo.innerHTML = formatAcceleratorHtml(accelerator);
  }

  if (data && data.settings) {
    data.settings.shortcuts = { ...(data.settings.shortcuts || DEFAULT_SHORTCUTS), [action]: accelerator };
    api.setSettings({ shortcuts: data.settings.shortcuts });
  } else {
    api.setSettings({ shortcuts: { [action]: accelerator } });
  }
});

window.addEventListener('mousedown', (e) => {
  if (recordingAction && !e.target.closest('.sc-record-btn')) {
    cancelRecordingShortcut();
  }
});
$('charName').onchange = () => {
  const v = $('charName').value.trim();
  api.setSettings({ charName: v || null });
};
if ($('itemTts')) $('itemTts').onchange = () => api.setSettings({ itemTts: $('itemTts').value });
$('viewSel').onchange = () => api.setSettings({ view: $('viewSel').value });
$('dataDir').onclick = () => api.openDataDir();
$('langSel').addEventListener('click', (e) => {
  const b = e.target.closest('button');
  if (b && b.dataset.v) {
    applyLang(b.dataset.v);
    api.setSettings({ lang: b.dataset.v });
  }
});
$('quit').onclick = () => api.quit();

// açıkken beceri listesi canlı yenilensin (yazarken bozma)
async function refresh() {
  if (!isOpen) return;
  const a = document.activeElement;
  if (a && a.closest && a.closest('#skills') && a.matches('input, select')) return;
  data = await api.getSettings();
  renderOwn();
  renderSkills(data.skills);
}
// kırık simgeyi sınıf simgesine düşür, o da yoksa gizle
document.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'IMG') {
    const img = e.target;
    if (!img._failed) {
      img._failed = true;
      const card = img.closest('[data-base]');
      let cls = 14;
      if (card && card.dataset.base) {
        const b = Number(card.dataset.base);
        cls = Math.floor(b / 1e6) || 14;
      }
      img.src = `../assets/classes/${cls}.png`;
    } else {
      img.style.visibility = 'hidden';
    }
  }
}, true);

api.on('skills-changed', refresh);
setInterval(refresh, 3000);
})();
