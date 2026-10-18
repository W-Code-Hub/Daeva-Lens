'use strict';
// Zindan koşusu gruplama testleri: boss kodu → zindan, gruplama, açık dünya gruplanmaz, eski kayıt uyumu.
// Saf mantık: Electron ve ağ yok. Dışa aktarım: [[ad, işlev], ...]; işlev hata listesi döner.
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = path.join(__dirname, '..');
const req = (p) => require(path.join(A, p));
function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }

const MIN = 60000;
const T0 = Date.UTC(2026, 9, 1, 18, 0, 0);
let n = 0;
const fight = (code, name, minute, extra) => ({ fk: (T0 + minute * MIN) + ':' + (++n), at: T0 + minute * MIN, boss: name, code, dur: 60000, res: 'k', n: 5, total: 1e6, dps: 1e4, top: 1e5, pb: 0, own: null, ...extra });

module.exports = [
  ['zindan: kod -> zindan eşlemesi', () => {
    const e = []; const ok = mk(e); const D = req('lib/dungeons.js');
    const a = D.lookup(2300371);
    ok(a && a.name === 'Fire Temple' && a.mode === 'c', 'Kromede 2300371 Fire Temple / Fetih olmalı');
    const b = D.lookup(2310371);
    ok(b && b.name === 'Fire Temple' && b.mode === 'e', '2310371 Keşif olmalı');
    ok(D.lookup('2300218') && D.lookup('2300218').name === 'Urugugu Canyon', 'Auldor 2300218 Urugugu (metin kod da olur)');
    ok(D.lookup(2300910).name === 'Ferocious Horn Den', 'Nuakum 2300910 Horn Den');
    ok(D.lookup(2300907).mini === true, 'Mau Totem mini boss işaretli olmalı');
    ok(D.lookup(2300470).name !== D.lookup(2301301).name, 'Afflicted Bakarma iki zindanda koda göre ayrılmalı');
    ok(D.lookup(2300601).name === 'Deus Research Base', 'Atiel 2300601');
    ok(D.lookup(999) === null && D.lookup(0) === null && D.lookup(undefined) === null && D.lookup('abc') === null, 'bilinmeyen kod null');
    return e;
  }],
  ['zindan: ardışık dövüşler tek koşu, boss sayısı ve mod', () => {
    const e = []; const ok = mk(e); const H = req('ui/bosshist.js');
    const items = [fight(2300310, 'Rotan', 0), fight(2300311, 'Ignus', 5), fight(2300312, 'Murute', 10), fight(2300371, 'Kromede', 15)];
    const g = H.groupRuns(items);
    ok(g.length === 1 && g[0].run, 'tek koşu kartı olmalı');
    ok(g[0].items.length === 4 && g[0].bosses === 4 && g[0].fights === 4, '4 boss / 4 dövüş');
    ok(g[0].items[0].boss === 'Rotan' && g[0].items[3].boss === 'Kromede', 'içerik eskiden yeniye');
    ok(g[0].dungeon === 'Fire Temple' && g[0].mode === 'c', 'zindan adı ve Fetih modu');
    const x = H.groupRuns([fight(2310371, 'Kromede', 0)]);
    ok(x[0].run && x[0].mode === 'e', 'Keşif rozeti');
    const w = H.groupRuns([fight(2300371, 'Kromede', 0, { res: 'w' }), fight(2300371, 'Kromede', 3)]);
    ok(w[0].bosses === 1 && w[0].fights === 2 && w[0].res === 'k', 'tekrar denemede boss sayısı 1, dövüş 2, sonuç kill');
    return e;
  }],
  ['zindan: zindan değişince / uzun boşlukta yeni koşu, mini boss ayrı kart açmaz', () => {
    const e = []; const ok = mk(e); const H = req('ui/bosshist.js');
    const g = H.groupRuns([fight(2300371, 'Kromede', 0), fight(2300910, 'Nuakum', 10)]);
    ok(g.length === 2 && g.every((r) => r.run), 'farklı zindan iki koşu');
    const l = H.groupRuns([fight(2300310, 'Rotan', 0), fight(2300311, 'Ignus', 5 + 30)]);
    ok(l.length === 2, '20 dk üstü boşluk yeni koşu');
    const s = H.groupRuns([fight(2300908, 'Kwapo', 0), fight(2300907, 'Mau Totem', 4), fight(2300909, 'Duanka', 8), fight(2300910, 'Nuakum', 12)]);
    ok(s.length === 1 && s[0].fights === 4 && s[0].bosses === 3, 'mini boss aynı kartta, boss sayısına katılmaz');
    return e;
  }],
  ['zindan: açık dünya / bilinmeyen kod gruplanmaz', () => {
    const e = []; const ok = mk(e); const H = req('ui/bosshist.js');
    const g = H.groupRuns([fight(2090027, 'Dünya Boss', 0), fight(2090027, 'Dünya Boss', 1), fight(0, 'Kodsuz', 2), fight(undefined, 'Kodsuz2', 3)]);
    ok(g.length === 4 && g.every((x) => !x.run), 'dört ayrı tek kart');
    const m = H.groupRuns([fight(2090027, 'Dünya', 0), fight(2300310, 'Rotan', 1), fight(2300371, 'Kromede', 2)]);
    ok(m.filter((x) => x.run).length === 1 && m.filter((x) => !x.run).length === 1, 'karışıkta yalnız zindan gruplanır');
    return e;
  }],
  ['zindan: eski kayıt uyumu (kodsuz özet, bosslog dosyası) ve görünüm süzgeçleri', () => {
    const e = []; const ok = mk(e); const H = req('ui/bosshist.js'); const { BossLog, cleanSummary } = req('lib/bosslog.js');
    const old = { fk: '1:2', at: T0, boss: 'Eski', dur: 1000, res: 'k', n: 3, total: 10, dps: 5, top: 1, pb: 0, own: null };
    ok(H.groupRuns(H.merge([old], [])).length === 1 && !H.groupRuns(H.merge([old], []))[0].run, 'kodsuz eski kayıt tek kart');
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dl-zindan-'));
    try {
      fs.writeFileSync(path.join(dir, 'index.jsonl'), JSON.stringify(old) + '\n' + JSON.stringify({ ...old, fk: '5:6', at: T0 + 1000, code: 2300371, boss: 'Kromede' }) + '\n');
      const log = new BossLog(dir); log.load();
      ok(log.size === 2, 'eski + yeni kayıt yüklenir (silinmez)');
      const g = H.groupRuns(H.merge(log.list(), []));
      ok(g.length === 2 && g.filter((x) => x.run).length === 1, 'eski tek kart, kodlu zindan kartı');
    } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* yok */ } }
    ok(cleanSummary({ ...old, code: 2300371 }).code === 2300371, 'özet kodu korur');
    const items = [fight(2300310, 'Rotan', 0), fight(2300371, 'Kromede', 5), fight(2090027, 'Dünya', 100)];
    ok(H.viewRuns(items, { sort: 'new' }).length === 2, 'görünüm 2 kart');
    ok(H.viewRuns(items, { q: 'fire' }).length === 1, 'zindan adıyla arama koşuyu bulur');
    ok(H.viewRuns(items, { boss: 'Rotan' }).length === 1 && H.viewRuns(items, { boss: 'Dünya' })[0].run === false, 'boss süzgeci');
    const days = H.groupDays(H.viewRuns(items, { sort: 'new' }));
    ok(days.length === 1 && days[0].items.length === 2, 'gün gruplama koşu girdileriyle çalışır');
    ok(H.groupDays([fight(1, 'a', 0)]).length === 1, 'groupDays düz kayıtla da çalışır');
    const mem = H.merge([], [{ fk: 'x:1', name: 'Rotan', at: T0, code: 2300310, dur: 5000 }]);
    ok(mem[0].code === 2300310, 'bellek kaydı kodu taşır');
    return e;
  }],
];
