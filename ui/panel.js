'use strict';
/* global api, Sound */

const CLASS_COLORS = {
  10: '#cf76d6', 11: '#e3a457', 12: '#93acc9', 13: '#b384e3', 14: '#82c870', 15: '#5eaaf0',
  16: '#cf76d6', 17: '#eedd8a', 18: '#5cd0b9', 19: '#e2716a',
};
const OWN_COLOR = 'var(--own)';
const $ = (id) => document.getElementById(id);
const t = (s) => I18N.t(s);
// "Ranger #123", "Unknown monster" gibi motordan gelen adları çevir
const localName = (n) => { const m = /^(\S+)( #\d+)$/.exec(n || ''); return m ? t(m[1]) + m[2] : t(n); };

// Faz 8.13: yayıncı modu. Maskeleme yalnız gösterimde; motor verisi, kayıtlar ve puanlama dosyası değişmez.
// Takma adlar tek kaynaktan (ana süreç) gelir: state.mask tablosu değiştiğinde gönderilir, burada yalnız okunur.
const masker = MASK.createClient();
const streamerOn = () => !!(state && state.ui && state.ui.streamerMode);
// 'Gladiator 1' → 'Gladyatör 1' (taban ad çevrilir, sayı korunur)
function maskName(name, cls, isMe) {
  const lab = masker.alias(name, cls, isMe, t('Me'));
  const m = /^(.+?) (\d+)$/.exec(lab);
  return m ? t(m[1]) + ' ' + m[2] : lab;
}
// Ad yalnız dizgi olarak geldiğinde (boss hedefi, grup listesi) sınıfı güncel dövüşteki oyunculardan bul
function maskByName(name) {
  const e = state && state.enc;
  const a = e && Array.isArray(e.actors) ? e.actors.find((x) => x && x.name === name) : null;
  const known = state && state.status && state.status.charName;
  return maskName(name, a ? a.cls : null, !!(a && a.own) || (known && name === known));
}

const fmtInt = new Intl.NumberFormat('en-US', { maximumFractionDigits: 0 });
const fmt1 = new Intl.NumberFormat('en-US', { maximumFractionDigits: 1 });
function short(n) {
  if (n >= 1e9) return fmt1.format(n / 1e9) + 'B';
  if (n >= 1e6) return fmt1.format(n / 1e6) + 'M';
  if (n >= 1e5) return fmt1.format(n / 1e3) + 'K';
  return fmtInt.format(n);
}
const pct = (x) => Math.round(x * 100) + '%';
function clock(ms) {
  const s = Math.floor(ms / 1000);
  return Math.floor(s / 60) + ':' + String(s % 60).padStart(2, '0');
}
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

let state = null;
const expanded = new Set();
// Sürüm 2.0: panel görünümü: 'dmg' (hasar) | 'heal' (iyileştirme) | 'taken' (alınan hasar)
const MODES = ['dmg', 'heal', 'taken'];
let mode = 'dmg';
try { const m = localStorage.getItem('dl-mode'); if (MODES.includes(m)) mode = m; } catch { /* yok */ }
let lastDeathKey = null;
let ownAutoExpanded = false;
let toastTimer = null;
let cdRafId = null;
let isTickingCds = false;
const icon = (u) => (u ? `<img class="ico" src="${esc(u)}" alt="">` : '<span class="ico"></span>');
const rowEls = new Map();
// Faz 8.2: oyuncu değerlendirme özeti { küçükAd: { r: ortalama, n: notVar, b: kara liste } }; değişince main gönderir
let ratingsIdx = {};
let ratingsOn = true;

// ---------------------------------------------------------------------------
// Durum çizimi
// ---------------------------------------------------------------------------

function render(s) {
  try {
    state = s;
    if (s.mask) masker.apply(s.mask);
    if (s.ui.lang &&s.ui.lang !== I18N.getLang()) { I18N.setLang(s.ui.lang); I18N.applyDom(); if (window.Drawer && window.Drawer.isOpen) window.Drawer.refresh(); }
    document.documentElement.style.setProperty('--alpha', s.ui.opacity);
    if (s.ui.zoom && document.documentElement.style.zoom !== String(s.ui.zoom)) document.documentElement.style.zoom = s.ui.zoom;
    if (s.ui.accent) document.documentElement.style.setProperty('--acc-rgb', s.ui.accent);
    $('frame').classList.toggle('locked', !!s.ui.clickThrough);
    document.body.classList.toggle('locked', !!s.ui.clickThrough);
    $('lock').classList.toggle('on', !!s.ui.clickThrough);
    $('lockBadge').hidden = !s.ui.clickThrough;
    $('posLock').classList.toggle('on', !!s.ui.posLock);
    $('posBadge').hidden = !s.ui.posLock;
    document.body.classList.toggle('poslocked', !!s.ui.posLock);

    // durum noktası
    const st = s.status || {};
    $('dot').className = 'dot ' + (st.error ? 'err' : st.live ? 'ok' : st.running ? 'idle' : 'err');
    npcapMissing = !!st.npcapMissing;
    $('brand').classList.toggle('warn', npcapMissing);
    $('brand').title = npcapMissing ? t('Install Npcap from npcap.com')
      : st.error ? t(st.error)
      : st.vpnHint ? t(st.vpnHint)
      : st.live ? t('Reading game traffic') + (st.ownId ? t(' · character #') + st.ownId : '')
      : st.running ? t('Listening, no game traffic (is AION2 running?)')
      : st.waiting ? t('Waiting for administrator permission') : t('Listener stopped');

    // dövüş seçimi
    const e = s.enc;
    const isBoss = !!(e && (e.isBoss || e.boss));

    // Boss Rapor butonu (yalnızca boss dövüşündeyken veya geçmişte boss kaydı varken göster)
    const showReport = isBoss || (s.bosses && s.bosses.length > 0);
    const rBtn = $('bossReportBtn');
    if (rBtn) {
      rBtn.hidden = !showReport;
      const rTxt = $('bossReportText');
      if (rTxt) rTxt.textContent = t('Boss Details');
      rBtn.title = t('Boss Details');
    }

    // Süre / Dakika sayacı (Kural: Sadece boss fighttayken gözükmeli)
    const timerEl = $('timer');
    if (timerEl) {
      timerEl.hidden = !isBoss;
      if (isBoss && e) {
        timerEl.textContent = clock(e.dur);
      }
    }


    // özet (kendi satırımız - yabancı biri asla ben sayılamaz)
    const knownChar = (st && st.charName) || '';
    let me = null;
    if (e && e.actors) {
      if (knownChar) {
        const lowerChar = knownChar.toLowerCase();
        me = e.actors.find((a) => a.own || (a.name && a.name.toLowerCase() === lowerChar)) || null;
        if (!me) {
          me = e.actors.find((a) => a.own && (!a.name || a.name.includes('#'))) || null;
        }
      } else {
        me = e.actors.find((a) => a.own) || null;
      }
    }
    $('myDps').textContent = me ? short(me.dps) : '0';
    $('myTotal').textContent = me ? short(me.total) : '0';
    $('myShare').textContent = me ? pct(me.share) : '–';
    $('myCrit').textContent = me ? pct(me.crit) : '–';
    $('takenWrap').hidden = !(e && e.taken > 0);
    if (e) $('taken').textContent = short(e.taken);
    document.body.classList.toggle('m-heal', mode === 'heal');
    document.body.classList.toggle('m-taken', mode === 'taken');
    for (const b of document.querySelectorAll('#modes button')) b.classList.toggle('on', b.dataset.m === mode);
    $('facts').hidden = mode !== 'dmg';
    $('facts2').hidden = mode === 'dmg';
    $('bigUnit').textContent = mode === 'heal' ? 'hps' : mode === 'taken' ? t('taken') : 'dps';
    if (mode !== 'dmg') renderAltSummary(e, knownChar);
    checkDeath(s);

    // görünüm çipi
    const v = s.view || { mode: 'auto', eff: 'all' };
    const label = t({ me: 'Me', party: 'Party', all: 'All' }[v.eff] || 'All');
    $('view').innerHTML = esc(label) + (v.mode === 'auto' ? `<i>${t('auto')}</i>` : '');
    $('view').title = (v.mode === 'auto' ? t('Auto: only you, your party when grouped. ') : '') + t('Click to change.') + (v.party ? ` ${t('Party: ')}${streamerOn() ? v.party.members.map(maskByName).join(', ') : v.party.members.join(', ')}` : '');
    $('view').classList.toggle('party', v.eff === 'party');
    $('summary').classList.toggle('needown', !!v.needOwn);

    renderFocus(e);
    if (mode === 'dmg') { renderRows(e, s.ui ? s.ui.maxRows : 8); renderEmpty(e, st); }
    else { const list = mode === 'heal' ? healModels(e) : takenModels(e); renderAlt(list, s.ui ? s.ui.maxRows : 8); renderEmpty(e, st, list.length); }
    renderCds(s.cds);
    const pg = $('ping');
    if (st.ping) { pg.innerHTML = `${st.ping | 0}<small>ms</small>`; pg.className = 'num ' + (st.ping < 60 ? 'ok' : st.ping < 100 ? 'mid' : st.ping < 200 ? 'hi' : 'bad'); } else pg.textContent = '';
    document.body.classList.add('autosize');
    squeezeBar();
    scheduleFit();
  } catch (errRender) {
    console.error('panel render error:', errRender);
  }
}

// Faz 5.0-P.3: üst bar sığmazsa sırayla küçült (s1 "ms", s2 "auto", s3 "Boss Details" yazısı, s4 süre ve boşluklar).
// Sabit genişlik eşiği yok: bar gerçekten taşıyorsa bir sonraki kademe. Logo ve 4 araç düğmesi hiç gizlenmez.
const SQUEEZE = ['s1', 's2', 's3', 's4'];
let squeezing = false;
let lastBarSig = '';
function squeezeBar(forceRecalc = false) {
  if (squeezing) return;
  squeezing = true;
  try {
    const bar = $('bar');
    if (!bar) return;
    const clientW = bar.clientWidth;
    const sig = clientW + ':' + (bar.textContent || '');
    if (!forceRecalc && sig === lastBarSig) {
      return;
    }
    lastBarSig = sig;
    bar.classList.remove(...SQUEEZE);
    if (bar.scrollWidth <= bar.clientWidth) return;
    for (const c of SQUEEZE) {
      bar.classList.add(c);
      if (bar.scrollWidth <= bar.clientWidth) break;
    }
  } finally {
    squeezing = false;
  }
}
new ResizeObserver(() => squeezeBar(true)).observe($('bar'));
$('logo').addEventListener('load', () => squeezeBar(true));

// hedefin canı (008d) ve bu hızla kaç saniyede öleceği
function renderFocus(e) {
  try {
    const show = !state || !state.ui || state.ui.showTarget === true;
    const f = (show && e && e.live && e.focus && e.focus.hp !== 0) ? e.focus : null; // ölen veya kapatılan hedef gizlenir
    const box = $('focus');
    if (!box) return;
    box.hidden = !f;
    if (!f) return;
    $('fName').innerHTML = esc(f.name || t('Target')) + (f.boss ? '<span class="boss">BOSS</span>' : '')
      + ((f.boss && e.boss && e.boss.target && (!state || !state.ui || state.ui.bossTarget === true)) ? '<span class="btarget">' + esc(t('Target')) + ': ' + esc(streamerOn() ? maskByName(e.boss.target) : e.boss.target) + '</span>' : '');
    const p = (typeof f.max === 'number' && f.max > 0) ? Math.max(0, Math.min(1, f.hp / f.max)) : null;
    $('fPct').textContent = p === null ? '' : (p * 100).toFixed(p < 0.1 ? 1 : 0) + '%';
    $('fFill').style.width = p === null ? '0%' : (p * 100).toFixed(1) + '%';
    $('fHp').textContent = f.max ? `${short(f.hp)} / ${short(f.max)}` : '';
    $('fTtk').textContent = f.ttk ? '~' + (f.ttk < 60 ? Math.ceil(f.ttk) + ' s' : clock(f.ttk * 1000)) + ' ' + t('to kill') : '';
    // Sürüm 2.0: boss kırılma göstergesi (sadece canlı boss dövüşünde ve paket geldiyse)
    const g = e && e.boss && e.boss.stagger && e.boss.stagger.live ? e.boss.stagger : null;
    const sb = $('stg');
    if (sb) {
      sb.hidden = !(g && f.boss);
      if (g && f.boss) {
        sb.classList.toggle('broken', !!g.broken);
        const stgL = sb.querySelector('.stg-l');
        if (stgL) stgL.textContent = g.broken ? t('BROKEN') : t('Break');
        const stgFill = $('stgFill');
        if (stgFill) stgFill.style.width = (Math.max(0, Math.min(1, typeof g.pct === 'number' ? g.pct : 0)) * 100).toFixed(1) + '%';
        const stgTxt = $('stgTxt');
        if (stgTxt) stgTxt.textContent = g.broken ? '×' + (g.breaks || 1) : Math.round((g.pct || 0) * 100) + '%';
        sb.title = t('Boss break gauge') + ` · ${g.val || 0}/${g.max || 0}` + (g.breaks ? ` · ${t('breaks')} ${g.breaks}` : '') + (g.burstDmg ? ` · ${t('burst damage')} ${short(g.burstDmg)}` : '');
      }
    }
  } catch (errFocus) {
    console.error('renderFocus error:', errFocus);
  }
}

let lastTouch = 0;
for (const ev of ['pointerdown', 'wheel']) document.addEventListener(ev, (e) => {
  if (e && e.target && (e.target.closest('#gear') || e.target.closest('#drawer'))) return;
  lastTouch = Date.now();
  if (document.body.classList.contains('idle-compact')) {
    document.body.classList.remove('idle-compact');
    scheduleFit();
  }
}, true);

// otomatik boyut: içeriğin gerçek yüksekliğini ana sürece bildir (pencere pikseli)
let lastFitHeight = 0;
let fitRafId = null;
function scheduleFit() {
  if (fitRafId) return;
  fitRafId = requestAnimationFrame(() => {
    fitRafId = null;
    fit();
  });
}

function fit() {
  if (!state || !state.ui) return;
  const z = (state && state.ui && typeof state.ui.zoom === 'number' && state.ui.zoom > 0)
    ? state.ui.zoom
    : (parseFloat(document.documentElement.style.zoom) || 1);
  // Chromium'da documentElement zoom'u altındayken getBoundingClientRect() doğrudan pencere (DIP) pikseli döner
  const h = (sel) => { const el = document.querySelector(sel); return el && el.offsetParent !== null ? el.getBoundingClientRect().height : 0; };
  const e = state.enc;
  const combatEndedAt = (e && !e.live) ? (e.start + e.dur) : 0;
  const isBossCombat = !!(e && (e.isBoss || e.boss));
  // Canlı dövüş devam ederken (e.live) ASLA boşta küçülme (idle-compact) yapılmaz!
  // Boss dövüşü bittikten sonra da oyuncuların sonuçları inceleyebilmesi için 60 sn açık kalır.
  // Normal mob dövüşlerinde ise çatışma bitip 10 sn geçince otomatik küçülür.
  const gracePeriod = isBossCombat ? 60000 : 10000;
  const hasCombat = !!(e && e.actors && e.actors.length > 0);
  const idle = !hasCombat || (!e.live && state.selected === 0 && (Date.now() - combatEndedAt > gracePeriod) && (Date.now() - lastTouch > gracePeriod));

  if (document.body.classList.contains('idle-compact') !== idle) {
    document.body.classList.toggle('idle-compact', idle);
  }

  let rows = 0;
  const rowsEl = $('rows');
  if (!idle && rowsEl.style.display !== 'none' && rowsEl.children.length > 0) {
    let childH = 0;
    const first = rowsEl.firstElementChild;
    const last = rowsEl.lastElementChild;
    if (first && last) {
      const span = last.getBoundingClientRect().bottom - first.getBoundingClientRect().top;
      // paddingTop (3px) + paddingBottom (6px) + ilk/son satır kenar boşluğu (4px) = 13px * z
      childH = span + 13 * z;
    }
    rows = Math.ceil(childH > 0 ? childH : rowsEl.scrollHeight * z);
  }
  const cdsH = idle ? 0 : h('#cds');
  const isLocked = !!(state && state.ui && state.ui.clickThrough);
  const footBase = isLocked ? 18 : 8;
  const footH = (idle && !isLocked) ? 0 : Math.ceil(footBase * z);
  const emptyEl = $('empty');
  const emptyH = (!idle && !isLocked && emptyEl && emptyEl.classList.contains('show')) ? Math.ceil(64 * z) : 0;
  // Çerçeve kenarlığı (1px üst + 1px alt): 2px * z
  const borderBuffer = Math.ceil(2 * z);
  const total = h('#bar') + (idle ? 0 : h('#focus')) + h('#summary') + (idle ? 0 : rows + cdsH) + emptyH + footH + borderBuffer;
  const targetH = Math.ceil(total);
  if (Math.abs(targetH - lastFitHeight) >= 2) {
    lastFitHeight = targetH;
    api.fit(targetH);
  }
}

// Boşta kalınca küçülme kontrolü (dövüş bitip 7 sn geçince otomatik küçülür)
setInterval(() => {
  if (state && !document.body.classList.contains('open')) scheduleFit();
}, 1200);

function renderEmpty(e, st, altCount) {
  const el = $('empty');
  const isLocked = !!(state && state.ui && state.ui.clickThrough);
  const show = altCount === undefined ? (!e || !e.actors || !e.actors.length) : altCount === 0;

  // Dövüş verisi varsa kilitli modda da satırlar daima görünür kalmalıdır
  $('rows').style.display = show ? 'none' : '';

  // Kilitli (click-through) modda boş durum kutusu (bekleniyor yazısı) ekranda yer kaplamasın
  if (isLocked) {
    el.classList.remove('show');
    el.style.display = 'none';
    return;
  }

  el.classList.toggle('show', show);
  el.style.display = show ? '' : 'none';
  if (!show) return;
  let msg;
  const sStatus = st || (state && state.status) || {};
  if (sStatus.error) msg = `<b>${t('Listener not running')}</b><span>${esc(t(sStatus.error))}</span>`;
  else if (sStatus.waiting) msg = `<b>${t('Waiting for administrator permission')}</b><span>${t('Click "Yes" in the Windows prompt.')}</span>`;
  else if (!sStatus.live) msg = `<b>${t('Waiting for the game')}</b><span>${t('Traffic is read automatically once AION2 is running.')}</span>`;
  else if (altCount !== undefined && e) msg = mode === 'heal'
    ? `<b>${t('No healing yet')}</b><span>${t('Heals show once a skill is seen restoring HP (shields and buffs are left out).')}</span>`
    : `<b>${t('No damage taken yet')}</b><span>${t('Monster hits on you and your group show here.')}</span>`;
  else msg = `<b>${t('Waiting for combat')}</b><span>${t('Measuring starts with the first hit.')}</span>`;
  el.innerHTML = msg;
}

// ---------------------------------------------------------------------------
// Sürüm 2.0: iyileştirme ve alınan hasar görünümleri
// ---------------------------------------------------------------------------

function pickMe(list, knownChar) {
  if (!list) return null;
  if (knownChar) { const m = list.find((a) => a.name === knownChar); if (m) return m; }
  return list.find((a) => a.own) || null;
}

function renderAltSummary(e, knownChar) {
  const f = $('facts2');
  if (mode === 'heal') {
    const h = e && e.heal;
    const me = h ? pickMe(h.actors.filter((a) => a.group > 0 || a.self > 0), knownChar) : null;
    if (me) {
      $('myDps').textContent = short(me.hps);
      f.innerHTML = `<span><b class="num">${short(me.group)}</b> ${t('healing')}</span><span><b class="num">${short(me.self)}</b> ${t('self')}</span><span><b class="num">${pct(me.overPct)}</b> ${t('overheal')}</span>`;
    } else {
      $('myDps').textContent = h ? short(h.hps) : '0';
      f.innerHTML = h ? `<span><b class="num">${short(h.total)}</b> ${t('group healing')}</span>` : `<span>${t('no healing')}</span>`;
    }
  } else {
    const tk = e && e.takenBy;
    const me = tk ? pickMe(tk.actors, knownChar) : null;
    const deaths = e && e.deathList ? e.deathList.length : 0;
    if (me) {
      $('myDps').textContent = short(me.amount);
      f.innerHTML = `<span><b class="num">${short(me.biggest)}</b> ${t('biggest hit')}</span><span><b class="num">${me.hits + me.ticks}</b> ${t('hits')}</span><span><b class="num">${deaths}</b> ${t('deaths')}</span>`;
    } else {
      $('myDps').textContent = tk ? short(tk.total) : '0';
      f.innerHTML = `<span><b class="num">${deaths}</b> ${t('deaths')}</span>`;
    }
  }
}

function healModels(e) {
  const h = e && e.heal;
  if (!h || !Array.isArray(h.actors)) return [];
  // sadece iksiri olan satır gösterilmez (grup ya da kendine iyileştirmesi olan oyuncular)
  return h.actors.filter((a) => a && (a.group > 0 || a.self > 0)).map((a) => ({
    key: 'h:' + a.id, a, id: a.id, own: a.own, name: a.name, cls: a.cls,
    value: a.group || a.self || 0, rate: a.group ? a.hps : null, share: a.share || 0, selfOnly: !a.group,
    detail: () => {
      const skills = Array.isArray(a.skills) ? a.skills : [];
      const meta = `<div class="meta"><span>${short(a.group || 0)} ${t('healing')}</span><span>${t('self')} ${short(a.self || 0)}</span><span>${t('overheal')} ${pct(a.overPct || 0)}</span>${a.items ? `<span>${t('potions')} ${short(a.items)}</span>` : ''}<span>${a.heals || 0} ${t('heals')}</span></div>`;
      const head = `<div class="skh"><span>${t('Skill')}</span><span>${t('effective')}</span><span>${t('over')}</span><span></span></div>`;
      const top = skills.length ? skills[0].eff || 1 : 1;
      const rows = skills.slice(0, 14).map((k) => `<div class="sk"><span class="n">${icon(k.icon)}${esc(k.name || '')}</span><span class="v num">${short(k.eff || 0)}</span><span class="p num">${pct(k.amount ? (k.over || 0) / k.amount : 0)}</span><span class="c num">${k.heals || 0}×</span><span class="bar"><i style="width:${Math.min(100, ((k.eff || 0) / top) * 100).toFixed(1)}%"></i></span></div>`).join('');
      return meta + head + rows;
    },
  }));
}

function takenModels(e) {
  const tk = e && e.takenBy;
  if (!tk || !Array.isArray(tk.actors)) return [];
  return tk.actors.filter(Boolean).map((a) => ({
    key: 'k:' + a.id, a, id: a.id, own: a.own, name: a.name, cls: a.cls,
    value: a.amount || 0, rate: null, share: a.share || 0,
    detail: () => {
      const skills = Array.isArray(a.skills) ? a.skills : [];
      const meta = `<div class="meta"><span>${short(a.amount || 0)} ${t('taken')}</span><span>${a.hits || 0} ${t('hits')} · ${a.ticks || 0} ${t('ticks')}</span><span>${t('biggest')} ${short(a.biggest || 0)}${a.biggestName ? ' · ' + esc(a.biggestName) : ''}</span>${a.fatal ? `<span class="fatal">☠ ${esc(a.fatal)}</span>` : ''}</div>`;
      const rows = skills.map((k) => `<div class="sk"><span class="n">${esc(k.name || '')}</span><span class="v num">${short(k.amount || 0)}</span><span class="p num">${pct(k.share || 0)}</span><span class="c num">${(k.hits || 0) + (k.ticks || 0)}×</span>${k.from && k.from.length ? `<span class="src">${t('from')} ${esc(k.from.join(', '))}</span>` : ''}<span class="bar"><i style="width:${((k.share || 0) * 100).toFixed(1)}%"></i></span></div>`).join('');
      return meta + rows;
    },
  }));
}

const altEls = new Map();
const expandedAlt = new Set();
function renderAlt(list, maxRows) {
  try {
    const box = $('rows');
    // hasar satırları alternatif görünümde kutuda kalmasın
    for (const [id, el] of rowEls) { el.remove(); rowEls.delete(id); }
    const items = (Array.isArray(list) ? list : []).slice(0, Math.max(1, maxRows || 8));
    const top = items.length ? Math.max(...items.map((x) => x.value || 0)) || 1 : 1;
    const st = state ? state.status : null;
    const knownChar = (st && st.charName) || '';
    const seen = new Set();
    items.forEach((m, i) => {
      try {
        if (!m || !m.key) return;
        seen.add(m.key);
        let el = altEls.get(m.key);
        if (!el) {
          el = document.createElement('div');
          el.className = 'row';
          el.innerHTML = '<div class="fill"></div><div class="line"><span class="stripe"></span><span class="name"><img class="cls" alt=""><span class="nm"></span></span><span class="dmg num"></span><span class="dps num"></span><span class="pct num"></span></div><div class="detail" hidden></div>';
          el.addEventListener('click', () => { if (expandedAlt.has(el._key)) expandedAlt.delete(el._key); else expandedAlt.add(el._key); if (state) render(state); });
          altEls.set(m.key, el);
        }
        el._key = m.key;
        if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
        const isMe = !!(m.own || (knownChar && m.name === knownChar));
        el.style.setProperty('--c', isMe ? OWN_COLOR : CLASS_COLORS[m.cls] || '#9a968e');
        el.classList.toggle('own', isMe);
        el.querySelector('.fill').style.width = Math.min(100, Math.max(0, ((m.value || 0) / top) * 100)).toFixed(1) + '%';
        el.querySelector('.nm').textContent = streamerOn() ? maskName(m.name, m.cls, isMe) : (isMe ? t('You · ') : '') + localName(m.name);
        const ci = el.querySelector('.cls');
        if (m.cls) { const src = '../assets/classes/' + m.cls + '.png'; if (ci.getAttribute('src') !== src) ci.src = src; ci.hidden = false; } else ci.hidden = true;
        const dm = el.querySelector('.dmg');
        dm.textContent = short(m.value || 0);
        dm.hidden = m.rate === null;
        el.querySelector('.dps').textContent = m.rate === null ? short(m.value || 0) : short(m.rate);
        const pc = el.querySelector('.pct');
        pc.textContent = m.selfOnly ? '↺' : pct(m.share || 0);
        pc.title = m.selfOnly ? t('self') : '';
        el.classList.toggle('selfonly', !!m.selfOnly);
        const det = el.querySelector('.detail');
        const open = expandedAlt.has(m.key);
        det.hidden = !open;
        if (open) det.innerHTML = m.detail ? m.detail() : '';
      } catch (errAltItem) {
        console.error('renderAlt item error:', m, errAltItem);
      }
    });
    for (const [k, el] of altEls) if (!seen.has(k)) { el.remove(); altEls.delete(k); }
  } catch (errAlt) {
    console.error('renderAlt error:', errAlt);
  }
}

function setMode(m) {
  if (!MODES.includes(m) || m === mode) return;
  mode = m;
  try { localStorage.setItem('dl-mode', m); } catch { /* yok */ }
  for (const [k, el] of altEls) { el.remove(); altEls.delete(k); }
  for (const [id, el] of rowEls) { el.remove(); rowEls.delete(id); }
  if (state) render(state);
}
for (const b of document.querySelectorAll('#modes button')) b.addEventListener('click', (ev) => { ev.stopPropagation(); setMode(b.dataset.m); });

// Sürüm 2.0: kendi ölümün → kısa bildirim; tıklayınca Boss ve Oyuncular ekranı açılır
function checkDeath(s) {
  const d = s && s.deaths && s.deaths[0];
  if (!d) return;
  const key = d.player + ':' + d.t;
  if (lastDeathKey === null) { lastDeathKey = key; return; } // açılışta eski ölümü gösterme
  if (key === lastDeathKey) return;
  lastDeathKey = key;
  if (!d.own) return;
  const el = $('toast');
  el.textContent = '☠ ' + t('You died') + (d.skillName ? ': ' + d.skillName + (d.fatalAmount ? ' (' + short(d.fatalAmount) + ')' : '') : '') + ' · ' + t('details');
  el.classList.add('death');
  el.hidden = false;
  el.onclick = () => { el.hidden = true; api.openSettings('boss'); };
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.hidden = true; el.classList.remove('death'); el.onclick = null; }, 6000);
}

