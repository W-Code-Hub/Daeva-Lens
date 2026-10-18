'use strict';
// Parti üyeliği / kimlik çözümü testleri (kadro paketi 0x0092, bayat parti, auto görünüm, parti.json, kara liste bayrağı).
// Saf mantık: Electron ve ağ yok. Dışa aktarım: [[ad, işlev], ...]; işlev hata listesi döner.
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = path.join(__dirname, '..');
const req = (p) => require(path.join(A, p));
const MAIN_SRC = fs.readFileSync(path.join(A, 'main.js'), 'utf8').replace(/\r\n/g, '\n'); // dosyalar CRLF: düzenli ifadeler \n bekler

function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }

// Gerçek paketle aynı düzende üye kaydı: [sid u32][sunucu u16][u16 e410] '$' GUID36 [küresel u32][u16 0][sunucu u16][uzunluk][ad] + dolgu
function memberRec(m) {
  const head = Buffer.alloc(8);
  head.writeUInt32LE(m.sid >>> 0, 0); head.writeUInt16LE(m.server || 1301, 4); head.writeUInt16LE(0x10e4, 6);
  const guid = Buffer.from('$' + '04496707-34FB-441E-B7F1-3C00A90C0B81', 'latin1');
  const nm = Buffer.from(m.name, 'utf8');
  const t2 = Buffer.alloc(8 + 1 + nm.length); // küresel kimlik(4) 0000 sunucu(2) uzunluk ad
  t2.writeUInt32LE(m.dbid >>> 0, 0); t2.writeUInt16LE(0, 4); t2.writeUInt16LE(m.server || 1301, 6);
  t2[8] = nm.length; nm.copy(t2, 9);
  return Buffer.concat([head, guid, t2, Buffer.alloc(30)]);
}
function rosterBody(members, pad = 16) { return Buffer.concat([Buffer.alloc(pad, 0x11), ...members.map(memberRec)]); }
function memberBody(m) { return memberRec(m); }

function newEngine(clockRef) {
  const { Engine } = req('lib/engine.js');
  const events = [];
  const eng = new Engine({ now: () => clockRef.t, setTimer: () => 0, clearTimer: () => 0, onEvent: (e) => events.push(e) });
  eng.events2 = events;
  return eng;
}
const ME = { sid: 5000, dbid: 237513, name: 'Player0', server: 1301 };
const P1 = { sid: 5001, dbid: 100001, name: 'Player1', server: 1301 };
const P2 = { sid: 5002, dbid: 100002, name: 'Player2', server: 1302 };
const P3 = { sid: 0, dbid: 100003, name: 'Zero', server: 1301 }; // oturum kimliği henüz atanmamış
const OP = { ROSTER: 0x0092, MEMBER: 0x2292, STATE: 0x1c92, LEAVE_A: 0x1d97, LEAVE_B: 0x1f93, ZONE: 0x8356 };

function rosterParseTests() {
  const errors = []; const ok = mk(errors);
  const { parseRosterMembers } = req('lib/combat.js');
  const ms = parseRosterMembers(rosterBody([ME, P1, P2, P3]));
  ok(ms.length === 4, 'dört üye bekleniyordu: ' + ms.length);
  ok(ms[0].name === 'Player0' && ms[0].sid === 5000 && ms[0].dbid === 237513 && ms[0].server === 1301, 'ilk üye alanları: ' + JSON.stringify(ms[0]));
  ok(ms[2].name === 'Player2' && ms[2].server === 1302, 'sunucu alanı');
  ok(ms[3].name === 'Zero' && ms[3].sid === 0, 'oturum kimliği 0 olan üye de kadroda (kimlik sonra gelir)');
  ok(parseRosterMembers(Buffer.alloc(300, 7)).length === 0, 'çöp veri üye üretmemeli');
  ok(parseRosterMembers(rosterBody([ME]).subarray(0, 40)).length === 0, 'kesik paket üye üretmemeli');
  ok(parseRosterMembers(null).length === 0, 'null paket');
  ok(parseRosterMembers(rosterBody([ME, { ...ME, sid: 9 }])).length === 1, 'aynı küresel kimlik iki kez sayılmaz');
  return errors;
}

