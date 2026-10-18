'use strict';
// Kayıtlardan otomatik test: node tools/test.js [kayıt klasörü ...]
// test/beklenen.json'daki her kaydı bulur, motordan geçirir, sonucu beklenenle karşılaştırır.
// Faz 5.0-K.3: kayıtlar akışla, satır satır okunur (.jsonl ve .jsonl.gz); dosyanın tamamı belleğe alınmaz.
const fs = require('fs');
const { forEachJson } = require('./satirlar');
const path = require('path');
const os = require('os');
const { Engine } = require('../lib/engine');

const exp = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'test', 'beklenen.json'), 'utf8'));
const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
const dirs = process.argv.slice(2).length ? process.argv.slice(2) : [
  path.join(__dirname, '..', 'test', 'kayitlar'),
  path.join(appData, 'Daeva Lens', 'kayitlar'),
  path.join(appData, 'Aion2 Cube Overlay', 'kayitlar'),
];

function find(file) {
  for (const d of dirs) {
    const walk = (p, depth) => {
      if (!fs.existsSync(p)) return null;
      if (fs.existsSync(path.join(p, file))) return path.join(p, file);
      if (fs.existsSync(path.join(p, file + '.gz'))) return path.join(p, file + '.gz');
      if (depth > 1) return null;
      for (const e of fs.readdirSync(p, { withFileTypes: true })) if (e.isDirectory()) { const r = walk(path.join(p, e.name), depth + 1); if (r) return r; }
      return null;
    };
    const r = walk(d, 0);
    if (r) return r;
  }
  return null;
}

async function run(file, cd, learned) {
  let clock = 0;
  const timers = [];
  const owns = [], alerts = [];
  const eng = new Engine({
    now: () => clock,
    setTimer: (fn, ms) => { const h = { at: clock + ms, fn }; timers.push(h); return h; },
    clearTimer: (h) => { const i = timers.indexOf(h); if (i >= 0) timers.splice(i, 1); },
    cdConfig: cd || {},
    learned: { ...(learned || {}) },
    onEvent: (e) => {
      if (e.type === 'own') owns.push({ t: clock, id: e.id, why: e.why });
      if (e.type === 'ready' || e.type === 'warn') alerts.push({ t: clock, kind: e.type, name: e.name, why: e.why });
    },
  });
  const runTimers = () => { timers.sort((a, b) => a.at - b.at); while (timers.length && timers[0].at <= clock) timers.shift().fn(); };
  let t0 = null;
  await forEachJson(file, (m) => {
    if (m.type !== 'pkt') return;
    if (t0 === null) t0 = m.t;
    clock = m.t - t0;
    runTimers();
    eng.packet(m);
  });
  clock += 60000; runTimers(); eng.tick();
  return { eng, owns, alerts };
}

let fail = 0, skip = 0, pass = 0;
// Kayıt testleri akışla okunduğu için asenkron; en sonda (birim testlerinden sonra) çalışır.
async function recordingTests() {
for (const k of exp.kayitlar) {
  const f = find(k.file);
  if (!f) { console.log(`ATLANDI  ${k.file} (yerel kayıt gerekli)`); skip++; continue; }
  const { eng, owns, alerts } = await run(f, k.cd, k.learned);
  const errs = [];
  if ('own' in k && eng.ownId !== k.own) errs.push(`kimlik ${eng.ownId}, beklenen ${k.own}`);
  for (const id of k.neverOwn || []) if (owns.some((o) => o.id === id)) errs.push(`#${id} bir an "sen" seçildi`);
  for (const n of k.noAlerts || []) if (alerts.some((a) => a.name === n)) errs.push(`"${n}" uyarısı çaldı: ${alerts.filter((a) => a.name === n).map((a) => (a.t / 1000).toFixed(1) + ' sn ' + a.why).join('; ')}`);
  for (const n of k.alerts || []) if (!alerts.some((a) => a.name === n && a.kind === 'ready')) errs.push(`"${n}" uyarısı çalmadı`);
  for (const [n, want] of Object.entries(k.readyCount || {})) {
    const got = alerts.filter((a) => a.name === n && a.kind === 'ready').length;
    if (got !== want) errs.push(`"${n}" hazır uyarısı ${got} kez, beklenen ${want}`);
  }
  const info = `kimlik ${eng.ownId === null ? '-' : '#' + eng.ownId}${owns.length ? ' (' + owns.map((o) => (o.t / 1000).toFixed(1) + 's→' + o.id).join(', ') + ')' : ''}, uyarı ${alerts.length}`;
  if (errs.length) { fail++; console.log(`HATA     ${k.file}: ${errs.join(' | ')}  [${info}]`); } else { pass++; console.log(`TAMAM    ${k.file}  [${info}]`); }
}
}

// 8) Boss hasarı ve bölünme koruması birim testi
function testBoss() {
  const { Meter } = require('../lib/meter');
  let clock = 1000;
  const m = new Meter({
    now: () => clock,
    idleMs: 8000,
  });

  m.targetInfo = (id) => {
    if (id === 200) return { name: 'Test Boss', code: 9999, boss: true, max: 5000, hp: 3500 };
    return { name: 'Small Mob', code: 1001, boss: false, max: 500, hp: 200 };
  };

  // 1. Oyuncu A küçük yaratığa (id 100) 300 hasar verir.
  m.damage({ t: clock, actor: 1, target: 100, skill: 14010000, damage: 300, crit: false, back: false });

  // 2. A ve B boss'a (id 200) toplam 1000 hasar verir.
  clock += 1000;
  m.damage({ t: clock, actor: 1, target: 200, skill: 14010000, damage: 600, crit: true, back: false });
  clock += 500;
  m.damage({ t: clock, actor: 2, target: 200, skill: 14020000, damage: 400, crit: false, back: false });

  // 3. 10 sn ara verilir → dövüş kapanır.
  clock += 10000;
  m.tick(clock);

  // 4. Aynı boss'a tekrar 500 hasar verilir.
  m.damage({ t: clock, actor: 1, target: 200, skill: 14010000, damage: 500, crit: false, back: false });

  // 5. targetDead(200) çağrılır.
  m.targetDead(200);

  // Ölümden sonra gelen DoT vuruşu (sayılmamalı)
  clock += 200;
  m.damage({ t: clock, actor: 1, target: 200, skill: 14010000, damage: 100, dot: true, crit: false, back: false });

  // Dövüş kapanır
  clock += 10000;
  m.tick(clock);

  const errors = [];
  if (m.bossHistory.length !== 1) errors.push(`bossHistory ${m.bossHistory.length}, beklenen 1`);
  const bh = m.bossHistory[0];
  if (!bh) {
    errors.push('bossHistory[0] boş');
  } else {
    if (bh.bossTotalDamage !== 1500) errors.push(`Boss hasarı ${bh.bossTotalDamage}, beklenen 1500`);
    if (!bh.bossKilled) errors.push('Boss killed false');
  }
  if (m.history.length !== 2) errors.push(`Normal dövüş sayısı ${m.history.length}, beklenen 2`);

  const snap = m.snapshot(0, { boss: 0 });
  if (!snap.enc || !snap.enc.boss) errors.push('Snapshot boss bilgisi eksik');
  else if (snap.enc.boss.total !== 1500) errors.push(`Snapshot boss hasarı ${snap.enc.boss.total}, beklenen 1500`);

  return errors;
}

const bossErrs = testBoss();
if (bossErrs.length) {
  fail++;
  console.log(`HATA     birim: boss testi: ${bossErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: boss hasarı, bölünme koruması ve ölüm  [bossHistory 1, toplam 1500, kesildi ✓]`);
}

function testMidFightBossAndNameDecoder() {
  const errors = [];
  const { decodeGameString, parseOwner } = require('../lib/combat');
  const { Meter } = require('../lib/meter');

  // 1. decodeGameString testi (önek tekrarı içeren metin)
  // "Ab" + \x02 -> "AbAb"
  const buf = Buffer.from([0x41, 0x62, 0x02]);
  const decoded = decodeGameString(buf, 0, 3);
  if (decoded !== 'AbAb') errors.push(`decodeGameString '${decoded}', beklenen 'AbAb'`);

  // 2. 160M HP paketi ve doğma paketi kaçmış boss'un dinamik terfisi
  let clock = 50000;
  const m = new Meter({ skillName: () => 'Skill', now: () => clock, idleMs: 8000 });
  let bossHp = 0;
  m.targetInfo = (id) => {
    if (id === 555) {
      const isBoss = bossHp >= 1000000;
      return { name: isBoss ? 'Lord Storm' : null, code: null, boss: isBoss, max: bossHp, hp: bossHp };
    }
    return { name: 'Mob', code: 1, boss: false, max: 100, hp: 100 };
  };

  // Boss olduğu henüz bilinmiyorken ilk 2 vuruş yapılır (spawn paketi gelmedi)
  m.damage({ t: clock, actor: 10, target: 555, skill: 14010000, damage: 25000, crit: false, back: false });
  m.damage({ t: clock + 200, actor: 11, target: 555, skill: 14020000, damage: 35000, crit: true, back: false });

  // Şimdi 160 milyon can paketi gelir (0x008d ile)
  bossHp = 160000000;
  const ti = m.targetInfo(555);
  m.promoteBoss(555, ti, clock + 300);

  // Vuruşlara devam edilir
  clock += 500;
  m.damage({ t: clock, actor: 10, target: 555, skill: 14010000, damage: 40000, crit: false, back: false });

  const snap = m.snapshot(0, { bossView: true });
  if (!snap.enc || !snap.enc.isBoss) errors.push('Dinamik boss terfisi başarısız (isBoss false)');
  if (!snap.enc.boss) errors.push('Snapshot boss nesnesi yok');
  else {
    if (snap.enc.boss.maxHp !== 160000000) errors.push(`Boss maxHp ${snap.enc.boss.maxHp}, beklenen 160000000`);
    // Geriye dönük ekleme sayesinde: 25000 + 35000 + 40000 = 100000
    if (snap.enc.boss.total !== 100000) errors.push(`Boss toplam hasarı ${snap.enc.boss.total}, beklenen 100000`);
    if (snap.enc.actors.length !== 2) errors.push(`Boss aktör sayısı ${snap.enc.actors.length}, beklenen 2`);
  }

  return errors;
}

const midBossErrs = testMidFightBossAndNameDecoder();
if (midBossErrs.length) {
  fail++;
  console.log(`HATA     birim: 160M HP, kaçan spawn ve isim çözücü: ${midBossErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: 160M HP, kaçan spawn ve isim çözücü  [160M can, geriye dönük 100k hasar, terfi ✓]`);
}

function testSummonMerging() {
  const { Meter } = require('../lib/meter');
  const errors = [];
  let clock = 100000;
  const m = new Meter({ skillName: () => 'Skill', now: () => clock, idleMs: 8000 });
  m.targetInfo = (id) => ({ name: 'Field Boss', code: 999, boss: true, max: 80000000, hp: 80000000 });

  // 1) Elementalist oyuncusu (ID 3052) boss'a vurur
  m.damage({ t: clock, actor: 3052, target: 999, skill: 16010000, damage: 64800, crit: false, back: false });
  // 2) Elementalist'in çağırdığı geçici ruhlar/hizmetkârlar (yüksek ID) vurur
  m.damage({ t: clock + 100, actor: 46316, target: 999, skill: 16020000, damage: 5476, crit: false, back: false });
  m.damage({ t: clock + 200, actor: 90148, target: 999, skill: 10001100, damage: 4323, crit: false, back: false });
  // 3) Başka bir oyuncu (Gladiator 4728) vurur
  m.damage({ t: clock + 300, actor: 4728, target: 999, skill: 11010000, damage: 19102, crit: false, back: false });

  // 4) Cleric oyuncusu ve Kutsal Hizmetkârı
  m.damage({ t: clock + 400, actor: 4000, target: 999, skill: 17010000, damage: 30000, crit: false, back: false });
  m.damage({ t: clock + 450, actor: 60000, target: 999, skill: 17050000, damage: 5000, crit: false, back: false });

  // 5) Sahipsiz öksüz çağrı (alanda oyuncusu yok, tek başına hayalet)
  m.damage({ t: clock + 500, actor: 85000, target: 999, skill: 15050000, damage: 2000, crit: false, back: false });

  const snap = m.snapshot(0, { bossView: true });
  const actors = snap.enc.actors;

  // Aktör sayısı 3 olmalı (Elementalist 3052, Gladiator 4728, Cleric 4000)
  if (actors.length !== 3) {
    errors.push(`Aktör sayısı ${actors.length}, beklenen 3 (Ruhlar ve öksüz hayaletler ayrı satır çıkmamalı)`);
  }
  const ele = actors.find((a) => a.id === 3052);
  if (!ele) {
    errors.push('Elementalist #3052 aktörü bulunamadı');
  } else {
    const expectedDmg = 64800 + 5476 + 4323;
    if (ele.total !== expectedDmg) {
      errors.push(`Elementalist toplam hasarı ${ele.total}, beklenen ${expectedDmg} (ruhların hasarı eklenmeli)`);
    }
  }
  const cle = actors.find((a) => a.id === 4000);
  if (!cle) {
    errors.push('Cleric #4000 aktörü bulunamadı');
  } else {
    if (cle.total !== 35000) {
      errors.push(`Cleric toplam hasarı ${cle.total}, beklenen 35000 (hizmetkâr hasarı eklenmeli)`);
    }
  }
  if (actors.some((a) => a.id === 46316 || a.id === 90148 || a.id === 60000 || a.id === 85000)) {
    errors.push('Geçici çağrı/ruh IDleri aktör listesinde bağımsız görünüyor');
  }

  // --- 2. BÖLÜM: GENEL CANAVAR DÖVÜŞÜ (BOSS DEĞİL, NORMAL CANAVAR / ZİNDAN) ---
  const m2 = new Meter({ skillName: () => 'Skill', now: () => clock, idleMs: 8000 });
  m2.setOwn(1421); // Bizim karakterimiz (Avcı / Ranger)
  m2.setName(1421, 'Player0');
  m2.setName(3052, 'Akrep'); // Elementalist oyuncu
  m2.targetInfo = (id) => ({ name: 'Orman Ayısı', code: 501, boss: false, max: 200000, hp: 200000 });

  // Biz (Player0) ve tuzağımız (ID 75000, Ranger skili 14170000) normal canavara vuruyoruz
  m2.damage({ t: clock + 1000, actor: 1421, target: 501, skill: 14010000, damage: 15000, crit: true, back: false });
  m2.damage({ t: clock + 1100, actor: 75000, target: 501, skill: 14170000, damage: 8000, crit: false, back: false });

  // Elementalist (Akrep) ve çağırdığı ruh (ID 88000) vuruyor
  m2.damage({ t: clock + 1200, actor: 3052, target: 501, skill: 16010000, damage: 20000, crit: false, back: false });
  m2.damage({ t: clock + 1300, actor: 88000, target: 501, skill: 16020000, damage: 4500, crit: false, back: false });

  // Genel dövüş özeti (bossView: false)
  const normSnap = m2.snapshot(0, { bossView: false });
  const normActors = normSnap.enc.actors;

  if (normActors.length !== 2) {
    errors.push(`Genel dövüş aktör sayısı ${normActors.length}, beklenen 2 (Player0 ve Akrep)`);
  }
  const me = normActors.find((a) => a.id === 1421);
  if (!me) {
    errors.push('Genel dövüşte kendi karakterimiz bulunamadı');
  } else if (me.total !== 23000) {
    errors.push(`Player0 toplam hasarı ${me.total}, beklenen 23000 (tuzak hasarı 8000 eklenmeli)`);
  }
  const otherEle = normActors.find((a) => a.id === 3052);
  if (!otherEle) {
    errors.push('Genel dövüşte Akrep (Elementalist) bulunamadı');
  } else if (otherEle.total !== 24500) {
    errors.push(`Akrep toplam hasarı ${otherEle.total}, beklenen 24500 (ruh hasarı 4500 eklenmeli)`);
  }
  if (normActors.some((a) => a.id === 75000 || a.id === 88000)) {
    errors.push('Genel dövüşte tuzak veya ruh IDsi ayrı satır olarak çıktı');
  }

  // --- 3. BÖLÜM (B-12): oyuncunun hasarı başka oyuncuya geçmez, çağrı zinciri kök oyuncuya gider ---
  // kalabalik-karisik.jsonl'daki gerçek durum: adı gelmemiş bir Avcı (#3794) bizim Avcı'mıza,
  // adı gelmemiş 5 Cleric adı bilinen bir Chanter'a ekleniyordu; ruh → ruh → oyuncu zinciri kayboluyordu.
  const m3 = new Meter({ skillName: () => 'Skill', now: () => clock, idleMs: 8000 });
  m3.setOwn(2987); m3.setName(2987, 'Player0');      // biz: Avcı
  m3.setName(12568, 'Fastrill');                     // adı bilinen Chanter
  m3.setName(582, 'Palemasked');                     // adı bilinen Elementalist
  m3.targetInfo = () => ({ name: 'Kalabalık', code: 700, boss: false, max: 9e6, hp: 9e6 });
  const t3 = clock + 5000;
  m3.damage({ t: t3, actor: 2987, target: 700, skill: 14010000, damage: 10000 });
  m3.damage({ t: t3 + 10, actor: 3794, target: 700, skill: 14010000, damage: 30000 });   // adsız başka Avcı
  m3.damage({ t: t3 + 20, actor: 12568, target: 700, skill: 18010000, damage: 5000 });
  m3.damage({ t: t3 + 30, actor: 1386, target: 700, skill: 17010000, damage: 25000 });   // adsız Cleric
  m3.damage({ t: t3 + 40, actor: 582, target: 700, skill: 16010000, damage: 7000 });
  m3.recordSummonCast(582, 16020000, t3 + 50);       // Palemasked ruh çağırdı
  m3.recordSummonCast(92548, 16020000, t3 + 60);     // bir ruhun "çağırma" olayı: sahip adayı OLMAMALI
  m3.damage({ t: t3 + 70, actor: 94360, target: 700, skill: 16020000, damage: 4000 });   // ruh
  m3.setOwner(70001, 70000); m3.setOwner(70000, 582);                                    // eski önbellekte zincir
  m3.damage({ t: t3 + 80, actor: 70001, target: 700, skill: 16020000, damage: 1000 });
  const s3 = m3.snapshot(0, { view: 'all', bossView: false }).enc.actors;
  const tot = (id) => { const a = s3.find((x) => x.id === id); return a ? a.total : null; };
  if (tot(2987) !== 10000) errors.push(`B-12: Player0 ${tot(2987)}, beklenen 10000 (başka Avcının hasarı eklenmemeli)`);
  if (tot(3794) !== 30000) errors.push(`B-12: adsız Avcı #3794 ${tot(3794)}, beklenen 30000 (kendi satırında)`);
  if (tot(12568) !== 5000) errors.push(`B-12: Fastrill ${tot(12568)}, beklenen 5000 (adsız Cleric eklenmemeli)`);
  if (tot(1386) !== 25000) errors.push(`B-12: adsız Cleric #1386 ${tot(1386)}, beklenen 25000`);
  if (tot(582) !== 12000) errors.push(`B-12: Palemasked ${tot(582)}, beklenen 12000 (7000 + ruh 4000 + zincirli ruh 1000)`);
  const sum3 = s3.reduce((x, a) => x + a.total, 0);
  if (sum3 !== 82000) errors.push(`B-12: görünen toplam ${sum3}, beklenen 82000 (kayıp hasar olmamalı)`);
  if (m3.findSummonOwner(3794, null) !== null) errors.push('B-12: oyuncu kimliği (< 20000) çağrı sayıldı');
  if (m3.resolveOwner(94360) !== 582) errors.push(`B-12: ruh 94360 sahibi ${m3.resolveOwner(94360)}, beklenen 582 (başka bir ruh sahip olamaz)`);
  m3.setOwner(80001, 80002); m3.setOwner(80002, 80001);                                   // döngü koruması
  if (m3.resolveOwner(80001) !== null) errors.push('B-12: sahip döngüsünde null beklenirdi');

  return errors;
}

