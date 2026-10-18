'use strict';
// Çekmece Aşama 1 testleri: dört sekme, "Boss ve Oyuncular" iki sütunlu ekran (kart seçimi → oyuncu görünürlüğü,
// arama / süzgeç / sıralama), silme düğmesi yok, eski rate IPC'leri yerinde. Saf mantık: Electron ve ağ yok.
// Dışa aktarım: [[ad, işlev], ...]; işlev hata listesi döner.
const fs = require('fs');
const path = require('path');
const A = path.join(__dirname, '..');
const req = (p) => require(path.join(A, p));
const rd = (f) => fs.readFileSync(path.join(A, f), 'utf8');
function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 1, 18, 0, 0);
let n = 0;
const fight = (code, name, minute, extra) => ({ fk: (T0 + minute * MIN) + ':' + (++n), at: T0 + minute * MIN, boss: name, code, dur: 60000, res: 'k', n: 5, total: 1e6, dps: 1e4, top: 1e5, pb: 0, own: null, ...extra });

module.exports = [
  ['çekmece: dört sekme (Boss ve Oyuncular, Beceriler, Zamanlayıcılar, Ayarlar); Ölümler/Rate/Hakkında sekmesi yok', () => {
    const e = []; const ok = mk(e); const DT = req('lib/drawertabs.js');
    const html = rd('ui/drawer.html');
    const btns = [...html.matchAll(/<button data-tab="([a-z]+)"/g)].map((m) => m[1]);
    ok(btns.join() === 'boss,skills,timers,general', 'drawer.html sekme düğmeleri: ' + btns);
    ok(DT.TABS.join() === btns.join(), 'sekme tablosu düğmelerle aynı sırada');
    for (const id of DT.TABS) ok(new RegExp('<section id="tab-' + id + '" class="tab').test(html), 'bölüm var: tab-' + id);
    ok(!/id="tab-(deaths|players|about)"/.test(html), 'eski deaths/players/about bölümleri kaldırıldı');
    ok(!/id="dlEmpty"|id="bcRate"|id="rtEncs"/.test(html), 'eski ölüm boş kutusu, Rate düğmesi, karşılaşma sütunu kalktı');
    const I = req('ui/i18n.js').TR;
    for (const k of ['Boss & Players', 'Skills', 'Timers', 'Settings']) ok(typeof I[k] === 'string' && I[k], 'sekme adı TR çevirisi var: ' + k);
    ok(I['Boss & Players'] === 'Boss ve Oyuncular' && I['Settings'] === 'Ayarlar', 'Türkçe sekme adları');
    // tepsi: "Beceriler ve sesler…" ve ayarlar yeni sekmelerde açılır
    ok(DT.normTab('beceriler') === 'skills' && DT.normTab('skills') === 'skills' && DT.normTab('general') === 'general', 'tepsi sekme adları');
    ok(DT.normTab('deaths') === 'boss' && DT.normTab('players') === 'boss' && DT.normTab('rate') === 'boss', 'panelden gelen deaths/players boss ekranına gider');
    return e;
  }],
  ['çekmece: Ayarlar sekmesine taşınanlar (oyuncu anahtarları, Hakkında) ve boss ekranındaki ölüm/oyuncu blokları', () => {
    const e = []; const ok = mk(e);
    const html = rd('ui/drawer.html');
    const a = html.indexOf('<section id="tab-general"'); const b = html.indexOf('</section>', a);
    const gen = html.slice(a, b);
    for (const id of ['playerRatingsOn', 'blacklistAlert', 'ver']) ok(gen.includes('id="' + id + '"'), 'Ayarlar içinde: ' + id);
    ok(/What it does/.test(gen), 'Hakkında metni Ayarlar içinde');
    const c = html.indexOf('<section id="tab-boss"'); const d = html.indexOf('</section>', c);
    const boss = html.slice(c, d);
    for (const id of ['bhSearch', 'bhBossSel', 'bhSort', 'bhKinds', 'bhList', 'bcDeathsWrap', 'dlList', 'bcPlayersWrap', 'rtPlayers', 'rtChips', 'bcEmpty', 'bcPickBoss', 'bcReport']) ok(boss.includes('id="' + id + '"'), 'Boss ve Oyuncular içinde: ' + id);
    ok(boss.indexOf('class="bp-left"') < boss.indexOf('class="bp-right"') && boss.indexOf('id="bhList"') < boss.indexOf('class="bp-right"'), 'sol sütun (kartlar) sağ sütundan önce');
    ok(boss.indexOf('id="bcPlayersWrap"') > boss.indexOf('id="bcReport"') && boss.indexOf('id="bcDeathsWrap"') > boss.indexOf('id="bcReport"'), 'oyuncular ve ölümler raporun içinde (sağ sütun)');
    // her id yalnız bir kez
    const ids = [...html.matchAll(/ id="([^"]+)"/g)].map((m) => m[1]);
    const dup = ids.filter((x, i) => ids.indexOf(x) !== i);
    ok(!dup.length, 'tekrarlı id yok: ' + dup);
    return e;
  }],
  ['çekmece: kart seçimi → sağ sütun / oyuncu görünürlüğü', () => {
    const e = []; const ok = mk(e); const H = req('ui/bosshist.js');
    ok(H.rightMode({ fk: '', run: '' }) === 'empty' && H.rightMode() === 'empty' && H.rightMode(null) === 'empty', 'kart seçili değil: boş durum');
    ok(!H.playersVisible({ fk: '', run: '' }) && !H.playersVisible(undefined), 'kart yokken oyuncular görünmez');
    ok(H.rightMode({ fk: 'a:1', run: '' }) === 'fight' && H.playersVisible({ fk: 'a:1', run: '' }), 'dövüş kartı seçilince rapor + oyuncular');
    ok(H.rightMode({ fk: '', run: 'run:x' }) === 'pick-boss' && !H.playersVisible({ fk: '', run: 'run:x' }), 'zindan başlığı seçilince önce boss seçilir; oyuncu yok');
    ok(H.rightMode({ fk: 'live', run: '' }) === 'fight', 'şimdiki parti kartı da bir karttır');
    // tıklama
    let r = H.clickCard({ fk: '', run: '' }, { fk: 'a:1' }, new Set());
    ok(r.sel.fk === 'a:1' && r.sel.run === '' && H.playersVisible(r.sel), 'boss kartına tıklama oyuncuları açar');
    r = H.clickCard(r.sel, { run: true, key: 'run:x' }, r.open);
    ok(r.sel.fk === '' && r.sel.run === 'run:x' && r.open.has('run:x') && !H.playersVisible(r.sel), 'zindan başlığı genişler, oyuncuları gizler');
    const r2 = H.clickCard(r.sel, { run: true, key: 'run:x' }, r.open);
    ok(!r2.open.has('run:x'), 'ikinci tıklama zindanı kapatır');
    const r3 = H.clickCard(r.sel, { fk: 'b:2' }, r.open);
    ok(r3.sel.fk === 'b:2' && r3.sel.run === '' && r3.open.has('run:x') && H.playersVisible(r3.sel), 'zindan içindeki boss seçilince oyuncular görünür, zindan açık kalır');
    ok(r.open !== r2.open, 'açık küme yerinde değişmez (girdi korunur)');
    return e;
  }],
  ['çekmece: arama (boss / zindan / oyuncu), tür ve boss süzgeci, sıralama', () => {
    const e = []; const ok = mk(e); const H = req('ui/bosshist.js');
    const a = fight(2300310, 'Rotan', 0, { dur: 300000, dps: 9000 });
    const b = fight(2300371, 'Kromede', 5, { dur: 100000, dps: 30000 });
    const w1 = fight(2090027, 'Dünya Boss', 100, { dur: 600000, dps: 2000 });
    const w2 = fight(0, 'Vahşi Ejder', 200, { dur: 50000, dps: 50000 });
    const items = [a, b, w1, w2];
    const names = (fk) => ({ [a.fk]: 'Vexalyn Mirael', [w2.fk]: 'Ordric' }[fk] || '');
    ok(H.viewRuns(items, { kind: 'all' }).length === 3, 'tümü: 1 zindan kartı + 2 açık dünya');
    const dun = H.viewRuns(items, { kind: 'dungeon' });
    ok(dun.length === 1 && dun[0].run, 'zindan süzgeci yalnız zindan kartı');
    const wor = H.viewRuns(items, { kind: 'world' });
    ok(wor.length === 2 && wor.every((x) => !x.run), 'açık dünya süzgeci yalnız tek dövüş');
    ok(H.viewRuns(items, { q: 'ejder' }).length === 1, 'boss adıyla arama');
    ok(H.viewRuns(items, { q: 'fire' }).length === 1 && H.viewRuns(items, { q: 'fire' })[0].run, 'zindan adıyla arama');
    ok(H.viewRuns(items, { q: 'ordric' }).length === 0, 'oyuncu çözücü yokken oyuncu adı aranmaz');
    const byP = H.viewRuns(items, { q: 'mirael', names });
    ok(byP.length === 1 && byP[0].run, 'oyuncu adıyla arama o oyuncunun zindan kartını bulur');
    const byP2 = H.viewRuns(items, { q: 'ordric', names });
    ok(byP2.length === 1 && !byP2[0].run && byP2[0].item.fk === w2.fk, 'oyuncu adıyla açık dünya kartı bulunur');
    ok(H.viewRuns(items, { q: 'mirael', names, kind: 'world' }).length === 0, 'arama ve tür süzgeci birlikte');
    ok(H.viewRuns(items, { boss: 'Rotan' }).length === 1, 'boss süzgeci');
    const at = (x) => (x.run ? x.at : x.item.at);
    const nw = H.viewRuns(items, { sort: 'new' });
    ok(nw.map(at).join() === [w2.at, w1.at, a.at].join(), 'en yeni önce: ' + nw.map(at));
    const lg = H.viewRuns(items, { sort: 'dur' });
    ok((lg[0].item || {}).fk === w1.fk, 'en uzun savaş önce (açık dünya 10 dk)');
    const dp = H.viewRuns(items, { sort: 'dps' });
    ok((dp[0].item || {}).fk === w2.fk, 'en yüksek DPS önce');
    ok(H.viewRuns([], { q: 'x', sort: 'dur', kind: 'dungeon', names }).length === 0, 'boş liste güvenli');
    // oyuncu satırı süzgeci
    const P = [{ rating: 0, bl: false }, { rating: 4, bl: false }, { rating: 0, bl: true }];
    ok(P.filter((p) => H.playerShown(p, 'all')).length === 3 && P.filter((p) => H.playerShown(p, 'todo')).length === 1 && P.filter((p) => H.playerShown(p, 'black')).length === 1, 'oyuncu süzgeçleri: hepsi / puansız / kara liste');
    return e;
  }],
  ['çekmece: silme düğmesi yok, oyuncu değerlendirme IPC\'leri çalışır durumda', () => {
    const e = []; const ok = mk(e);
    const main = rd('main.js'); const pre = rd('ui/preload.js'); const dr = rd('ui/drawer.js'); const html = rd('ui/drawer.html');
    ok(!/bh-del|bh-yes|bossLogDelete|boss-log-delete|data-del/.test(dr + html + pre + main), 'geçmişte silme düğmesi / IPC yok');
    for (const ch of ['rate-data', 'quick-rate', 'ratings-take-prefill', 'ratings-open']) ok(main.includes("'" + ch + "'"), 'ana süreç IPC: ' + ch);
    for (const fn of ['rateData', 'quickRate', 'ratingsTakePrefill', 'ratingsOpen']) ok(pre.includes(fn + ':'), 'preload köprüsü: ' + fn);
    ok(/api\.rateData\(\)/.test(dr) && /api\.quickRate\(/.test(dr) && /api\.ratingsTakePrefill\(\)/.test(dr), 'çekmece bu IPC\'leri kullanır');
    ok(/openSettings\('boss'\)/.test(main) && !/openSettings\('players'\)/.test(main), 'sağ tık Rate player boss ekranını açar');
    ok(/DRAWER_W = 820/.test(fs.readFileSync(path.join(A, 'lib/drawerpos.js'), 'utf8')), 'çekmece penceresi 820 px');
    // Ölümler sekmesine giden kod kalmadı
    ok(!/isTabActive\('deaths'\)|showTab\('players'\)|tab-players|lastDeathsList/.test(dr), 'drawer.js eski sekmelere dokunmuyor');
    ok(!/openSettings\('deaths'\)/.test(rd('ui/panel.js')), 'panel ölüm bildirimi boss ekranını açar');
    return e;
  }],
];
