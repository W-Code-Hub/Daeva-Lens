'use strict';
// Bölge geçişinde kimlik değişimi, bayat kimlikle görünüm, sessizlik kuralı, kayıp paket zaman aşımı.
const path = require('path');
const A = path.join(__dirname, '..');
const { Engine } = require(path.join(A, 'lib/engine.js'));
const { Meter } = require(path.join(A, 'lib/meter.js'));
const { Stream } = require(path.join(A, 'lib/parser.js'));
const { PartyTracker, QUIET_MS } = require(path.join(A, 'lib/party.js'));
const { Combat } = require(path.join(A, 'lib/combat.js'));
function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }
module.exports = [
  ['bölge: yeni oturum kimliği karakter adıyla yeniden eşlenir', () => {
    const e = []; const ok = mk(e); const c = { t: 1000 };
    const eng = new Engine({ now: () => c.t, setTimer: () => 0, clearTimer: () => 0, charName: 'Tester', onEvent: () => {} });
    eng.meter.setName(5000, 'Tester');
    eng.pickOwn(5000, 'isim', 'test');
    eng.meter.setName(7000, 'Tester'); // bölge girişinde aynı ad yeni kimlikle göründü
    eng.combatEventCore({ type: 'zone-load', t: c.t });
    ok(eng.ownId === 7000, 'kimlik 7000 olmalı: ' + eng.ownId);
    eng.setOwnManual(5000);
    eng.combatEventCore({ type: 'zone-load', t: c.t });
    ok(eng.ownId === 5000, 'elle seçilen kimlik bozulmamalı: ' + eng.ownId);
    return e;
  }],
  ['bölge: bayat kimlikte "ben" görünümü boş kalmaz', () => {
    const e = []; const ok = mk(e);
    const m = new Meter({ now: () => 1000 });
    m.setCharName('Tester');
    m.setOwn(5000); // bayat kimlik
    m.setName(7000, 'Tester');
    m.damage({ t: 1000, actor: 7000, target: 900, skill: 14010000, damage: 300 });
    m.damage({ t: 1100, actor: 8000, target: 900, skill: 14010000, damage: 200 });
    const rows = m.snapshot(0, { view: 'me', bossView: false }).enc.actors;
    ok(rows.length === 1 && rows[0].id === 7000, 'ada göre yalnız kendi satırı: ' + rows.map((r) => r.id));
    m.setCharName(null); m.setName(7000, 'Baska');
    const r2 = m.snapshot(0, { view: 'me', bossView: false }).enc.actors;
    ok(r2.length === 2, 'bulunamazsa hepsi gösterilmeli: ' + r2.length);
    return e;
  }],
  ['bölge: yükleme sonrası 30 sn yabancı vuruşları elenmez', () => {
    const e = []; const ok = mk(e); let now = 1000;
    const m = new Meter({ now: () => now });
    m.setCharName('Tester'); m.setOwn(5000);
    m.damage({ t: now, actor: 9, target: 900, skill: 14010000, damage: 100 });
    ok(!m.cur, 'normalde yabancı vuruş sayaç başlatmaz');
    m.noteZone();
    m.damage({ t: now, actor: 9, target: 900, skill: 14010000, damage: 100 });
    ok(!!m.cur, 'bölge sonrası vuruş alınmalı');
    return e;
  }],
  ['parti: canlı dövüş sürerken sessizlik kuralı partiyi bitirmez', () => {
    const e = []; const ok = mk(e); let now = 1000; let busy = true;
    const g = new PartyTracker({ now: () => now, isBusy: () => busy });
    g.onRoster([{ name: 'A', sid: 1, dbid: 1 }, { name: 'B', sid: 2, dbid: 2 }], now);
    now += QUIET_MS + 1000; g.tick(now);
    ok(g.live, 'dövüş sürerken parti canlı kalmalı');
    busy = false; g.tick(now);
    ok(!g.live, 'dövüş bitince sessizlik kuralı çalışmalı');
    return e;
  }],
  ['parser: kayıp paket ~500 ms sonra atlanır', () => {
    const e = []; const ok = mk(e); const fr = [];
    const s = new Stream((op) => fr.push(op), false);
    s.push(1000, Buffer.from([0]), 0);   // akışı başlat (dolgu baytı)
    s.push(5000, Buffer.from([0, 0, 0]), 100); // eksik parça: 1001..4999 gelmedi
    ok(s.pending.size === 1, 'parça beklemede olmalı');
    s.checkGap(300); ok(s.pending.size === 1, '500 ms dolmadan atlanmamalı');
    s.checkGap(700); ok(s.pending.size === 0 && s.gaps === 1, 'zaman aşımında boşluk atlanmalı');
    return e;
  }],
  ['combat: çerçeve istisnası loga yazılır, sayaç çalışır', () => {
    const e = []; const ok = mk(e); const logs = [];
    const cb = new Combat({ emit: () => {}, log: (...a) => logs.push(a) });
    cb._frame = () => { throw new Error('x'); };
    for (let i = 0; i < 7; i++) cb.frame(1, Buffer.alloc(0), 0);
    ok(cb.stats.errors === 7, 'hata sayılmalı');
    ok(logs.length === 5, 'ilk 5 hata loglanmalı: ' + logs.length);
    return e;
  }],
];