function renderRows(e, maxRows) {
  try {
    const box = $('rows');
    for (const [k, el] of altEls) { el.remove(); altEls.delete(k); }
    const st = state ? state.status : null;
    const actors = (e && Array.isArray(e.actors)) ? e.actors.slice(0, Math.max(1, maxRows || 8)) : [];
    const top = actors.length ? (actors[0].total || 1) : 1;
    const isBoss = !!(e && (e.isBoss || e.boss));
    const seen = new Set();
    actors.forEach((a, i) => {
      try {
        if (!a || a.id === null || a.id === undefined) return;
        seen.add(a.id);
        let el = rowEls.get(a.id);
        if (!el) {
          el = document.createElement('div');
          el.className = 'row';
          el.innerHTML = '<div class="fill"></div><div class="line"><span class="stripe"></span><span class="name"><img class="cls" alt=""><span class="nm"></span><span class="rb" hidden></span><span class="gc num" hidden><span class="gc-gs" hidden><img class="ico-gs" src="../assets/badge-gs.png" alt=""><span class="gc-t"></span></span><span class="gc-cp" hidden><img class="ico-cp" src="../assets/badge-cp.png" alt=""><span class="gc-t"></span></span></span></span><span class="dmg num" hidden></span><span class="dps num"></span><span class="pct num"></span></div><div class="detail" hidden></div>';
          el.addEventListener('click', () => { if (expanded.has(a.id)) expanded.delete(a.id); else expanded.add(a.id); if (state) render(state); });
          el.addEventListener('contextmenu', (ev) => { ev.preventDefault(); rowMenu(ev, el._actor); });
          rowEls.set(a.id, el);
        }
        el._actor = a;
        if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
        const rawName = a.name || '';
        const hasRealName = rawName && !rawName.includes('#');
        const knownChar = (st && st.charName) || '';
        const isNamedMe = !!(knownChar && rawName === knownChar);
        const isOtherName = !!(knownChar && hasRealName && rawName !== knownChar);

        // KURAL: Karakter adı belliyse ve bu aktörün adı farklıysa, ASLA 'You' olamaz!
        // Asla alanda tek kişi var diye (actors.length === 1) başkası "You" yapılamaz!
        const isMe = !isOtherName && (a.own || isNamedMe);
        const color = isMe ? OWN_COLOR : CLASS_COLORS[a.cls] || '#9a968e';
        el.style.setProperty('--c', color);
        el.classList.toggle('own', isMe);

        // Hasar dolum çubuğu (Details! standardı: en çok vuran lider oyuncuya oranla dolar)
        const fillEl = el.querySelector('.fill');
        if (fillEl) {
          const fillPct = top > 0 ? Math.min(100, Math.max(0, ((a.total || 0) / top) * 100)) : 0;
          fillEl.style.width = fillPct.toFixed(1) + '%';
        }

        const finalName = hasRealName ? localName(rawName) : (isMe && knownChar ? knownChar : localName(rawName));
        const nmEl = el.querySelector('.nm');
        if (nmEl) nmEl.textContent = streamerOn() ? maskName(rawName, a.cls, isMe) : (isMe ? t('You · ') : '') + finalName;

        // Faz 8.2: ad hücresindeki rozet düğümü (⚠️ kara liste, ⭐ ortalama, 📝 not); yalnız metin değişirse yazılır
        const rbEl = el.querySelector('.rb');
        if (rbEl) {
          let rs = (ratingsOn && !streamerOn() && hasRealName && !isMe) ? (ratingsIdx[rawName.toLowerCase() + '|' + (a.server || '')] || (a.server ? ratingsIdx[rawName.toLowerCase() + '|'] : null)) : null; // ad + sunucu; sunucusuz eski kayıt yedek
          if (!rs && a.bl && ratingsOn && !streamerOn() && hasRealName && !isMe) rs = { b: 1 }; // ana süreç kara liste bayrağı (sanal satır dahil)
          const rt = rs ? (rs.b ? '⚠️' : '') + (rs.r ? '⭐' + rs.r : '') + (rs.n ? '📝' : '') : '';
          if (rbEl._t !== rt) {
            rbEl._t = rt;
            rbEl.textContent = rt;
            rbEl.hidden = !rt;
            rbEl.classList.toggle('bad', !!(rs && rs.b));
            rbEl.title = rs ? (rs.b ? t('Blacklisted') : '') + (rs.b && rs.r ? ' · ' : '') + (rs.r ? t('Rating') + ' ' + rs.r + '/5' : '') : '';
          }
        }

        // Faz 6.2b (S-17, biçim A): grup üyesinde "GS · CP", grupta olmayanlarda hiçbir şey (oyun göndermiyor)
        const gc = el.querySelector('.gc');
        if (gc) {
          const ui = (state && state.ui) || {};
          // Faz 8.5: statik rozet kapları korunur; yalnız metin düğümleri/gizlilik güncellenir (DOM yeniden kurulmaz)
          const gsEl = gc.querySelector('.gc-gs');
          const cpEl = gc.querySelector('.gc-cp');
          const showG = !!(gsEl && ui.showGS === true && a.gs);
          const showC = !!(cpEl && ui.showCP === true && typeof a.cp === 'number' && a.cp > 0);
          if (gsEl) {
            gsEl.hidden = !showG;
            if (showG) {
              const gt = gsEl.lastChild;
              const gv = String(a.gs);
              if (gt.textContent !== gv) { gt.textContent = gv; gsEl.title = t('Gear Score') + ' ' + gv; }
            }
          }
          if (cpEl) {
            cpEl.hidden = !showC;
            if (showC) {
              const ct = cpEl.lastChild;
              const cv = a.cp >= 1e4 ? fmt1.format(a.cp / 1e3) + 'K' : fmtInt.format(a.cp);
              if (ct.textContent !== cv) { ct.textContent = cv; cpEl.title = t('Combat Power') + ' ' + a.cp.toLocaleString(); }
            }
          }
          gc.hidden = !(showG || showC);
        }
        const ci = el.querySelector('.cls');
        if (ci) {
          if (a.cls) {
            const src = '../assets/classes/' + a.cls + '.png';
            if (ci.getAttribute('src') !== src) ci.src = src;
            ci.hidden = false;
          } else {
            ci.hidden = true;
          }
        }
        
        let dmgEl = el.querySelector('.dmg');
        if (!dmgEl) {
          const line = el.querySelector('.line');
          if (line) {
            dmgEl = document.createElement('span');
            dmgEl.className = 'dmg num';
            line.insertBefore(dmgEl, line.querySelector('.dps'));
          }
        }
        if (dmgEl) {
          dmgEl.textContent = short(a.total || 0);
          dmgEl.hidden = !isBoss;
          dmgEl.title = t('damage');
        }

        const dpsEl = el.querySelector('.dps');
        if (dpsEl) dpsEl.textContent = short(a.dps || 0);
        const pctEl = el.querySelector('.pct');
        if (pctEl) pctEl.textContent = pct(a.share || 0);
        const det = el.querySelector('.detail');
        if (det) {
          const open = expanded.has(a.id);
          det.hidden = !open;
          if (open) det.innerHTML = detailHtml(a);
        }
      } catch (errActor) {
        console.error('Actor render error:', a, errActor);
      }
    });
    for (const [id, el] of rowEls) {
      if (!seen.has(id)) { el.remove(); rowEls.delete(id); }
    }
  } catch (errRows) {
    console.error('renderRows error:', errRows);
  }
}

