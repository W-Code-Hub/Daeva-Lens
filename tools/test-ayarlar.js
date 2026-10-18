'use strict';
// Aşama 2: Ayarlar kenar menüsü, tek ses merkezi, ayar varsayılanları/göçü, bosslog ölüm alanı (Electron gerekmez).
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = path.join(__dirname, '..');
const req = (p) => require(path.join(A, p));
const read = (p) => fs.readFileSync(path.join(A, p), 'utf8');
function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }

// drawer.html → { sekmeId: html } ; Ayarlar sekmesi → { bölümId: html }
function sliceBy(html, re) {
  const out = {};
  const marks = [];
  let m; while ((m = re.exec(html))) marks.push([m[1], m.index]);
  marks.forEach(([id, i], k) => { out[id] = html.slice(i, k + 1 < marks.length ? marks[k + 1][1] : html.length); });
  return out;
}
const tabsOf = (html) => sliceBy(html, /<section id="tab-(\w+)" class="tab[^"]*">/g);
const panesOf = (general) => sliceBy(general, /<div class="set-pane" data-pane="(\w+)"/g);
const idsOf = (html, tags) => [...html.matchAll(new RegExp('<(?:' + tags + ')\\b[^>]*\\bid="(\\w+)"', 'g'))].map((x) => x[1]);
function defaultsKeys() {
  const src = read('main.js');
  const i = src.indexOf('const DEFAULTS = {');
  const body = src.slice(i, src.indexOf('\n};', i));
  return new Set([...body.matchAll(/^ {2}(\w+):/gm)].map((x) => x[1]));
}

function sectionTests() {
  const errors = []; const ok = mk(errors);
  const S = req('ui/setsections.js');
  const I = req('ui/i18n.js');
  const ids = S.SECTIONS.map((s) => s.id);
  ok(ids.length >= 7 && new Set(ids).size === ids.length, 'bölüm kimlikleri benzersiz ve en az 7 bölüm: ' + ids.join());
  for (const want of ['appearance', 'sounds', 'players', 'privacy', 'window', 'about']) ok(ids.includes(want), 'bölüm eksik: ' + want);
  const lastSec = S.SECTIONS[S.SECTIONS.length - 1];
  ok(lastSec.id === 'about' && lastSec.last, 'Hakkında en altta ve ayrı');
  ok(S.isSection('sounds') && !S.isSection('constructor') && !S.isSection('') && S.isSection(S.DEFAULT_SECTION), 'isSection / varsayılan bölüm');
  const html = read('ui/drawer.html');
  const panes = panesOf(tabsOf(html).general || '');
  ok(Object.keys(panes).join() === ids.join(), 'HTML bölüm sırası listeyle aynı olmalı: ' + Object.keys(panes).join() + ' / ' + ids.join());
  for (const s of S.SECTIONS) {
    ok(Object.prototype.hasOwnProperty.call(I.TR, s.label), 'TR yok (bölüm adı): ' + s.label);
    ok(Object.prototype.hasOwnProperty.call(I.TR, s.desc), 'TR yok (bölüm açıklaması): ' + s.desc);
  }
  const JS = read('ui/drawer.js');
  ok(/SETSECTIONS\.SECTIONS/.test(JS) && /function showSection/.test(JS), 'drawer.js kenar menüyü listeden kurar');
  ok(html.indexOf('src="setsections.js"') > 0 && html.indexOf('src="setsections.js"') < html.indexOf('src="drawer.js"'), 'setsections.js drawer.js ten önce yüklenir');
  // Her kutu (input/select) bir ayar anahtarı olmalı ve drawer.js ona bağlanmalı: ölü satır kalmasın
  const D = defaultsKeys();
  const free = new Set(['customColorInput', 'volume2']);
  const ALIAS = { viewSel: 'view' }; // kutu adı ≠ ayar anahtarı olanlar
  for (const [pid, ph] of Object.entries(panes)) {
    for (const id of idsOf(ph, 'input|select')) {
      if (free.has(id)) continue;
      ok(D.has(ALIAS[id] || id), pid + ': "' + id + '" DEFAULTS ta yok (ölü satır?)');
      ok(JS.includes("'" + id + "'") || JS.includes('$(\'' + id + '\')') || JS.includes('"' + id + '"'), pid + ': "' + id + '" drawer.js te bağlı değil');
    }
  }
  ok(!/bossTargetMe|Boss is targeting you|hedefi sende/i.test(html + JS) && ![...D].some((k) => /bossTargetMe|soundBossTarget|soundTarget/i.test(k)), '"Boss hedefi sende" uyarısı geri eklenmemeli');
  return errors;
}