function rosterNamesTests() {
  const errors = []; const ok = mk(errors);
  const c = { t: 1000 };
  const eng = newEngine(c);
  eng.pickOwn(5000, 'elle', 'test');
  // zindana giriş: bölge yüklemesi + kadro (3 üye + biri kimliksiz)
  eng.combat.frame(OP.ZONE, Buffer.alloc(39000), c.t);
  c.t += 300;
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1, P2, P3]), c.t);
  ok(eng.meter.names.get(5001) === 'Player1' && eng.meter.names.get(5002) === 'Player2', 'oturum kimliği → ad (meter.names)');
  ok(eng.meter.names.get(5000) === 'Player0', 'kendi satırımızın adı kadrodan');
  ok(eng.meter.label(5001) === 'Player1', 'etiket "Sınıf #id" değil gerçek ad');
  ok(eng.group.live && eng.group.via === 'roster' && eng.meter.inGroup, 'kadro ≥2 → partideyim');
  ok(eng.meter.party && eng.meter.party.members.has('Zero'), 'kimliksiz üye de parti adları arasında');
  ok(eng.meter.instanceOn, 'bölge yüklemesiyle birlikte gelen kadro = gerçek zindan içi');
  ok(eng.globalNames.get(237513) === 'Player0' && eng.globalNames.get(100003) === 'Zero', 'küresel kimlik → ad tablosu kadrodan da dolar');
  ok(eng.meter.partyServer.get('Player2') === 1302, 'sunucu numarası kadrodan erken gelir');
  // sonradan 0x2292: Zero'nun oturum kimliği gelir
  c.t += 500;
  eng.combat.frame(OP.MEMBER, memberBody({ sid: 5003, dbid: 100003, name: 'Zero', server: 1301 }), c.t);
  ok(eng.meter.names.get(5003) === 'Zero', '0x2292 ile gelen oturum kimliği ada bağlanır');
  // oturum kimliği eskiden bir canavara ait sayılmışsa kadro onu oyuncu yapar
  eng.meter.noteNpc(5009, c.t);
  eng.combat.frame(OP.MEMBER, memberBody({ sid: 5009, dbid: 100009, name: 'Player5' }), c.t);
  ok(!eng.meter.npcIds.has(5009) && eng.meter.names.get(5009) === 'Player5', 'kadrodaki oyuncu canavar listesinden çıkar');
  return errors;
}

function ownFromRosterTests() {
  const errors = []; const ok = mk(errors);
  const c = { t: 1000 };
  const eng = newEngine(c);
  // 0x2036: küresel bağlantı → kendi küresel kimliğimiz; kadro bize doğru oturum kimliğini verir
  eng.combatEvent({ type: 'global-link', t: c.t, sessionId: 4000, globalId: 237513 });
  eng.pickOwn(4000, 'eşleşme', 'tahmin');
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1]), c.t);
  ok(eng.ownId === 5000, 'kadrodaki küresel kimlik eşleşmesi ile kendi oturum kimliği düzelir: ' + eng.ownId);
  return errors;
}