const openSkills = new Set(); // "aktör:beceri" açık ayrıntılar

function detailHtml(a) {
  if (!a) return '';
  const meta = `<div class="meta"><span>${short(a.total || 0)} ${t('damage')}</span><span>${a.hits || 0} ${t('hits')}</span><span>${t('crit')} ${pct(a.crit || 0)}</span><span>${t('back')} ${pct(a.back || 0)}</span><span>${t('max')} ${short(a.max || 0)}</span></div>`;
  const skillsList = Array.isArray(a.skills) ? a.skills : [];
  const rows = skillsList.slice(0, 16).map((k) => {
    if (!k) return '';
    const key = (a.id || 0) + ':' + (k.skill || 0) + (k.dot ? 'd' : '');
    const open = openSkills.has(key);
    const det = open ? `<div class="skd">
        <span>${t('DPS')} <b>${short(k.dps || 0)}</b></span><span>${t('Hits')} <b>${k.hits || 0}</b></span><span>${t('Targets')} <b>${k.targets || 0}</b></span>
        <span>${t('Avg')} <b>${short(k.avg || 0)}</b></span><span>${t('Min')} <b>${short(k.min || 0)}</b></span><span>${t('Max')} <b>${short(k.max || 0)}</b></span>
        <span>${t('Crit')} <b>${pct(k.crit || 0)}</b></span><span>${t('Avg crit')} <b>${k.avgCrit ? short(k.avgCrit) : '–'}</b></span><span>${t('Avg normal')} <b>${k.avgNormal ? short(k.avgNormal) : '–'}</b></span>
        <span>${t('Back')} <b>${pct(k.back || 0)}</b></span><span>${t('Perfect')} <b>${pct(k.perfect || 0)}</b></span><span>${t('Multi-hit')} <b>${pct(k.double || 0)}</b></span>
      </div>` : '';
    return `
    <div class="sk${open ? ' open' : ''}" data-key="${esc(key)}" title="${t('Click for details')}">
      <span class="n">${icon(k.icon)}${esc(k.name || '')}</span><span class="v num">${short(k.total || 0)}</span><span class="p num">${pct(k.share || 0)}</span><span class="c num">${k.hits || 0}×</span>
      <span class="bar"><i style="width:${(Math.max(0, Math.min(1, k.share || 0)) * 100).toFixed(1)}%"></i></span>${det}
    </div>`;
  }).join('');
  return meta + rows;
}

