'use strict';
// Aşama 3: yalnız boss hasarı anahtarı, son bölüm hatırlama, rapor özeti / ana boss rozeti, eski çeviri temizliği, çekmece yerleşimi (Electron gerekmez).
const fs = require('fs');
const path = require('path');
const A = path.join(__dirname, '..');
const req = (p) => require(path.join(A, p));
const read = (p) => fs.readFileSync(path.join(A, p), 'utf8');
function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }

function bossViewTests() {
  const errors = []; const ok = mk(errors);
  const main = read('main.js');
  const html = read('ui/drawer.html');
  const js = read('ui/drawer.js');
  const I = req('ui/i18n.js');
  ok(/bossView: true,/.test(main), 'bossView varsayılanı korunur (açık)');
  ok(/for \(const bk of \[[^\]]*'bossView'/.test(main), 'set-settings bossView değerini mantıksala çevirir');
  const i = html.indexOf('data-pane="boss"');
  const pane = html.slice(i, html.indexOf('data-pane="sounds"'));
  ok(/id="bossView"/.test(pane), 'bossView anahtarı "Boss ve savaşlar" bölümünde');
  ok(/\$\('bossView'\)\.checked = s\.bossView !== false/.test(js) && js.includes("'bossView', 'deathRecap'"), 'drawer.js anahtarı okur ve kaydeder');
  ok(I.TR['Boss damage only'] && I.TR['The meter shows only the damage you deal to the boss'].includes('boss'), 'TR metinleri var');
  // Meter yalnız bossView !== false iken boss hasarını gösterir (mantık main.js e bağlı)
  ok(/bossView: settings\.bossView !== false/.test(main), 'sol sayaç ayara bağlı');
  return errors;
}

function sectionMemoryTests() {
  const errors = []; const ok = mk(errors);
  const S = req('ui/setsections.js');
  ok(S.pickSection('sounds') === 'sounds' && S.pickSection('about') === 'about', 'geçerli kayıtlı bölüm kullanılır');
  for (const bad of [null, undefined, '', 'yok', 'constructor', 42, {}, '__proto__']) ok(S.pickSection(bad) === S.DEFAULT_SECTION, 'bozuk kayıt varsayılana düşer: ' + String(bad));
  ok(S.DEFAULT_SECTION === 'appearance', 'varsayılan Görünüm');
  const js = read('ui/drawer.js');
  ok(js.includes("localStorage.setItem('daeva.lastSection'") && js.includes("localStorage.getItem('daeva.lastSection')"), 'son bölüm kaydedilir ve okunur');
  ok(/try \{ localStorage\.setItem[^}]*\} catch/.test(js) && /try \{ startSec = [^}]*\} catch/.test(js), 'depolama hatası sessizce yutulur');
  return errors;
}

function summaryTests() {
  const errors = []; const ok = mk(errors);
  const B = req('ui/bosshist.js');
  const D = req('lib/dungeons.js');
  const enc = { boss: { dur: 90000, total: 5000, allTotal: 7000, dps: 55.5 }, actors: [{ own: false, dps: 10 }, { own: true, dps: 33 }] };
  const s = B.summary(enc);
  ok(s.dur === 90000 && s.total === 5000 && s.allTotal === 7000 && s.groupDps === 55.5 && s.ownDps === 33, 'özet alanları kayıttan gelir');
  const s2 = B.summary({ boss: { total: 10 }, actors: [{ own: false, dps: 5 }] });
  ok(s2.dur === null && s2.groupDps === null && s2.ownDps === null && s2.total === 10 && s2.allTotal === 10, 'olmayan veri null (uydurulmaz)');
  ok(B.summary(null) === null && B.summary({}) === null, 'boş kayıt null');
  ok(B.summary({ boss: { dur: NaN, total: 'x' } }).dur === null, 'bozuk sayı null');
  // ana boss: tabloda işaretli değilse rozet yok
  ok(B.isMainBoss(0) === false && B.isMainBoss(999) === false && B.isMainBoss(2300310) === false, 'işaretsiz/bilinmeyen kod için ana boss rozeti yok');
  const L = D.lookup(2300310);
  ok(L && L.main === false && L.mini === false && D.lookup(2300162).mini === true, 'lookup mini/main alanları');
  D.CODES[9999999] = [0, 'c', 2];
  ok(D.lookup(9999999).main === true && D.lookup(9999999).mini === false && B.isMainBoss(9999999) === true, 'tabloda 2 işaretliyse ana boss');
  delete D.CODES[9999999];
  const runs = B.groupRuns([{ fk: 'a', at: 1, dur: 10, code: 2300310, res: 'k' }]);
  ok(runs[0].run && runs[0].items[0].main === false, 'koşu kayıtları main alanı taşır');
  return errors;
}

