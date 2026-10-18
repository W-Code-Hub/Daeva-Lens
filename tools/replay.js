'use strict';
// Kayıt dosyasını motordan geçirir: node tools/replay.js <kayit.jsonl | oturum-….jsonl.gz> [--cd base=sn,...]
// Faz 5.0-K.3: dosya akışla, satır satır okunur (oturum kayıtları 1 GB'ı geçebilir; tamamı belleğe alınmaz).
const { forEachJson } = require('./satirlar');
const { Engine } = require('../lib/engine');

const f = process.argv[2];
const cdArg = (process.argv.find((a) => a.startsWith('--cd=')) || '').slice(5);
const cdConfig = {};
for (const p of cdArg.split(',').filter(Boolean)) { const [b, s] = p.split('='); cdConfig[b] = { on: true, cdMs: +s * 1000, earlyMs: 500 }; }

let clock = 0;
const timers = [];
const log = [];
const eng = new Engine({
  now: () => clock,
  setTimer: (fn, ms) => { const h = { at: clock + ms, fn }; timers.push(h); return h; },
  clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
  cdConfig,
  onEvent: (e) => { if (e.type !== 'changed' && e.type !== 'diag') log.push([clock, e]); },
});
let t0 = null;
const runTimers = () => {
  timers.sort((a, b) => a.at - b.at);
  while (timers.length && timers[0].at <= clock) timers.shift().fn();
};
(async () => {
if (!f) { console.log('kullanım: node tools/replay.js <kayit.jsonl | oturum-….jsonl.gz> [--cd=base=sn,...]'); process.exit(2); }
const info = await forEachJson(f, (m) => {
  if (m.type !== 'pkt') return;
  if (t0 === null) t0 = m.t;
  clock = m.t - t0;
  runTimers();
  eng.packet(m);
  eng.tick();
});
if (info.yarim) console.log('not: dosya yarım (düzgün kapanmamış), okunabilen kısım kullanıldı' + (info.hata ? ': ' + info.hata : ''));
clock += 60000; runTimers(); eng.tick();
const fmt = (ms) => (ms / 1000).toFixed(1);
console.log('kendi id:', eng.ownId, eng.ownSource, 'çerçeve:', eng.combat.stats, eng.counts);
const snap = eng.meter.snapshot(0);
console.log('bölümler:', snap.encounters.map((e) => fmt(e.dur) + 's').join(' '));
for (let i = 0; i < snap.encounters.length; i++) {
  const s = eng.meter.snapshot(i, { onlyMine: true }).enc;
  console.log(`-- bölüm ${i}: ${fmt(s.dur)} sn, toplam ${s.total}, alınan ${s.taken}`);
  for (const a of s.actors.slice(0, 5)) {
    console.log(`  ${a.own ? '*' : ' '} ${a.name.padEnd(18)} ${Math.round(a.dps).toString().padStart(6)} dps ${a.total.toString().padStart(7)} ${(a.share * 100).toFixed(0)}% krit ${(a.crit * 100).toFixed(0)}%`);
    if (a.own) for (const k of a.skills.slice(0, 6)) console.log(`        ${k.name.padEnd(20)} ${k.total} (${k.hits} vuruş, ort ${Math.round(k.avg)})`);
  }
}
console.log('olaylar:');
for (const [t, e] of log) if (e.type !== 'new-skill') console.log(' ', fmt(t), e.type, e.name || '', e.ms != null ? fmt(e.ms) + 's' : '', e.id || '');
console.log('beceriler:', eng.cds.list().map((s) => `${s.name}(${s.uses}, öğr ${fmt(s.learnedMs)})`).join(', '));
})();