// beceri satırına tıklama: ayrıntıyı aç/kapa (oyuncu satırı kapanmasın)
document.getElementById('rows').addEventListener('click', (ev) => {
  const sk = ev.target.closest('.sk');
  if (!sk) return;
  ev.stopPropagation();
  const k = sk.dataset.key;
  if (openSkills.has(k)) openSkills.delete(k); else openSkills.add(k);
  if (state) render(state);
}, true);

// ---------------------------------------------------------------------------
// Bekleme süreleri (yerel saatle akıcı geri sayım)
// ---------------------------------------------------------------------------

const cdEls = new Map();
let cdList = [];
function formatCdLeft(left, isIconMode) {
  if (left <= 0) return isIconMode ? '✓' : t('ready');
  const sec = left / 1000;
  if (sec >= 60) {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    return `${m}:${String(s).padStart(2, '0')}`;
  }
  if (sec >= 10) {
    return Math.ceil(sec) + 's';
  }
  return fmt1.format(sec) + 's';
}

function renderCds(list) {
  cdList = list || [];
  const box = $('cds');
  if (!box) return;
  if (!state || !state.ui.showCooldowns) {
    if (cdRafId) { cancelAnimationFrame(cdRafId); cdRafId = null; }
    isTickingCds = false;
    box.innerHTML = ''; cdEls.clear(); return;
  }
  const isIcon = !state.ui || (state.ui.cdViewMode || 'icons') === 'icons';
  box.classList.toggle('mode-icons', isIcon);
  box.classList.toggle('mode-bars', !isIcon);
  const now = Date.now();
  const sorted = [...cdList].sort((a, b) => {
    const leftA = a.readyAt && a.readyAt > now ? a.readyAt - now : 0;
    const leftB = b.readyAt && b.readyAt > now ? b.readyAt - now : 0;
    if (leftA > 0 && leftB > 0) return leftA - leftB;
    if (leftA > 0) return -1;
    if (leftB > 0) return 1;
    return (b.lastCast || 0) - (a.lastCast || 0);
  });
  const seen = new Set();
  sorted.forEach((c, i) => {
    seen.add(c.base);
    let el = cdEls.get(c.base);
    if (!el) {
      el = document.createElement('div');
      el.className = 'cd';
      el.innerHTML = '<div class="prog"></div><span class="n"><img class="ico" alt=""><span class="t"></span></span><span class="s"></span>';
      cdEls.set(c.base, el);
    }
    if (box.children[i] !== el) box.insertBefore(el, box.children[i] || null);
    el.title = c.name + (c.cdMs ? ` · ${fmt1.format(c.cdMs / 1000)} s` : ' · ' + t('cooldown unknown'));
    el.querySelector('.t').textContent = c.name;
    const im = el.querySelector('img');
    if (c.icon && im.getAttribute('src') !== c.icon) im.src = c.icon;
    el._cd = c;
  });
  for (const [b, el] of cdEls) if (!seen.has(b)) { el.remove(); cdEls.delete(b); }
  ensureTickCds();
}