const summonErrs = testSummonMerging();
if (summonErrs.length) {
  fail++;
  console.log(`HATA     birim: çağrı/ruh hasarını sahibine birleştirme ve filtre: ${summonErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: çağrı/ruh hasarını sahibine birleştirme ve filtre  [ruhlar sahibine eklendi, oyuncular birbirine karışmıyor, zincir kök oyuncuda (B-12) ✓]`);
}

function testMedianCooldownLearning() {
  const { Cooldowns, quantizeCooldown } = require('../lib/cooldowns');
  const errors = [];
  let clock = 10000;
  let inCombatState = true;
  const cds = new Cooldowns({ now: () => clock, inCombat: () => inCombatState });

  // 1. Standart 30 sn becerisi (proc ve ortanca testi)
  const base30 = 99010000;
  cds.use(base30, base30, clock, 'kullanım'); // ilk basış

  clock += 30000;
  cds.use(base30, base30, clock, 'kullanım'); // +30s -> learned = 30000
  if (cds.learned[base30] !== 30000) errors.push(`1. aralık sonrası: ${cds.learned[base30]}, beklenen 30000`);

  clock += 30000;
  cds.use(base30, base30, clock, 'kullanım'); // +30s -> learned = 30000
  if (cds.learned[base30] !== 30000) errors.push(`2. aralık sonrası: ${cds.learned[base30]}, beklenen 30000`);

  clock += 6000;
  cds.use(base30, base30, clock, 'kullanım'); // +6s proc/reset -> median = 30000
  if (cds.learned[base30] !== 30000) errors.push(`3. aralık (6s proc) sonrası: ${cds.learned[base30]}, beklenen 30000`);

  clock += 30000;
  cds.use(base30, base30, clock, 'kullanım'); // +30s -> median = 30000
  if (cds.learned[base30] !== 30000) errors.push(`4. aralık sonrası: ${cds.learned[base30]}, beklenen 30000`);

  clock += 7000;
  cds.use(base30, base30, clock, 'kullanım'); // +7s proc/reset -> median = 30000
  if (cds.learned[base30] !== 30000) errors.push(`5. aralık (7s proc) sonrası: ${cds.learned[base30]}, beklenen 30000`);

  // Dövüş dışına çıkış (şehir/gezinme): dövüş biter, 120s sonra basılır
  cds.combatEnd(clock + 10000);
  inCombatState = false;
  clock += 120000;
  cds.use(base30, base30, clock, 'kullanım'); // dövüş dışı basış -> örnek eklenmez, 30000 kalır
  if (cds.learned[base30] !== 30000) errors.push(`Dövüş dışı bekleme (120s) sonrası: ${cds.learned[base30]}, beklenen 30000`);

  // 2. Hızlı beceri ve insan reaksiyonu yuvarlama (18.4s -> 18s)
  inCombatState = true;
  const base18 = 99020000;
  clock += 5000;
  cds.use(base18, base18, clock, 'kullanım');
  clock += 18400; // 18.4 sn (400 ms reaksiyon gecikmesi)
  cds.use(base18, base18, clock, 'kullanım');
  if (cds.learned[base18] !== 18000) errors.push(`Hızlı beceri (18.4s -> 18s) yuvarlama: ${cds.learned[base18]}, beklenen 18000`);

  // 3. Uzun süreli dövüş içi beceri (90s sınırı olmadan 180s limitsiz dinamik ölçüm)
  const longBase = 99030000; // Tabloda olmayan 180s beceri
  clock += 5000;
  cds.use(longBase, longBase, clock, 'kullanım'); // açılış kullanımı
  clock += 181200; // dövüş kesintisiz sürerken 181.2 sn sonra 2. basış
  cds.use(longBase, longBase, clock, 'kullanım');
  if (cds.learned[longBase] !== 180000) errors.push(`Dövüş içi limitsiz dinamik ölçüm: ${cds.learned[longBase]}, beklenen 180000`);

  // Dövüş bitişi ve şehirde 300s sonra basış koruması
  cds.combatEnd(clock + 20000);
  inCombatState = false;
  clock += 300000;
  cds.use(longBase, longBase, clock, 'kullanım');
  if (cds.learned[longBase] !== 180000) errors.push(`Dövüş dışı koruma: ${cds.learned[longBase]}, beklenen 180000`);

  // 4. Bow of Blessing ve resmi taban tablosu doğrulaması (Aion 2 resmi süreleri)
  if (cds.durationOf(14220000).ms !== 120000) errors.push(`Bow of Blessing taban süresi ${cds.durationOf(14220000).ms}, beklenen 120000`);
  if (cds.durationOf(14310000).ms !== 60000) errors.push(`Vaizel taban süresi ${cds.durationOf(14310000).ms}, beklenen 60000`);

  // 5. Pasif / Seviye indirimi adaptasyonu (Supporting Fire taban 90s -> Seviye 15 pasifle 60s'ye düşüş)
  inCombatState = true;
  const suppBase = 14380000; // Supporting Fire (taban 90 sn)
  clock += 5000;
  cds.use(suppBase, suppBase, clock, 'kullanım'); // 1. basış
  clock += 60200; // 60.2 sn sonra 2. basış
  cds.use(suppBase, suppBase, clock, 'kullanım');
  clock += 59800; // 59.8 sn sonra 3. basış (kararlı küme -> 60s onaylanır!)
  cds.use(suppBase, suppBase, clock, 'kullanım');
  if (cds.learned[suppBase] !== 60000) errors.push(`Pasif indirimi öğrenme: ${cds.learned[suppBase]}, beklenen 60000`);
  const suppDur = cds.durationOf(suppBase);
  if (suppDur.ms !== 60000 || suppDur.src !== 'pasif/öğrenildi') {
    errors.push(`Pasif indirimi önceliği: ${suppDur.ms} (${suppDur.src}), beklenen 60000 (pasif/öğrenildi)`);
  }

  return errors;
}

const cdLearnErrs = testMedianCooldownLearning();
if (cdLearnErrs.length) {
  fail++;
  console.log(`HATA     birim: bekleme süresi dövüş içi limitsiz ölçüm ve yuvarlama: ${cdLearnErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: dövüş içi limitsiz ölçüm (Bow of Blessing 180s, 18.4s->18s, dövüş dışı koruma) ✓`);
}

function testUniversalClassesAndPlayer() {
  const fs = require('fs');
  const path = require('path');
  const { Engine } = require('../lib/engine');
  const { Cooldowns } = require('../lib/cooldowns');
  const I18N = require('../ui/i18n');
  const errors = [];

  // 1. Sınıf ikonları varlığı (10.png - 19.png)
  for (let cls = 10; cls <= 19; cls++) {
    const iconPath = path.join(__dirname, '..', 'assets', 'classes', `${cls}.png`);
    if (!fs.existsSync(iconPath)) {
      errors.push(`Sınıf ikonu eksik: assets/classes/${cls}.png`);
    }
  }

  // 2. Çok sınıflı bekleme süreleri tablosu kontrolü
  const cds = new Cooldowns();
  const checks = [
    { base: 11010000, expectedMs: 10000, name: 'Gladiator Rending Blow' },
    { base: 12190000, expectedMs: 120000, name: 'Templar Second Skin' },
    { base: 13180000, expectedMs: 120000, name: 'Assassin Shadow Walk' },
    { base: 14010000, expectedMs: 20000, name: 'Ranger Deadshot' },
    { base: 15010000, expectedMs: 12000, name: 'Sorcerer Flame Scattershot' },
    { base: 16200000, expectedMs: 60000, name: 'Elementalist Defiance' },
    { base: 17240000, expectedMs: 60000, name: 'Cleric Defiance' },
    { base: 18440000, expectedMs: 180000, name: 'Chanter Barrier Spell' },
    { base: 19130000, expectedMs: 60000, name: 'Brawler Rampage' },
    { base: 101600, expectedMs: 60000, name: 'Spirit Protection' },
  ];

  for (const c of checks) {
    const d = cds.durationOf(c.base);
    if (d.ms !== c.expectedMs || d.src !== 'varsayılan') {
      errors.push(`${c.name} (${c.base}) süresi ${d.ms} (${d.src}), beklenen ${c.expectedMs} (varsayılan)`);
    }
  }

  // 3. Sıfır kurulum / Evrensel dinamik kimlik ve karakter adı sahiplenme testi
  let clock = 50000;
  const engine = new Engine({
    now: () => clock,
    charName: null, // İlk kez kuran yeni kullanıcı: ayarlarında hiçbir isim yok
  });

  // Kullanıcı (Büyücü / Sorcerer) tuşa basar, giden istek çerçevesi çıkar
  // 4 ardışık eşleşme ile OwnTracker kimliği seçer
  const myActorId = 7777;
  for (let i = 0; i < 4; i++) {
    clock += 1000;
    engine.owner.outFrame(clock - 50, 48); // 48 baytlık istek
    engine.combatEvent({ type: 'cast', actor: myActorId, skill: 15010000, kind: 2, t: clock });
  }

  if (engine.ownId !== myActorId) {
    errors.push(`Otomatik kimlik eşleşmedi: ${engine.ownId}, beklenen ${myActorId}`);
  }

  // Sunucudan oyuncu ad paketi gelir (0x4536)
  clock += 100;
  engine.combatEvent({ type: 'name', id: myActorId, name: 'Archmage' });

  if (engine.charName !== 'Archmage') {
    errors.push(`Karakter adı dinamik atanmadı: '${engine.charName}', beklenen 'Archmage'`);
  }
  if (engine.meter.names.get(myActorId) !== 'Archmage') {
    errors.push(`Meter isim kaydı uyuşmadı: '${engine.meter.names.get(myActorId)}', beklenen 'Archmage'`);
  }
  if (engine.meter.classes.get(myActorId) !== 15) {
    errors.push(`Oyuncu sınıfı tespit edilemedi: ${engine.meter.classes.get(myActorId)}, beklenen 15 (Sorcerer)`);
  }

  // 4. Sınıf Türkçe çevirileri
  I18N.setLang('tr');
  if (I18N.t('Gladiator') !== 'Gladyatör') errors.push('Gladiator TR çevirisi eksik');
  if (I18N.t('Templar') !== 'Muhafız') errors.push('Templar TR çevirisi eksik');
  if (I18N.t('Npcap is required. Install it from npcap.com') === 'Npcap is required. Install it from npcap.com') errors.push('Npcap uyarısı TR çevirisi eksik');
  if (I18N.t('Sorcerer') !== 'Büyücü') errors.push('Sorcerer TR çevirisi eksik');
  if (I18N.t('Cleric') !== 'Rahip') errors.push('Cleric TR çevirisi eksik');
  if (I18N.t('Chanter') !== 'Ozan') errors.push('Chanter TR çevirisi eksik');
  I18N.setLang('en');

  return errors;
}

const univErrs = testUniversalClassesAndPlayer();
if (univErrs.length) {
  fail++;
  console.log(`HATA     birim: evrensel sınıf desteği (10 sınıf, dinamik nickname ve tak-çalıştır): ${univErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: evrensel sınıf ve oyuncu desteği (10 sınıf, dinamik nickname, tak-çalıştır) ✓`);
}