function cleanupTests() {
  const errors = []; const ok = mk(errors);
  const I = req('ui/i18n.js');
  const raw = ['ui/drawer.html', 'ui/drawer.js', 'ui/panel.js', 'ui/panel.html', 'main.js'].map(read).join('\n');
  for (const dead of ['Boss targeting you!', 'Boss hedefi sendesin!', 'Fight History', 'Back to Live Fight', 'PAST ENCOUNTERS', 'RAID BOSS']) {
    ok(!Object.prototype.hasOwnProperty.call(I.TR, dead), 'eski çeviri silinmiş olmalı: ' + dead);
  }
  // Kullanılan temel metinler çevirisiz kalmamalı
  for (const k of ['Open Sounds', 'YOUR DPS', 'main boss', 'Alert sound, voice and volume are in the Sounds section of Settings.']) ok(I.TR[k], 'TR eksik: ' + k);
  // Zamanlayıcılar notu Sesler bölümüne götüren bağ içerir
  ok(raw.includes('id="gotoSounds"') && read('ui/drawer.js').includes("showSection('sounds')"), 'Sesler notu düğmeyle Sesler bölümüne gider');
  // Silinen CSS sınıfları geri gelmemeli
  const css = read('ui/drawer.css') + read('ui/panel.css');
  for (const c of ['rt-encs', 'bc-dev-bar', 'bc-segment-select', 'bh-del']) ok(!css.includes('.' + c), 'ölü CSS geri gelmemeli: ' + c);
  const open = (css.match(/{/g) || []).length; const close = (css.match(/}/g) || []).length;
  ok(open === close, 'CSS parantezleri dengeli');
  return errors;
}

function drawerPlacementTests() {
  const errors = []; const ok = mk(errors);
  const P = req('lib/drawerpos.js');
  const inside = (r, wa) => r.x >= wa.x && r.y >= wa.y && r.x + r.width <= wa.x + wa.width && r.y + r.height <= wa.y + wa.height;
  const screens = [
    { x: 0, y: 0, width: 1366, height: 728 }, // 1366x768 görev çubuğu hariç
    { x: 0, y: 0, width: 1920, height: 1040 },
    { x: 0, y: 0, width: 800, height: 560 },
    { x: -1280, y: 0, width: 1280, height: 984 }, // sol ikinci ekran
  ];
  for (const wa of screens) {
    for (const zoom of [1, 1.25, 1.5, 0, undefined]) {
      for (const px of [wa.x, wa.x + 200, wa.x + wa.width - 300, wa.x + wa.width + 50, wa.x - 40]) {
        const r = P.drawerRect({ x: px, y: wa.y + wa.height - 200, width: 280, height: 180 }, wa, zoom);
        ok(inside(r, wa), 'çekmece çalışma alanını aşmamalı: ' + JSON.stringify([wa.width, wa.height, zoom, px]) + ' -> ' + JSON.stringify(r));
      }
    }
  }
  const sz = P.drawerSize({ x: 0, y: 0, width: 1366, height: 728 }, 1);
  ok(sz.width === 820 && sz.height === 640, '1366x768 te tam boy sığar: ' + JSON.stringify(sz));
  const small = P.drawerSize({ x: 0, y: 0, width: 600, height: 400 }, 1);
  ok(small.width === 600 && small.height === 400, 'küçük ekranda ekrana kısalır');
  const css = read('ui/drawer.css');
  ok(/@media \(max-width: 700px\)[^}]*\.bp-left/.test(css), 'dar pencerede iki sütun daralır');
  ok(/\.bp-right \{[^}]*min-width: 0/.test(css) && /\.set-body \{[^}]*min-width: 0/.test(css), 'sağ sütunlar min-width:0 ile taşmaz');
  ok(/require\('\.\/lib\/drawerpos'\)/.test(read('main.js')), 'main.js yerleşimi drawerpos tan alır');
  return errors;
}

module.exports = [
  ['aşama3: "Yalnız boss hasarı" anahtarı (bölüm, bağlama, doğrulama, çeviri)', bossViewTests],
  ['aşama3: Ayarlar son bölümü hatırlar, bozuk kayıtta Görünüm', sectionMemoryTests],
  ['aşama3: rapor özet kutuları yalnız kayıttaki veri; ana boss rozeti yalnız tabloda varsa', summaryTests],
  ['aşama3: eski çeviri / ölü CSS temizliği ve Sesler notu', cleanupTests],
  ['aşama3: çekmece dar ekranda taşmaz, iki sütun daralır', drawerPlacementTests],
];