function ensureTickCds() {
  if (isTickingCds) return;
  isTickingCds = true;
  cdRafId = requestAnimationFrame(tickCds);
}

function tickCds() {
  cdRafId = null;
  const now = Date.now();
  const isIcon = !state || !state.ui || (state.ui.cdViewMode || 'icons') === 'icons';
  const onlyOnCd = !!(state && state.ui && state.ui.cdOnlyOnCooldown);
  const box = $('cds');
  let visibleCount = 0;
  let anyActive = false;

  for (const el of cdEls.values()) {
    const c = el._cd;
    const left = c.readyAt ? c.readyAt - now : 0;
    const total = c.readyAt ? c.readyAt - c.startAt : 1;
    const ready = left <= 0;
    if (!ready) anyActive = true;

    if (ready && el._wasCooldown) {
      el._wasCooldown = false;
      el._flashUntil = now + 2500;
      el.classList.remove('flash');
      requestAnimationFrame(() => el.classList.add('flash'));
    } else if (!ready) {
      el._wasCooldown = true;
    }

    const isFlashing = el._flashUntil && el._flashUntil > now;
    if (isFlashing) anyActive = true;

    if (onlyOnCd) {
      const show = !ready || isFlashing;
      el.style.display = show ? '' : 'none';
      if (show) visibleCount++;
    } else {
      el.style.display = '';
      visibleCount++;
    }

    if (!ready) {
      el.style.order = Math.min(999999, Math.round(left / 100));
    } else {
      el.style.order = 1000000;
    }

    el.classList.toggle('ready', ready);
    el.classList.toggle('soon', !ready && left < 3000);
    if (isIcon) {
      const pct = ready ? 0 : Math.min(100, Math.max(0, (left / total) * 100));
      el.querySelector('.prog').style.height = pct + '%';
      el.querySelector('.prog').style.width = '100%';
    } else {
      el.querySelector('.prog').style.width = ready ? '0%' : (100 * left / total).toFixed(1) + '%';
      el.querySelector('.prog').style.height = '100%';
    }
    el.querySelector('.s').textContent = formatCdLeft(left, isIcon);
  }

  if (onlyOnCd && box) {
    box.style.display = visibleCount === 0 ? 'none' : '';
  } else if (box) {
    box.style.display = '';
  }

  if (anyActive && cdEls.size > 0) {
    isTickingCds = true;
    cdRafId = requestAnimationFrame(tickCds);
  } else {
    isTickingCds = false;
  }
}