function testActorMigrationAndDeduplication() {
  const { Meter } = require('../lib/meter');
  const errors = [];
  let clock = 1000;
  const m = new Meter({
    skillName: () => 'Skill',
    now: () => clock,
    idleMs: 8000,
  });
  m.charName = 'Player0';
  m.setParty({ size: 3, dungeon: 1, members: ['Player0', 'Player3', 'Player4'] });

  // 1. Dövüş başlar: Kullanıcı eski ID 9327 ile vurur (2,243 hasar)
  m.setOwn(9327);
  m.setName(9327, 'Player0');
  m.damage({ t: clock, actor: 9327, target: 99, skill: 14010000, damage: 2243, crit: false, back: false });

  // 2. Diğer oyuncu (Player3) vurur (11,104 hasar)
  m.setName(5555, 'Player3');
  m.damage({ t: clock + 500, actor: 5555, target: 99, skill: 14020000, damage: 11104, crit: true, back: false });

  // 3. Parti üyesi Player4 ilk ID 7701 ile vurur (167,500 hasar)
  m.setName(7701, 'Player4');
  m.damage({ t: clock + 600, actor: 7701, target: 99, skill: 15010000, damage: 167500, crit: false, back: false });

  // 4. Bölge geçişi / dirilme: Karakter ID 14808 olur
  clock += 1000;
  m.setOwn(14808);
  m.setName(14808, 'Player0');

  // 5. Player4 de dirilip yeni ID 7702 alır ve vurur (144,300 hasar)
  m.setName(7702, 'Player4');
  m.damage({ t: clock + 200, actor: 7702, target: 99, skill: 15020000, damage: 144300, crit: true, back: false });

  // 6. Yeni ID ile kullanıcı vurmaya devam eder (11,015 hasar)
  m.damage({ t: clock + 300, actor: 14808, target: 99, skill: 14030000, damage: 11015, crit: false, back: false });

  // Snapshot al ve kontrol et
  const snap = m.snapshot(0, { view: 'party' });
  const actors = snap.enc.actors;

  // Aktör sayısı kesinlikle 3 olmalı (Player0, Player3, Player4; mükerrer satır olmamalı)
  if (actors.length !== 3) {
    errors.push(`Aktör sayısı ${actors.length}, beklenen 3 (mükerrer Player0 ve Player4 engellenmeli)`);
  }

  const player0 = actors.find((a) => a.own || a.name === 'Player0');
  if (!player0) {
    errors.push('Player0 aktörü bulunamadı');
  } else {
    const expectedDmg = 2243 + 11015; // 13258
    if (player0.total !== expectedDmg) {
      errors.push(`Player0 toplam hasarı ${player0.total}, beklenen ${expectedDmg} (eski ID hasarı yeniye eklenmeli)`);
    }
    if (!player0.own) {
      errors.push('Player0 aktöründe own: true olmalı');
    }
  }

  const lynx = actors.find((a) => a.name === 'Player4');
  if (!lynx) {
    errors.push('Player4 aktörü bulunamadı');
  } else {
    const expectedLynxDmg = 167500 + 144300; // 311800
    if (lynx.total !== expectedLynxDmg) {
      errors.push(`Player4 toplam hasarı ${lynx.total}, beklenen ${expectedLynxDmg}`);
    }
  }

  const lynxDuplicates = actors.filter((a) => a.name === 'Player4');
  if (lynxDuplicates.length > 1) {
    errors.push(`Player4 adında ${lynxDuplicates.length} adet aktör çıktı (1 olmalı)`);
  }

  const duplicates = actors.filter((a) => a.name === 'Player0' || (a.name && a.name.includes('Player0')));
  if (duplicates.length > 1) {
    errors.push(`Player0 adında ${duplicates.length} adet aktör çıktı (1 olmalı)`);
  }

  return errors;
}

const migErrs = testActorMigrationAndDeduplication();
if (migErrs.length) {
  fail++;
  console.log(`HATA     birim: kimlik değişimi ve mükerrer oyuncu engelleme: ${migErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: kimlik değişimi / dirilmede aktör birleştirme ve çift isim engelleme ✓`);
}

function testCooldownsRefreshAndForeignFiltering() {
  const { Cooldowns } = require('../lib/cooldowns');
  const errors = [];
  let clock = 50000;
  const cds = new Cooldowns({ now: () => clock, ownClass: 14 });

  // 1. Yabancı sınıf filtreleme (Avcı 14 iken Ozan 18, Ruh 16 veya Gladyatör 11 eklenmemeli)
  cds.cast({ own: true, skill: 18160002, kind: 0, t: clock });
  cds.cast({ own: true, skill: 16780002, kind: 2, t: clock });
  cds.damage({ own: true, skill: 11340028, damage: 1000, t: clock });

  if (cds.skills.has(18160000)) errors.push('Ozan mantrası (18160000) Cooldowns listesine sızdı');
  if (cds.skills.has(16780000)) errors.push('Ruh yeteneği (16780000) Cooldowns listesine sızdı');
  if (cds.skills.has(11340000)) errors.push('Gladyatör yeteneği (11340000) Cooldowns listesine sızdı');

  // 2. Kendi sınıf yeteneklerimiz sorunsuz eklenmeli
  cds.cast({ own: true, skill: 14020340, kind: 2, t: clock }); // Snipe (aktif)
  cds.cast({ own: true, skill: 14720007, kind: 0, t: clock }); // Concentrated Fire (pasif)

  if (!cds.skills.has(14020000)) errors.push('Avcı Snipe (14020000) listeye eklenemedi');
  if (!cds.skills.has(14720000)) errors.push('Avcı Concentrated Fire (14720000) listeye eklenemedi');

  // 3. Pasif ayrımı
  const list = cds.list();
  const snipe = list.find((s) => s.base === 14020000);
  const passive = list.find((s) => s.base === 14720000);
  if (!snipe || snipe.passive !== false) errors.push('Snipe passive: false olmalıydı');
  if (!passive || passive.passive !== true) errors.push('Concentrated Fire passive: true olmalıydı');

  // 4. Akıllı sıralama (en erken açılacak olan en başta)
  const c1 = { base: 14020000, readyAt: clock + 5000, name: 'Snipe' };
  const c2 = { base: 14010000, readyAt: clock + 18000, name: 'Deadshot' };
  const c3 = { base: 14110000, readyAt: 0, name: 'Gale Arrow' };
  const testList = [c3, c2, c1];
  const sorted = [...testList].sort((a, b) => {
    const leftA = a.readyAt && a.readyAt > clock ? a.readyAt - clock : 0;
    const leftB = b.readyAt && b.readyAt > clock ? b.readyAt - clock : 0;
    if (leftA > 0 && leftB > 0) return leftA - leftB;
    if (leftA > 0) return -1;
    if (leftB > 0) return 1;
    return 0;
  });
  if (sorted[0].base !== 14020000 || sorted[1].base !== 14010000 || sorted[2].base !== 14110000) {
    errors.push(`Akıllı sıralama hatalı: ${sorted.map((s) => s.name).join(' -> ')}`);
  }

  return errors;
}

const cdFilterErrs = testCooldownsRefreshAndForeignFiltering();
if (cdFilterErrs.length) {
  fail++;
  console.log(`HATA     birim: yabancı sınıf filtresi, pasif ayrımı ve akıllı sıralama: ${cdFilterErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: yabancı sınıf filtresi, pasif ayrımı ve akıllı sıralama ✓`);
}

function testFakeBossProtectionAndInstantOwner() {
  const { Meter } = require('../lib/meter');
  const { OwnTracker } = require('../lib/owner');
  const errors = [];
  let clock = 100000;

  // 1. Antrenman kuklası (Training Scarecrow) koruması: 2.5M hasarda dahi boss olmamalı
  const m = new Meter({ skillName: () => 'Skill', now: () => clock, idleMs: 8000 });
  m.targetInfo = (id) => {
    if (id === 777) return { name: 'Training Scarecrow', code: 30435, boss: false, max: 5000000, hp: 5000000 };
    return { name: 'Mob', code: 1, boss: false, max: 100, hp: 100 };
  };

  m.damage({ t: clock, actor: 2987, target: 777, skill: 14010000, damage: 1200000, crit: false, back: false });
  m.damage({ t: clock + 500, actor: 2987, target: 777, skill: 14020000, damage: 1300000, crit: true, back: false });

  const snap = m.snapshot(0);
  if (snap.enc && snap.enc.isBoss) {
    errors.push('Training Scarecrow sahte boss olarak işaretlendi (isBoss true olmamalıydı)');
  }
  if (m.bossHistory.length > 0) {
    errors.push(`Scarecrow boss geçmişine eklendi (uzunluk ${m.bossHistory.length})`);
  }

  // 2. İlk vuruşta anında kimlik tespiti (OwnTracker)
  let pickedOwn = null;
  const tracker = new OwnTracker({
    onPick: (id) => { pickedOwn = id; },
    onDiag: () => {},
    isOther: () => false,
  });

  // Giden istek çerçevesi (boyut 55 bayt)
  tracker.outFrame(clock + 10, 55);
  // 60ms sonra gelen beceri kullanımı (0x0238 tür 2)
  tracker.cast(2987, 14010000, clock + 70);

  if (pickedOwn !== 2987) {
    errors.push(`İlk vuruşta kimlik hemen sahiplenilemedi (pickedOwn: ${pickedOwn}, beklenen 2987)`);
  }

  return errors;
}

function testStrictOwnerSeparation() {
  const errors = [];
  const eng = new Engine({
    charName: 'Player0',
    now: () => 1000,
  });

  // 1. Başka bir oyuncunun isim paketi geliyor (Player7, ID: 5555)
  eng.combatEvent({ type: 'name', id: 5555, name: 'Player7' });

  // 2. Player7 beceri kullanıyor ve giden paket denk geliyor
  eng.owner.outFrame(1010, 55);
  eng.owner.cast(5555, 14010000, 1070);

  if (eng.ownId === 5555) {
    errors.push('Farklı isimli oyuncu (Player7) yanlışlıkla kendi karakterimiz (Player0) sanıldı');
  }

  // 3. İsimsiz bir oyuncu (ID: 6666) kazara eşleşti diyelim; sonradan ismi 'Arthur' geldiğinde sahiplik bırakılmalı
  eng.ownId = 6666;
  eng.owner.own = 6666;
  eng.combatEvent({ type: 'name', id: 6666, name: 'Arthur' });

  if (eng.ownId === 6666) {
    errors.push('Gerçek adı Arthur olan oyuncunun ismi geldiğinde sahiplik bırakılmadı');
  }

  // 4. Doğru isimli karakterimiz (Player0, ID: 7777) geldiğinde hemen sahiplenilmeli
  eng.combatEvent({ type: 'name', id: 7777, name: 'Player0' });
  if (eng.ownId !== 7777) {
    errors.push(`Kayıtlı karakterimiz Player0 geldiğinde sahiplenilmedi (ownId: ${eng.ownId})`);
  }

  return errors;
}

const fakeBossErrs = testFakeBossProtectionAndInstantOwner();
if (fakeBossErrs.length) {
  fail++;
  console.log(`HATA     birim: sahte boss koruması ve anında kimlik tespiti: ${fakeBossErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: sahte boss koruması (scarecrow) ve anında kimlik tespiti ✓`);
}

const sepErrs = testStrictOwnerSeparation();
if (sepErrs.length) {
  fail++;
  console.log(`HATA     birim: kesin yabancı oyuncu ayrımı ve isim koruması: ${sepErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: kesin yabancı oyuncu ayrımı ve isim koruması (asla başkasına You denmez) ✓`);
}

function testPersistentMobsCacheAndHpSignature() {
  const { MobsCache } = require('../lib/mobs-cache');
  const errors = [];
  // B-25: geçici dosya proje klasörüne değil sistemin geçici klasörüne yazılır
  const tempDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'daeva-test-'));
  const tempFile = path.join(tempDir, 'temp-canavarlar-test.json');

  try {
    if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
  } catch {}

  const cache = new MobsCache(tempFile, { saveDebounceMs: 10, loadDefaults: false });

  // 1. Eşleşme ve öğrenme
  cache.learn(3099901, { name: 'Kromede the Corrupt', maxHp: 80000000, boss: true });
  const byCode = cache.findByCode(3099901);
  if (!byCode || byCode.name !== 'Kromede the Corrupt' || byCode.maxHp !== 80000000 || !byCode.boss) {
    errors.push('findByCode doğru kayıt döndürmedi');
  }

  // 2. Benzersiz HP imzası doğrulaması
  const byHp = cache.findByHp(80000000);
  if (!byHp || byHp.name !== 'Kromede the Corrupt') {
    errors.push('findByHp 80M benzersiz can imzasından Kromede the Corrupt bulamadı');
  }

  // 3. Çakışma koruması (Aynı HP'ye sahip iki farklı boss)
  cache.learn(3099902, { name: 'Fire Temple Boss Alpha', maxHp: 15000000, boss: true });
  cache.learn(3099903, { name: 'Fire Temple Boss Beta', maxHp: 15000000, boss: true });
  const conflictMatch = cache.findByHp(15000000);
  if (conflictMatch !== null) {
    errors.push(`Aynı 15M HP'ye sahip iki boss varken çakışma koruması çalışmadı (beklenen null, dönen: ${conflictMatch.name})`);
  }

  // 4. Can imzasıyla "Target" kurtarma (Spawn paketi kaçmış mob)
  const eng = new Engine({ mobsCache: cache, now: () => 1000 });

  // Varlık 4444 için spawn gelmedi, sadece HP paketi geldi (80.000.000)
  eng.combatEvent({ type: 'hp', id: 4444, hp: 80000000, t: 1000 });
  const ti1 = eng.meter.targetInfo(4444);
  if (!ti1 || ti1.name !== 'Kromede the Corrupt' || !ti1.boss) {
    errors.push(`Spawn kaçan 80M boss için isim Kromede the Corrupt olmalıydı (çıkan: ${ti1 ? ti1.name : 'null'})`);
  }

  // 5. Çakışan canda güvenli "Boss" adı basılması (asla yanlış isim tahmin edilmemeli)
  eng.combatEvent({ type: 'hp', id: 5555, hp: 15000000, t: 1000 });
  const ti2 = eng.meter.targetInfo(5555);
  if (!ti2 || ti2.name !== 'Boss' || !ti2.boss) {
    errors.push(`Çakışan 15M HP için güvenli Boss adı gösterilmeliydi (çıkan: ${ti2 ? ti2.name : 'null'})`);
  }

  // 6. Antrenman korkuluğu (Dummy) asla boss olmamalı
  eng.combatEvent({ type: 'spawn', id: 6666, code: 2000000, maxHp: 15000000, t: 1000 });
  const ti3 = eng.meter.targetInfo(6666);
  if (!ti3 || ti3.boss !== false || ti3.dummy !== true) {
    errors.push(`Antrenman kuklası (Punching Bag) boss sayılmamalıydı (boss: ${ti3 ? ti3.boss : 'null'})`);
  }

  // 7. Mükerrer ölüm engelleme: hp=0, owner ve death üst üste gelse de canavar kaydı bozulmamalı
  eng.combatEvent({ type: 'spawn', id: 7777, code: 3099901, maxHp: 80000000, t: 1000 });
  eng.combatEvent({ type: 'hp', id: 7777, hp: 0, t: 1001 });
  eng.combatEvent({ type: 'owner', id: 7777, owner: 9999, name: 'Looter', t: 1002 });
  eng.combatEvent({ type: 'death', id: 7777, t: 1003 });

  const deadMob = cache.findByCode(3099901);
  if (!deadMob || deadMob.name !== 'Kromede the Corrupt' || deadMob.maxHp !== 80000000) {
    errors.push(`Ölüm sonrası canavar kaydı bozuldu (çıkan: ${deadMob ? deadMob.name : 'null'})`);
  }
  if (eng.kills.markDead(7777) !== null) {
    errors.push('Aynı varlığın ikinci ölümü engellenmedi');
  }

  // 8. Kullanıcı arayüzünden isim değiştirme (setMobName / forceName)
  eng.setMobName(3099901, 'Kromede the Awakened');
  const renamedMob = cache.findByCode(3099901);
  if (!renamedMob || renamedMob.name !== 'Kromede the Awakened') {
    errors.push(`setMobName ile isim güncellenemedi (çıkan: ${renamedMob ? renamedMob.name : 'null'})`);
  }

  // 9. Kalıcı diske yazma ve yeni yükleme doğrulaması
  cache.saveSync();
  if (!fs.existsSync(tempFile)) {
    errors.push('canavarlar.json dosyası diske kaydedilmedi');
  } else {
    const loaded = new MobsCache(tempFile, { loadDefaults: false });
    const loadedMob = loaded.findByCode(3099901);
    if (!loadedMob || loadedMob.name !== 'Kromede the Awakened' || loadedMob.maxHp !== 80000000) {
      errors.push(`Diskten yüklenen MobsCache kaydı hatalı (çıkan: ${loadedMob ? loadedMob.name : 'null'})`);
    }
    const loadedHp = loaded.findByHp(80000000);
    if (!loadedHp || loadedHp.name !== 'Kromede the Awakened') {
      errors.push('Diskten yüklenen HP imzası hatalı');
    }
  }

  // 10. Kanal 3: Dahili default-mobs-cache.json yükleme doğrulaması (1331+ boss)
  const defaultCache = new MobsCache(null, { loadDefaults: true });
  const octa = defaultCache.findByHp(114737);
  if (!octa || octa.name !== 'Blue Core Octaside') {
    errors.push('Dahili önbellekten Blue Core Octaside (114737 HP) yüklenemedi');
  }
  const teegant = defaultCache.findByCode(2100079);
  if (!teegant || !teegant.boss || teegant.maxHp !== 160000000) {
    errors.push('Dahili önbellekten Bodyguard Teegant (160M HP) yüklenemedi');
  }

  // B-16b: diske sadece dahili veritabanından farklı kayıtlar, girintisiz yazılır
  const diffFile = path.join(tempDir, 'fark.json');
  const withDefaults = new MobsCache(diffFile, { saveDebounceMs: 10, loadDefaults: true });
  const defCount = withDefaults.byCode.size;
  withDefaults.learn(3099905, { name: 'Yeni Öğrenilen Canavar', maxHp: 123456, boss: false });
  withDefaults.learn(2100079, { name: 'Bodyguard Teegant (yeni ad)', forceName: true });
  withDefaults.saveSync();
  const written = JSON.parse(fs.readFileSync(diffFile, 'utf8'));
  const writtenCodes = Object.keys(written.byCode);
  if (writtenCodes.length !== 2) errors.push(`B-16b: diske ${writtenCodes.length} kayıt yazıldı, beklenen 2 (sadece farklar)`);
  if (fs.readFileSync(diffFile, 'utf8').includes('\n  ')) errors.push('B-16b: dosya girintili yazılmış');
  const reloaded = new MobsCache(diffFile, { loadDefaults: true });
  if (reloaded.byCode.size !== defCount + 1) errors.push(`B-16b: yeniden yüklemede ${reloaded.byCode.size} kayıt, beklenen ${defCount + 1}`);
  const tg = reloaded.findByCode(2100079);
  if (!tg || tg.name !== 'Bodyguard Teegant (yeni ad)' || tg.maxHp !== 160000000) errors.push('B-16b: değiştirilen dahili kayıt geri yüklenemedi');

  cache.dispose();
  withDefaults.dispose();
  try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch {}

  return errors;
}