function stalePartyTests() {
  const errors = []; const ok = mk(errors);
  const c = { t: 1000 };
  const eng = newEngine(c);
  eng.pickOwn(5000, 'elle', 'test');
  eng.combat.frame(OP.ZONE, Buffer.alloc(39000), c.t);
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1, P2]), c.t + 100);
  c.t += 200;
  // dövüş: ben + Player1 vurur, Player2 vurmaz; yabancı 7777 (kadroda yok)
  eng.meter.setName(7777, 'Stranger');
  for (const [id, d] of [[5000, 900], [5001, 500], [7777, 400]]) eng.combatEvent({ type: 'damage', t: c.t, actor: id, target: 90001, skill: 14010000, damage: d });
  let rows = eng.meter.snapshot(0, { view: 'party', bossView: false }).enc.actors.map((a) => a.name);
  ok(rows.includes('Player0') && rows.includes('Player1') && rows.includes('Player2'), 'parti görünümü: kadro (hasar vurmayan 0 ile): ' + rows.join());
  ok(!rows.includes('Stranger'), 'adı bilinen ama kadroda olmayan yabancı zindanda bile parti görünümüne girmez: ' + rows.join());
  // ayrılma bildirimi: parti biter, sanal satır ve parti süzgeci kalmaz
  c.t += 1000;
  eng.combat.frame(OP.LEAVE_A, Buffer.from([0, 0]), c.t);
  ok(!eng.group.live && eng.meter.party === null && !eng.meter.inGroup, 'ayrılma sonrası parti yok');
  ok(!eng.meter.isMeOrParty(7777) && !eng.meter.isMeOrParty(5001), 'ayrılma sonrası yabancı da eski üye de "parti" sayılmaz');
  rows = eng.meter.snapshot(0, { view: 'all', bossView: false }).enc.actors.map((a) => a.id);
  ok(!rows.some((id) => typeof id === 'string'), 'bayat parti sanal ("p:") satır üretmez');
  // 0x0297 (zindan ilanı) gelse de parti DİRİLMEZ: yalnız bilgi
  const { parseParty } = req('lib/combat.js');
  eng.combatEvent({ type: 'party', size: 5, dungeon: 600092, members: ['Player0', 'Player1'], memberDetails: [{ name: 'Player1', globalId: 100001, server: 1301, level: 50, gearScore: 2000, combatPower: 50000, cls: 13 }] });
  ok(!eng.group.live && eng.meter.party === null && !eng.meter.inGroup, '0x0297 ilanı üyelik kanıtı değil');
  ok(eng.meter.partyCls.get('Player1') === 13 && eng.meter.memberStats('p:Player1').gs === 2000, '0x0297 yine de ad/sınıf/GS bilgisi sağlar');
  ok(typeof parseParty === 'function', 'parseParty duruyor');
  // ayrılmadan hemen sonra uçuştaki durum paketi partiyi diriltmez; 3 sn sonrası yeni akış diriltir
  const st = Buffer.alloc(64); st.writeUInt32LE(100001, 0);
  eng.combat.frame(OP.STATE, st, c.t + 500);
  ok(!eng.group.live, 'ayrılma sonrası ilk 3 sn durum paketi partiyi diriltmez');
  return errors;
}

function zoneNoRosterTests() {
  const errors = []; const ok = mk(errors);
  const c = { t: 1000 };
  const eng = newEngine(c);
  eng.combat.frame(OP.ZONE, Buffer.alloc(39000), c.t);
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1]), c.t + 100);
  ok(eng.group.live, 'giriş: parti canlı');
  // zindan içi bölge yüklemesi + kadro tekrar gelir: parti sürer
  c.t += 60000;
  eng.combat.frame(OP.ZONE, Buffer.alloc(39000), c.t);
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1]), c.t + 1500);
  c.t += 20000; eng.tick();
  ok(eng.group.live, 'bölge yüklemesinden sonra kadro geldi → parti sürüyor');
  // çıkış: bölge yüklemesi var, kadro yok
  c.t += 30000;
  eng.combat.frame(OP.ZONE, Buffer.alloc(39000), c.t);
  c.t += 9000; eng.tick();
  ok(eng.group.live, '10 sn dolmadan parti bitmez');
  c.t += 2000; eng.tick();
  ok(!eng.group.live && eng.meter.party === null, 'bölge yüklemesinden 10 sn sonra kadro gelmedi → parti bitti');
  ok(!eng.meter.instanceOn, 'zindan içi bayrağı da düştü');
  // kadroda yalnız ben (184 baytlık paket): parti yok
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1]), c.t + 100000);
  ok(eng.group.live, 'yeni kadro → tekrar parti');
  eng.combat.frame(OP.ROSTER, rosterBody([ME]), c.t + 100500);
  ok(!eng.group.live, 'kadroda yalnız ben → parti bitti');
  // yedek: sinyal yok
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1]), c.t + 200000);
  c.t += 200000 + 151000; eng.tick();
  ok(!eng.group.live, 'yedek: 150 sn kadro/durum akışı yok → parti bitti');
  return errors;
}