function soundHubTests() {
  const errors = []; const ok = mk(errors);
  const S = req('ui/setsections.js');
  const tabs = tabsOf(read('ui/drawer.html'));
  const panes = panesOf(tabs.general);
  const where = (id) => Object.keys(panes).filter((p) => panes[p].includes('id="' + id + '"'));
  for (const k of S.SOUND_KEYS) {
    const w = where(k);
    ok(w.length === 1 && w[0] === 'sounds', 'ses ayarı "' + k + '" yalnız Sesler bölümünde olmalı: ' + w.join());
    ok(!new RegExp('id="' + k + '"').test(tabs.timers + tabs.boss), 'ses ayarı "' + k + '" Zamanlayıcılar/Boss sekmesinde kalmamalı');
  }
  // Sesler dışındaki bölümlerde ses/okuma/bip anahtarı bulunmamalı (anahtar → bölüm eşlemesi)
  const soundish = /^(sound|volume|timerBeep|timerTts|timerSound|timerVolume|itemTts|combatOnlySound|visualToasts)/;
  for (const [pid, ph] of Object.entries(panes)) {
    if (pid === 'sounds') continue;
    for (const id of idsOf(ph, 'input|select')) ok(!soundish.test(id), 'ses benzeri "' + id + '" ' + pid + ' bölümünde; Sesler e taşınmalı');
  }
  // Beceriler sekmesindeki ses çubuğu aynı "volume" ayarının ikinci görünümü (iki yönlü bağlı)
  ok(/id="volume2"/.test(tabs.skills) && read('ui/drawer.js').includes("bindRange('volume2', 'volume', 'volume')"), 'volume2 ↔ volume bağlı');
  // Zamanlayıcılar sekmesinde ses satırı kalmadı ama uyarı türü/ekran uyarısı orada
  for (const id of ['timerAlertMode', 'timerSteps', 'timerToastMode', 'timerToastSec', 'timerCombat', 'timerTest']) ok(tabs.timers.includes('id="' + id + '"'), id + ' Zamanlayıcılar sekmesinde kalmalı');
  const D = defaultsKeys();
  for (const k of S.SOUND_KEYS) ok(D.has(k), 'DEFAULTS ta yok: ' + k);
  ok(where('gotoSkills').join() === 'sounds', 'Becerilere geçiş düğmesi Sesler bölümünde');
  return errors;
}