const mobCacheErrs = testPersistentMobsCacheAndHpSignature();
if (mobCacheErrs.length) {
  fail++;
  console.log(`HATA     birim: kalıcı canavar/boss önbelleği ve HP imzası: ${mobCacheErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: kalıcı canavar/boss önbelleği, HP imzası ve çakışma koruması ✓`);
}

function testIdea1SelfOrPartyEngagement() {
  const { Meter } = require('../lib/meter');
  const errors = [];
  let clock = 10000;
  const m = new Meter({
    skillName: () => 'Skill',
    now: () => clock,
    idleMs: 8000,
    bossIdleMs: 45000,
    charName: 'Player0',
  });
  m.setOwn(1000);
  m.setName(1000, 'Player0');
  m.setParty({ size: 2, dungeon: 0, members: ['Player0', 'Player2'] });
  m.setName(2000, 'Player2');
  m.targetInfo = (id) => {
    if (id === 8888) return { name: 'Rotten Kutar', code: 2100888, boss: true, max: 76600000, hp: 76600000 };
    return null;
  };

  // 1. Yabancı oyuncu (9999) Rotten Kutar'a vuruyor
  m.damage({ t: clock, actor: 9999, target: 8888, skill: 14010000, damage: 50000, crit: false, back: false });
  clock += 10000;
  m.damage({ t: clock, actor: 9999, target: 8888, skill: 14020000, damage: 60000, crit: false, back: false });

  // Dövüş başlamamalı! m.cur null olmalı
  if (m.cur !== null) {
    errors.push('Yabancı vuruşunda dövüş başladı (m.cur null olmalıydı)');
  }

  // 2. Biz (Player0, 1000) boss'a ilk vuruşumuzu yapıyoruz (clock = 25000)
  clock = 25000;
  m.damage({ t: clock, actor: 1000, target: 8888, skill: 14010000, damage: 100000, crit: true, back: false });

  if (!m.cur) {
    errors.push('Kendi vuruşumuzda dövüş başlamadı');
  } else {
    if (!m.cur.isBoss) errors.push('Kendi vuruşumuzda boss terfi etmedi');
    if (m.cur.bossName !== 'Rotten Kutar') errors.push(`Boss adı yanlış: ${m.cur.bossName}`);
    if (m.cur.bossFirst !== 25000) errors.push(`Boss başlangıç süresi yanlış: ${m.cur.bossFirst}, beklenen 25000`);

    const snap = m.snapshot(0, { view: 'party' });
    if (!snap.enc || !snap.enc.boss) {
      errors.push('Party görünümünde boss özeti eksik');
    } else {
      if (snap.enc.boss.name !== 'Rotten Kutar') errors.push(`Snapshot boss adı: ${snap.enc.boss.name}`);
      // gerçek vuranlar (yalnız biz) ve hasar vurmayan parti üyesinin sanal satırı ayrı doğrulanır
      const hitters = snap.enc.actors.filter((a) => !a.idle);
      const idle = snap.enc.actors.filter((a) => a.idle);
      if (hitters.length !== 1 || hitters[0].name !== 'Player0') {
        errors.push(`Party aktörleri hatalı: ${JSON.stringify(hitters)}`);
      }
      if (idle.length !== 1 || idle[0].name !== 'Player2' || idle[0].total !== 0 || idle[0].id !== 'p:Player2') {
        errors.push(`Hasarsız parti satırı hatalı: ${JSON.stringify(idle)}`);
      }
    }
  }

  // 3. Parti üyemiz (Player2, 2000) vuruyor
  clock += 5000;
  m.damage({ t: clock, actor: 2000, target: 8888, skill: 11010000, damage: 120000, crit: false, back: false });
  const partySnap = m.snapshot(0, { view: 'party' });
  if (partySnap.enc.actors.length !== 2 || partySnap.enc.actors.some((a) => a.idle)) {
    errors.push(`Parti üyesi vuruşu sonrasında aktör sayısı ${partySnap.enc.actors.length}, beklenen 2 (sanal satır kalmamalı)`);
  }

  // 4. Biz ve partimiz vurmayı bırakıyoruz, 46 saniye sonra yabancılar vurmaya devam ediyor
  clock += 46000;
  m.damage({ t: clock, actor: 9999, target: 8888, skill: 14010000, damage: 40000, crit: false, back: false });

  if (m.cur !== null) {
    errors.push('Parti vuruşu kesildikten 45s sonra dövüş bitmedi (yabancı vuruşu dövüşü açık tuttu)');
  }
  if (m.bossHistory.length !== 1) {
    errors.push(`Boss geçmişine kaydedilmedi (bossHistory: ${m.bossHistory.length})`);
  }

  return errors;
}

const idea1Errs = testIdea1SelfOrPartyEngagement();
if (idea1Errs.length) {
  fail++;
  console.log(`HATA     birim: Fikir 1 (biz/parti vurmadan dövüş ve sayaç başlamasın): ${idea1Errs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: Fikir 1 (biz/parti vurmadan dövüş ve sayaç başlamasın, yabancı vuruşları sayacı açmaz/uzatmaz) ✓`);
}

// Hasar vurmayan parti üyeleri: süren dövüşte sanal "hasar 0" satırı (yalnız snapshot çıktısında), çift satır yok
function testIdlePartyRows() {
  const { Meter } = require('../lib/meter');
  const errors = [];
  let clock = 10000;
  const m = new Meter({ skillName: () => 'Skill', now: () => clock, idleMs: 8000, bossIdleMs: 45000 });
  // kendi adımız bilinmiyor (ad paketi yok, karakter adı ayarı yok): kimlik 1000, sınıf 14
  m.setOwn(1000);
  m.setName(2000, 'Ally');
  m.setParty({ size: 3, dungeon: 0, members: ['Player0', 'Ally', 'Idle1'], memberDetails: [
    { name: 'Player0', cls: 14, server: 1301 }, { name: 'Ally', cls: 12, server: 1301 }, { name: 'Idle1', cls: 17, server: 2301 },
  ] });
  m.damage({ t: clock, actor: 1000, target: 8888, skill: 14010000, damage: 100000, crit: false, back: false });
  m.classes.set(1000, 14);
  clock += 1000;
  m.damage({ t: clock, actor: 2000, target: 8888, skill: 11010000, damage: 50000, crit: false, back: false });
  m.classes.set(1000, 14);
  const s = m.snapshot(0, { view: 'all' });
  const acts = (s.enc && s.enc.actors) || [];
  const names = acts.map((a) => a.name);
  const own = acts.filter((a) => a.own);
  if (own.length !== 1 || own[0].id !== 1000 || own[0].name !== 'Player0') errors.push(`kendi satırı parti listesinden adlanmadı / çift: ${JSON.stringify(own.map((a) => [a.id, a.name]))}`);
  if (acts.some((a) => a.id === 'p:Player0')) errors.push('kendi karakter için ayrıca sanal satır eklendi (çift)');
  if (acts.some((a) => a.id === 'p:Ally') || names.filter((n) => n === 'Ally').length !== 1) errors.push('vuran parti üyesi çift eklendi');
  const idle = acts.find((a) => a.id === 'p:Idle1');
  if (!idle || !idle.idle || idle.total !== 0 || idle.dps !== 0 || idle.name !== 'Idle1' || idle.cls !== 17 || idle.server !== 2301 || idle.own || (idle.skills || []).length) {
    errors.push(`sanal satır hatalı: ${JSON.stringify(idle)}`);
  }
  if (acts.length !== 3) errors.push(`satır sayısı ${acts.length}, beklenen 3: ${names.join(',')}`);
  const sp = m.snapshot(0, { view: 'party' });
  if (!sp.enc || !sp.enc.actors.some((a) => a.id === 'p:Idle1')) errors.push('parti görünümünde sanal satır yok');
  const sm = m.snapshot(0, { view: 'me' });
  if (!sm.enc || sm.enc.actors.some((a) => a.idle) || sm.enc.actors.length !== 1) errors.push('"me" görünümünde sanal satır var');
  if ([...m.cur.actors.keys()].some((k) => typeof k === 'string')) errors.push('sanal satır dövüş kaydına (e.actors) sızdı');

  // belirsiz: aynı sınıftan adı görülmemiş iki üye → kendi satırı adlanmaz, ikisi de sanal eklenmez (biri biz olabiliriz)
  m.setParty({ size: 4, dungeon: 0, members: ['Player0', 'Twin', 'Ally', 'Idle1'], memberDetails: [
    { name: 'Player0', cls: 14 }, { name: 'Twin', cls: 14 }, { name: 'Ally', cls: 12 }, { name: 'Idle1', cls: 17 },
  ] });
  const sa = m.snapshot(0, { view: 'all' }).enc.actors;
  const ownA = sa.find((a) => a.id === 1000);
  if (!ownA || !ownA.own || ownA.name === 'Player0' || ownA.name === 'Twin') errors.push(`belirsiz durumda kendi satırı tahminle adlandı: ${ownA && ownA.name}`);
  if (sa.some((a) => a.id === 'p:Player0' || a.id === 'p:Twin')) errors.push('belirsiz durumda kendi sınıfımızdaki üyeler sanal eklendi (çift olabilir)');
  if (!sa.some((a) => a.id === 'p:Idle1')) errors.push('belirsiz durumda başka sınıftaki üye eklenmedi');

  // karakter adı ayarlı: kendi adımız sanal satır olmaz (kendi satırı zaten var)
  m.setCharName('Player0');
  const sc = m.snapshot(0, { view: 'all' }).enc.actors;
  if (sc.filter((a) => a.own).length !== 1 || sc.some((a) => a.id === 'p:Player0')) errors.push(`karakter adı ayarlıyken kendi satırı çift: ${JSON.stringify(sc.map((a) => a.name))}`);

  // dövüş bitince (geçmiş/donmuş) sanal satır yok
  clock += 20000;
  m.tick(clock);
  if (m.cur) errors.push('dövüş bitmedi');
  const sh = m.snapshot(0, { view: 'all' });
  if (!sh.enc || sh.enc.live || sh.enc.actors.some((a) => a.idle || typeof a.id === 'string')) errors.push('geçmiş dövüşte sanal satır var');
  return errors;
}

const idleErrs = testIdlePartyRows();
if (idleErrs.length) {
  fail++;
  console.log(`HATA     birim: hasar vurmayan parti üyeleri (sanal satır): ${idleErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: hasar vurmayan parti üyeleri görünür (hasar 0), vuran/kendi karakter çift eklenmez, "me" ve geçmişte yok ✓`);
}