function instanceRuleTests() {
  const errors = []; const ok = mk(errors);
  const c = { t: 1000 };
  const eng = newEngine(c);
  eng.pickOwn(5000, 'elle', 'test');
  // açık dünyada elle kurulan parti (bölge yüklemesi yok): "herkes partidir" kuralı KAPALI
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1]), c.t);
  ok(eng.group.live && !eng.meter.instanceOn, 'açık dünya partisi zindan içi sayılmaz');
  eng.meter.setName(7001, 'Passerby');
  ok(!eng.meter.isMeOrParty(7001) && eng.meter.isMeOrParty(5001), 'açık dünyada yoldan geçen yabancı parti değil, üye parti');
  // zindan: adı bilinmeyen (çözülmemiş) canavar olmayan aktör partidir
  c.t += 100000;
  eng.combat.frame(OP.ZONE, Buffer.alloc(39000), c.t);
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1]), c.t + 500);
  ok(eng.meter.instanceOn && eng.meter.isMeOrParty(8888), 'zindan içinde adsız oyuncu satırı partidir');
  eng.meter.noteNpc(8889, c.t);
  ok(!eng.meter.isMeOrParty(8889), 'canavar zindanda bile parti değil');
  // zindandan çıkış: bayrak düşer
  c.t += 50000;
  eng.combat.frame(OP.ZONE, Buffer.alloc(39000), c.t);
  c.t += 11000; eng.tick();
  ok(!eng.meter.instanceOn && !eng.meter.isMeOrParty(8888), 'çıkıştan sonra "herkes partidir" kalmaz');
  return errors;
}

function stateOnlyTests() {
  const errors = []; const ok = mk(errors);
  const c = { t: 1000000 };
  const eng = newEngine(c);
  eng.pickOwn(5000, 'elle', 'test');
  eng.charName = 'Player0';
  // program zindan ortasında açıldı: kadro paketi kaçırıldı; 0x0297 ilanı ve üye durum akışı var
  eng.combatEvent({ type: 'party', t: c.t, size: 5, dungeon: 600092, members: ['Player0', 'Player1', 'Player2'], memberDetails: [
    { name: 'Player0', globalId: 237513, server: 1301, level: 50, gearScore: 3000, combatPower: 90000, cls: 13 },
    { name: 'Player1', globalId: 100001, server: 1301, level: 50, gearScore: 2800, combatPower: 80000, cls: 11 },
    { name: 'Player2', globalId: 100002, server: 1302, level: 50, gearScore: 2700, combatPower: 70000, cls: 15 }] });
  ok(!eng.group.live && eng.meter.party === null, '0x0297 tek başına parti kurmaz');
  const st = (db) => { const b = Buffer.alloc(64); b.writeUInt32LE(db, 0); return b; };
  eng.combat.frame(OP.STATE, st(100001), c.t);
  ok(eng.group.live && eng.group.via === 'state', 'üye durum akışı → partideyim');
  eng.combat.frame(OP.STATE, st(100002), c.t + 100);
  ok(eng.meter.party.members.has('Player1') && eng.meter.party.members.has('Player2'), 'adlar 0x0297 küresel kimliğinden çözülür: ' + [...eng.meter.party.members]);
  ok(eng.meter.instanceOn, 'taze zindan ilanı + durum akışı → zindan içi');
  // kendi küresel kimliğimizin durum paketi tek başına parti kurmaz
  const e2 = newEngine({ t: 5 });
  e2.charName = 'Player0';
  e2.combatEvent({ type: 'global-link', t: 5, sessionId: 5000, globalId: 237513 });
  e2.combat.frame(OP.STATE, st(237513), 5);
  ok(!e2.group.live, 'yalnız kendi durumum → parti yok');
  // akış kesilince 30 sn sonra biter
  c.t += 31000; eng.tick();
  ok(!eng.group.live && eng.meter.party === null, 'durum akışı kesildi → parti bitti');
  return errors;
}