// ---------------------------------------------------------------------------
// Uyarılar
// ---------------------------------------------------------------------------

// Faz 8.16: Npcap kurulu değilken (kırmızı nokta) logoya tıklayınca kurulum ipucu gösterilir
let npcapMissing = false;
$('brand').addEventListener('click', () => { if (npcapMissing) showPanelToast(t('Install Npcap from npcap.com'), 'threat', 4000); });

function showPanelToast(text, kind = 'ready', dur = 1800) {
  const t = $('toast');
  if (!t) return;
  t.classList.remove('death', 'stagger', 'threat', 'lowhp', 'potion', 'pb');
  if (kind && kind !== 'ready') t.classList.add(kind);
  t.onclick = null;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    t.hidden = true;
    t.classList.remove('death', 'stagger', 'threat', 'lowhp', 'potion', 'pb');
  }, dur);
}


function onAlert(a) {
  let snd = a.sound;
  if (!snd) {
    if (a.kind === 'stagger') snd = 'stagger';
    else if (a.kind === 'lowhp') snd = 'lowhp';
    else if (a.kind === 'potion') snd = 'potion';
    else snd = 'can';
  }
  const ttsText = a.tts || (typeof Sound !== 'undefined' && Sound.getAlertTts ? Sound.getAlertTts(a.kind) : a.name);
  Sound.play(snd, a.volume, (snd === 'oku' && ttsText) ? ttsText : a.name, a.kind);
  const showVisual = a.visual !== false && (!state || !state.ui || state.ui.visualToasts === true);
  if (a.kind === 'ready') {
    const el = cdEls.get(a.base);
    if (el) {
      el._flashUntil = Date.now() + 2500;
      el.classList.remove('flash');
      requestAnimationFrame(() => el.classList.add('flash'));
    }
    if (showVisual) showPanelToast(a.name + I18N.t(' ready'), 'ready', 1600);
  } else if (showVisual) {
    if (a.kind === 'stagger') {
      showPanelToast('⚡ ' + (a.name || I18N.t('Boss Stagger')) + ' (' + I18N.t('BURST WINDOW') + ')', 'stagger', 2400);
    } else if (a.kind === 'lowhp') {
      showPanelToast('❤️ ' + (a.name || I18N.t('Low HP Alert')), 'lowhp', 2200);
    } else if (a.kind === 'pb') {
      showPanelToast('🏆 ' + (a.name || I18N.t('New record!')), 'pb', 4500);
    } else if (a.kind === 'blacklist') {
      showPanelToast('⛔ ' + (a.name || I18N.t('Blacklisted player in party')), 'threat', 6000);
    } else if (a.kind === 'potion') {
      showPanelToast('🧪 ' + (a.name || I18N.t('Potion')), 'potion', 1600);
    }
  }
}