function testBossSegments() {
  const { Meter } = require('../lib/meter');
  const errors = [];
  let clock = 1600000000000; // sabit zaman damgası
  const m = new Meter({
    skillName: () => 'Skill',
    now: () => clock,
    idleMs: 8000,
    bossIdleMs: 45000,
    charName: 'Player0',
  });
  m.setOwn(1000);
  m.setName(1000, 'Player0');
  m.targetInfo = (id) => {
    if (id === 5555) return { name: 'Kernon of the West', code: 215555, boss: true, max: 80000000, hp: 80000000 };
    return null;
  };

  // 1. Dövüş başlar (0. saniye)
  m.damage({ t: clock, actor: 1000, target: 5555, skill: 14010000, damage: 150000, crit: true, back: false });

  // 2. 1. saniyede vuruş
  m.damage({ t: clock + 1000, actor: 1000, target: 5555, skill: 14020000, damage: 250000, crit: false, back: false });

  // 3. 2. saniyede başka oyuncu (2000) vurur
  m.setName(2000, 'Sylphira');
  m.damage({ t: clock + 2000, actor: 2000, target: 5555, skill: 15010000, damage: 180000, crit: false, back: false });

  // 4. 4. saniyede boss kesilir
  clock += 4000;
  m.targetDead(5555);
  m.finish();

  if (m.bossHistory.length !== 1) {
    errors.push(`Boss arşivi boyutu ${m.bossHistory.length}, beklenen 1`);
  }

  // 5. Segment seçimi ile snapshot inceleme
  const segSnap = m.snapshot(0, { boss: 0 });
  if (!segSnap.enc || !segSnap.enc.boss) {
    errors.push('Segment snapshot içinde boss objesi bulunamadı');
  } else {
    const b = segSnap.enc.boss;
    if (b.name !== 'Kernon of the West') errors.push(`Boss adı ${b.name}, beklenen Kernon of the West`);
    if (!b.killed) errors.push('Boss kesilme durumu true olmalıydı');
    if (b.total !== 580000) errors.push(`Boss toplam hasarı ${b.total}, beklenen 580000`);
    // Kural 2 (S-02): silinen hasar zaman çizelgesi geri gelmemeli
    if ('timeline' in b) errors.push('Boss bilgisinde silinmiş timeline alanı tekrar görünüyor');
  }

  // 6. Bosses geçmiş listesindeki saat ve format kontrolü
  if (!segSnap.bosses || !segSnap.bosses.length) {
    errors.push('Bosses geçmiş listesi boş');
  } else {
    const b0 = segSnap.bosses[0];
    if (!b0.timeStr || !b0.timeStr.includes(':')) {
      errors.push(`Boss saat formatı timeStr eksik: ${b0.timeStr}`);
    }
    if (!b0.killed) errors.push('Bosses listesinde killed: true olmalı');
  }

  // 7. Dövüş içi boss can basma (Heal) vs Gerçek Wipe/Reset kontrolü
  m.clearBosses();
  clock += 10000;
  // Yeni boss dövüşü başlar
  m.damage({ t: clock, actor: 1000, target: 5555, skill: 14010000, damage: 20000000, crit: true, back: false });
  // Boss dövüş ortasında can bastı (40M -> 50M), biz vurmaya devam ediyoruz
  m.bossHpUpdate(5555, 50000000, 80000000, clock + 2000);
  m.damage({ t: clock + 2500, actor: 1000, target: 5555, skill: 14020000, damage: 5000000, crit: false, back: false });
  if (m.cur === null) {
    errors.push('Boss dövüş ortasında can bastığında dövüş kapandı (heal mekaniği bozulmamalıydı)');
  }

  // Şimdi parti vurmayı bıraktı (wipe yedi), 9 sn geçti ve boss agro bırakıp canı tam %100 oldu
  clock += 12000;
  m.bossHpUpdate(5555, 80000000, 80000000, clock);
  if (m.cur !== null) {
    errors.push('Parti vurmayı bırakıp boss canı %100 olduğunda dövüş anında Wipe olarak kapanmadı');
  }
  if (m.bossHistory.length !== 1 || m.bossHistory[0].bossKilled) {
    errors.push('Boss geçmişine Wipe olarak kaydedilmedi');
  }

  return errors;
}

const bossSegErrs = testBossSegments();
if (bossSegErrs.length) {
  fail++;
  console.log(`HATA     birim: boss segmentleri ve karsilasma secimi: ${bossSegErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: boss segmentleri ve karsilasma secimi ✓`);
}

function testBackgroundBossProtection() {
  const { Meter } = require('../lib/meter');
  const errors = [];
  let clock = 10000;
  const m = new Meter({
    skillName: () => 'Skill',
    now: () => clock,
    idleMs: 8000,
    bossIdleMs: 45000,
    charName: 'Player0',
  });
  m.setOwn(13612);
  m.setName(13612, 'Player0');
  m.targetInfo = (id) => {
    if (id === 52099) return { name: 'Bloodfang Pryn', code: 2105209, boss: true, max: 160000000, hp: 160000000 };
    if (id === 50675) return { name: 'Forest Agrint', code: 101, boss: false, max: 100000, hp: 100000 };
    return null;
  };

  // 1. Oyuncu Forest Agrint'e vurur (çöp mob)
  m.damage({ t: clock, actor: 13612, target: 50675, skill: 14010000, damage: 50000, crit: false, back: false });

  // 2. Bu esnada sunucudan arkadaki 160M'lik Bloodfang Pryn için HP paketi (008d) gelir
  const bossTi = m.targetInfo(52099);
  m.promoteBoss(52099, bossTi, clock + 100);

  // 3. Çevredeki bir yabancı (15788) boss'a vurur
  m.damage({ t: clock + 200, actor: 15788, target: 52099, skill: 13730007, damage: 1740, crit: false, back: false });

  // Dövüş boss fight'a DÖNÜŞMEMELİ çünkü oyuncu boss'a hiç vurmadı!
  const snap = m.snapshot(0, { view: 'party' });
  if (snap.enc.focus && snap.enc.focus.boss) {
    errors.push('Oyuncu bossa vurmadığı halde focus boss barı gösterildi: ' + JSON.stringify(snap.enc.focus));
  }
  if (snap.enc.isBoss) {
    errors.push('Oyuncu bossa vurmadığı halde isBoss true oldu');
  }

  // 4. Oyuncu çöp mobu kesip vurmayı bırakır, 9 saniye sonra (idleMs: 8s) dövüş normal şekilde kapanmalı
  clock += 9000;
  m.tick(clock);
  if (m.cur !== null) {
    errors.push('Boss idle süresi (45s) yüzünden çöp mob dövüşü 8 sn sonra kapanmadı');
  }

  return errors;
}

const bgBossErrs = testBackgroundBossProtection();
if (bgBossErrs.length) {
  fail++;
  console.log(`HATA     birim: arka plan boss koruması (160M barı engelleme): ${bgBossErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: arka plan boss koruması (vurulmayan 160M boss barı ve sayacı engellendi) ✓`);
}

