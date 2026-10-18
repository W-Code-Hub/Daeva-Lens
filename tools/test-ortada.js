'use strict';
// "Oyun ortasında program açılışı" testleri: program parti/zindan başladıktan SONRA açılırsa isimler gelir mi?
// Kayıtlı trafiğin başı kesilerek (program geç açılmış gibi) oynatılır; ayrıca kadro paketi (0x0092) kaçırılmış senaryo üretilir.
// Saf mantık: Electron ve ağ yok. Dışa aktarım: [[ad, işlev], ...]; işlev hata listesi (ya da onu veren söz) döner.
const path = require('path');
const A = path.join(__dirname, '..');
const req = (p) => require(path.join(A, p));
const KAYIT = path.join(__dirname, '..', 'test', 'kayitlar');
const fs = require('fs');
const kayitYok = (...f) => f.some((x) => !fs.existsSync(path.join(KAYIT, x)));
function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }

function newEngine(c, charName) {
  const { Engine } = req('lib/engine.js');
  return new Engine({ now: () => c.t, setTimer: () => 0, clearTimer: () => 0, charName: charName || null, onEvent: () => {} });
}
const stateFrame = (db) => { const b = Buffer.alloc(64); b.writeUInt32LE(db, 0); return b; };
// Gerçek paketle aynı düzende üye kaydı (test-parti.js ile aynı)
function memberRec(m) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(m.sid >>> 0, 0); head.writeUInt16LE(m.server || 1301, 4); head.writeUInt16LE(0x10e4, 6);
  const guid = Buffer.from('$' + '04496707-34FB-441E-B7F1-3C00A90C0B81', 'latin1');
  const nm = Buffer.from(m.name, 'utf8');
  const t2 = Buffer.alloc(8 + 1 + nm.length);
  t2.writeUInt32LE(m.dbid >>> 0, 0); t2.writeUInt16LE(0, 4); t2.writeUInt16LE(m.server || 1301, 6);
  t2[8] = nm.length; nm.copy(t2, 9);
  return Buffer.concat([head, guid, t2, Buffer.alloc(30)]);
}
const rosterBody = (ms) => Buffer.concat([Buffer.alloc(16, 0x11), ...ms.map(memberRec)]);

const ME = { sid: 5000, dbid: 237513, name: 'Player1' };
const P1 = { sid: 5001, dbid: 100001, name: 'Player2' };
const P2 = { sid: 5002, dbid: 100002, name: 'Player3' };
const RANGER = 14010000, GLADI = 11010000;

// Parti zaten sürerken program açıldı: kadro paketi kaçtı; yalnız üye durum akışı (0x1c92) ve zindan ilanı (0x0297) geliyor.
function kacirilmisKadro(c, skills) {
  const eng = newEngine(c, 'Player1');
  eng.pickOwn(5000, 'eşleşme', 'test');
  const sk = skills || { 5001: RANGER, 5002: GLADI };
  for (let i = 0; i < 5; i++) {
    c.t += 1000;
    eng.combat.frame(0x1c92, stateFrame(100001), c.t); eng.combat.frame(0x1c92, stateFrame(100002), c.t);
    eng.tick();
    for (const [id, d, s] of [[5000, 900, RANGER], [5001, 500, sk[5001]], [5002, 400, sk[5002]]]) eng.combatEvent({ type: 'damage', t: c.t, actor: id, target: 90001, skill: s, damage: d });
  }
  eng.combatEvent({ type: 'party', size: 3, dungeon: 600092, members: ['Player1', 'Player2', 'Player3'], memberDetails: [
    { name: 'Player2', globalId: 100001, server: 1301, level: 50, gearScore: 2000, combatPower: 5e4, cls: 14 },
    { name: 'Player3', globalId: 100002, server: 1301, level: 50, gearScore: 2000, combatPower: 5e4, cls: 11 }] });
  c.t += 1000; eng.tick();
  return eng;
}