// ---------------------------------------------------------------------------
// Menü ve düğmeler
// ---------------------------------------------------------------------------

function positionMenu(ev, m) {
  m.hidden = false;
  m.style.visibility = 'hidden';
  m.style.left = '0px';
  m.style.top = '0px';

  const rectM = m.getBoundingClientRect();
  const mw = rectM.width || m.offsetWidth || 180;
  const mh = rectM.height || m.offsetHeight || 80;
  const clientW = document.documentElement.clientWidth;
  const clientH = document.documentElement.clientHeight;
  const pad = 8;

  const targetEl = (ev.target && ev.target.closest) ? (ev.target.closest('.cd') || ev.target.closest('.row') || ev.target.closest('.chip')) : null;

  let left, top;

  if (targetEl) {
    const r = targetEl.getBoundingClientRect();
    // Simgenin doğrudan ÜSTÜNDE aç
    top = r.top - mh - 6;
    if (top < pad) {
      // Yukarıya sığmıyorsa simgenin altına aç
      top = r.bottom + 6;
    }
    // Yatay hizalama: Sağa sığmıyorsa simgenin sağına yasla (sola doğru aç)
    if (r.left + mw <= clientW - pad) {
      left = r.left;
    } else {
      left = r.right - mw;
    }
  } else {
    // Fare koordinatlarına göre: farenin ÜSTÜNDE aç
    top = ev.clientY - mh - 6;
    if (top < pad) top = ev.clientY + 6;
    left = ev.clientX;
    if (left + mw > clientW - pad) left = left - mw;
  }

  // Panel sınırları dışına kesinlikle taşamaz
  left = Math.max(pad, Math.min(left, clientW - mw - pad));
  top = Math.max(pad, Math.min(top, clientH - mh - pad));

  m.style.left = Math.round(left) + 'px';
  m.style.top = Math.round(top) + 'px';
  m.style.visibility = 'visible';
}