// ---------------------------------------------------------------------------
// 21. BİRİM TESTİ: Serbest Tema Rengi ve Kısayol Atama Doğrulaması (Faz 4.3 & 4.5)
// ---------------------------------------------------------------------------
function testCustomThemeAndShortcuts() {
  const errors = [];
  const { THEMES, hexToRgb, rgbToHex } = require('../lib/themes');

  // 1. hexToRgb dönüşüm doğrulaması
  if (hexToRgb('#ff0055') !== '255, 0, 85') {
    errors.push(`hexToRgb('#ff0055') hatalı: ${hexToRgb('#ff0055')}`);
  }
  if (hexToRgb('#f05') !== '255, 0, 85') {
    errors.push(`hexToRgb('#f05') hatalı: ${hexToRgb('#f05')}`);
  }
  if (hexToRgb('geçersiz') !== null) {
    errors.push('Geçersiz hex için null dönmedi');
  }

  // 2. rgbToHex dönüşüm doğrulaması
  if (rgbToHex('255, 0, 85') !== '#ff0055') {
    errors.push(`rgbToHex('255, 0, 85') hatalı: ${rgbToHex('255, 0, 85')}`);
  }

  // 3. Tema çözücü: main.js'in kullandığı gerçek fonksiyon (B-25: kopya değil)
  const { resolveAccent, DEFAULT_SHORTCUTS, mergeShortcuts } = require('../lib/themes');
  const mainSrc = fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8');
  if (!/const accentRgb = \(\) => resolveAccent\(settings\);/.test(mainSrc)) errors.push('main.js accentRgb artık resolveAccent kullanmıyor (test gerçek kodu denemiyor)');
  if ((mainSrc.match(/mergeShortcuts\(/g) || []).length < 2) errors.push('main.js kısayolları mergeShortcuts ile birleştirmiyor (test gerçek kodu denemiyor)');

  if (resolveAccent({ accent: 'ice' }) !== '94, 196, 255') {
    errors.push('Sabit tema (ice) çözülemedi');
  }
  if (resolveAccent({ accent: 'custom', customAccentRgb: '120, 200, 50' }) !== '120, 200, 50') {
    errors.push('Özel tema (custom) çözülemedi');
  }
  if (resolveAccent({ accent: 'bilinmeyen' }) !== THEMES.gold.rgb) {
    errors.push('Bilinmeyen tema gold temasına düşmedi');
  }

  // 4. Kısayol varsayılanları ve birleştirme (main.js'teki gerçek fonksiyon)
  if (DEFAULT_SHORTCUTS.toggle !== 'CommandOrControl+Shift+D' || DEFAULT_SHORTCUTS.clickThrough !== 'CommandOrControl+Shift+L' || DEFAULT_SHORTCUTS.reset !== 'CommandOrControl+Shift+R') {
    errors.push('Varsayılan kısayollar değişmiş: ' + JSON.stringify(DEFAULT_SHORTCUTS));
  }
  const merged = mergeShortcuts({ toggle: 'CommandOrControl+Shift+D' }, { reset: 'CommandOrControl+Alt+X' }, null);
  if (merged.toggle !== 'CommandOrControl+Shift+D' || merged.reset !== 'CommandOrControl+Alt+X' || merged.clickThrough !== 'CommandOrControl+Shift+L') {
    errors.push('Kısayol birleştirme hatalı: ' + JSON.stringify(merged));
  }
  if (DEFAULT_SHORTCUTS.reset !== 'CommandOrControl+Shift+R') errors.push('mergeShortcuts varsayılanları değiştirdi');

  return errors;
}

const themeShortcutErrs = testCustomThemeAndShortcuts();
if (themeShortcutErrs.length) {
  fail++;
  console.log(`HATA     birim: serbest tema rengi ve kısayol atama: ${themeShortcutErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: serbest tema rengi ve kısayol atama doğrulandı (Faz 4.3 & 4.5) ✓`);
}

// 24. B-31 / B-33: başkasının buff'ı sınıfımızı değiştirmez, iyileştirme hasar sayılmaz (2026-10-10)
function testClassVotesAndHeals() {
  const { Engine } = require('../lib/engine');
  const errors = [];
  let clock = 1000;
  const eng = new Engine({ now: () => clock, setTimer: () => 0, clearTimer: () => 0, onEvent: () => {} });
  const ME = 12943, SHERKL = 9161, MOB = 38983;
  eng.pickOwn(ME, 'elle', 'test');
  eng.meter.setName(ME, 'Player0');
  eng.meter.setName(SHERKL, 'Sherkl');
  // Gerçek kayıttaki gibi: Sherkl'in parti buff'ı (Sprint Mantra, Chanter 18xxxxxx) BİZİM kimliğimizle tür 00 gelir, hem de ilk olay olarak
  eng.combatEvent({ type: 'cast', t: clock, actor: ME, skill: 18030000, kind: 0 });
  // Bizim Avcı becerimiz ve hasarımız (dövüşü biz başlatırız: Fikir 1)
  eng.combatEvent({ type: 'cast', t: clock + 10, actor: ME, skill: 14010000, kind: 2 });
  eng.combatEvent({ type: 'damage', t: clock + 20, actor: ME, target: MOB, skill: 14010000, damage: 5000 });
  // Sherkl'in kendi saldırısı (tür 02) ve canavara hasarı
  eng.combatEvent({ type: 'cast', t: clock + 30, actor: SHERKL, skill: 18010000, kind: 2 });
  eng.combatEvent({ type: 'damage', t: clock + 40, actor: SHERKL, target: MOB, skill: 18010000, damage: 1000 });
  // Buff tekrar gelir (16 kez geldi): sınıf değişmemeli
  for (let i = 0; i < 16; i++) eng.combatEvent({ type: 'cast', t: clock + 50 + i, actor: ME, skill: 18030000, kind: 0 });
  if (eng.meter.classes.get(ME) !== 14) errors.push(`B-31: kendi sınıfımız ${eng.meter.classes.get(ME)}, beklenen 14 (Avcı)`);
  if (eng.cds.ownClass !== 14) errors.push(`B-31: bekleme süreleri sınıfı ${eng.cds.ownClass}, beklenen 14`);
  if (eng.cds.list().some((s) => Math.floor(s.base / 1e6) === 18)) errors.push('B-31: Chanter buff\'ı bizim beceri listemize girdi');
  if (eng.meter.classes.get(SHERKL) !== 18) errors.push(`B-31: Sherkl sınıfı ${eng.meter.classes.get(SHERKL)}, beklenen 18`);
  // Sadece tür 00 ile görülen biri: zayıf kanıtla da sınıfı olmalı
  eng.combatEvent({ type: 'cast', t: clock + 80, actor: 7777, skill: 17010000, kind: 0 });
  if (eng.meter.classes.get(7777) !== 17) errors.push(`B-31: sadece tür 00 gören aktörün sınıfı ${eng.meter.classes.get(7777)}, beklenen 17`);
  // B-33: Sherkl'in bize iyileştirmesi (Recuperation, 0x0538) hasar sayılmaz
  eng.combatEvent({ type: 'damage', t: clock + 90, actor: SHERKL, target: ME, skill: 18200000, damage: 700, dot: true });
  const snap = eng.meter.snapshot(0, { view: 'all', bossView: false }).enc;
  const sh = snap && snap.actors.find((a) => a.id === SHERKL);
  if (!sh || sh.total !== 1000) errors.push(`B-33: Sherkl toplamı ${sh ? sh.total : null}, beklenen 1000 (iyileştirme 700 eklenmemeli)`);
  const me = snap && snap.actors.find((a) => a.id === ME);
  if (!me || me.total !== 5000) errors.push(`B-33: bizim toplamımız ${me ? me.total : null}, beklenen 5000`);
  if (eng.meter.playerTargetSkipped !== 1) errors.push(`B-33: atlanan oyuncu hedefli olay ${eng.meter.playerTargetSkipped}, beklenen 1`);
  // Canavarın bize vurduğu hâlâ "alınan hasar"
  eng.combatEvent({ type: 'damage', t: clock + 100, actor: MOB, target: ME, skill: 1234300, damage: 300 });
  const snap2 = eng.meter.snapshot(0, { view: 'all', bossView: false }).enc;
  if (!snap2 || snap2.taken !== 300) errors.push(`B-33: alınan hasar ${snap2 ? snap2.taken : null}, beklenen 300`);
  return errors;
}
const classHealErrs = testClassVotesAndHeals();
if (classHealErrs.length) {
  fail++;
  console.log(`HATA     birim: B-31/B-33 sınıf oylaması ve iyileştirme: ${classHealErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: B-31/B-33 başkasının buff'ı sınıfımızı değiştirmiyor, iyileştirme hasar sayılmıyor ✓`);
}

// 25. Faz 5.0-P.1: panelin ev konumu (üst bar bırakılan yerde, panel aşağı uzar, alta çarpınca itilir, geri döner)
function testPanelHome() {
  const P = require('../lib/panelpos');
  const errors = [];
  const eq = (name, got, exp) => { for (const k of Object.keys(exp)) if (got[k] !== exp[k]) { errors.push(`${name}: ${k}=${got[k]}, beklenen ${exp[k]}`); return; } };
  const wa = { x: 0, y: 0, width: 2560, height: 1400 };
  // üst yarı: üst bar sabit, panel aşağı uzar
  const up = { x: 100, y: 200, width: 400 };
  eq('üst yarı kısa', P.place(up, 100, wa), { x: 100, y: 200, height: 100 });
  eq('üst yarı uzun', P.place(up, 300, wa), { x: 100, y: 200, height: 300 });
  // alt yarı: eskiden yukarı büyüyordu, artık üst bar sabit
  const low = { x: 19, y: 889, width: 502 };
  eq('alt yarı boşta', P.place(low, 112, wa), { y: 889, height: 112 });
  eq('alt yarı dövüşte', P.place(low, 225, wa), { y: 889, height: 225 });
  // alta çarpma: sadece sığmayan kadar yukarı, kısalınca ev konumuna geri
  const bottom = { x: 19, y: 1300, width: 502 };
  eq('altta kısa', P.place(bottom, 100, wa), { y: 1300, height: 100 });
  eq('altta uzun (itildi)', P.place(bottom, 225, wa), { y: 1175, height: 225 });
  eq('altta tekrar kısa (geri döndü)', P.place(bottom, 100, wa), { y: 1300, height: 100 });
  if (bottom.y !== 1300) errors.push('ev konumu değişti (itilmiş yer kaydedilmemeli)');
  // ekrandan uzun: ekran boyuna kısılır, üstten başlar
  eq('ekrandan uzun', P.place(bottom, 2000, wa), { y: 0, height: 1400 });
  // ikinci monitör (sağda, 200 px yukarıda): o monitörün sınırları
  const wa2 = { x: 2560, y: -200, width: 1920, height: 1040 };
  const m2 = { x: 2700, y: 700, width: 400 };
  eq('2. monitör uzun', P.place(m2, 300, wa2), { x: 2700, y: 540, height: 300 });
  eq('2. monitör kısa', P.place(m2, 100, wa2), { x: 2700, y: 700, height: 100 });
  // monitör çıkarılmışsa ekranda kalsın
  eq('ekran dışı x', P.place({ x: 3000, y: 100, width: 400 }, 100, wa), { x: 2160, y: 100 });
  // eski kayıt: alt yarıdaki panelin alt kenarı korunur, üst yarıdaki zaten üst kenar
  if (P.legacyBottom({ x: 19, y: 776, width: 502, height: 225 }, wa) !== 1001) errors.push('eski kayıt alt yarı: alt kenar 1001 olmalı');
  if (P.legacyBottom({ x: 19, y: 100, width: 502, height: 225 }, wa) !== null) errors.push('eski kayıt üst yarı: çevrilmemeli');
  const br = P.barRect(low);
  if (br.y !== 889 || br.height !== 30) errors.push('barRect: üst bar şeridi yanlış');
  return errors;
}
const panelHomeErrs = testPanelHome();
if (panelHomeErrs.length) {
  fail++;
  console.log(`HATA     birim: panel ev konumu (Faz 5.0-P.1): ${panelHomeErrs.join(' | ')}`);
} else {
  pass++;
  console.log(`TAMAM    birim: panel ev konumu: üst bar sabit, aşağı uzar, alta çarpınca itilir, geri döner, 2. monitör (Faz 5.0-P.1) ✓`);
}


// 28. Faz 6 (2026-10-11): S-10 eski 'kimlik → ad' önbelleği kalktı; 6.2a boş yerli grup paketi; 6.2b GS/CP.
function testFaz6() {
  const errors = [];
  const root = path.join(__dirname, '..');
  // S-10: oyuncular.json artık yüklenmez/yazılmaz; sadece açılışta bir kez silinir
  const mainSrc = fs.readFileSync(path.join(root, 'main.js'), 'utf8');
  if (/knownPlayers|loadPlayers|savePlayers/.test(mainSrc)) errors.push('S-10: main.js hâlâ eski oyuncu önbelleğini kullanıyor');
  if (/writeFileSync\(\s*OLD_PLAYERS_FILE/.test(mainSrc) || /readFileSync\(\s*OLD_PLAYERS_FILE/.test(mainSrc)) errors.push('S-10: oyuncular.json okunuyor ya da yazılıyor');
  if (!/function removeOldPlayersFile\(\)[\s\S]{0,200}unlinkSync\(OLD_PLAYERS_FILE\(\)\)/.test(mainSrc)) errors.push('S-10: eski dosyayı silen işlev yok');
  if (!/removeOldPlayersFile\(\);/.test(mainSrc)) errors.push('S-10: eski dosya açılışta silinmiyor');
  if (/\bnames:\s*\w/.test(mainSrc.slice(mainSrc.indexOf('new Engine(')))) errors.push('S-10: motor hâlâ diskten ad listesiyle başlıyor');
  // S-10: motor ad listesi olmadan başlar, kimlik → ad sadece bu oturumun paketlerinden gelir
  const eng = new Engine({ now: () => 0, setTimer: () => ({}), clearTimer: () => {}, onEvent: () => {} });
  if (eng.meter.names.size !== 0) errors.push('S-10: motor boş ad listesiyle başlamadı');

  // 6.2a: boş yerli zindan ilanı (0x0297). Sahte paket, PROTOKOL.md'deki düzenle kurulur (gerçek adlar depoya girmez).
  const { parseParty } = require('../lib/combat');
  const pkt = partyPacket('90k', 600012, [
    { name: 'Aaa', level: 45, gs: 2342, cp: 99839, server: 1301 },
    null,
    { name: 'Bbb', level: 45, gs: 1706, cp: 88703, server: 1303 },
    null,
    null,
  ]);
  const pp = parseParty(pkt);
  if (!pp) errors.push('6.2a: boş yerli ilan hâlâ atılıyor');
  else {
    if (pp.members.join() !== 'Aaa,Bbb') errors.push('6.2a: üyeler yanlış: ' + pp.members.join());
    const a = pp.memberDetails[0], b = pp.memberDetails[1];
    if (!a || a.gearScore !== 2342 || a.combatPower !== 99839 || a.level !== 45) errors.push('6.2a: 1. üyenin GS/CP/seviyesi yanlış: ' + JSON.stringify(a));
    if (!b || b.gearScore !== 1706 || b.combatPower !== 88703) errors.push('6.2a: 2. üyenin GS/CP\'si yanlış: ' + JSON.stringify(b));
    if (pp.size !== 5 || pp.dungeon !== 600012) errors.push('6.2a: ilan başlığı alanları yanlış');
  }
  const full = parseParty(partyPacket('x', 1, [{ name: 'Ccc', level: 45, gs: 1, cp: 10000, server: 1301 }]));
  if (!full || full.members.join() !== 'Ccc') errors.push('6.2a: dolu ilan okunmuyor');
  if (parseParty(partyPacket('x', 1, [{ name: 'Ddd', level: 999, gs: 1, cp: 1, server: 1 }]))) errors.push('6.2a: seviye > 200 süzgeci kalktı');

  // 6.2b (S-17): GS/CP grup üyesinin satırında, yabancıda yok; son gelen değer; parti.json'dan gelen grupta yok
  let clock = 1000;
  const e2 = new Engine({ now: () => clock, setTimer: () => 0, clearTimer: () => 0, onEvent: () => {} });
  const ME = 500, MATE = 600, STRANGER = 700, MOB = 30000;
  e2.pickOwn(ME, 'elle', 'test');
  e2.meter.setName(ME, 'Aaa'); e2.meter.setName(MATE, 'Bbb'); e2.meter.setName(STRANGER, 'Zzz');
  e2.combatEvent({ type: 'party', ...parseParty(pkt) });
  for (const [id, sk] of [[ME, 14010000], [MATE, 18010000], [STRANGER, 15010000]]) {
    e2.combatEvent({ type: 'cast', t: clock, actor: id, skill: sk, kind: 2 });
    e2.combatEvent({ type: 'damage', t: clock + 5, actor: id, target: MOB, skill: sk, damage: 1000 });
  }
  const rows = () => { const sn = e2.meter.snapshot(0, { view: 'all', bossView: false }).enc; return new Map((sn ? sn.actors : []).map((a) => [a.id, a])); };
  let r = rows();
  if (!r.get(ME) || r.get(ME).gs !== 2342 || r.get(ME).cp !== 99839) errors.push('6.2b: kendi satırımızda GS/CP yok: ' + JSON.stringify(r.get(ME) && { gs: r.get(ME).gs, cp: r.get(ME).cp }));
  if (!r.get(MATE) || r.get(MATE).gs !== 1706 || r.get(MATE).cp !== 88703) errors.push('6.2b: grup üyesinde GS/CP yok');
  if (!r.get(STRANGER) || r.get(STRANGER).gs || r.get(STRANGER).cp) errors.push('6.2b: yabancıda GS/CP olmamalı');
  // son gelen değer: aynı üyenin CP'si değişince satır yeni değeri gösterir
  e2.combatEvent({ type: 'party', ...parseParty(partyPacket('90k', 600012, [{ name: 'Aaa', level: 45, gs: 2342, cp: 99839, server: 1301 }, { name: 'Bbb', level: 45, gs: 1706, cp: 65065, server: 1303 }])) });
  r = rows();
  if (!r.get(MATE) || r.get(MATE).cp !== 65065) errors.push('6.2b: son gelen CP gösterilmiyor');
  // parti.json'dan yüklenen grup (memberDetails yok): GS/CP yok, eski değer kalmaz
  e2.meter.setParty({ size: 5, dungeon: 1, members: ['Aaa', 'Bbb'] });
  r = rows();
  if (r.get(MATE) && (r.get(MATE).gs || r.get(MATE).cp)) errors.push('6.2b: parti.json grubunda GS/CP görünmemeli');
  // ayarlar: ikisi de varsayılan açık, çekmecede iki ayrı aç/kapa, panelde ayara bakılıyor
  const drawerHtml = fs.readFileSync(path.join(root, 'ui', 'drawer.html'), 'utf8');
  const drawerJs = fs.readFileSync(path.join(root, 'ui', 'drawer.js'), 'utf8');
  const panelJs = fs.readFileSync(path.join(root, 'ui', 'panel.js'), 'utf8');
  if (!/showGS: false,/.test(mainSrc) || !/showCP: false,/.test(mainSrc)) errors.push('6.2b: varsayılan kapalı değil');
  if (!/id="showGS"/.test(drawerHtml) || !/id="showCP"/.test(drawerHtml)) errors.push('6.2b: çekmecede aç/kapa yok');
  if (!/'showGS', 'showCP'/.test(drawerJs)) errors.push('6.2b: çekmece ayarı kaydetmiyor');
  if (!/ui\.showGS === true && a\.gs/.test(panelJs) || !/ui\.showCP === true && typeof a\.cp === 'number'/.test(panelJs)) errors.push('6.2b: panel ayara bakmıyor');
  if (!/showGS: settings\.showGS === true, showCP: settings\.showCP === true/.test(mainSrc)) errors.push('6.2b: ayar panele gitmiyor');
  return errors;
}

// 29. Sürüm 2.0: kayıtla doğrulanan protokol çözücüleri (gerçek kayıtlardan alınmış çerçeveler)
function testProtocolV2() {
  const { parseDamage, parseDot, parseVitals, parseGauge, classFromTemplate } = require('../lib/combat');
  const { parseSpawn } = require('../lib/mobs');
  const { readVarint } = require('../lib/parser');
  const H = (h) => Buffer.from(h, 'hex');
  const errors = [];
  // 0x0438: sw&4 yoksa hasar alanı yok (etki bildirimi) → null
  if (parseDamage(H('d4810200008244ea89d600de028cdbcd530100000088540100')) !== null) errors.push('0438 sw=0 hasar sayıldı');
  const d6 = parseDamage(H('dceb0106008244f4eed500dd020000015b5791530100000088549c090100'));
  if (!d6 || d6.damage !== 1180 || d6.actor !== 8706 || d6.target !== 30172 || d6.skill !== 14020340) errors.push('0438 sw=6 yanlış: ' + JSON.stringify(d6));
  // alt vuruş listesi hasara EKLENMEZ (canavar canı ölçümü: ana hasar birebir)
  const d38 = parseDamage(H('dceb0126008244ea89d600de020000028bdbcd53010000008854822901740100'));
  if (!d38 || d38.damage !== 5250 || d38.multi !== 1) errors.push('0438 sw=38 (alt vuruş) yanlış: ' + JSON.stringify(d38));
  const d20 = parseDamage(H('c2e0031400d226ecb403010a028b757265010000009e558807010100'));
  if (!d20 || d20.damage !== 904) errors.push('0438 sw=20 yanlış');
  const d54 = parseDamage(H('dcae033600d226f80204013202800002dc019165010000009e55981201330100'));
  if (!d54 || d54.damage !== 2328 || d54.multi !== 1) errors.push('0438 sw=54 yanlış');
  // 0x0538: etki 10 = DoT hasarı; etki 11 = HoT, gerçek iyileştirme miktardan sonraki tik
  const dot = parseDot(H('dceb010a8244018cdbcd53a802ea89d600'));
  if (!dot || dot.kind !== 'damage' || dot.damage !== 296 || dot.skill !== 14060000) errors.push('0538 DoT yanlış: ' + JSON.stringify(dot));
  const hot = parseDot(H('e2440be2449c035fb2fc0b8806c101ddaf1e00'));
  if (!hot || hot.kind !== 'heal' || hot.amount !== 193 || !hot.self) errors.push('0538 HoT yanlış (havuz 776 değil tik 193 olmalı): ' + JSON.stringify(hot));
  // 0x008d: tür 2 (u64, alan 0 can + alan 7 azami can) ve tür 3 (u32 + u64)
  const v2 = parseVitals(H('e2440202001d3e000000000000071d3e000000000000'));
  if (!v2 || v2.id !== 8802 || v2.hp !== 15901 || v2.max !== 15901) errors.push('008d tür 2 yanlış: ' + JSON.stringify(v2));
  const v3 = parseVitals(H('e244030101fa0d000001001040000000000000'));
  if (!v3 || v3.hp !== 16400 || v3.max !== null) errors.push('008d tür 3 yanlış: ' + JSON.stringify(v3));
  if (parseVitals(H('e244010103443c0200')) !== null) errors.push('008d sadece u32 alanı can sanıldı');
  // 0x05e0 kırılma göstergesi
  const g = parseGauge(H('a085010301b00400008b04000002'));
  if (!g || g.id !== 17056 || g.max !== 1200 || g.val !== 1163 || g.state !== 2) errors.push('05e0 yanlış: ' + JSON.stringify(g));
  const gb = parseGauge(H('a08501000302'));
  if (!gb || !gb.broken) errors.push('05e0 kırılma olayı okunmadı');
  // 0x4136: tarama yok; yarı canlı canavar ve adlı (çağrı) doğma
  const half = parseSpawn(H('d4e0050520002fa024004002cdcda64727df99c700d0384623b9d342484b01ed840394a707640000006400'), readVarint);
  if (!half || half.code !== 2400303 || half.maxHp !== 119700 || half.curHp !== 49773 || half.owner) errors.push('4136 yarı can yanlış: ' + JSON.stringify(half));
  const named = parseSpawn(H('d8ba031f000106436861707069bd902c00400280d8a647802c99c700d4384650498543d58401c657c6573c0f00003c0f0000'), readVarint);
  if (!named || named.owner !== 'Chappi' || named.code !== 2920637 || named.maxHp !== 11206) errors.push('4136 adlı çağrı yanlış: ' + JSON.stringify(named));
  // 0x0297 karakter şablonu → sınıf (kayıtta 21/21 eşleşme; 21–24 ve 37+ doğrulanmadı)
  const tm = { 5: 11, 7: 11, 9: 12, 13: 14, 14: 14, 17: 13, 19: 13, 26: 15, 28: 15, 30: 17, 31: 17, 32: 17, 34: 18, 35: 18, 22: null, 38: null, 4: null };
  for (const [k, v] of Object.entries(tm)) if (classFromTemplate(Number(k)) !== v) errors.push(`şablon ${k} → ${classFromTemplate(Number(k))}, beklenen ${v}`);
  return errors;
}

// 30. Sürüm 2.0: iyileştirme (HPS), alınan hasar, ölüm özeti, kırılma, adlı çağrı, B-34/B-38
function testMeterV2() {
  const { Engine } = require('../lib/engine');
  const errors = [];
  let clock = 1000;
  const eng = new Engine({ now: () => clock, setTimer: () => 0, clearTimer: () => 0, onEvent: () => {} });
  const ME = 32, CLE = 3381, MOB = 45000, BOSS = 17056, SUM = 19209;
  eng.pickOwn(ME, 'elle', 'test');
  eng.meter.setName(ME, 'Player0');
  eng.meter.setName(CLE, 'Player6');
  // 0x0297: şablon 30 → Cleric (oylama yok)
  eng.combatEvent({ type: 'party', size: 2, dungeon: 1, members: ['Player0', 'Player6'], memberDetails: [{ name: 'Player0', cls: 14 }, { name: 'Player6', cls: 17 }] });
  if (eng.meter.classes.get(CLE) !== 17) errors.push('parti şablonu sınıfı uygulanmadı');
  eng.combatEvent({ type: 'cast', t: clock, actor: CLE, skill: 18030000, kind: 0 }); // başkasının buff'ı sınıfı değiştirmemeli
  if (eng.meter.classes.get(CLE) !== 17) errors.push('kesin sınıf oylamayla ezildi');
  // dövüş başlasın
  eng.combatEvent({ type: 'spawn', t: clock, id: MOB, code: 2400303, maxHp: 119700, curHp: 119700, alive: true });
  eng.combatEvent({ type: 'damage', t: clock, actor: ME, target: MOB, skill: 14010000, damage: 5000 });
  // oyuncu canı ve azami can (008d)
  eng.combatEvent({ type: 'hp', t: clock, id: ME, hp: 10000, max: 16000 });
  // doğrudan iyileştirme adayı: can birebir artınca beceri doğrulanır
  eng.combatEvent({ type: 'damage', t: clock + 10, actor: CLE, target: ME, skill: 17010000, damage: 4000 });
  eng.combatEvent({ type: 'hp', t: clock + 10, id: ME, hp: 14000 });
  if (!eng.meter.healSkills.has(17010000)) errors.push('iyileştirme becerisi can artışıyla doğrulanmadı');
  // ikinci iyileştirme: azami cana 2000 kaldı → 2000 etkili, 2000 aşırı
  eng.combatEvent({ type: 'damage', t: clock + 20, actor: CLE, target: ME, skill: 17010000, damage: 4000 });
  // kalkan/buff: canı artırmayan beceri iyileştirme görünümüne girmez
  eng.combatEvent({ type: 'damage', t: clock + 30, actor: CLE, target: ME, skill: 17550000, damage: 30000 });
  eng.combatEvent({ type: 'hp', t: clock + 30, id: ME, hp: 16000 });
  // HoT tiki (0x0538 etki&1): protokolle kesin
  eng.combatEvent({ type: 'heal', t: clock + 40, actor: CLE, target: ME, skill: 17080000, amount: 500, hot: true });
  // kendi kendine iyileştirme (0x0438 aktör = hedef) grup HPS'ine girmez; iksir ayrı
  eng.combatEvent({ type: 'heal', t: clock + 50, actor: CLE, target: CLE, skill: 17010000, amount: 1000, self: true, direct: true });
  eng.combatEvent({ type: 'hp', t: clock + 52, id: ME, hp: 15000 });
  eng.combatEvent({ type: 'heal', t: clock + 55, actor: ME, target: ME, skill: 2011101, amount: 300, self: true, hot: true });
  clock += 60;
  const snap = eng.meter.snapshot(0, { view: 'all', bossView: false }).enc;
  const h = snap.heal && snap.heal.actors.find((a) => a.id === CLE);
  if (!h) errors.push('iyileştirme görünümünde Cleric yok');
  else {
    if (h.group !== 4000 + 2000) errors.push(`grup etkili iyileştirme ${h.group}, beklenen 6000 (kalkan 30000 ve aşırı kısım hariç)`);
    if (h.self !== 1000) errors.push(`kendine iyileştirme ${h.self}, beklenen 1000`);
    if (h.over !== 2000 + 500) errors.push(`aşırı iyileştirme ${h.over}, beklenen 2500`);
    if (h.skills.some((k) => k.skill === 17550000)) errors.push('doğrulanmamış kalkan iyileştirme sayıldı');
  }
  const meH = snap.heal && snap.heal.actors.find((a) => a.id === ME);
  if (!meH || meH.items !== 300 || meH.group !== 0) errors.push('iksir grup iyileştirmesinden ayrılmadı: ' + JSON.stringify(meH));
  const me = snap.actors.find((a) => a.id === ME);
  if (!me || me.total !== 5000) errors.push('iyileştirme hasar toplamını bozdu');
  // alınan hasar + ölüm özeti + dirilme
  eng.combatEvent({ type: 'damage', t: clock, actor: MOB, target: ME, skill: 2700001, damage: 9000 });
  eng.combatEvent({ type: 'damage', t: clock + 500, actor: MOB, target: ME, skill: 2700002, damage: 7000, dot: true });
  eng.combatEvent({ type: 'hp', t: clock + 500, id: ME, hp: 0 });
  const s2 = eng.meter.snapshot(0, { view: 'all', bossView: false });
  const tk = s2.enc.takenBy && s2.enc.takenBy.actors.find((a) => a.id === ME);
  if (!tk || tk.amount !== 16000 || tk.hits !== 1 || tk.ticks !== 1 || tk.biggest !== 9000) errors.push('alınan hasar raporu yanlış: ' + JSON.stringify(tk));
  const dr = s2.deaths && s2.deaths[0];
  if (!dr || dr.player !== ME || dr.skill !== 2700002 || dr.total !== 16000 || !dr.own) errors.push('ölüm özeti yanlış: ' + JSON.stringify(dr));
  if (s2.enc.deaths !== 1) errors.push(`kendi ölüm sayısı ${s2.enc.deaths}, beklenen 1`);
  eng.combatEvent({ type: 'hp', t: clock + 4500, id: ME, hp: 16000 });
  if (!dr || dr.deadFor !== 4000) errors.push(`yerde kalma süresi ${dr && dr.deadFor}, beklenen 4000`);
  // kırılma göstergesi ve patlama penceresi
  clock += 5000;
  eng.combatEvent({ type: 'spawn', t: clock, id: BOSS, code: 2300312, maxHp: 8208000, curHp: 8208000, alive: true });
  eng.combatEvent({ type: 'damage', t: clock, actor: ME, target: BOSS, skill: 14010000, damage: 1000 });
  eng.combatEvent({ type: 'gauge', t: clock, id: BOSS, max: 1200, val: 300, state: 2 });
  eng.combatEvent({ type: 'gauge', t: clock + 10, id: BOSS, broken: true });
  eng.combatEvent({ type: 'damage', t: clock + 20, actor: ME, target: BOSS, skill: 14010000, damage: 2500 });
  eng.combatEvent({ type: 'gauge', t: clock + 5010, id: BOSS, max: 1200, val: 1200, state: 2 });
  const b = eng.meter.snapshot(0, { view: 'all' }).enc.boss;
  if (!b || !b.stagger || b.stagger.breaks !== 1 || b.stagger.burstDmg !== 2500 || b.stagger.broken) errors.push('kırılma göstergesi yanlış: ' + JSON.stringify(b && b.stagger));
  // B-38 / B-34: doğma paketi gelen 20000 altı kimlik oyuncu sayılmaz; adlı doğma sahibin satırına eklenir
  eng.combatEvent({ type: 'spawn', t: clock, id: SUM, code: 2920626, maxHp: 17647, curHp: 17647, alive: true, owner: 'Player0' });
  eng.combatEvent({ type: 'damage', t: clock + 30, actor: SUM, target: BOSS, skill: 14800001, damage: 700 });
  if (eng.meter.isKnownPlayer(SUM)) errors.push('çağrı kimliği oyuncu sayıldı (B-34)');
  const s3 = eng.meter.snapshot(0, { view: 'all', bossView: false }).enc;
  if (s3.actors.some((a) => a.id === SUM)) errors.push('adlı çağrı ayrı satır olarak kaldı (B-38)');
  const me3 = s3.actors.find((a) => a.id === ME);
  if (!me3 || !me3.skills.some((k) => k.skill === 14800000)) errors.push('çağrının hasarı sahibine eklenmedi');
  // uzun oturum: harita budaması
  for (let i = 0; i < 40000; i++) eng.meter.noteNpc(100000 + i, clock);
  eng.meter.tick(clock + 60000);
  if (eng.meter.npcIds.size > 30000) errors.push(`npcIds budanmadı (${eng.meter.npcIds.size})`);
  return errors;
}

// A-1 (Hata Avı, 2026-10-12): main.js'in GERÇEK loadSettings'i (kopya değil, B-25) sahte Electron ile yüklenir.
// İki sınıflı ayar dosyası (Avcı 20 beceri, Cleric 6 beceri + 3 ses ayarı) açılışta hiçbir şey kaybetmemeli.
async function testA1KeepOtherClass() {
  const fs = require('fs');
  const os = require('os');
  const path = require('path');
  const Module = require('module');
  const errors = [];
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'a1-'));
  const dataDir = path.join(tmp, 'Daeva Lens');
  fs.mkdirSync(dataDir, { recursive: true });
  const seen = {}; const cd = {}; const learned = {};
  for (let i = 1; i <= 20; i++) seen[14000000 + i * 10000] = { name: 'Avcı ' + i, raw: 14000000 + i * 10000 + 1 };
  for (let i = 1; i <= 6; i++) seen[17000000 + i * 10000] = { name: 'Cleric ' + i, raw: 17000000 + i * 10000 + 1 };
  for (let i = 1; i <= 3; i++) cd[17000000 + i * 10000] = { on: true, sound: 'zil', earlyMs: 0 };
  cd[14010000] = { on: true, sound: 'can' };
  learned[17060000] = 42000; // varsayılanı olmayan öğrenilmiş süre
  const castBases = [14010000, 17010000, 17020000];
  const file = path.join(dataDir, 'ayarlar.json');
  fs.writeFileSync(file, JSON.stringify({ seenSkills: seen, cd, learned, castBases, activeBases: castBases.slice() }));
  const handlers = {};
  const fake = {
    app: {
      getPath: (k) => (k === 'userData' ? dataDir : tmp), setPath: () => {}, setAppUserModelId: () => {},
      requestSingleInstanceLock: () => true, whenReady: () => new Promise(() => {}), on: (ev, fn) => { handlers[ev] = fn; },
      getLocale: () => 'tr', getVersion: () => '0', quit: () => {},
    },
    BrowserWindow: function () {}, Tray: function () {}, Menu: {}, ipcMain: { on: () => {}, handle: () => {} },
    globalShortcut: {}, dialog: {}, screen: {}, shell: {}, nativeImage: {},
  };
  const mainPath = path.join(__dirname, '..', 'main.js');
  const src = fs.readFileSync(mainPath, 'utf8');
  const m = new Module(mainPath, module);
  m.filename = mainPath;
  m.paths = Module._nodeModulePaths(path.dirname(mainPath));
  const origLoad = Module._load;
  Module._load = function (req, ...rest) { return req === 'electron' ? fake : origLoad.call(this, req, ...rest); };
  try {
    m._compile(src + '\n;module.exports.__a1 = { loadSettings, get: () => settings };', mainPath);
    m.exports.__a1.loadSettings();
    const st = m.exports.__a1.get();
    const cls17 = Object.keys(st.seenSkills).filter((b) => b.startsWith('17')).length;
    if (cls17 !== 6) errors.push(`Cleric görülen beceri ${cls17}/6`);
    const cd17 = Object.keys(st.cd).filter((b) => b.startsWith('17')).length;
    if (cd17 !== 3) errors.push(`Cleric ses ayarı ${cd17}/3`);
    if (st.learned[17060000] !== 42000) errors.push('Cleric öğrenilen süre silindi');
    if (!st.castBases.includes(17010000)) errors.push('Cleric castBases silindi');
    if (Object.keys(st.seenSkills).length !== 26) errors.push('Avcı becerileri eksik');
    await new Promise((r) => setTimeout(r, 400)); // olası kayıt zamanlayıcısı
    const disk = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (Object.keys(disk.cd).filter((b) => b.startsWith('17')).length !== 3) errors.push('diskteki Cleric ses ayarları silindi');
  } catch (err) {
    errors.push('main.js yüklenemedi: ' + (err && err.message));
  } finally {
    Module._load = origLoad;
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* yok */ }
  }
  return errors;
}