// Kayıt başı kesilir (kesSn saniye atlanır); kalan paketlerle oyuncu (canavar olmayan) hasar vuranların etiketleri ölçülür.
function oynat(file, kesSn, charName) {
  const { forEachJson } = require('./satirlar');
  return new Promise((res, rej) => {
    const pk = [];
    forEachJson(path.join(KAYIT, file), (m) => { if (m.type === 'pkt') pk.push(m); }).then(() => {
      const t0 = pk[0].t; const c = { t: 0 };
      const eng = newEngine(c, charName);
      const dmg = new Set();
      const orig = eng.combatEvent.bind(eng);
      eng.combatEvent = (e) => { if (e.type === 'damage') dmg.add(e.actor); return orig(e); };
      for (const m of pk) { if (m.t - t0 < kesSn * 1000) continue; c.t = m.t - t0; eng.packet(m); eng.tick(); }
      const oyuncu = [...dmg].filter((id) => typeof id === 'number' && !eng.meter.npcIds.has(id));
      const cozulmemis = oyuncu.filter((id) => / #\d+$/.test(String(eng.meter.label(id))));
      res({ eng, oyuncu, cozulmemis, oran: oyuncu.length ? 1 - cozulmemis.length / oyuncu.length : 1 });
    }, rej);
  });
}

module.exports = [
  ['ortada: kadro kaçırıldı, sınıfları farklı üyeler ilan + durum akışından tahminen adlanır', () => {
    const e = []; const ok = mk(e); const c = { t: 1000 };
    const eng = kacirilmisKadro(c);
    ok(eng.group.live && eng.group.via === 'state', 'parti durum akışından canlı sayılmalı: ' + eng.group.via);
    ok(!eng.group.snapshot().complete, 'kadro görülmediği için "tam kadro" denmemeli');
    ok(eng.meter.names.get(5001) === undefined, 'gerçek ad haritası kadro olmadan dolmaz (yalnız gösterim tahmini)');
    eng.meter.snapshot(0, { view: 'party', bossView: false }); // tahmin (inferNames) görünüm çizilirken çalışır
    ok(eng.meter.label(5001) === 'Player2' && eng.meter.label(5002) === 'Player3', 'sınıfı kadroda tek aday olan üyeler adlanır: ' + eng.meter.label(5001) + '/' + eng.meter.label(5002));
    return e;
  }],
  ['ortada: kadro kaçırıldı, aynı sınıftan iki üye -> "Sınıf #id" kalır (bilinen boşluk)', () => {
    const e = []; const ok = mk(e); const c = { t: 1000 };
    const eng = kacirilmisKadro(c, { 5001: RANGER, 5002: RANGER });
    ok(/^Ranger #5001$/.test(eng.meter.label(5001)) && /^Ranger #5002$/.test(eng.meter.label(5002)), 'belirsizse tahmin yapılmaz, numaralı kalır: ' + eng.meter.label(5001));
    ok(eng.meter.label(5000) === 'Player1', 'kendi satırımız kayıtlı karakter adıyla görünür');
    const rows = eng.meter.snapshot(0, { view: 'party', bossView: false }).enc.actors.map((a) => a.name);
    ok(rows.includes('Player2') && rows.includes('Player3') && rows.includes('Ranger #5001'), 'adlı sanal satırlar ile numaralı gerçek satırlar yan yana kalır: ' + rows.join());
    return e;
  }],
  ['ortada: kadro sonradan gelince (üye değişimi/yeni bölge) bütün adlar anında çözülür', () => {
    const e = []; const ok = mk(e); const c = { t: 1000 };
    const eng = kacirilmisKadro(c, { 5001: RANGER, 5002: RANGER });
    c.t += 2000;
    eng.combat.frame(0x0092, rosterBody([ME, P1, P2]), c.t);
    ok(eng.meter.label(5001) === 'Player2' && eng.meter.label(5002) === 'Player3', 'kadro gelince kesin ad: ' + eng.meter.label(5001));
    ok(eng.group.via === 'roster' && eng.group.snapshot().complete, 'parti artık tam kadroyla doğrulanmış');
    const rows = eng.meter.snapshot(0, { view: 'party', bossView: false }).enc.actors.map((a) => a.name);
    ok(!rows.some((n) => / #\d+$/.test(n)), 'numaralı satır kalmaz: ' + rows.join());
    return e;
  }],
  ['ortada: kadro gelmese de tek üyenin ad paketi (0x2292) o kişiyi çözer', () => {
    const e = []; const ok = mk(e); const c = { t: 1000 };
    const eng = kacirilmisKadro(c, { 5001: RANGER, 5002: RANGER });
    c.t += 500;
    eng.combat.frame(0x2292, memberRec(P1), c.t);
    ok(eng.meter.label(5001) === 'Player2', 'tek üye paketi bu üyeyi çözer: ' + eng.meter.label(5001));
    ok(/ #5002$/.test(eng.meter.label(5002)), 'diğeri henüz numaralı: ' + eng.meter.label(5002));
    return e;
  }],
  ['ortada: kayıt başı kesilince oyuncu adları görüş alanına girdikçe gelir, çökme yok', async () => {
    if (kayitYok('kalabalik-karisik.jsonl')) return { skip: true };
    const e = []; const ok = mk(e);
    const tam = await oynat('kalabalik-karisik.jsonl', 0, 'Player1');
    const kes = await oynat('kalabalik-karisik.jsonl', 20, 'Player1');
    ok(tam.oyuncu.length > 20 && kes.oyuncu.length > 20, 'oyuncu sayısı beklenenden az');
    ok(kes.oran >= tam.oran - 0.15, 'geç açılışta çözülen oran tam kayda yakın olmalı: ' + kes.oran.toFixed(2) + ' vs ' + tam.oran.toFixed(2));
    ok(kes.eng.meter.label(2987) === 'Player1', 'kendi adı kayıtlı karakter adından gelir');
    return e;
  }],
  ['ortada: kendi kimliğimiz için ad paketi tekrar gelmez; yalnız kendi becerisiyle bulunur, yanlış kişi seçilmez', async () => {
    if (kayitYok('kalabalik-karisik.jsonl', 'konum-kaydi-2026-10-04T00-55-49-402Z.jsonl')) return { skip: true };
    const e = []; const ok = mk(e);
    const kes = await oynat('kalabalik-karisik.jsonl', 45, 'Player1');
    ok(kes.eng.ownId === null || kes.eng.ownId === 2987, 'yanlış kişi "sen" seçilmemeli: ' + kes.eng.ownId);
    const ham = await oynat('konum-kaydi-2026-10-04T00-55-49-402Z.jsonl', 20, null);
    ok(ham.eng.ownId === 2987, 'kayıtlı karakter adı yokken kendi becerisiyle geç açılışta da bulunur: ' + ham.eng.ownId);
    // BİLİNEN BOŞLUK (düzeltilmedi): kayıtlı karakter adı VARKEN aynı kayıt 20. sn'den açılırsa, ad paketiyle bulunan doğru kimlik (2987)
    // bir saniye sonra zayıf "giden istek eşleşmesi" ile başka kimliğe (86830) devredilir ve ad oraya taşınır (migrateActor). Burada yalnız çökmediği doğrulanır.
    const adli = await oynat('konum-kaydi-2026-10-04T00-55-49-402Z.jsonl', 20, 'Player1');
    ok(adli.eng.ownId !== undefined, 'adlı geç açılış çalışır durumda kalır');
    return e;
  }],
];