function rowMenu(ev, a) {
  const m = $('menu');
  // items: [simge, etiket, işlev, tehlikeli?]. hasar vurmayan parti üyesi (sanal satır) da gerçek adla kara listeye alınabilir
  const items = [];
  if (a.own && !a.idle) items.push(['👤', t('Not me (detect automatically)'), () => api.setOwn(null)]);
  const named = a.name && !String(a.name).includes('#');
  if (ratingsOn && !a.own && named) {
    const rs = ratingsIdx[String(a.name).toLowerCase() + '|' + (a.server || '')] || (a.server ? ratingsIdx[String(a.name).toLowerCase() + '|'] : null);
    const bl = !!(a.bl || (rs && rs.b));
    // Mevcut kara liste mekanizması (quick-rate): aynı ad + sunucu; panel rozeti defter değişince kendiliğinden güncellenir
    items.push(['⛔', t(bl ? 'Remove from blacklist' : 'Blacklist'), () => api.quickRate({ name: a.name, server: a.server || 0, blacklist: !bl }), !bl]);
    // Faz 8.2: oyuncuyu değerlendir (★); Ayarlar > Players sekmesini ad dolu açar. Yayıncı modunda da çalışır: ham ad yalnız ana sürece gider
    items.push(['★', t('Rate player'), () => api.ratingsOpen(a.name, a.server || 0)]);
  }
  if (!items.length) { m.hidden = true; return; }
  m.innerHTML = '';
  for (const [ico, label, fn, danger] of items) {
    const b = document.createElement('button');
    if (danger) b.className = 'danger';
    const ic = document.createElement('i'); ic.textContent = ico;
    const tx = document.createElement('span'); tx.textContent = label;
    b.append(ic, tx);
    b.onclick = () => { m.hidden = true; fn(); };
    m.appendChild(b);
  }
  positionMenu(ev, m);
}

document.addEventListener('pointerdown', (ev) => { if (!$('menu').contains(ev.target)) $('menu').hidden = true; });

$('reset').onclick = () => { expanded.clear(); ownAutoExpanded = false; api.reset(); };
$('lock').onclick = () => api.toggleClickThrough();
$('posLock').onclick = () => api.togglePosLock();
const VIEWS = ['auto', 'me', 'party', 'all'];
$('view').onclick = () => {
  const cur = (state && state.view && state.view.mode) || 'auto';
  api.setSettings({ view: VIEWS[(VIEWS.indexOf(cur) + 1) % VIEWS.length] });
};
$('view').oncontextmenu = (ev) => {
  ev.preventDefault();
  const m = $('menu');
  m.innerHTML = '';
  const modes = [
    ['auto', `⚙️ ${t('Auto')} (${t('party when grouped')})`],
    ['all', `🌐 ${t('All')} (${t('everyone')})`],
    ['me', `👤 ${t('Me')} (${t('only you')})`],
    ['party', `🛡️ ${t('Party')}`],
  ];
  for (const [mode, lbl] of modes) {
    const b = document.createElement('button');
    b.textContent = lbl;
    b.onclick = () => { m.hidden = true; api.setSettings({ view: mode }); };
    m.appendChild(b);
  }
  positionMenu(ev, m);
};
$('gear').onclick = () => api.drawerToggle();
$('hide').onclick = () => api.hidePanel();

$('bossReportBtn').onclick = (ev) => {
  ev.stopPropagation();
  api.openSettings('boss');
};

api.on('drawer-status', (d) => {
  $('gear').classList.toggle('on', !!(d && d.open));
});

// kısa bilgi notu (ör. geliştirme sürümünde "yeni kod hazır")
api.on('notice', (text) => {
  const t = $('toast');
  t.classList.remove('death', 'stagger', 'threat', 'lowhp', 'potion', 'pb'); t.onclick = null;
  t.textContent = text;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.hidden = true; }, 5000);
});

// taşıma: üst çubuk (tıklama geçirgenken taşınmaz)
window.enableDrag('#bar', api.drag, () => !(state && (state.ui.clickThrough || state.ui.posLock)));

api.on('state', render);
api.on('alert', onAlert);
// Faz 9: zamanlayıcı uyarı sesi + İngilizce sesli okuma (yazı kutusu ayrı pencerede)
api.on('timer-sound', (a) => {
  if (!a) return;
  Sound.play(a.sound, a.volume);
  if (a.tts) Sound.speak(a.tts, a.volume, a.lang);
});
api.on('ratings-changed', (d) => { ratingsOn = !d || d.on !== false; ratingsIdx = (d && d.index) || {}; if (state) render(state); });
api.getRatings().then((d) => { ratingsOn = d.on !== false; ratingsIdx = d.index || {}; }).catch(() => {});
api.on('custom-sounds', (l) => Sound.setCustomSounds(l));
api.customSounds().then((l) => Sound.setCustomSounds(l));

// kırık simgeyi sınıf simgesine düşür, o da yoksa gizle
document.addEventListener('error', (e) => {
  if (e.target && e.target.tagName === 'IMG') {
    const img = e.target;
    if (!img._fallback) {
      img._fallback = true;
      const cdEl = img.closest('.cd');
      const cls = (cdEl && cdEl._cd && cdEl._cd.base) ? Math.floor(cdEl._cd.base / 1e6) : 14;
      img.src = `../assets/classes/${cls || 14}.png`;
    } else {
      img.style.visibility = 'hidden';
    }
  }
}, true);