function defaultsMigrationTests() {
  const errors = []; const ok = mk(errors);
  const src = read('main.js');
  const D = defaultsKeys();
  // Anahtar adları korunur (kullanıcı ayarları geçerli kalır)
  for (const k of ['volume', 'combatOnlySound', 'visualToasts', 'soundStagger', 'soundLowHp', 'soundPotion', 'soundChoiceStagger', 'soundChoiceLowHp', 'soundChoicePotion',
    'itemTts', 'timerBeep', 'timerSound', 'timerVolume', 'timerTts', 'playerRatingsOn', 'blacklistAlert', 'streamerMode', 'screenProtect', 'autoShowWithGame', 'autoHideSec', 'shortcuts']) {
    ok(D.has(k), 'DEFAULTS anahtarı korunmalı: ' + k);
  }
  ok(src.includes('settings = { ...DEFAULTS, ...raw };'), 'açılışta eski ayar dosyası varsayılanlarla birleştirilir (eksik anahtar varsayılana düşer)');
  ok(src.includes('if (k in DEFAULTS) settings[k] = v;'), 'set-settings yalnız bilinen anahtarı kabul eder');
  ok(src.includes("!['kind', 'name', 'off'].includes(settings.itemTts)"), 'itemTts doğrulaması duruyor');
  ok(/for \(const bk of \[[^\]]*'blacklistAlert'/.test(src), 'mantıksal doğrulama listesi blacklistAlert içerir');
  // Bozuk zamanlayıcı ses ayarı doğrulanır, kullanıcının ses seviyesi korunur
  const merged = { timerAlertMode: 'both', timerSound: 'yok', timerVolume: 999, timerBeep: true, timerTts: true, volume: 0.5 };
  const s = req('lib/alerts.js').normalize(merged);
  ok(s.timerVolume === 100 && s.timerSound === 'chime' && s.timerBeep === true && s.timerTts === true, 'bozuk zamanlayıcı ses ayarı doğrulanır: ' + [s.timerVolume, s.timerSound]);
  ok(merged.volume === 0.5, 'kullanıcının ses seviyesi korunur');
  return errors;
}

function bossDeathTests() {
  const errors = []; const ok = mk(errors);
  const { BossLog, packDetail, unpackDetail, cleanDeaths } = req('lib/bosslog.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daeva-olum-'));
  try {
    const death = (n, own, t) => ({ player: 5, name: n, cls: 14, own, t, at: 1000 + t, killerName: 'Boss', skillName: 'Stomp', fatalAmount: 900, total: 1500,
      taken: [{ name: 'Stomp', amount: 900, hits: 1 }, { name: 'Slash', amount: 600, hits: 3 }],
      timeline: [{ dt: -2, amount: 600, name: 'Slash', dot: false, who: 'Boss', fatal: false }, { dt: 0, amount: 900, name: 'Stomp', dot: false, who: 'Boss', fatal: true }], deadFor: null });
    const enc = (list) => ({ start: 1, dur: 60000, total: 1000, isBoss: true, boss: { name: 'Rudra', code: 7, total: 1000, dps: 10, dur: 60000, killed: true }, actors: [{ id: 1, name: 'Kai', total: 1000, skills: [] }], replay: { duration: 60000, start: 1 }, deathList: list });
    const bdir = path.join(dir, 'b');
    const L = new BossLog(bdir); L.load();
    L.save({ fk: '100:1', at: 100, enc: enc([death('Kai', true, 5), death('Mira', false, 9), { zararli: 1 }, null]) });
    const got = new BossLog(bdir); got.load();
    const e = got.get('100:1');
    ok(e && Array.isArray(e.deathList) && e.deathList.length === 3, 'ölüm listesi diske yazılır ve geri okunur: ' + (e && e.deathList && e.deathList.length));
    ok(e && e.deathList[0].name === 'Kai' && e.deathList[0].own === true && e.deathList[0].timeline.length === 2 && e.deathList[0].timeline[1].fatal === true && e.deathList[0].taken[1].hits === 3, 'ölüm özeti alanları (kim/hangi beceri/ne kadar) korunur');
    // Eski kayıt: ölüm alanı yok → boş liste, kayıt bozulmaz
    const pk = JSON.parse(JSON.stringify(packDetail(enc([]))));
    delete pk.dl;
    const un = unpackDetail(pk);
    ok(un && Array.isArray(un.deathList) && un.deathList.length === 0 && un.boss.name === 'Rudra', 'eski kayıtta (dl yok) ölüm listesi boş, rapor açılır');
    const bad = JSON.parse(JSON.stringify(packDetail(enc([]))));
    bad.dl = 'x';
    ok(unpackDetail(bad).deathList.length === 0, 'bozuk dl yok sayılır');
    ok(cleanDeaths(null).length === 0 && cleanDeaths([1, 'a', null]).length === 0, 'cleanDeaths sağlam');
    const many = Array.from({ length: 25 }, (_, i) => death('P' + i, false, i));
    ok(cleanDeaths(many).length === 10, 'en çok 10 ölüm yazılır');
    // Kayıt silme yok: yeni kayıt eskileri silmez
    L.save({ fk: '200:2', at: 200, enc: enc([]) });
    const again = new BossLog(bdir); again.load();
    ok(again.size === 2 && again.get('100:1').deathList.length === 3 && again.get('200:2').deathList.length === 0, 'eski kayıtlar korunur, ölümsüz kayıt da olabilir');
  } catch (x) { errors.push('istisna: ' + (x && x.stack)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const DJ = read('ui/drawer.js');
  ok(DJ.includes('renderDeaths(e && e.deathList ? e.deathList.slice().reverse() : [])'), 'rapor ölüm listesini çizer');
  return errors;
}

module.exports = [
  ['ayarlar: kenar menü bölüm listesi (kimlikler, sıra, Hakkında en altta, HTML eşleşmesi, çeviri, ölü satır yok)', sectionTests],
  ['ayarlar: tüm ses ayarları tek "Sesler" merkezinde (anahtar → bölüm eşlemesi)', soundHubTests],
  ['ayarlar: anahtar adları/varsayılanlar/doğrulama ve eski ayar göçü korunur', defaultsMigrationTests],
  ['bosslog: ölüm listesi opsiyonel alan (yazma/okuma, eski kayıt uyumu, sınır, silme yok)', bossDeathTests],
];