function autoViewTests() {
  const errors = []; const ok = mk(errors);
  const c = { t: 1000 };
  const eng = newEngine(c);
  eng.pickOwn(5000, 'elle', 'test');
  eng.meter.setName(5000, 'Player0');
  ok(!eng.meter.inGroup, 'partide değilken inGroup false (auto → yalnız ben)');
  ok(/effView = engine\.meter\.inGroup \? 'party' : 'me';/.test(MAIN_SRC), "main.js 'auto' kuralı: parti → party, değilse → me (boss dövüşünde 'all' yok)");
  ok(!/isBossFight \? 'all' : 'me'/.test(MAIN_SRC), "eski 'boss'ta herkes' kuralı kalmadı");
  // açık dünya boss dövüşü, yabancılar vurur: 'me' görünümü yalnız beni gösterir
  eng.meter.setName(7001, 'Stranger1');
  eng.meter.setName(7002, 'Alia');
  for (const [id, d] of [[5000, 1000], [7001, 5000], [7002, 4000]]) eng.combatEvent({ type: 'damage', t: c.t, actor: id, target: 90001, skill: 14010000, damage: d });
  const me = eng.meter.snapshot(0, { view: 'me', bossView: false }).enc.actors.map((a) => a.name);
  ok(me.length === 1 && me[0] === 'Player0', "'me' görünümü yalnız ben: " + me.join());
  // partideyken 'party': kadro + 0 hasarlı üyeler; 'all' hepsi
  eng.combat.frame(OP.ROSTER, rosterBody([ME, P1, P2]), c.t + 10);
  const party = eng.meter.snapshot(0, { view: 'party', bossView: false }).enc.actors.map((a) => a.name).sort();
  ok(party.join() === 'Player0,Player1,Player2', "'party' görünümü kadro (vurmayanlar 0 ile), yabancı yok: " + party.join());
  const all = eng.meter.snapshot(0, { view: 'all', bossView: false }).enc.actors.map((a) => a.name);
  ok(all.includes('Stranger1') && all.includes('Alia'), "'all' görünümü hâlâ herkesi gösterir");
  return errors;
}

