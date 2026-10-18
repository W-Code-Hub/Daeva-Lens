'use strict';
// "Sen" etiketi: ad paketiyle doğrulanmış kimliği zayıf (giden istek) eşleşmesi devralmamalı.
const path = require('path');
const A = path.join(__dirname, '..');
const KAYIT = path.join(__dirname, '..', 'test', 'kayitlar');
const { Engine } = require(path.join(A, 'lib/engine.js'));
const fs = require('fs');
const kayitYok = (...f) => f.some((x) => !fs.existsSync(path.join(KAYIT, x)));
function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }
function newEngine(c, charName) {
  return new Engine({ now: () => c.t, setTimer: () => 0, clearTimer: () => 0, charName: charName || null, onEvent: () => {} });
}
function oynat(file, kesSn, charName) {
  const { forEachJson } = require('./satirlar');
  return new Promise((res, rej) => {
    const pk = [];
    forEachJson(path.join(KAYIT, file), (m) => { if (m.type === 'pkt') pk.push(m); }).then(() => {
      const t0 = pk[0].t; const c = { t: 0 }; const eng = newEngine(c, charName);
      for (const m of pk) { if (m.t - t0 < kesSn * 1000) continue; c.t = m.t - t0; eng.packet(m); eng.tick(); }
      res(eng);
    }, rej);
  });
}
module.exports = [
  ['kimlik: ad paketiyle doğrulanan kimliği zayıf eşleşme devralmaz', () => {
    const e = []; const ok = mk(e); const c = { t: 1000 };
    const eng = newEngine(c, 'Player0');
    eng.meter.setName(5000, 'Player0');
    eng.pickOwn(5000, 'isim', 'test');
    eng.pickOwn(5001, 'eşleşme', 'giden istek');
    ok(eng.ownId === 5000, 'zayıf eşleşme kimliği çalmamalı: ' + eng.ownId);
    eng.pickOwn(null, 'eşleşme', 'bıraktı');
    ok(eng.ownId === 5000, 'zayıf eşleşme doğrulanmış kimliği bırakmamalı: ' + eng.ownId);
    eng.pickOwn(6000, 'giriş', 'yeniden giriş');
    ok(eng.ownId === 6000, 'güçlü kaynak (yeniden giriş) kimliği yine güncellemeli: ' + eng.ownId);
    return e;
  }],
  ['kimlik: ad kayıtlı değilse zayıf eşleşme çalışır', () => {
    const e = []; const ok = mk(e); const c = { t: 1000 };
    const eng = newEngine(c, null);
    eng.pickOwn(5001, 'eşleşme', 'giden istek');
    ok(eng.ownId === 5001, 'adsız durumda zayıf eşleşme seçmeli: ' + eng.ownId);
    return e;
  }],
  ['kimlik: kayıt 20. sn\'den başlayınca (ad kayıtlı) "sen" 2987 kalır', async () => {
    if (kayitYok('konum-kaydi-2026-10-04T00-55-49-402Z.jsonl')) return { skip: true };
    const e = []; const ok = mk(e);
    const eng = await oynat('konum-kaydi-2026-10-04T00-55-49-402Z.jsonl', 20, 'Player0');
    ok(eng.ownId === 2987, 'ownId 2987 olmalı: ' + eng.ownId);
    ok(eng.meter.label(2987) === 'Player0', 'etiket Player0 olmalı: ' + eng.meter.label(2987));
    return e;
  }],
];
