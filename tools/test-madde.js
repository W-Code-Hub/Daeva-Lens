'use strict';
// 5 maddelik iş: tehdit sesi kalktı, sağ tık menüsü, hasar vurmayan üyeler, Türkçe zamanlayıcı okuma, mini mod (Electron gerekmez).
const fs = require('fs');
const path = require('path');
const A = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(A, p), 'utf8');
const mk = (errors) => (c, msg) => { if (!c) errors.push(msg); };

function maddeTests() {
  const errors = []; const ok = mk(errors);
  const MAIN = read('main.js'); const DJ = read('ui/drawer.js'); const DH = read('ui/drawer.html');
  const PJ = read('ui/panel.js'); const PC = read('ui/panel.css'); const I18N = read('ui/i18n.js'); const M = read('lib/meter.js');
  // 1) Boss hedefi sesli uyarısı yok; hedef göstergesi (rozet) duruyor
  ok(!/soundThreat|soundChoiceThreat/.test(DJ + DH + PJ) && !/^\s*soundThreat:/m.test(MAIN), 'boss hedefi ses ayarı arayüzde/varsayılanda kalmamalı');
  ok(/delete settings\[k\]/.test(MAIN) && MAIN.includes("['soundThreat', 'soundChoiceThreat']"), 'eski threat ses ayarları silinir');
  ok(DH.includes('id="bossTarget"') && PJ.includes('btarget'), 'boss hedefi göstergesi kalır');
  // 2) Sağ tık menüsü
  ok(!I18N.includes("'This is my character'") && !PJ.includes('This is my character'), '"Bu benim karakterim" kalkmış');
  ok(PJ.includes("'Blacklist'") && PJ.includes('api.quickRate') && PJ.includes("'Rate player'") && PJ.includes('api.ratingsOpen'), 'kara liste + Rate menüde');
  ok(/#menu button i\b/.test(PC) && PC.includes('#menu button.danger:hover'), 'menü stili uygulama stiline uyar');
  ok(/'Blacklist': /.test(I18N) && /'Remove from blacklist': /.test(I18N), 'Blacklist çevirileri var');
  // 3) Hasar vurmayan üyeler
  ok(/showIdleParty: true/.test(MAIN) && MAIN.includes("'showIdleParty'") && MAIN.includes('showIdle: settings.showIdleParty !== false'), 'showIdleParty varsayılan açık, doğrulanır, meter\'a geçer');
  ok(DH.includes('id="showIdleParty"') && DJ.includes("'showIdleParty'") && DJ.includes("$('showIdleParty').checked"), 'showIdleParty arayüzü bağlı');
  ok(M.includes('opts.showIdle === false') && /Show non-damaging party members': '/.test(I18N), 'meter kapalıyken gizler; çeviri var');
  // 4) Türkçe zamanlayıcı okuma
  const AL = require(path.join(A, 'lib/alerts.js'));
  ok(AL.ttsText('Siege boss', 5) === 'Siege boss in 5 minutes' && AL.ttsText('Siege boss', 0) === 'Siege boss is starting now', 'İngilizce okuma aynen');
  ok(AL.ttsText('Kuşatma Bossları', 5, 'tr') === 'Kuşatma Bossları 5 dakika sonra başlıyor' && AL.ttsText('Kuşatma Bossları', 0, 'tr') === 'Kuşatma Bossları şimdi başlıyor', 'Türkçe cümle');
  ok(MAIN.includes("ALERTS.ttsText(t(name), step, 'tr')") && MAIN.includes("lang: trLang ? 'tr' : 'en'") && PJ.includes('Sound.speak(a.tts, a.volume, a.lang)') && read('ui/sound.js').includes("'tr-TR'"), 'dil ana süreçten sese kadar taşınır; deneme de aynı yoldan');
  ok(!/timers\.js/.test('') && fs.existsSync(path.join(A, 'lib/timers.js')), 'timers.js yerinde');
  // 5) Mini mod
  ok(!/autoSize/.test(DJ + DH + PJ) && !/\bautoSize\b[^\n]*:/.test(MAIN.replace(/delete settings\.autoSize[^\n]*/, '')), 'autoSize tiki ayar/arayüz/kodda yok (yalnız göç silmesi)');
  ok(MAIN.includes('delete settings.autoSize'), 'eski autoSize silinir');
  return errors;
}

// Ana boss kuralı: ana boss kesilince aynı zindanda sonraki boss yeni kart açar (20 dk beklemeden).
function anaBossTests() {
  const errors = []; const ok = mk(errors);
  const D = require(path.join(A, 'lib/dungeons.js')); const BH = require(path.join(A, 'ui/bosshist.js'));
  const T0 = Date.UTC(2026, 9, 1, 18, 0, 0); let n = 0;
  const f = (code, min, res) => ({ fk: 'f' + (++n), at: T0 + min * 60000, boss: 'b' + code, code, dur: 60000, res: res || 'k', dps: 1, own: null });
  ok(D.lookup(2300371).main === true && D.lookup(2300910).main === true && D.lookup(2300471).main === true, 'ana boss kodları işaretli');
  ok(D.lookup(2300470).main === false && D.lookup(2301301).main === true, 'Draupnir Afflicted ana değil, Cradle Afflicted ana');
  ok(D.lookup(2300311).main === false, 'ara boss ana değil');
  const runs = (a) => BH.groupRuns(a).filter((e) => e.run);
  ok(runs([f(2300310, 0), f(2300311, 3), f(2300371, 6), f(2300310, 9)]).length === 2, 'ana boss kesilince sonraki boss yeni kart');
  ok(runs([f(2300310, 0), f(2300311, 3), f(2300371, 6, 'w'), f(2300310, 9)]).length === 1, 'ana boss kesilmediyse (wipe) kart kapanmaz');
  ok(runs([f(2301059, 0), f(2301060, 3), f(2301061, 6), f(2301059, 9)]).length === 1, 'ana bossu olmayan zindan eskisi gibi tek kart');
  ok(runs([f(2300502, 0), f(2300509, 3), f(2300502, 6)]).length === 1, 'mini boss yeni kart açmaz');
  ok(runs([f(2300907, 0), f(2300910, 3), f(2300907, 5)]).length === 1, 'ana boss sonrası mini boss aynı karta girer');
  ok(runs([f(2300310, 0), f(2300311, 40)]).length === 2, '20 dk boşluk yeni kart');
  return errors;
}

function posLockTests() {
  const errors = []; const ok = mk(errors);
  const MAIN = read('main.js'); const PJ = read('ui/panel.js'); const PH = read('ui/panel.html'); const DJ = read('ui/drawer.js'); const DH = read('ui/drawer.html');
  const PRE = read('ui/preload.js'); const I18N = read('ui/i18n.js'); const COL = read('lib/collide.js');
  const TH = require(path.join(A, 'lib/themes.js'));
  ok(TH.DEFAULT_SHORTCUTS.posLock === 'CommandOrControl+Shift+K' && TH.DEFAULT_SHORTCUTS.clickThrough === 'CommandOrControl+Shift+L', 'Ctrl+Shift+K kısayolu var, L aynen');
  const vals = Object.values(TH.DEFAULT_SHORTCUTS); ok(new Set(vals).size === vals.length, 'kısayollar çakışmaz');
  ok(MAIN.includes('reg(sc.posLock || DEFAULTS.shortcuts.posLock, togglePosLock)') && /posLock: false/.test(MAIN), 'kısayol globalShortcut kalıbıyla kayıtlı; ayar varsayılanı kapalı');
  ok(MAIN.includes("'streamerMode', 'posLock']") && MAIN.includes('posLock: !!settings.posLock'), 'ayar mantıksal doğrulanır, panele iletilir');
  ok(MAIN.includes("ipcMain.on('toggle-pos-lock'") && PRE.includes('togglePosLock') && PJ.includes("$('posLock').onclick = () => api.togglePosLock()"), 'düğme ve kısayol aynı işleve gider');
  ok(PH.includes('id="posLock"') && PH.includes('id="posBadge"') && PH.indexOf('id="posLock"') > PH.indexOf('id="lock"') && PH.indexOf('id="posLock"') < PH.indexOf('id="gear"'), 'düğme araç çubuğunda, L düğmesinin yanında; köşe göstergesi var');
  ok(/state.ui.clickThrough || state.ui.posLock/.test(PJ) && PJ.includes("$('posBadge').hidden = !s.ui.posLock"), 'kilitliyken sürükleme kapalı (mini ve normal aynı çubuk)');
  ok(COL.includes('dragGuard(win)') && MAIN.includes('Collide.setDragGuard(() => !!settings.posLock)'), 'ana süreç de sürüklemeyi başlatmaz');
  ok(read('ui/panel.css').includes('#posBadge') && DH.includes('id="scBtnPosLock"') && DJ.includes("posLock: 'CommandOrControl+Shift+K'"), 'ayar çekmecesinde kısayol satırı');
  ok(/'Position lock': '/.test(I18N), 'Türkçe çeviri var');
  // davranış: sürükleme kilitliyken gönderilmez
  const src = read('ui/drag.js'); const sent = []; let handler = null;
  const sandbox = { window: {}, document: { addEventListener: (t, f) => { handler = f; } } };
  new Function('window', 'document', src)(sandbox.window, sandbox.document);
  let locked = true; sandbox.window.enableDrag('#bar', (p) => sent.push(p), () => !locked);
  const mkEv = () => ({ button: 0, target: { closest: (q) => (q === '#bar' ? { setPointerCapture() {}, addEventListener() {}, removeEventListener() {}, releasePointerCapture() {} } : null) }, preventDefault() {}, pointerId: 1, screenX: 1, screenY: 1 });
  handler(mkEv()); ok(sent.length === 0, 'kilitliyken sürükleme başlamaz');
  locked = false; handler(mkEv()); ok(sent[0] === 'start', 'kilit açılınca sürükleme çalışır');
  return errors;
}


function miniKalktiTests() {
  const errors = []; const ok = mk(errors);
  const MAIN = read('main.js');
  const files = { MAIN, 'drawer.js': read('ui/drawer.js'), 'drawer.html': read('ui/drawer.html'), 'panel.js': read('ui/panel.js'), 'panel.html': read('ui/panel.html'), 'panel.css': read('ui/panel.css'), 'i18n.js': read('ui/i18n.js') };
  for (const [n, src] of Object.entries(files)) {
    const body = n === 'MAIN' ? src.replace(/delete settings\.miniMode[^\n]*/, '') : src;
    ok(!/miniMode|renderMini|MINI_W|miniApplied|body\.mini|id="mini"|#mini\b|Mini mode/.test(body), 'mini mod izi kalmış: ' + n);
  }
  ok(/delete settings\.miniMode/.test(MAIN), 'eski miniMode ayarı yüklemede temizlenir');
  ok(!/^\s*miniMode:/m.test(MAIN), 'miniMode varsayılan ayar değil');
  ok(/body\.idle-compact #rows/.test(files['panel.css']), 'idle-compact kuralları duruyor');
  ok(/minWidth: Math\.round\(270 \* zoom\)/.test(MAIN), 'normal asgari genişlik 270');
  return errors;
}

// Sahte DOM ile renderTimeline'ı gerçekten çalıştır
function rotasyonTests() {
  const errors = []; const ok = mk(errors);
  const vm = require('vm');
  const DJ = read('ui/drawer.js'); const DH = read('ui/drawer.html'); const DC = read('ui/drawer.css');
  ok(['bcTlZoomIn', 'bcTlZoomOut', 'bcTlFit', 'bcTlCanvas'].every((i) => DH.includes('id="' + i + '"')), 'zoom düğmeleri ve tuval html\'de');
  ok(/\.bc-tl-lane\b/.test(DC) && /\.bc-tl-pill \{[^}]*width: 28px/.test(DC), 'şerit ve 28px ikon css');
  ok(/function tlTeardown/.test(DJ) && /function renderTimeline/.test(DJ) && /const setZoom/.test(DJ), 'zoom/temizlik fonksiyonları var');
  const a = DJ.indexOf("let selectedTlPlayer = 'all';"); const b = DJ.indexOf('const THEME_MAP');
  ok(a > 0 && b > a, 'zaman çizgisi bloğu bulunamadı');
  if (!(a > 0 && b > a)) return errors;
  let listeners = 0;
  class El {
    constructor(tag) { this.tag = tag; this.children = []; this.style = {}; this.className = ''; this.clientWidth = 700; this.scrollLeft = 0; this.scrollTop = 0; this._l = {}; this.classList = { add() {}, remove() {} }; this._html = ''; }
    appendChild(c) { this.children.push(c); return c; }
    set innerHTML(v) { this._html = v; this.children = []; }
    get innerHTML() { return this._html; }
    addEventListener(n, f) { (this._l[n] = this._l[n] || []).push(f); listeners++; }
    removeEventListener(n, f) { const l = this._l[n] || []; const i = l.indexOf(f); if (i >= 0) { l.splice(i, 1); listeners--; } }
    getBoundingClientRect() { return { left: 0, top: 0 }; }
    setPointerCapture() {}
    releasePointerCapture() {}
    fire(n, ev) { for (const f of (this._l[n] || []).slice()) f(ev); }
  }
  const ids = {};
  for (const i of ['bcTlPlayerFilter', 'bcTlTracks', 'bcTlCanvas', 'bcTlStream', 'bcTlAxis', 'bcTlApm', 'bcTlZoomIn', 'bcTlZoomOut', 'bcTlFit']) ids[i] = new El('x');
  let ros = 0;
  class RO { constructor() { ros++; } observe() {} disconnect() { ros--; } }
  const sandbox = { $: (i) => ids[i], t: (s) => s, esc: (s) => String(s), dispName: (n) => String(n), clock: (ms) => String(Math.round(ms / 1000)), document: { createElement: (tag) => new El(tag) }, window: { addEventListener() {} }, ResizeObserver: RO, Math, String, Array, Map, Set, Number };
  vm.createContext(sandbox);
  vm.runInContext(DJ.slice(a, b) + '\n;this.rt = renderTimeline; this.td = tlTeardown; this.zoom = () => tlZoom;', sandbox);
  const casts = []; const t0 = 100000;
  for (let i = 0; i < 40; i++) casts.push({ t: t0 + i * 1500, skill: 1, name: 'S' + i, icon: '', actor: i % 2 ? 7 : 8 });
  const replay = { start: t0, duration: 60000, casts, consumables: [{ t: t0 + 5000, itemSkill: 2, name: 'P', icon: '', actor: 9 }] };
  const actors = [{ id: 7, name: 'A', own: false }, { id: 8, name: 'B', own: true }, { id: 9, name: 'C', own: false }];
  sandbox.rt(replay, null, actors);
  const lanes = () => ids.bcTlStream.children.filter((c) => /bc-tl-lane\b/.test(c.className));
  ok(lanes().length === 3, 'şerit sayısı oyuncu sayısı kadar (' + lanes().length + ')');
  const l1 = listeners; const ro1 = ros;
  ok(l1 >= 5 && ro1 === 1, 'wheel/pointer dinleyicileri ve gözlemci kuruldu');
  ids.bcTlTracks.fire('wheel', { preventDefault() {}, deltaY: -100, clientX: 300 });
  ok(sandbox.zoom() > 1, 'tekerlek yakınlaştırır');
  ok(parseInt(ids.bcTlCanvas.style.width, 10) > 700, 'zoom tuval genişliğini piksel olarak açar');
  ids.bcTlFit.onclick();
  ok(sandbox.zoom() === 1, 'sığdır zoom=1');
  ids.bcTlZoomIn.onclick();
  ok(sandbox.zoom() > 1, '+ düğmesi çalışır');
  ids.bcTlZoomOut.onclick(); ids.bcTlZoomOut.onclick();
  ok(sandbox.zoom() === 1, '- düğmesi 1\'in altına inmez');
  for (let i = 0; i < 5; i++) sandbox.rt(replay, null, actors);
  ok(listeners === l1 && ros === ro1, 'yeniden çizimde dinleyici/gözlemci birikmiyor');
  sandbox.td();
  ok(listeners === 0 && ros === 0 && ids.bcTlFit.onclick === null, 'temizlikte tüm dinleyiciler bırakılır');
  return errors;
}


module.exports = [
  ['madde: tehdit sesi kalktı, sağ tık menüsü, boşta üyeler, Türkçe okuma', maddeTests],
  ['mini mod tamamen kaldırıldı (ayar, panel, çekmece, dil); idle-compact kaldı', miniKalktiTests],
  ['skill rotation: oyuncu başına şerit, zoom/sürükle, dinleyici temizliği', rotasyonTests],
  ['konum kilidi: Ctrl+Shift+K, düğme, kalıcı ayar, kilitliyken sürükleme kapalı', posLockTests],
  ['ana boss: kesilince yeni kart, verisiz zindan eskisi gibi, mini boss kart açmaz', anaBossTests],
];