// 31. Sürüm 2.0: bütün kayıtlarla tekrar oynatma (fuzz): istisna yok, NaN/sonsuz yok, haritalar sınırlı
async function testReplayFuzz() {
  const fs = require('fs');
  const path = require('path');
  const { Engine } = require('../lib/engine');
  const errors = [];
  const files = [];
  for (const d of dirs) {
    const walk = (p, depth) => { if (!fs.existsSync(p) || depth > 2) return; for (const e of fs.readdirSync(p, { withFileTypes: true })) { const q = path.join(p, e.name); if (e.isDirectory()) walk(q, depth + 1); else if (/\.jsonl(\.gz)?$/.test(e.name)) files.push(q); } };
    walk(d, 0);
  }
  const bad = (x) => typeof x === 'number' && !Number.isFinite(x);
  const scan = (o, where, depth = 0) => {
    if (!o || typeof o !== 'object' || depth > 6) return;
    for (const [k, v] of Object.entries(o)) {
      if (bad(v)) { errors.push(`${where}: ${k} = ${v}`); return; }
      if (v && typeof v === 'object') scan(v, where, depth + 1);
    }
  };
  let frames = 0;
  for (const f of files) {
    let clock = 0, t0 = null, n = 0;
    const eng = new Engine({ now: () => clock, setTimer: () => 0, clearTimer: () => 0, onEvent: () => {} });
    try {
      await forEachJson(f, (m) => {
        if (m.type !== 'pkt') return;
        if (t0 === null) t0 = m.t;
        clock = m.t - t0;
        eng.packet(m);
        if (++n % 3000 === 0) { eng.tick(); scan(eng.meter.snapshot(0, { view: 'all' }), path.basename(f)); }
      });
      clock += 120000; eng.tick();
      scan(eng.meter.snapshot(0, { view: 'all' }), path.basename(f));
      if (eng.combat.stats.errors) errors.push(`${path.basename(f)}: ${eng.combat.stats.errors} çözücü hatası`);
      frames += eng.combat.stats.frames;
    } catch (err) { errors.push(`${path.basename(f)}: ${err && err.message}`); }
    if (errors.length > 20) break;
  }
  return { errors, files: files.length, frames };
}

// 0x0297 sahte paket kurucu (lib/combat.js parseParty ile aynı bit okuma sırası). Üye null = boş yer.
function partyPacket(title, dungeon, slots) {
  const out = [];
  let bitLeft = 0;
  const u8 = (v) => out.push(v & 255);
  const u32 = (v) => { for (let i = 0; i < 4; i++) u8(v >>> (8 * i)); };
  const u16 = (v) => { u8(v); u8(v >> 8); };
  const u64 = (v) => { const b = Buffer.alloc(8); b.writeBigUInt64LE(BigInt(v)); out.push(...b); };
  const str = (t) => { const b = Buffer.from(t, 'utf8'); u8(b.length); out.push(...b); };
  const bit = () => { if (!bitLeft) { u8(0); bitLeft = 8; } bitLeft--; };
  u32(0); str(title); u8(slots.length); u32(dungeon); u8(0); u8(0); for (let i = 0; i < 8; i++) u8(0); bit(); u8(0); u8(0);
  u8(slots.length); // üye sayısı (vi, < 128)
  slots.forEach((m, i) => {
    const mask = m ? 0b11110 : 0;
    u8(mask); u8(i + 1); u32(m ? 100000 + i : 0); u16(0); u16(m ? m.server : 0);
    str(m ? m.name : ''); u32(m ? 9 : 0); u32(m ? m.level : 0); u32(m ? m.gs : 0);
    if (mask & 2) bit();
    bit();
    if (mask & 4) u16(m.server);
    if (mask & 8) u16(4302);
    u8(m ? 4 : 0); u64(m ? m.cp : 0); u8(0);
    if (mask & 16) for (let k = 0; k < 8; k++) u8(0);
    u8(1); u8(1);
  });
  u8(0); u8(0);
  return Buffer.from(out);
}