function loadPartyTests() {
  const errors = []; const ok = mk(errors);
  const m = /function loadParty\(\) \{[\s\S]*?\n\}\n/.exec(MAIN_SRC);
  ok(!!m, 'main.js loadParty bulunamadı');
  if (!m) return errors;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daeva-parti-'));
  try {
    const file = path.join(dir, 'parti.json');
    const loadParty = new Function('fs', 'PARTY_FILE', m[0] + '; return loadParty;')(fs, () => file);
    const w = (o) => fs.writeFileSync(file, JSON.stringify(o));
    w({ size: 5, dungeon: 600092, members: ['A', 'B'], at: Date.now() - 60000 });
    ok(loadParty() && loadParty().members.length === 2, '1 dk önceki kayıt yüklenir');
    w({ size: 5, dungeon: 600092, members: ['A', 'B'], at: Date.now() - 6 * 60000 });
    ok(loadParty() === null, '5 dk\'dan eski kayıt yok sayılır');
    w({ size: 5, dungeon: 600092, members: ['A', 'B'] });
    ok(loadParty() === null, 'zaman damgasız (eski sürüm) kayıt yok sayılır');
    w({ size: 5, dungeon: 600092, members: ['A', 'B'], at: Date.now() + 3600000 });
    ok(loadParty() === null, 'gelecekteki zaman damgası yok sayılır');
    fs.writeFileSync(file, '{bozuk');
    ok(loadParty() === null, 'bozuk dosya');
    ok(/setParty\(savedParty, \{ info: true \}\)/.test(MAIN_SRC), 'açılışta yüklenen grup yalnız bilgi olarak verilir (üyelik kurmaz)');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  // motor tarafı: yüklenen bayat bilgi parti kurmaz
  const eng = newEngine({ t: 1 });
  eng.meter.setParty({ size: 5, dungeon: 600092, members: ['Player1', 'Player2'] }, { info: true });
  ok(eng.meter.party === null && !eng.meter.inGroup, 'bilgi-modu setParty parti kurmaz');
  return errors;
}

function inferTests() {
  const errors = []; const ok = mk(errors);
  const c = { t: 1000 };
  const eng = newEngine(c);
  eng.pickOwn(5000, 'elle', 'test');
  eng.meter.setName(5000, 'Player0');
  eng.meter.classes.set(5000, 14);
  // program zindan ortasında açıldı: kadro yok, durum akışı + ilan var; satırlar adsız ("Gladiator #10719")
  eng.combatEvent({ type: 'party', t: c.t, size: 5, dungeon: 600092, members: ['Player0', 'Player1', 'Player2', 'Zero'], memberDetails: [
    { name: 'Player0', globalId: 237513, server: 1301, gearScore: 3000, combatPower: 9e4, cls: 14 },
    { name: 'Player1', globalId: 100001, server: 1301, gearScore: 2800, combatPower: 8e4, cls: 5 },
    { name: 'Player2', globalId: 100002, server: 1302, gearScore: 2700, combatPower: 7e4, cls: 13 },
    { name: 'Zero', globalId: 100003, server: 1301, gearScore: 2600, combatPower: 6e4, cls: 15 }] });
  const st = (db) => { const b = Buffer.alloc(64); b.writeUInt32LE(db, 0); return b; };
  for (const db of [100001, 100002, 100003]) eng.combat.frame(OP.STATE, st(db), c.t);
  ok(eng.group.live && eng.group.via === 'state', 'durum akışı ile parti');
  for (const [id, d] of [[5000, 1000], [10719, 900], [9359, 800], [3685, 700]]) eng.combatEvent({ type: 'damage', t: c.t, actor: id, target: 90001, skill: 14010000, damage: d });
  eng.meter.classes.set(10719, 5); eng.meter.classes.set(9359, 13); eng.meter.classes.set(3685, 15); // sınıflar beceri oylamasıyla bulunur (burada elle)
  const a1 = eng.meter.snapshot(0, { view: 'party', bossView: false }).enc.actors;
  const nm = Object.fromEntries(a1.map((a) => [a.id, a.name]));
  ok(nm[10719] === 'Player1' && nm[9359] === 'Player2' && nm[3685] === 'Zero', 'sınıfı tek aday olan adsız satırlar adlanır: ' + JSON.stringify(nm));
  ok(!a1.some((a) => typeof a.id === 'string'), 'çözülen üye için ayrıca 0 hasarlı sanal satır eklenmez (isim ↔ DPS uyuşmaz hatası)');
  ok(!eng.meter.names.has(10719), 'çıkarım ad haritasına YAZILMAZ (yalnız gösterim)');
  // belirsiz: iki adaylı aynı sınıf → tahmin yok
  const c2 = { t: 1 };
  const e2 = newEngine(c2);
  e2.pickOwn(5000, 'elle', 'test'); e2.meter.setName(5000, 'Player0');
  e2.combatEvent({ type: 'party', t: 1, size: 3, dungeon: 1, members: ['Player0', 'Player1', 'Zero'], memberDetails: [
    { name: 'Player1', globalId: 1, server: 1301, cls: 5 }, { name: 'Zero', globalId: 2, server: 1301, cls: 5 }] });
  for (const db of [1, 2]) e2.combat.frame(OP.STATE, st(db), 1);
  e2.combatEvent({ type: 'damage', t: 1, actor: 5000, target: 90001, skill: 14010000, damage: 100 });
  e2.combatEvent({ type: 'damage', t: 1, actor: 10719, target: 90001, skill: 14010000, damage: 100 });
  e2.meter.classes.set(10719, 5);
  const a2 = e2.meter.snapshot(0, { view: 'party', bossView: false }).enc.actors;
  const r = a2.find((a) => a.id === 10719);
  ok(r && /#10719/.test(r.name), 'aynı sınıftan iki aday → tahmin yapılmaz: ' + (r && r.name));
  return errors;
}

function blacklistFlagTests() {
  const errors = []; const ok = mk(errors);
  const m = /function flagBlacklisted\(enc\) \{[\s\S]*?\n\}\n/.exec(MAIN_SRC);
  ok(!!m, 'main.js flagBlacklisted bulunamadı');
  if (!m) return errors;
  const { Ratings, validate } = req('lib/ratings.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daeva-bl-'));
  try {
    const R = new Ratings(path.join(dir, 'r.json'), path.join(dir, 'yok.json'));
    R.load();
    R.upsert(validate({ targetNickname: 'Zero', server: '1301', rating: 1, tags: ['blacklist'] }).value, 'Ben');
    const settings = { playerRatingsOn: true };
    const flag = new Function('settings', 'getRatings', m[0] + '; return flagBlacklisted;')(settings, () => R);
    const enc = { actors: [
      { id: 1, name: 'Zero', server: 1301 },            // kara listede (ad + sunucu)
      { id: 'p:Zero', name: 'Zero', server: 1301, idle: true }, // sanal satır da bayraklanır
      { id: 2, name: 'Zero', server: 1999 },            // aynı ad başka sunucu: bayrak yok
      { id: 3, name: 'Player1', server: 1301 },
      { id: 4, name: 'Zero', server: 1301, own: true },  // kendi satırımız bayraklanmaz
      { id: 5, name: 'Player #5' },
    ] };
    flag(enc);
    const bl = enc.actors.map((a) => !!a.bl);
    ok(bl.join() === 'true,true,false,false,false,false', 'kara liste bayrağı ad+sunucu: ' + bl.join());
    settings.playerRatingsOn = false;
    flag(enc);
    ok(enc.actors.every((a) => !a.bl), 'puanlama kapalıyken bayrak kalkar');
  } catch (x) {
    errors.push('istisna: ' + (x && x.message));
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  const PANEL = fs.readFileSync(path.join(A, 'ui', 'panel.js'), 'utf8');
  ok(/a\.bl && ratingsOn && !streamerOn\(\)/.test(PANEL), 'panel: bayrak yayıncı modunda gösterilmez, puanlama kapalıyken gösterilmez');
  return errors;
}

module.exports = [
  ['parti: kadro paketi 0x0092/0x2292 çözümü (üye alanları, sid 0, çöp/kesik paket, tekrar)', rosterParseTests],
  ['parti: kadro → oturum kimliği ↔ ad eşlemesi (meter.names, küresel kimlik, sunucu, 0x2292, canavar listesinden çıkış)', rosterNamesTests],
  ['parti: kadro + 0x2036 küresel bağlantı ile kendi oturum kimliği', ownFromRosterTests],
  ['parti: bayat parti temizliği (ayrılma, sanal satır yok, 0x0297 diriltmez, uçuştaki durum paketi)', stalePartyTests],
  ['parti: bölge yüklemesi + 10 sn kadro yok, yalnız-ben kadro, yedek zaman aşımı', zoneNoRosterTests],
  ['parti: "zindandaysa herkes partidir" yalnız gerçek zindan içinde ve çıkışta sıfırlanır', instanceRuleTests],
  ['parti: zindan ortasında açılış (kadro kaçtı): durum akışı + 0x0297 küresel kimlikten ad, kendi durumum parti kurmaz, akış kesilince biter', stateOnlyTests],
  ['parti: auto görünüm (partide yalnız parti, değilse yalnız ben; açık dünya boss yabancıları girmez)', autoViewTests],
  ['parti: parti.json açılışta bayatsa yok sayılır, yüklenen grup üyelik kurmaz', loadPartyTests],
  ['parti: adsız satıra sınıfı tek aday olan ad (yalnız gösterim), belirsizse tahmin yok', inferTests],
  ['parti: sol sayaç kara liste bayrağı (ad+sunucu, sanal satır, kendi satır, kapalıyken yok)', blacklistFlagTests],
];