function testDenetimFixes() {
  const errors = [];
  const { readVarint, Stream, splitSizes } = require('../lib/parser');
  const { outFrameSizes } = require('../lib/owner');
  const { Meter, baseSkill } = require('../lib/meter');

  // 1. 10-bayt negatif LEB128 varint (-1191)
  const bNeg = Buffer.from('d9f6ffffffffffffff01', 'hex');
  const vNeg = readVarint(bNeg, 0);
  if (!vNeg || vNeg[0] !== -1191 || vNeg[1] !== 10) {
    errors.push(`10-bayt negatif varint başarısız: ${JSON.stringify(vNeg)}`);
  }

  // 2. Pozitif 1-bayt, 2-bayt, 5-bayt varint'ler
  const bPos = Buffer.from([0x01, 0xac, 0x02, 0x80, 0x80, 0x80, 0x80, 0x01]);
  if (readVarint(bPos, 0)[0] !== 1) errors.push('1-bayt varint başarısız');
  if (readVarint(bPos, 1)[0] !== 300) errors.push('2-bayt varint başarısız');
  if (readVarint(bPos, 3)[0] !== 268435456) errors.push('5-bayt varint başarısız');

  // 3. outFrameSizes geçerli ve yarım kalan çerçeveler
  const frameBuf = Buffer.concat([Buffer.from([0x0e]), Buffer.alloc(10)]); // L=14, tot = 14-4+1 = 11 == frameBuf.length
  const sizes = outFrameSizes(frameBuf);
  if (sizes.length !== 1 || sizes[0] !== 11) {
    errors.push(`outFrameSizes geçerli çerçeve başarısız: ${JSON.stringify(sizes)}`);
  }
  const multiBuf = Buffer.concat([frameBuf, Buffer.from([0x50])]); // 11-bayt çerçeve + eksik çerçeve
  const multiSizes = outFrameSizes(multiBuf);
  if (multiSizes.length !== 1 || multiSizes[0] !== 11) {
    errors.push(`outFrameSizes yarım kalan çerçeve koruması başarısız: ${JSON.stringify(multiSizes)}`);
  }

  // 4. Stream.skipGap eski paket bellek sızıntısı koruması
  let streamFrames = 0;
  const s = new Stream((op, body, tot) => streamFrames++);
  s.next = 10000;
  for (let k = 0; k < 70; k++) {
    s.pending.set(1000 + k, Buffer.from([1, 2, 3]));
  }
  s.skipGap();
  if (s.pending.size !== 0) {
    errors.push(`Stream.skipGap eski paketleri temizlemedi, kalan boyut: ${s.pending.size}`);
  }

  // 5. migrateActor sırasında byTarget korunması ve boss'a AoE sızmasının engellenmesi
  const m = new Meter();
  m.ownId = 101;
  m.damage({ t: 1000, actor: 101, target: 500, skill: 11000001, damage: 1000, crit: false, back: false });
  m.damage({ t: 1010, actor: 101, target: 501, skill: 11000001, damage: 5000, crit: false, back: false });
  m.setOwn(102);
  m.damage({ t: 1020, actor: 102, target: 500, skill: 11000001, damage: 2000, crit: false, back: false });
  m.promoteBoss(500, 1030);
  if (!m.cur || !m.cur.bossActors.get(102)) {
    errors.push('migrateActor sonrası bossActor bulunamadı');
  } else if (m.cur.bossActors.get(102).total !== 3000) {
    errors.push(`AoE hasarı boss DPS'ine sızdı veya taşınan hasar kayboldu: beklenen 3000, alınan ${m.cur.bossActors.get(102).total}`);
  }

  // 6. splitSizes 0-bayt dolgu koruması
  const padBuf = Buffer.concat([Buffer.from([0x00, 0x00, 0x0e]), Buffer.alloc(10), Buffer.from([0x00])]);
  const padSizes = [];
  const rPad = splitSizes(padBuf, (op, b, tot) => padSizes.push(tot));
  if (!rPad || rPad.bad || padSizes.length !== 1 || padSizes[0] !== 11) {
    errors.push(`splitSizes 0-bayt dolgu koruması başarısız: bad=${rPad && rPad.bad}, sizes=${JSON.stringify(padSizes)}`);
  }

  // 7. archiveBoss byTarget birleştirme testi
  const m2 = new Meter({ now: () => 2000 });
  m2.cur = m2.newEncounter(1000);
  m2.promoteBoss(900, { name: 'SplitBoss', max: 50000000, boss: true }, 1000, 101);
  m2.damage({ t: 1000, actor: 101, target: 900, skill: 11000001, damage: 10000 });
  m2.finish();
  m2.cur = m2.newEncounter(2000);
  m2.promoteBoss(900, { name: 'SplitBoss', max: 50000000, boss: true }, 2000, 101);
  m2.damage({ t: 2000, actor: 101, target: 900, skill: 11000001, damage: 15000 });
  m2.finish();
  if (m2.bossHistory.length !== 1) {
    errors.push(`archiveBoss birleşmedi, uzunluk: ${m2.bossHistory.length}`);
  } else {
    const bActor = m2.bossHistory[0].bossActors.get(101);
    const sk = bActor && bActor.skills.get(baseSkill(11000001));
    if (!sk || !sk.byTarget || !sk.byTarget.get(900) || sk.byTarget.get(900).total !== 25000) {
      errors.push(`archiveBoss byTarget birleşimi başarısız: ${sk && sk.byTarget && sk.byTarget.get(900) && sk.byTarget.get(900).total}`);
    }
  }

  return errors;
}

// Kendi kimliği bölge/zindan değişiminde yenilenince: eski kimlik biten dövüşlerde adsız "Player #N" satırı olarak
// kalmamalı, oyuncu sayısı çift sayılmamalı; gerçekten bilinmeyen başka oyuncular ve başkası çıkan tahmini kimlik etkilenmemeli.
function testOwnAliasMerge() {
  const { Engine } = require('../lib/engine');
  const { OwnTracker } = require('../lib/owner');
  const errors = [];
  let clock = 1000;
  const eng = new Engine({ now: () => clock, setTimer: () => ({}), clearTimer() {}, cdConfig: {}, onEvent: () => {}, charName: 'Player0' });
  const m = eng.meter;
  const ledger = [];
  m.onBossRecord = (r) => ledger.push(r);
  const ev = (e) => eng.combatEvent(e);
  const party = ['Player0', 'Player3', 'Archmage', 'Player4', 'Player5'];
  ev({ type: 'party', size: 5, dungeon: 600011, members: party });
  ev({ type: 'name', id: 13720, name: 'Player0' });
  [201, 202, 203, 204].forEach((id, i) => ev({ type: 'name', id, name: party[i + 1] }));
  if (eng.ownId !== 13720) errors.push('ad paketiyle kendi kimlik 13720 seçilmeliydi: ' + eng.ownId);
  const hit = (actor, dmg, t) => ev({ type: 'damage', t, actor, target: 900, skill: 14010000, damage: dmg });
  // 1. boss denemesi (öldürülmedi) eski kimlikle
  m.cur = m.newEncounter(clock);
  m.promoteBoss(900, { name: 'Divine Auldor', max: 50000000, boss: true }, clock, 13720);
  hit(13720, 5000, clock); for (const id of [201, 202, 203, 204]) hit(id, 1000, clock + 10);
  m.finish();
  // 2. zindan yeniden girişi: sunucu yeni oturum kimliği verdi
  clock += 20000;
  ev({ type: 'name', id: 12144, name: 'Player0' });
  if (eng.ownId !== 12144) errors.push('yeni kimlik 12144 seçilmeliydi: ' + eng.ownId);
  const h0 = m.snapshot(0, {}).enc;
  if (!h0) errors.push('biten dövüş bulunamadı');
  else {
    if (h0.actors.length !== 5) errors.push('biten dövüşte oyuncu sayısı ' + h0.actors.length + ' (5 olmalı): ' + h0.actors.map((a) => a.name).join(','));
    if (h0.actors.some((a) => /#13720$/.test(a.name))) errors.push('eski kimlik "Player #13720" satırı kaldı');
    const me = h0.actors.filter((a) => a.own);
    if (me.length !== 1 || me[0].name !== 'Player0' || me[0].total !== 5000) errors.push('kendi satırı adıyla ve hasarıyla tek olmalı: ' + JSON.stringify(me.map((a) => [a.name, a.total])));
  }
  // 3. aynı boss'a 90 sn içinde yeni kimlikle devam: birleşen boss kaydında 6 değil 5 kişi
  m.cur = m.newEncounter(clock);
  m.promoteBoss(900, { name: 'Divine Auldor', max: 50000000, boss: true }, clock, 12144);
  hit(12144, 7000, clock); for (const id of [201, 202, 203, 204]) hit(id, 500, clock + 10);
  m.finish();
  if (m.bossHistory.length !== 1) errors.push('boss kaydı birleşmeliydi: ' + m.bossHistory.length);
  const b = m.snapshot(0, { boss: 0, bossView: true }).enc;
  if (!b || b.actors.length !== 5) errors.push('boss raporunda oyuncu sayısı ' + (b && b.actors.length) + ' (5 olmalı): ' + (b ? b.actors.map((a) => a.name).join(',') : ''));
  else {
    const me = b.actors.filter((a) => a.own || a.name === 'Player0');
    if (me.length !== 1 || me[0].total !== 12000 || !me[0].own) errors.push('boss raporunda kendi satırı 12000 hasarla tek olmalı: ' + JSON.stringify(me.map((a) => [a.name, a.total, a.own])));
  }
  const last = ledger[ledger.length - 1];
  if (!last || last.actors.length !== 5 || last.actors.filter((a) => a.name === 'Player0').length !== 1) errors.push('oyuncu defterine giden liste çift kişi içermemeli: ' + (last ? last.actors.map((a) => a.name).join(',') : 'yok'));
  // 4. tahmini (eşleşme) kimlik başka biri çıkarsa sonraki kesin seçimde bize birleştirilmez
  m.cur = m.newEncounter(clock + 200000);
  clock += 200000;
  hit(777, 3333, clock); // adsız, sınıfı bilinmeyen başka bir aktör
  eng.pickOwn(777, 'eşleşme', 'test tahmini');
  ev({ type: 'name', id: 777, name: 'Bob' }); // gerçek adı geldi: başkası
  m.finish();
  ev({ type: 'name', id: 15000, name: 'Player0' });
  const h1 = m.snapshot(0, {}).enc;
  const bob = h1 && h1.actors.find((a) => a.name === 'Bob');
  if (!bob || bob.own || bob.total !== 3333) errors.push('başkası çıkan tahmini kimlik bize birleştirilmemeli: ' + (h1 ? JSON.stringify(h1.actors.map((a) => [a.name, a.total, a.own])) : 'yok'));
  if (eng.lastKnownOwnId === 777) errors.push('başkası çıkan kimlik son bilinen kendi kimliği olarak kalmamalı');
  // 5. gerçekten bilinmeyen sayısal oyuncu satırı değişmez
  m.cur = m.newEncounter(clock + 1000);
  hit(15000, 100, clock + 1000); hit(4321, 200, clock + 1001);
  const live = m.snapshot(0, {}).enc;
  if (!live || !live.actors.some((a) => a.id === 4321 && /#4321$/.test(a.name) && !a.own)) errors.push('bilinmeyen başka oyuncu sayısal adıyla ayrı kalmalı');
  // 6. OwnTracker: kesin kimlik (seed) sonrası susmuş eski kimlik, birikmiş puanıyla seçimi geri almaz
  const picks = [];
  const ot = new OwnTracker({ onPick: (id) => picks.push(id) });
  let t = 0;
  for (let i = 0; i < 40; i++) { t += 1000; ot.outFrame(t - 60, 45); ot.cast(5067, 14010000, t); }
  if (ot.own !== 5067) errors.push('OwnTracker eski kimliği seçmeliydi: ' + ot.own);
  ot.seed(16277, t + 10);
  for (let i = 0; i < 5; i++) { t += 1000; ot.cast(888, 14010000, t); } // başka aktörün kullanımı decide'ı tetikler
  if (ot.own !== 16277 || picks[picks.length - 1] === 5067 && picks.length > 1) errors.push('seed sonrası eski kimliğe dönülmemeli: ' + ot.own + ' / ' + picks.join(','));
  return errors;
}

(async () => {
  await recordingTests();
  const dFixErrs = testDenetimFixes();
  if (dFixErrs.length) {
    fail++;
    console.log(`HATA     birim: Denetim düzeltmeleri (10-bayt varint, outFrameSizes, Stream.skipGap, migrateActor byTarget): ${dFixErrs.join(' | ')}`);
  } else {
    pass++;
    console.log('TAMAM    birim: Denetim düzeltmeleri: 10-bayt negatif varint (-1191), outFrameSizes yarım çerçeve, Stream.skipGap sızıntı koruması, migrateActor byTarget AoE yalıtımı ✓');
  }
  const faz6Errs = testFaz6();
  if (faz6Errs.length) {
    fail++;
    console.log(`HATA     birim: Faz 6 (S-10 eski ad önbelleği, 6.2a boş yerli grup, 6.2b GS/CP): ${faz6Errs.join(' | ')}`);
  } else {
    pass++;
    console.log('TAMAM    birim: Faz 6: eski kimlik → ad önbelleği yok (S-10), boş yerli zindan ilanı okunuyor (6.2a), GS/CP sadece grup üyesinde, son gelen, iki ayar (6.2b) ✓');
  }
  for (const [name, fn] of [['Sürüm 2.0 protokol: 0x0438 sw&4/alt vuruş, 0x0538 HoT tiki, 0x008d alan 0/7, 0x05e0 kırılma, 0x4136 tam okuma, 0x0297 şablon → sınıf', testProtocolV2], ['Sürüm 2.0 sayaç: iyileştirme (etkili/aşırı/kendine/iksir), kalkan dışarıda, alınan hasar, ölüm özeti + dirilme, kırılma penceresi, adlı çağrı (B-38), B-34, budama', testMeterV2], ['kendi kimlik yenilenince eski kimlik birleşir (geçmiş + boss kaydı + defter 5 kişi, "Player #N" yetim yok, başkası çıkan tahmin ayrı, OwnTracker eski kimliğe dönmez)', testOwnAliasMerge]]) {
    const e = fn();
    if (e.length) { fail++; console.log(`HATA     birim: ${name}: ${e.join(' | ')}`); } else { pass++; console.log(`TAMAM    birim: ${name} ✓`); }
  }
  {
    const e = await testA1KeepOtherClass();
    if (e.length) { fail++; console.log(`HATA     birim: A-1 açılışta öbür sınıfın beceri ayarları: ${e.join(' | ')}`); }
    else { pass++; console.log('TAMAM    birim: A-1 iki sınıflı ayar dosyası açılışta korunuyor (ses, öğrenilen süre, görülen beceriler) ✓'); }
  }
  const fz = await testReplayFuzz();
  if (!fz.files) { skip++; console.log('ATLANDI  tekrar oynatma (fuzz) (yerel kayıt gerekli)'); }
  else if (fz.errors.length) { fail++; console.log(`HATA     tekrar oynatma (fuzz): ${fz.errors.slice(0, 8).join(' | ')}`); }
  else { pass++; console.log(`TAMAM    tekrar oynatma (fuzz): ${fz.files} kayıt, ${fz.frames} çerçeve; istisna 0, çözücü hatası 0, NaN/sonsuz 0 ✓`); }
  for (const [name, fn] of [...require('./test-yeni'), ...require('./test-parti'), ...require('./test-zindan'), ...require('./test-cekmece'), ...require('./test-ayarlar'), ...require('./test-asama3'), ...require('./test-madde'), ...require('./test-ortada'), ...require('./test-kimlik'), ...require('./test-bolge')]) {
    let e; try { e = await fn(); } catch (x) { e = ['istisna: ' + (x && x.stack)]; }
    if (e && e.skip) { skip++; console.log(`ATLANDI  yeni birim: ${name} (yerel kayıt gerekli)`); continue; }
    if (e.length) { fail++; console.log(`HATA     yeni birim: ${name}: ${e.join(' | ')}`); } else { pass++; console.log(`TAMAM    yeni birim: ${name} ✓`); }
  }
  console.log(`\n${pass} geçti, ${fail} hatalı, ${skip} atlandı`);
  process.exit(fail ? 1 : 0);
})().catch((err) => { console.log('HATA     test çalıştırılamadı:', err && err.stack); process.exit(1); });




