'use strict';
// Faz 12: yeni modüllerin saf mantık testleri (Electron gerekmez). Dışa aktarım: [[ad, işlev], ...]; işlev hata listesi döner.
const fs = require('fs');
const os = require('os');
const path = require('path');
const A = path.join(__dirname, '..');
const req = (p) => require(path.join(A, p));
const Z = (y, mo, d, h = 0, mi = 0) => Date.UTC(y, mo - 1, d, h, mi);
const iso = (ms) => (ms == null ? 'null' : new Date(ms).toISOString().slice(0, 16) + 'Z');

function mk(errors) { return (c, msg) => { if (!c) errors.push(msg); }; }
function tmpDir() { return fs.mkdtempSync(path.join(os.tmpdir(), 'daeva-yeni-')); }

function timersTests() {
  const errors = []; const ok = mk(errors);
  const T = req('lib/timers.js');
  const ev = (id) => T.EVENTS.find((e) => e.id === id);
  ok(T.normRegion('yok') === T.DEFAULT_REGION && T.normRegion('asia-kr') === 'asia-kr', 'normRegion');
  ok(T.normRegion('constructor') === T.DEFAULT_REGION, 'normRegion: prototype adı bölge sayılmamalı');
  // Siege Bosses: Global yalnız Pzt(1)/Per(4)/Cmt(6), 21:30 sunucu saati (Seoul)
  const from = Z(2026, 10, 11, 0, 0), to = Z(2026, 10, 18, 0, 0);
  const slots = T.slotsIn(ev('siegeboss').global, 'Asia/Seoul', from, to);
  const days = slots.map((s) => new Date(s + 9 * 3600000).getUTCDay());
  ok(slots.length === 3 && days.join() === '1,4,6', 'Siege Bosses Global: Pzt/Per/Cmt bekleniyordu, gelen ' + days.join());
  ok(slots.every((s) => new Date(s).getUTCHours() === 12 && new Date(s).getUTCMinutes() === 30), 'Siege Bosses Global 21:30 KST = 12:30Z');
  const kr = T.slotsIn(ev('siegeboss').kr, 'Asia/Seoul', from, to).map((s) => new Date(s + 9 * 3600000).getUTCDay());
  ok(kr.length === 6 && kr.every((d) => d === 3 || d === 6), 'Siege Bosses Kore yalnız Çrş/Cmt (3 saat x 2 gün): ' + kr.join());
  // Tayvan Artifact Siege: Çarşamba 21:30 Taipei = 13:30Z
  const tw = T.eventInfo(ev('siege'), 'asia-tw', Z(2026, 10, 14, 0, 0));
  ok(tw.next === Z(2026, 10, 14, 13, 30), 'Tayvan siege 13:30Z bekleniyordu: ' + iso(tw.next));
  // Kore Artifact Siege: Çarşamba 21:20 KST = 12:20Z
  const krs = T.eventInfo(ev('siege'), 'asia-kr', Z(2026, 10, 14, 0, 0));
  ok(krs.next === Z(2026, 10, 14, 12, 20), 'Kore siege 12:20Z bekleniyordu: ' + iso(krs.next));
  const act = T.eventInfo(ev('siege'), 'asia-tw', Z(2026, 10, 14, 13, 45));
  ok(act.active && act.active.start === Z(2026, 10, 14, 13, 30) && act.active.end === Z(2026, 10, 14, 14, 0), 'active penceresi');
  ok(!T.eventInfo(ev('siege'), 'asia-tw', Z(2026, 10, 14, 14, 0)).active, 'bitiş anında etkinlik sürmüyor sayılmalı');
  ok(T.eventInfo(ev('nahma'), 'global-eu', Z(2026, 10, 12, 0, 0)).next !== null, 'haftalık etkinlik sonraki başlangıcı bulunamadı');
  // Sıfırlama
  const rg = T.resetInfo('global-asia', Z(2026, 10, 17, 0, 0));
  ok(rg.daily === Z(2026, 10, 17, 7, 0), 'Global günlük sıfırlama 07:00Z: ' + iso(rg.daily));
  ok(rg.weekly === Z(2026, 10, 21, 7, 0), 'Global haftalık sıfırlama Çrş 07:00Z: ' + iso(rg.weekly));
  ok(T.resetInfo('global-eu', Z(2026, 10, 17, 8, 0)).daily === Z(2026, 10, 18, 7, 0), 'Global sıfırlama geçince ertesi gün');
  ok(T.resetInfo('asia-kr', Z(2026, 10, 17, 0, 0)).daily === Z(2026, 10, 17, 20, 0), 'Kore günlük sıfırlama 05:00 KST = 20:00Z');
  ok(T.resetInfo('asia-tw', Z(2026, 10, 17, 0, 0)).daily === Z(2026, 10, 17, 21, 0), 'Tayvan günlük sıfırlama 05:00 Taipei = 21:00Z');
  // DST: Berlin 25 Eki 2026'da kış saatine geçer
  ok(T.zonedToUtc(2026, 10, 24, 21, 0, 'Europe/Berlin') === Z(2026, 10, 24, 19, 0), 'DST öncesi CEST (UTC+2)');
  ok(T.zonedToUtc(2026, 10, 26, 21, 0, 'Europe/Berlin') === Z(2026, 10, 26, 20, 0), 'DST sonrası CET (UTC+1)');
  ok(T.zonedToUtc(2026, 3, 29, 12, 0, 'Europe/Berlin') === Z(2026, 3, 29, 10, 0), 'ilkbahar DST sonrası UTC+2');
  const dst = T.eventInfo(ev('siege'), 'global-eu', Z(2026, 10, 24, 20, 0));
  ok(dst.next === Z(2026, 10, 26, 20, 0), 'DST sonrası global siege yerel 21:00 = 20:00Z: ' + iso(dst.next));
  const all = T.allInfo('asia-tw', Z(2026, 10, 14, 13, 45));
  ok(all.length === T.EVENTS.length && all[0].active, 'allInfo: süren etkinlik başta olmalı');
  for (let i = 1; i < all.length; i++) { if (!all[i - 1].active && all[i].next < all[i - 1].next) { errors.push('allInfo sıralama'); break; } }
  // Alarmlar
  const en = { invasion: true };
  const a10 = T.dueAlarms('asia-tw', Z(2026, 10, 14, 5, 20, 0), en);
  ok(a10.length === 1 && a10[0].step === 600 && a10[0].start === Z(2026, 10, 14, 5, 30), 'dueAlarms 10 dk: ' + JSON.stringify(a10));
  const a10b = T.dueAlarms('asia-tw', Z(2026, 10, 14, 5, 20, 0) + 2000, en);
  ok(a10b.length === 1 && a10b[0].key === a10[0].key, 'aynı alarm anahtarı tekrar (dedupe için)');
  ok(T.dueAlarms('asia-tw', Z(2026, 10, 14, 5, 20, 0) + 6000, en).length === 0, 'GRACE sonrası eski alarm ateşlenmemeli');
  ok(T.dueAlarms('asia-tw', Z(2026, 10, 14, 5, 25, 0), en)[0].step === 300, '5 dk alarmı');
  ok(T.dueAlarms('asia-tw', Z(2026, 10, 14, 5, 30, 0), en)[0].step === 0, '0 dk alarmı');
  ok(T.dueAlarms('asia-tw', Z(2026, 10, 14, 5, 20, 0), { invasion: false }).length === 0, 'kapalı etkinlik alarm vermemeli');
  ok(T.dueAlarms('asia-tw', Z(2026, 10, 14, 5, 20, 0), null).length === 0, 'enabled=null alarm vermemeli');
  return errors;
}

function ratingsTests() {
  const errors = []; const ok = mk(errors);
  const R = req('lib/ratings.js');
  const { validate, Ratings } = R;
  ok(validate(null).ok === false && validate('x').ok === false, 'validate: nesne dışı');
  ok(!validate({ targetNickname: '', rating: 3 }).ok, 'boş ad');
  ok(!validate({ targetNickname: 'x'.repeat(R.MAX_NAME + 1), rating: 3 }).ok, 'uzun ad');
  ok(!validate({ targetNickname: 'A', rating: 0 }).ok && !validate({ targetNickname: 'A', rating: 6 }).ok && !validate({ targetNickname: 'A', rating: 2.5 }).ok && !validate({ targetNickname: 'A', rating: '3' }).ok, 'rating 1-5 tam sayı');
  ok(!validate({ targetNickname: 'A', rating: 3, note: 'n'.repeat(R.MAX_NOTE + 1) }).ok, 'uzun not');
  ok(!validate({ targetNickname: 'A', rating: 3, note: 5 }).ok, 'not türü');
  ok(!validate({ targetNickname: 'A', rating: 3, tags: ['uydurma'] }).ok, 'bilinmeyen etiket');
  ok(!validate({ targetNickname: 'A', rating: 3, tags: 'blacklist' }).ok, 'etiket dizi olmalı');
  const v = validate({ targetNickname: '  Kai ', rating: 4, tags: ['toxic', 'toxic', 'leaver'], server: ' S1 ' });
  ok(v.ok && v.value.targetNickname === 'Kai' && v.value.tags.length === 2 && v.value.server === 'S1' && v.value.note === '', 'validate: kırpma/tekilleştirme');
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'sub', 'r.json');
    const r = new Ratings(file); r.load();
    ok(fs.existsSync(file), 'ilk yüklemede dosya yazılmalı');
    ok(r.list().length === 0, 'yeni belge boş');
    const e1 = r.upsert(validate({ targetNickname: 'Kai', rating: 5, tags: ['good-tank'] }).value, 'Ben');
    ok(e1 && e1.id && r.list().length === 1, 'ekleme');
    const e1b = r.upsert(validate({ targetNickname: 'KAI', rating: 2, note: 'geç kaldı', tags: ['blacklist'] }).value, 'Ben');
    ok(e1b.id === e1.id && r.list().length === 1 && r.list()[0].rating === 2, 'aynı ad+sunucu güncellenmeli, çoğalmamalı');
    const e1c = r.upsert(Object.assign(validate({ targetNickname: 'Kai', rating: 3 }).value, { id: e1.id }), 'Ben');
    ok(e1c.id === e1.id && r.list().length === 1, 'id ile güncelleme');
    r.upsert(validate({ targetNickname: 'Mira', rating: 4 }).value, 'Ben');
    ok(r.list().length === 2, 'ikinci kayıt');
    ok(r.summary('kai').rating === 3 && r.summary('KAI'), 'summary büyük/küçük harf duyarsız');
    ok(r.summary('yok') === null, 'summary: yok');
    const io = r.indexObject();
    ok(io.mira && io.mira.r === 4 && io.mira.n === 0 && io.mira.b === 0, 'indexObject mira');
    r.upsert(validate({ targetNickname: 'Mira', rating: 4, tags: ['blacklist'], server: 'S2' }).value, 'Ben');
    ok(r.indexObject().mira.b === 1, 'kara liste bayrağı (b) farklı sunucu kaydıyla da');
    ok(r.summary('mira').rating === 4, 'ortalama');
    let changes = 0; r.onChange = () => { changes++; };
    ok(r.remove(e1.id) === true && r.remove(e1.id) === false && r.remove('yok') === false, 'silme sonuçları');
    ok(changes === 1, 'onChange yalnız başarılı silmede');
    ok(r.flush() === true && r.flush() === false, 'flush: kirliyken true, temizken false');
    ok(!fs.existsSync(file + '.tmp'), 'tmp kalmamalı');
    const r2 = new Ratings(file); r2.load();
    ok(r2.list().length === 2 && r2.clientId === r.clientId, 'dosyadan geri yükleme');
    // Bozuk dosya: yedeklenir, boş belgeyle başlanır
    fs.writeFileSync(file, '{bozuk json');
    const r3 = new Ratings(file); r3.load();
    ok(r3.list().length === 0 && fs.existsSync(file + '.bak'), 'bozuk dosya .bak + boş belge');
    ok(JSON.parse(fs.readFileSync(file, 'utf8')).schemaVersion === 1, 'bozuk dosya yerine temiz belge yazılmalı');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 99, entries: [] }));
    const r4 = new Ratings(file); r4.load(); ok(r4.list().length === 0, 'yanlış şema reddedilmeli');
    fs.writeFileSync(file, JSON.stringify({ schemaVersion: 1, clientId: 'c1', entries: [{ id: 'a', targetNickname: 'Ok', rating: 5, tags: [] }, { id: 'b', targetNickname: '', rating: 5 }, { targetNickname: 'IdYok', rating: 3 }, null, 7] }));
    const r5 = new Ratings(file); r5.load();
    ok(r5.list().length === 1 && r5.list()[0].targetNickname === 'Ok' && r5.clientId === 'c1', 'bozuk girdiler elenmeli');
    const tpl = path.join(dir, 'tpl.json');
    fs.writeFileSync(tpl, JSON.stringify({ entries: [{ id: 't1', targetNickname: 'Sablon', rating: 1, tags: ['blacklist'] }] }));
    const r6 = new Ratings(path.join(dir, 'yeni.json'), tpl); r6.load();
    ok(r6.list().length === 1 && r6.summary('sablon').rating === 1, 'ilk kurulum şablonu');
    const r7 = new Ratings(path.join(dir, 'yeni2.json'), path.join(dir, 'yok-sablon.json')); r7.load();
    ok(r7.list().length === 0, 'şablon yoksa boş belge');
    r.flush(); r5.flush();
  } catch (err) { errors.push('istisna: ' + (err && err.stack)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return errors;
}

function recapTests() {
  const errors = []; const ok = mk(errors);
  const { RecapRing } = req('lib/recap.js');
  const r = new RecapRing(4);
  ok(r.size === 0 && r.lastT() === -Infinity && r.snapshot(1000).length === 0, 'boş tampon');
  for (let i = 1; i <= 6; i++) r.push(i * 1000, i, 100 + i, i * 10, i % 2 === 0);
  ok(r.size === 4, 'kapasite aşılmaz: ' + r.size);
  const s = r.snapshot(6000, Infinity);
  ok(s.length === 4 && s[0].t === 3000 && s[3].t === 6000, 'en eski ezilmeli, sıra eskiden yeniye: ' + s.map((x) => x.t).join());
  ok(r.lastT() === 6000, 'lastT');
  ok(s[3].dot === true && s[2].dot === false && s[3].amount === 60 && s[3].skill === 106 && s[3].actor === 6, 'alanlar');
  ok(r.snapshot(6000, 1500).length === 2, 'pencere süzmesi (6000 ve 5000)');
  r.push(7000, null, undefined, 5, false);
  const l = r.snapshot(7000, Infinity).pop();
  ok(l.actor === null && l.skill === null, 'null/undefined -> null');
  const a = new RecapRing(3), b = new RecapRing(3);
  a.push(1, 1, 1, 1, false); a.push(5, 1, 1, 5, false); b.push(3, 2, 2, 3, false); b.push(7, 2, 2, 7, false);
  const m = RecapRing.merge(a, b).snapshot(10, Infinity);
  ok(m.map((x) => x.t).join() === '3,5,7', 'merge zaman sırası ve kapasiteye kırpma: ' + m.map((x) => x.t).join());
  const big = new RecapRing(); for (let i = 0; i < 1000; i++) big.push(i, 1, 1, 1, false);
  ok(big.size === 128 && big.snapshot(1000, Infinity).length === 128, 'varsayılan kapasite 128');
  return errors;
}

function pbTests() {
  const errors = []; const ok = mk(errors);
  const { PersonalBests, keyOf, MIN_DUR_MS } = req('lib/pb.js');
  ok(keyOf(12, 'X') === 'c12' && keyOf(0, 'Kaira') === 'nkaira' && keyOf(null, '  Kaira ') === 'nkaira', 'keyOf');
  ok(keyOf(null, 'Boss') === null && keyOf(null, '???') === null && keyOf(null, '') === null && keyOf(-1, null) === null, 'keyOf: genel adlar anahtar olmaz');
  const dir = tmpDir();
  try {
    const f = path.join(dir, 'pb.json');
    const p = new PersonalBests(f); p.load();
    let r = p.submit(5, 'Kaira', 1000, 60000, 111);
    ok(r.recorded && !r.isNew && r.prev === null, 'ilk deneme kaydedilir ama rekor sayılmaz');
    r = p.submit(5, 'Kaira', 900, 60000, 112);
    ok(!r.recorded && !r.isNew && r.prev === 1000, 'düşük skor');
    r = p.submit(5, 'Kaira', 1000, 60000, 112);
    ok(!r.recorded, 'eşit skor rekor değil');
    r = p.submit(5, 'Kaira', 1500.4, 60000, 113);
    ok(r.recorded && r.isNew && r.prev === 1000 && p.get(5, 'Kaira').dps === 1500, 'yeni rekor ve yuvarlama');
    r = p.submit(6, 'Argo', 9999, MIN_DUR_MS - 1, 114);
    ok(!r.recorded && p.get(6, 'Argo') === null, 'kısa deneme sayılmaz');
    ok(!p.submit(7, 'Z', NaN, 60000).recorded && !p.submit(7, 'Z', -5, 60000).recorded && !p.submit(null, 'Boss', 100, 60000).recorded, 'geçersiz giriş');
    ok(p.flush() === true && fs.existsSync(f) && !fs.existsSync(f + '.tmp'), 'atomik yazma');
    const q = new PersonalBests(f); q.load();
    ok(q.get(5, 'Kaira').dps === 1500, 'yeniden yükleme');
    fs.writeFileSync(f, '{{{'); const bz = new PersonalBests(f); bz.load();
    ok(bz.map.size === 0, 'bozuk dosya boş sayılır');
    fs.writeFileSync(f, JSON.stringify({ v: 1, bests: { c1: { name: 'a', dps: 5, at: 1 }, c2: { dps: -1 }, c3: 'x', c4: null } })); const pz = new PersonalBests(f); pz.load();
    ok(pz.map.size === 1, 'bozuk girdiler elenir');
    const big = new PersonalBests(path.join(dir, 'b.json'));
    for (let i = 1; i <= 505; i++) big.submit(i, 'B' + i, 100 + i, 60000, i);
    ok(big.map.size === 500 && !big.get(1, 'B1') && big.get(505, 'B505'), 'MAX_ENTRIES: en eski atılmalı');
    big.flush(); p.flush();
  } catch (err) { errors.push('istisna: ' + (err && err.stack)); } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return errors;
}

function autoshowTests() {
  const errors = []; const ok = mk(errors);
  const AS = req('lib/autoshow.js');
  const H = 1000;
  let a = AS.create({ hideAfterMs: H, now: 0 });
  ok(a.tick(500, { visible: true }) === null, 'eşikten önce gizleme yok');
  ok(a.tick(1000, { visible: true }) === null, 'tam eşikte gizleme yok');
  ok(a.tick(1001, { visible: true }) === 'hide' && a.idle && a.autoHidden, 'eşik aşılınca gizle');
  ok(a.tick(1100, { visible: false }) === null, 'zaten gizliyse null');
  ok(a.gamePacket(1200, false) === 'show' && !a.autoHidden, 'paket gelince göster');
  ok(a.gamePacket(1300, true) === null, 'görünürken göster yok');
  ok(a.tick(2000, { visible: true }) === null, 'son paketten 700ms: gizleme yok');
  ok(a.tick(2400, { visible: true }) === 'hide', 'son paketten 1100ms: gizle');
  a = AS.create({ hideAfterMs: H, now: 0 });
  ok(a.tick(5000, { visible: true, drawerOpen: true }) === null, 'çekmece açıkken gizleme yok');
  a = AS.create({ hideAfterMs: H, now: 0 });
  a.gamePacket(100, true); a.manualShow();
  ok(a.override === 'shown' && a.tick(5000, { visible: true }) === null, 'elle açılan gizlenmez');
  ok(a.gamePacket(6000, true) === null && a.override === null, 'sessizlik sonrası ilk paket elle kararı sıfırlar');
  ok(a.tick(8000, { visible: true }) === 'hide', 'sıfırlanınca yeniden gizlenebilir');
  a = AS.create({ hideAfterMs: H, now: 0 });
  a.gamePacket(100, true); a.manualHide();
  ok(a.gamePacket(200, false) === null, 'elle gizlenen aynı oturumda gösterilmez');
  ok(a.gamePacket(5000, false) === 'show', 'yeni oturumda gösterilir');
  a = AS.create({ hideAfterMs: H, now: 0 });
  a.gamePacket(100, true); a.manualHide();
  ok(a.gamePacket(100 + H + 1, false) === 'show', 'tick olmadan boşluk sonrası paket override sıfırlar');
  a = AS.create({ hideAfterMs: H, enabled: false, now: 0 });
  ok(a.tick(99999, { visible: true }) === null && a.gamePacket(99999, false) === null, 'devre dışıyken pasif');
  a.setEnabled(true); ok(a.enabled && a.tick(200000, { visible: true }) === 'hide', 'setEnabled');
  a.start(200000); ok(a.tick(200500, { visible: true }) === null && a.tick(201500, { visible: true }) === 'hide', 'start() sayacı sıfırlar');
  ok(AS.create({}).enabled === true && AS.HIDE_AFTER_MS === 30000 && AS.create({}).hideAfterMs === 30000, 'varsayılanlar (30 sn)');
  // autoHideSec doğrulama: tamsayı 10-300, geçersiz → 30
  ok(AS.normHideSec(undefined) === 30 && AS.normHideSec('abc') === 30 && AS.normHideSec(NaN) === 30 && AS.normHideSec(null) === 30 && AS.normHideSec('') === 30, 'autoHideSec: geçersiz → 30');
  ok(AS.normHideSec(5) === 10 && AS.normHideSec(1000) === 300 && AS.normHideSec(45.6) === 46 && AS.normHideSec('60') === 60, 'autoHideSec: 10-300 aralığına sıkıştırma/yuvarlama');
  a = AS.create({ now: 0 }); a.setHideSec(60);
  ok(a.hideAfterMs === 60000 && a.tick(59000, { visible: true }) === null && a.tick(61000, { visible: true }) === 'hide', 'setHideSec: süre ayardan gelir');
  a = AS.create({ now: 0 });
  ok(a.tick(29000, { visible: true }) === null && a.tick(31000, { visible: true }) === 'hide' && a.gamePacket(32000, false) === 'show', '30 sn sessizlik → gizle, paket gelince kendiliğinden geri gelir');
  return errors;
}

function maskTests() {
  const errors = []; const ok = mk(errors);
  const M = req('ui/mask.js');
  const m = M.create();
  ok(m.alias('kai', 12, true, 'Ben') === 'Ben' && m.alias('x', 12, true) === 'Me', 'isMe etiketi');
  ok(m.size === 0, 'isMe haritaya girmez');
  const a1 = m.alias('kai', 12), a2 = m.alias('kai', 12), a3 = m.alias('KAI', 12);
  ok(a1 === 'Tank 1' && a2 === a1 && a3 === a1, 'aynı ad aynı etiket (büyük/küçük harf duyarsız): ' + a1 + '/' + a3);
  ok(m.alias('mira', 17) === 'Healer 1' && m.alias('lia', 18) === 'Healer 2', 'şifacı sınıfları ortak sayaç');
  ok(m.alias('r', 14) === 'Ranger 1' && m.alias('g', 11) === 'Gladiator 1', 'sınıf adı etiketi');
  ok(m.alias('bilinmez', null) === 'Player 1' && m.alias('bilinmez2', 0) === 'Player 2', 'sınıfsız Player');
  ok(m.alias('bilinmez', 12) === 'Player 1', 'sınıf sonradan gelse etiket değişmez');
  ok(m.peek('KAI') === 'Tank 1' && m.peek('yok') === null && m.peek(null) === null, 'peek');
  ok(m.alias('yeni', 12) === 'Tank 2', 'peek sayaç ilerletmez');
  const l = M.create();
  const first = l.alias('p0', null);
  for (let i = 1; i < 400; i++) l.alias('p' + i, null);
  ok(l.size === 300, 'harita 300 ile sınırlı: ' + l.size);
  ok(l.peek('p0') === null && first === 'Player 1', 'en eski atıldı');
  ok(l.alias('p0', null) === 'Player 401', 'atılan yeniden gelirse yeni numara (çakışma yok)');
  const l2 = M.create(); l2.alias('a', null); l2.alias('b', null);
  for (let i = 0; i < 298; i++) l2.alias('f' + i, null);
  l2.alias('a', null);
  l2.alias('yeni', null);
  ok(l2.peek('a') !== null && l2.peek('b') === null, 'LRU: son kullanılan korunur');
  m.reset(); ok(m.size === 0 && m.alias('kai', 12) === 'Tank 1', 'reset');
  ok(typeof m.alias(undefined, null) === 'string', 'undefined anahtar çökmemeli');
  const mm = M.create();
  const st = {
    enc: { actors: [{ name: 'Kai', cls: 12, own: false }, { name: 'Ben', cls: 15, own: true }, { name: 'Zed', cls: 17 }], boss: { target: 'Mira' } },
    bossEnc: { actors: [{ name: 'Kai', cls: 12 }], boss: { target: 'Ghost' } },
    deaths: [{ name: 'Lia', cls: 18 }],
    view: { party: { members: ['Kai', 'Partner'] } },
  };
  const t = M.buildTable(mm, st, 'Zed');
  ok(t['n:ben'] === 'Me', 'own:true -> Me');
  ok(t['n:zed'] === 'Me', 'charName eşleşmesi -> Me');
  ok(t['n:kai'] === 'Tank 1' && t['n:lia'] === 'Healer 1', 'sınıfa göre etiket');
  ok(t['n:mira'] === 'Player 1' && t['n:ghost'] === 'Player 2' && t['n:partner'] === 'Player 3', 'sınıfsız çıplak adlar Player: ' + JSON.stringify(t));
  ok(JSON.stringify(M.buildTable(mm, st, 'Zed')) === JSON.stringify(t), 'buildTable tekrarında etiketler sabit');
  ok(Object.keys(M.buildTable(M.create(), null, null)).length === 0, 'buildTable(null)');
  ok(M.buildTable(M.create(), { enc: { actors: [{ name: 'constructor', cls: 12 }] } }, null)['n:constructor'] === 'Tank 1', "'constructor' adı güvenli");
  const c = M.createClient();
  ok(c.alias('Kai', 12, false) === '…', 'tabloda yoksa …');
  c.apply(t);
  ok(c.alias('KAI', 12) === 'Tank 1' && c.alias('x', 1, true, 'Ben') === 'Ben' && c.alias('Ben', 15, false, 'Ben') === 'Ben', 'client alias');
  ok(c.size === Object.keys(t).length, 'client size');
  c.apply(null); ok(c.size === Object.keys(t).length, 'apply(null) tabloyu bozmaz');
  c.reset(); ok(c.size === 0, 'client reset');
  return errors;
}

function itemKindTests() {
  const errors = []; const ok = mk(errors);
  const { itemKind } = req('lib/engine.js');
  const cases = [
    [2210001, '', 'scroll'], [2210000, 'x', 'scroll'], [1, 'Teleport Scroll', 'scroll'], [1, 'Hero Talisman', 'scroll'],
    [2010001, '', 'potion'], [2015000, '', 'potion'], [2020000, '', 'potion'], [2030000, '', 'item'], [1, 'Greater Elixir', 'potion'], [1, 'HP Serum', 'potion'], [1, 'Brew of Might', 'potion'],
    [2160005, '', 'food'], [1, 'Beef Stew', 'food'], [1, 'Roast Meat', 'food'],
    [2110001, '', 'drink'], [1, 'Mint Tea', 'drink'], [1, 'Apple Juice', 'drink'],
    [2900001, '', 'rebirth'], [1, 'Resurrect Stone', 'rebirth'], [1, 'Spiritstone', 'rebirth'],
    [2500000, '', 'item'], [0, '', 'item'], [null, null, 'item'], [undefined, undefined, 'item'], ['abc', 'Rock', 'item'],
  ];
  for (const [c, n, want] of cases) { const got = itemKind(c, n); if (got !== want) errors.push(`itemKind(${c}, ${n}) = ${got}, beklenen ${want}`); }
  ok(itemKind(2210000, 'Healing Potion') === 'scroll', 'kod bloğu ada göre önceliklidir');
  return errors;
}

// 0x0297 sahte paket kurucu (tools/test.js partyPacket ile aynı düzen; sunucu numarası dbid'den sonraki u32'nin üst 16 biti)
function partyPkt(slots) {
  const out = [];
  let bitLeft = 0;
  const u8 = (v) => out.push(v & 255);
  const u32 = (v) => { for (let i = 0; i < 4; i++) u8(v >>> (8 * i)); };
  const u16 = (v) => { u8(v); u8(v >> 8); };
  const str = (t) => { const b = Buffer.from(t, 'utf8'); u8(b.length); out.push(...b); };
  const bit = () => { if (!bitLeft) { u8(0); bitLeft = 8; } bitLeft--; };
  u32(0); str('x'); u8(slots.length); u32(600012); u8(0); u8(0); for (let i = 0; i < 8; i++) u8(0); bit(); u8(0); u8(0);
  u8(slots.length);
  slots.forEach((m, i) => {
    const mask = 0b11110;
    u8(mask); u8(i + 1); u32(100000 + i); u16(0); u16(m.server);
    str(m.name); u32(9); u32(45); u32(2000);
    if (mask & 2) bit();
    bit();
    if (mask & 4) u16(m.server);
    if (mask & 8) u16(4302);
    u8(4); for (let k = 0; k < 8; k++) u8(0); u8(0);
    if (mask & 16) for (let k = 0; k < 8; k++) u8(0);
    u8(1); u8(1);
  });
  u8(0); u8(0);
  return Buffer.from(out);
}

function serverTests() {
  const errors = []; const ok = mk(errors);
  const { parseParty } = req('lib/combat.js');
  const { serverLabel } = req('lib/servers.js');
  const pp = parseParty(partyPkt([{ name: 'Aaa', server: 1301 }, { name: 'Bbb', server: 2301 }, { name: 'Ccc', server: 0 }]));
  ok(pp && pp.memberDetails.length === 3, 'parseParty: 3 üye');
  ok(pp && pp.memberDetails[0].server === 1301 && pp.memberDetails[1].server === 2301 && pp.memberDetails[2].server === 0, 'parseParty: server alanı (1301 / 2301 / 0)');
  ok(pp && pp.memberDetails[0].level === 45 && pp.memberDetails[0].gearScore === 2000 && pp.memberDetails[0].name === 'Aaa', 'parseParty: diğer alanlar korunur');
  ok(serverLabel(1301) === 'Siel (EU)', 'serverLabel(1301): ' + serverLabel(1301));
  ok(serverLabel(2301) === 'Israphel (EU)', 'serverLabel(2301): ' + serverLabel(2301));
  ok(serverLabel(9999) === 'S9999', 'tabloda yok → S<numara>: ' + serverLabel(9999));
  ok(serverLabel(0) === '?' && serverLabel(null) === '?' && serverLabel(undefined) === '?' && serverLabel('x') === '?' && serverLabel(-5) === '?', 'numara yok/0/geçersiz → ?');
  ok(serverLabel(1, { 1: { region: 'naw', name: 'Foo' } }) === 'Foo (NA-W)', 'verilen tablo + bölge kısaltması');
  ok(serverLabel(2, { 2: { region: 'zz', name: 'Bar' } }) === 'Bar (ZZ)', 'bilinmeyen bölge büyük harf');
  ok(serverLabel(1, { constructor: 1 }) === 'S1', 'prototip adları tabloya karışmaz');
  return errors;
}

function ledgerTests() {
  const errors = []; const ok = mk(errors);
  const { Ledger, pidOf } = req('lib/ledger.js');
  const { Ratings, validate } = req('lib/ratings.js');
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'sub', 'defter.jsonl');
    const L = new Ledger(file); L.load();
    const fight = (fk, at, actors) => ({ fk, boss: 'Boss A', code: 5, at, dur: 60000, killed: true, actors });
    ok(L.record(fight('1:1', Z(2026, 10, 1), [{ name: 'Kai', server: 1301, cls: 14, total: 1000 }, { name: 'Kai', server: 2301, cls: 12, total: 500 }, { name: 'Sınıf #5', server: 0, total: 9 }])) !== null, 'kayıt eklendi');
    L.record(fight('2:1', Z(2026, 10, 2), [{ name: 'KAI', server: 1301, cls: 14, total: 1500 }, { name: 'Mira', server: 0, total: 10 }]));
    ok(pidOf('Kai', 1301) !== pidOf('Kai', 2301), 'aynı ad farklı sunucu → ayrı kimlik');
    ok(pidOf('Kai', 1301) === pidOf('KAI', 1301), 'aynı ad + sunucu (büyük/küçük harf farksız) → aynı kimlik');
    ok(L.seen('Kai', 1301).n === 2 && L.seen('Kai', 1301).last === Z(2026, 10, 2), 'aynı oyuncu iki günde TEK kayıtta birleşir (2 kez, son görülme)');
    ok(L.seen('Kai', 2301).n === 1, 'başka sunucudaki Kai ayrı oyuncu');
    ok(L.seen('Mira', 0).n === 1 && L.seen('Mira', 1301) === null, 'sunucusu bilinmeyen oyuncu ayrı');
    ok(L.seen('Sınıf #5', 0) === null, 'adı bilinmeyen (#) oyuncu deftere girmez');
    // aynı karşılaşma (birleşme) güncellenir, ikilenmez
    L.record(fight('2:1', Z(2026, 10, 2), [{ name: 'Kai', server: 1301, cls: 14, total: 2500 }]));
    ok(L.seen('Kai', 1301).n === 2 && L.seen('Kai', 1301).dmg === 3500 && L.seen('Mira', 0) === null, 'aynı fk yeniden yazılınca son kayıt geçerli');
    ok(L.record({ fk: '', actors: [] }) === null && L.record(null) === null && L.record(fight('3:1', 1, [])) === null, 'geçersiz/boş kayıt reddedilir');
    // kalıcılık: eklemeli jsonl, yeniden yükleme, yarım yazılmış son satır
    fs.appendFileSync(file, '{"fk":"yarim","p":[');
    const L2 = new Ledger(file); L2.load();
    ok(L2.seen('Kai', 1301).n === 2 && L2.seen('Kai', 2301).n === 1 && L2.size === 2, 'dosyadan geri yükleme (bozuk satır atlanır)');
    L2.record(fight('4:1', Z(2026, 10, 3), [{ name: 'Kai', server: 1301, total: 1 }]));
    const L3 = new Ledger(file); L3.load();
    ok(L3.seen('Kai', 1301).n === 3, 'yarım satırdan sonra ekleme bozulmaz');
    ok(Object.keys(L3.summaries()).includes('kai|1301'), 'summaries anahtar biçimi ad|sunucu');

    // puanlama kimliği: aynı ad farklı sunucu = AYRI kayıt; hızlı puan / kara liste
    const R = new Ratings(path.join(dir, 'r.json')); R.load();
    ok(R.quick('Kai', 1301, { rating: 4 }, 'Ben').ok && R.quick('Kai', 2301, { rating: 1, blacklist: true }, 'Ben').ok, 'hızlı puan');
    ok(R.list().length === 2, 'aynı ad farklı sunucu iki ayrı kayıt');
    ok(R.quick('kai', 1301, { rating: 5 }, 'Ben').ok && R.list().length === 2 && R.find('Kai', '1301').rating === 5, 'aynı ad + sunucu birleşir');
    ok(R.isBlacklisted('Kai', '2301') === true && R.isBlacklisted('Kai', '1301') === false, 'kara liste sunucuya göre');
    ok(R.isBlacklisted('Kai', '') === false, 'sunucusuz kayıt yok');
    ok(R.quick('Kai', 1301, { rating: 0 }).ok && R.find('Kai', '1301') === null && R.list().length === 1, 'puan 0 + etiketsiz/notsuz → kayıt silinir (temizle)');
    ok(R.quick('Kai', 2301, { blacklist: false }).ok && R.find('Kai', '2301').tags.length === 0 && R.find('Kai', '2301').rating === 1, 'kara liste kaldırılır, puan korunur');
    ok(R.quick('Neo', 0, { blacklist: true }).ok && R.isBlacklisted('Neo', '') && R.find('Neo', '').rating === 0, 'puansız kara liste kaydı (rating 0)');
    ok(R.lookup('Neo', '1301') && R.lookup('Neo', '1301').tags.includes('blacklist'), 'lookup: sunucusuz eski kayıt yedek olur');
    ok(!R.quick('Kai', 1301, { rating: 6 }).ok && !R.quick('', 1, { rating: 3 }).ok, 'geçersiz puan/ad reddedilir');
    const io = R.indexObject();
    ok(io['neo|'] && io['neo|'].b === 1 && io['neo|'].r === 0 && io['kai|2301'] && io['kai|2301'].r === 1, 'indexObject ad|sunucu anahtarları');
    R.flush();
    const R2 = new Ratings(path.join(dir, 'r.json')); R2.load();
    ok(R2.find('Neo', '') && R2.find('Neo', '').rating === 0 && R2.list().length === 2, 'puansız kayıt dosyadan yüklenir');
    ok(!validate({ targetNickname: 'A', rating: 0 }).ok && validate({ targetNickname: 'A', rating: 0 }, { allowZero: true }).ok, 'validate: 0 yalnız allowZero ile');
    ok(validate({ targetNickname: 'A', rating: 3, server: 1301 }).value.server === '1301', 'validate: sayısal sunucu metne çevrilir');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return errors;
}

function blacklistWarnTests() {
  // Kara liste uyarısı: oyuncu başına oturumda bir kez (main.js warnBlacklisted ile aynı mantık; Electron gerekmez)
  const errors = []; const ok = mk(errors);
  const { Ratings } = req('lib/ratings.js');
  const dir = tmpDir();
  try {
    const R = new Ratings(path.join(dir, 'r.json')); R.load();
    R.quick('Bad', 1301, { blacklist: true }, 'Ben');
    const warned = new Set(); const sent = [];
    const warn = (details) => {
      for (const m of details) {
        const id = m.name.toLowerCase() + '|' + (m.server || 0);
        if (warned.has(id) || !R.isBlacklisted(m.name, m.server > 0 ? String(m.server) : '')) continue;
        warned.add(id); sent.push(m.name + '|' + m.server);
      }
    };
    const party = [{ name: 'Bad', server: 1301 }, { name: 'Good', server: 1301 }, { name: 'Bad', server: 2301 }];
    warn(party); warn(party); warn(party);
    ok(sent.length === 1 && sent[0] === 'Bad|1301', 'üç paket, tek uyarı; başka sunucudaki aynı ad uyarılmaz: ' + sent.join());
    R.quick('Bad', 2301, { blacklist: true }, 'Ben');
    warn(party);
    ok(sent.length === 2 && sent[1] === 'Bad|2301', 'sonradan kara listeye girene bir kez daha');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return errors;
}

function alertsTests() {
  const errors = []; const ok = mk(errors);
  const T = req('lib/timers.js');
  const A = req('lib/alerts.js');
  const REG = 'global-asia'; // sunucu saati Seoul; Spacetime Rift 20:00 KST = 11:00Z
  const start = Z(2026, 10, 17, 11, 0);
  const on = { rift: true };
  const run = (sch, from, to, enabled = on, steps = [10, 5, 1, 0]) => {
    const got = [];
    for (let t = from; t <= to; t += 1000) for (const a of sch.tick(t, REG, enabled, steps)) got.push({ step: a.step, t });
    return got;
  };
  // her eşik bir kez, doğru anda
  let got = run(A.createScheduler(T), start - 12 * 60000, start + 60000);
  ok(got.length === 4 && got.map((g) => g.step).join() === '10,5,1,0', 'eşikler 10,5,1,0 bir kez: ' + JSON.stringify(got));
  ok(got.every((g) => g.t === start - g.step * 60000), 'eşik tam zamanında tetiklenmeli');
  // iki kez aynı dakikayı tarasa bile tekrar yok (aynı zamanlayıcı)
  const sch = A.createScheduler(T);
  const first = run(sch, start - 6 * 60000, start - 4 * 60000);
  const again = run(sch, start - 4 * 60000 + 1000, start - 4 * 60000 + 5000).concat(first.length ? [] : []);
  ok(first.length === 1 && first[0].step === 5 && again.length === 0, 'aynı eşik ikinci kez tetiklenmedi');
  // yeniden başlatma: yeni zamanlayıcı, geçmiş eşikleri tekrarlamaz, kalanları tetikler
  const restart = run(A.createScheduler(T), start - 5 * 60000 + 30000, start + 1000);
  ok(restart.map((g) => g.step).join() === '1,0', 'yeniden başlatmada geçmiş eşik (10,5) tekrarlanmadı: ' + restart.map((g) => g.step).join());
  // ilk tick hiçbir şey ateşlemez (tam eşik anında açılış)
  ok(A.createScheduler(T).tick(start - 300000, REG, on, [5]).length === 0, 'açılış anındaki eşik ateşlenmemeli');
  // saat atlaması: ileri (uyku/ayar) ve geri
  const j = A.createScheduler(T);
  j.tick(start - 3600000, REG, on, [10, 5, 1, 0]);
  ok(j.tick(start - 300000, REG, on, [10, 5, 1, 0]).length === 0, 'büyük ileri atlamada eski eşikler ateşlenmemeli');
  ok(j.tick(start - 299000, REG, on, [10, 5, 1, 0]).length === 0, 'atlamadan sonra normal akış sessiz');
  ok(j.tick(start - 600000, REG, on, [10, 5, 1, 0]).length === 0, 'saat geri alınınca ateşlenmemeli');
  const back = run(j, start - 600000 + 1000, start - 590000);
  ok(back.length === 0, 'geri sarılan saatte aynı eşik tekrar ateşlenmemeli');
  // seçili eşikler ve etkinlik süzgeci
  ok(run(A.createScheduler(T), start - 12 * 60000, start + 1000, on, [15]).length === 0, 'rift 15 dk: dar aralıkta yok');
  ok(run(A.createScheduler(T), start - 16 * 60000, start + 1000, on, [15]).map((g) => g.step).join() === '15', '15 dk eşiği seçilince tetiklenir');
  ok(run(A.createScheduler(T), start - 12 * 60000, start + 1000, {}, [5]).length === 0, 'etkinlik kapalıyken yok');
  ok(run(A.createScheduler(T), start - 12 * 60000, start + 1000, on, []).length === 0, 'eşik seçilmediyse yok');
  // normalize
  const n = A.normalize({ timerAlertMode: 'x', timerAlertSteps: [7, 5, 5, 99, 15], timerSound: 'yok', timerVolume: 500, timerToastSec: 0, timerCombat: '?', timerToastMode: 1 });
  ok(n.timerAlertMode === 'both' && n.timerAlertSteps.join() === '15,5' && n.timerSound === 'chime' && n.timerVolume === 100 && n.timerToastSec === 3 && n.timerCombat === 'quiet' && n.timerToastMode === 'auto', 'normalize: ' + JSON.stringify(n));
  ok(A.normalize({}).timerVolume === 70 && A.normalize({}).timerAlertSteps.join() === '10,5,1,0', 'normalize varsayılanlar');
  ok(A.normalize({ timerAlertSteps: [] }).timerAlertSteps.length === 0, 'boş eşik listesi korunur');
  // uyarı türü süzgeci
  const cfg = (m, extra) => ({ timerAlertMode: m, timerTts: true, timerCombat: 'normal', ...(extra || {}) });
  const d = (m, fight, extra) => A.decide(cfg(m, extra), fight);
  ok(JSON.stringify(d('both', false)) === JSON.stringify({ sound: true, tts: true, toast: 'full' }), 'both');
  ok(JSON.stringify(d('sound', false)) === JSON.stringify({ sound: true, tts: true, toast: null }), 'sound');
  ok(JSON.stringify(d('text', false)) === JSON.stringify({ sound: false, tts: false, toast: 'full' }), 'text');
  ok(JSON.stringify(d('off', false)) === JSON.stringify({ sound: false, tts: false, toast: null }), 'off');
  ok(d('both', false, { timerTts: false }).tts === false && d('both', false, { timerTts: false }).sound === true, 'TTS kapalıyken yalnız ses');
  // savaşta sessiz
  const q = (m, extra) => A.decide({ timerAlertMode: m, timerTts: true, timerCombat: 'quiet', ...(extra || {}) }, true);
  ok(JSON.stringify(q('both')) === JSON.stringify({ sound: false, tts: false, toast: 'quiet' }), 'savaşta sessiz: ses yok, sessiz yazı');
  ok(JSON.stringify(q('sound')) === JSON.stringify({ sound: false, tts: false, toast: 'quiet' }), 'yalnız ses modunda da savaşta sessiz yazı');
  ok(q('off').toast === null && !q('off').sound, 'kapalıyken savaşta da yok');
  ok(A.decide({ timerAlertMode: 'both', timerTts: true, timerCombat: 'normal' }, true).sound === true, 'normal: savaşta da ses');
  const sep = (extra) => A.decide({ timerAlertMode: 'both', timerCombat: 'normal', ...extra }, false);
  ok(sep({ timerBeep: false, timerTts: true }).sound === false && sep({ timerBeep: false, timerTts: true }).tts === true, 'alerts: yalnız sesli okuma (zil kapalı)');
  ok(sep({ timerBeep: true, timerTts: false }).sound === true && sep({ timerBeep: true, timerTts: false }).tts === false, 'alerts: yalnız zil (okuma kapalı)');
  ok(A.decide({ timerAlertMode: 'both', timerTts: true, timerCombat: 'quiet' }, false).sound === true, 'savaşta değilken ses var');
  // savaş tespiti: son 8 sn
  const now = Z(2026, 10, 17, 12, 0);
  ok(A.inFight(now, now - 3000, 0) && A.inFight(now, 0, now - 7000), 'son 8 sn içinde hasar/beceri = savaşta');
  ok(!A.inFight(now, now - 9000, now - 20000) && !A.inFight(now, 0, 0), '8 sn sonra savaş değil');
  // TTS metni
  ok(A.ttsText('Siege Bosses (Tamasa / Argo / Kaira)', 5) === 'Siege Bosses in 5 minutes' && A.ttsText('Boss (a) x (b)', 0) === 'Boss x is starting now', 'alerts: TTS parantez içini okumaz');
  ok(A.ttsText('Siege boss', 5) === 'Siege boss in 5 minutes' && A.ttsText('Siege boss', 1) === 'Siege boss in 1 minute' && A.ttsText('Siege boss', 0) === 'Siege boss is starting now', 'ttsText');
  return errors;
}

function threatTests() {
  const errors = []; const ok = mk(errors);
  const { Engine } = req('lib/engine.js');
  const eng = new Engine({ now: () => 0, setTimer: () => ({}), clearTimer() {}, cdConfig: {}, onEvent: () => {} });
  ok(typeof eng.threatGate === 'undefined' && typeof eng.evalThreat === 'undefined', 'threat: uyarı işlevleri motorda yok');
  const rd = (f) => fs.readFileSync(path.join(A, f), 'utf8');
  const main = rd('main.js'), eg = rd('lib/engine.js'), html = rd('ui/drawer.html'), pl = rd('ui/panel.js'), i18n = rd('ui/i18n.js');
  ok(!/case 'threat'/.test(main) && !/soundThreat|soundChoiceThreat/.test(html + rd('ui/drawer.js') + pl) && !/evalThreat|threatGate/.test(eg + main), 'threat: uyarı gönderimi / ayarı / arayüzü kalmadı');
  ok(!/Boss targeting you/i.test(main + eg + pl + rd('ui/sound.js')) && !/Boss Threat Alert/.test(i18n + html), 'threat: sesli okuma ve metinler kalmadı');
  ok(/for \(const k of \['soundThreat', 'soundChoiceThreat'\]\) delete settings\[k\]/.test(main), 'threat: eski ayar anahtarları loadSettings ile silinir');
  ok(/bossTarget/.test(main) && /noteBossTarget/.test(rd('lib/meter.js') + eg), 'boss hedef göstergesi duruyor');
  return errors;
}

function drawerTabsTests() {
  const errors = []; const ok = mk(errors);
  const DT = req('lib/drawertabs.js');
  const html = fs.readFileSync(path.join(A, 'ui', 'drawer.html'), 'utf8');
  const ids = [...html.matchAll(/data-tab="([a-z]+)"/g)].map((m) => m[1]);
  ok(ids.length > 0 && ids.every((x) => DT.TABS.includes(x)) && DT.TABS.every((x) => ids.includes(x)), 'sekme tablosu drawer.html ile aynı: ' + ids);
  ok(DT.normTab('beceriler') === 'skills' && DT.normTab('genel') === 'general' && DT.normTab('Beceriler') === 'skills', 'eski Türkçe adlar çevrilir');
  ok(DT.TABS.join() === 'boss,skills,timers,general', 'tam dört sekme: Boss ve Oyuncular, Beceriler, Zamanlayıcılar, Ayarlar');
  ok(DT.normTab('boss') === 'boss' && DT.normTab('skills') === 'skills' && DT.normTab('timers') === 'timers' && DT.normTab('general') === 'general', 'gerçek kimlikler korunur');
  ok(DT.normTab('players') === 'boss' && DT.normTab('rate') === 'boss' && DT.normTab('deaths') === 'boss' && DT.normTab('ölümler') === 'boss' && DT.normTab('about') === 'general', 'kalkan sekmeler yeni yerine çevrilir (Rate/Deaths → Boss ve Oyuncular, About → Ayarlar)');
  ok(DT.normTab(undefined) === DT.DEFAULT_TAB && DT.normTab('???') === DT.DEFAULT_TAB && DT.normTab(5) === DT.DEFAULT_TAB && DT.normTab('constructor') === DT.DEFAULT_TAB, 'bilinmeyen ad varsayılan sekmeye düşer');
  return errors;
}

function noDeleteTests() {
  const errors = []; const ok = mk(errors);
  const rd = (f) => fs.readFileSync(path.join(A, f), 'utf8');
  ok(!/boss-log-delete|bossLogDelete/.test(rd('main.js') + rd('ui/preload.js') + rd('ui/drawer.js')), 'geçmişten silme: IPC/köprü/arayüz kaldırıldı');
  ok(!/data-del|bh-del|data-yes/.test(rd('ui/drawer.js')), 'geçmişten silme: düğme/onay yok');
  return errors;
}

function noteTests() {
  const errors = []; const ok = mk(errors);
  const { Ratings } = req('lib/ratings.js');
  const { Ledger } = req('lib/ledger.js');
  const RATE = req('lib/rate.js');
  const dir = tmpDir();
  try {
    const file = path.join(dir, 'r.json');
    const R = new Ratings(file); R.load();
    let r = R.quick('Kai', 1301, { note: '  Güvenilir tank  ' }, 'Ben');
    ok(r.ok && r.entry && r.entry.note === 'Güvenilir tank' && r.entry.rating === 0, 'not tek başına kaydolur (kırpılmış)');
    ok(R.find('Kai', '1301').note === 'Güvenilir tank', 'not okunur');
    r = R.quick('Kai', 1301, { rating: 4 }, 'Ben');
    ok(r.ok && r.entry.note === 'Güvenilir tank' && r.entry.rating === 4, 'puan değişince not korunur');
    r = R.quick('Kai', 1301, { note: 'x'.repeat(301) }, 'Ben');
    ok(!r.ok && R.find('Kai', '1301').note === 'Güvenilir tank', '301 karakter reddedilir, eski not kalır');
    ok(R.quick('Kai', 1301, { note: 'x'.repeat(300) }, 'Ben').ok, '300 karakter kabul');
    ok(!R.quick('Kai', 1301, { note: 5 }, 'Ben').ok, 'metin olmayan not reddedilir');
    // özet: not metni + panel göstergesi
    R.quick('Kai', 1301, { note: 'Güvenilir tank' }, 'Ben');
    ok(R.lookup('Kai', '1301').note === 'Güvenilir tank' && R.indexObject()['kai'].n === 1, 'özette not + n=1');
    // kalıcılık
    R.flush();
    const R2 = new Ratings(file); R2.load();
    ok(R2.find('Kai', '1301').note === 'Güvenilir tank', 'not yeniden açılışta korunur');
    // puanlama ekranı satırı
    const L = new Ledger(path.join(dir, 'd.jsonl')); L.load();
    L.record({ fk: 'a', boss: 'Tamasa', code: 1, at: Z(2026, 10, 14, 12), dur: 1000, killed: true, actors: [{ name: 'Ben', server: 1301, total: 9 }, { name: 'Kai', server: 1301, total: 5 }] });
    const d = RATE.collect(L, R2, { me: 'ben' });
    const p = d.encs[0].players.find((x) => x.n === 'Kai');
    ok(p && p.note === 'Güvenilir tank', 'rate.collect satırında not var');
    // notu silince kayıt (başka içerik yoksa) kalkar
    const R3 = new Ratings(path.join(dir, 'r3.json')); R3.load();
    R3.quick('Mira', 0, { note: 'a' }, 'Ben');
    const q = R3.quick('Mira', 0, { note: '' }, 'Ben');
    ok(q.ok && q.entry === null && !R3.find('Mira', ''), 'notu boşaltınca içeriksiz kayıt silinir');
    // geriye uyumluluk: notu olmayan eski dosya
    const old = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const e of old.entries) delete e.note;
    fs.writeFileSync(file, JSON.stringify(old));
    const R4 = new Ratings(file); R4.load();
    ok(R4.lookup('Kai', '1301') && R4.lookup('Kai', '1301').note === '' && R4.lookup('Kai', '1301').hasNote === false, 'notsuz eski kayıt hatasız okunur');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return errors;
}

function rateTests() {
  const errors = []; const ok = mk(errors);
  const { Ledger } = req('lib/ledger.js');
  const { Ratings } = req('lib/ratings.js');
  const RATE = req('lib/rate.js');
  const dir = tmpDir();
  try {
    const L = new Ledger(path.join(dir, 'd.jsonl')); L.load();
    const R = new Ratings(path.join(dir, 'r.json')); R.load();
    const fight = (fk, at, boss, actors) => ({ fk, boss, code: 1, at, dur: 1000, killed: true, actors });
    const d1 = Z(2026, 10, 14, 12, 0), d2 = Z(2026, 10, 16, 12, 0);
    L.record(fight('a', d1, 'Tamasa', [{ name: 'Ben', server: 1301, total: 900 }, { name: 'Kai', server: 1301, cls: 14, total: 500 }, { name: 'Kai', server: 2301, total: 700 }]));
    L.record(fight('b', d2, 'Argo', [{ name: 'Kai', server: 1301, total: 800 }, { name: 'Mira', server: 0, total: 100 }]));
    L.record(fight('c', d2 + 3600000, 'Kaira', [{ name: 'Kai', server: 1301, total: 100 }]));
    R.quick('Kai', 1301, { rating: 4 }, 'Ben');
    R.quick('Mira', 0, { blacklist: true }, 'Ben');
    let d = RATE.collect(L, R, { me: 'ben' });
    ok(d.encs.map((e) => e.fk).join() === 'c,b,a', 'karşılaşmalar yeniden eskiye: ' + d.encs.map((e) => e.fk));
    ok(d.encs[0].day === d.encs[1].day || Math.abs(d.encs[0].at - d.encs[1].at) > 3600000 * 12, 'aynı gün aynı anahtar');
    ok(d.encs[1].day !== d.encs[2].day, 'farklı gün farklı anahtar (gün gruplama)');
    ok(d.encs[2].players.length === 2 && !d.encs[2].players.some((p) => p.n === 'Ben'), 'kendi karakter listeden çıkar');
    const a = d.encs[2].players;
    ok(a[0].n === 'Kai' && a[0].s === 2301 && a[1].s === 1301, 'oyuncular hasara göre sıralı');
    ok(a[0].key !== a[1].key && a[0].rating === 0 && a[1].rating === 4, 'aynı ad farklı sunucu ayrı oyuncu (puan yalnız 1301)');
    ok(a[1].times === 3 && a[0].times === 1, 'birlikte sayısı defterden: ' + a[1].times + '/' + a[0].times);
    ok(a[1].avg === 4 && a[0].avg === 0, 'ortalama puan');
    ok(d.encs[1].bl === 1 && d.encs[1].todo === 0 && d.encs[2].todo === 1 && d.encs[0].todo === 0 && d.encs[0].bl === 0, 'durum sayaçları (kara liste / bekliyor / tamam)');
    ok(d.total === 3 && d.rated === 1 && d.black === 1, 'başlık özeti: ' + d.total + '/' + d.rated + '/' + d.black);
    // hızlı etiket aç/kapa + kalıcılık
    ok(R.quick('Kai', 2301, { tags: { afk: true, good: true } }, 'Ben').ok, 'etiket aç');
    ok(R.quick('Kai', 2301, { tags: { afk: false, bogus: true } }, 'Ben').ok, 'etiket kapa (bilinmeyen yok sayılır)');
    R.flush();
    const R2 = new Ratings(path.join(dir, 'r.json')); R2.load();
    d = RATE.collect(L, R2, { me: 'ben' });
    const k = d.encs[2].players[0];
    ok(k.tags.includes('good') && !k.tags.includes('afk') && !k.tags.includes('bogus') && !k.bl, 'etiketler yeniden yüklemede kalıcı');
    ok(d.encs[2].players[1].rating === 4 && d.encs[2].players[1].tags.length === 0, 'diğer sunucudaki Kai etkilenmez');
    R2.quick('Kai', 2301, { tags: { good: false } }, 'Ben');
    ok(R2.find('Kai', '2301') === null, 'tüm etiket kapanınca puansız kayıt silinir');
    ok(RATE.collect(new Ledger(path.join(dir, 'yok.jsonl')), R2, {}).encs.length === 0, 'boş defter: karşılaşma yok');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* geçici klasör */ } }
  return errors;
}

function rateLiveTests() {
  const errors = []; const ok = mk(errors);
  const { Ledger } = req('lib/ledger.js');
  const { Ratings } = req('lib/ratings.js');
  const RATE = req('lib/rate.js');
  const dir = tmpDir();
  try {
    const L = new Ledger(path.join(dir, 'd.jsonl')); L.load();
    const R = new Ratings(path.join(dir, 'r.json'), path.join(dir, 'yok.json')); R.load();
    L.record({ fk: 'a:1', at: Z(2026, 10, 10, 20), boss: 'Eski Boss', actors: [{ name: 'Kai', server: 2301, cls: 1, total: 500 }] });
    // canlı savaş: defterde olmayan oyuncular + adsız (#) + kendi karakter
    const live = { at: Z(2026, 10, 17, 20), boss: 'Yeni Boss', actors: [
      { name: 'Mira', server: 2302, cls: 2, total: 900 }, { name: 'Kai', server: 2301, cls: 1, total: 100 },
      { name: 'Sinif #77', server: 0, cls: 3, total: 50 }, { name: 'Ben', server: 2301, cls: 4, total: 700 }] };
    const d = RATE.collect(L, R, { me: 'Ben', live });
    ok(d.encs.length === 2 && d.encs[0].fk === 'live' && d.encs[0].kind === 'live', 'canlı savaş sanal karşılaşma olarak başa eklenmeli');
    const names = d.encs[0].players.map((p) => p.n).join();
    ok(names === 'Mira,Kai', 'canlı: adsız (#) ve kendi karakter listede olmamalı, hasara göre sıralı: ' + names);
    ok(d.encs[0].players.find((p) => p.n === 'Kai').key === d.encs[1].players[0].key, 'canlıdaki Kai defterdekiyle aynı kimlik');
    // canlı oyuncuyu puanla → sanal karşılaşmada ve toplamda görünür
    ok(R.quick('Mira', 2302, { rating: 4 }, 'Ben').ok, 'canlı oyuncu puanlanabilmeli (quick)');
    const d2 = RATE.collect(L, R, { me: 'Ben', live });
    ok(d2.encs[0].players[0].rating === 4 && d2.rated === 1, 'puan canlı satırda görünmeli');
    // sağ tık prefill: defterde/canlıda yoksa tek kişilik sanal karşılaşma
    const d3 = RATE.collect(L, R, { me: 'Ben', pick: { name: 'Yabanci', server: 0 } });
    const pk3 = d3.encs.find((e) => e.fk === 'pick');
    ok(pk3 && pk3.players.length === 1 && pk3.players[0].n === 'Yabanci', 'sunucusuz bilinmeyen oyuncu seçili oyuncu kartı olmalı');
    ok(R.quick('Yabanci', 0, { blacklist: true }, 'Ben').ok && RATE.collect(L, R, { pick: { name: 'Yabanci', server: 0 } }).black === 1, 'sunucusuz oyuncu kara listeye alınabilmeli');
    // aynı ad farklı sunucu: Kai@2999 ledgerde yok → ayrı kart; Kai@2301 varsa kart eklenmez
    ok(RATE.collect(L, R, { pick: { name: 'Kai', server: 2999 } }).encs.some((e) => e.fk === 'pick'), 'aynı ad farklı sunucu ayrı oyuncu (kart eklenir)');
    ok(!RATE.collect(L, R, { pick: { name: 'Kai', server: 2301 } }).encs.some((e) => e.fk === 'pick'), 'defterde olan oyuncu için ek kart olmamalı');
    ok(!RATE.collect(L, R, { pick: { name: 'Kai', server: 0 } }).encs.some((e) => e.fk === 'pick'), 'sunucusu bilinmeyen sağ tık, aynı adlı kayıtla eşleşir');
    ok(!RATE.collect(L, R, { me: 'Ben', pick: { name: 'ben', server: 2301 } }).encs.some((e) => e.fk === 'pick'), 'kendi karakter için kart yok');
    ok(!RATE.collect(L, R, { pick: { name: 'Sinif #5', server: 0 } }).encs.some((e) => e.fk === 'pick'), 'adsız (#) oyuncu için kart yok');
    // sunucusuz eski puan, sunuculu oyuncuda da görünür (panel rozetiyle aynı eşleşme)
    R.quick('Eski', 0, { rating: 3 }, 'Ben');
    const d4 = RATE.collect(L, R, { live: { at: Z(2026, 10, 17, 21), boss: 'B', actors: [{ name: 'Eski', server: 2301, total: 10 }] } });
    ok(d4.encs[0].players[0].rating === 3, 'sunucusuz eski puan sunuculu satırda görünmeli');
    // boss yok, savaş yok: yalnız parti üyeleri (hasar 0) da puanlanabilir; sınıf gelir
    const L2 = new Ledger(path.join(dir, 'bos.jsonl')); L2.load();
    const dp = RATE.collect(L2, R, { live: { at: Z(2026, 10, 17, 22), boss: '', actors: [{ name: 'Parti1', server: 2301, cls: 15, total: 0 }, { name: 'Parti2', server: 0, cls: 0, total: 0 }] } });
    ok(dp.encs[0].kind === 'live' && dp.encs[0].players.length === 2 && dp.encs[0].players[0].c === 15, 'boss yokken parti üyeleri (sınıfıyla) listelenmeli');
    ok(R.quick('Parti1', 2301, { rating: 5 }, 'Ben').ok && R.quick('Parti2', 0, { tags: { afk: true } }, 'Ben').ok, 'parti üyesi puanlanır/etiketlenir');
    // Tüm puanlananlar: savaş/parti yokken bile kalıcı puanlar sonradan görülür
    const dr = RATE.collect(L2, R, { rated: true });
    const re = dr.encs.find((e) => e.kind === 'rated');
    ok(re && re.players.some((p) => p.n === 'Parti1' && p.rating === 5) && re.players.some((p) => p.n === 'Parti2' && p.tags.includes('afk')), 'Tüm puanlananlar girişi puanlı oyuncuları içermeli');
    ok(!RATE.collect(L2, new Ratings(path.join(dir, 'r2.json'), path.join(dir, 'yok.json')), { rated: true }).encs.length, 'boş durumda giriş yok (arayüz boş durum metni gösterir)');
  } finally { try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* geçici klasör */ } }
  return errors;
}

function bossLogTests() {
  // Kalıcı boss geçmişi (lib/bosslog.js) + Boss sekmesi liste mantığı (ui/bosshist.js)
  const errors = []; const ok = mk(errors);
  const { BossLog, summarize, safeFk } = req('lib/bosslog.js');
  const BH = req('ui/bosshist.js');
  const { Meter } = req('lib/meter.js');
  const dir = tmpDir();
  try {
    const bdir = path.join(dir, 'boss_gecmisi');
    const encOf = (name, total, dur, killed, own) => ({
      start: 1, dur, total, isBoss: true,
      boss: { name, code: 7, total, dps: total / (dur / 1000), dur, killed, wiped: !killed, pb: false, target: 'Kai' },
      actors: [{ id: 1, own: own === 1, name: 'Kai', cls: 14, total: total * 0.6, dps: total * 0.6 / (dur / 1000), share: 0.6, skills: [{ skill: 14010000, name: 'Sting', icon: null, total: total * 0.6, share: 1 / 3, hits: 3 }] },
        { id: 2, own: own === 2, name: 'Mira', cls: 17, total: total * 0.4, dps: total * 0.4 / (dur / 1000), share: 0.4, skills: [] }],
      replay: { duration: dur, start: 1, stagger: { breaks: 1, windows: [] }, casts: [{ t: 5, actor: 1, skill: 14010000, name: 'Sting', target: 9, kind: 0, icon: '../assets/skill_icons/x.png' }, { t: 9, actor: 1, skill: 14010000, name: 'Sting', target: 9, kind: 0, icon: '../assets/skill_icons/x.png' }], consumables: [{ t: 7, actor: 2, itemSkill: 3000001, name: 'Potion', icon: null }] },
      heal: { big: 'x'.repeat(5000) }, deathList: [{ x: 1 }],
    });
    const L = new BossLog(bdir); L.load();
    ok(L.size === 0, 'boş klasör: 0 kayıt');
    const s1 = L.save({ fk: Z(2026, 10, 16, 20) + ':900', at: Z(2026, 10, 16, 20), enc: encOf('Rudra', 600000, 60000, true, 2) });
    L.save({ fk: Z(2026, 10, 17, 9) + ':901', at: Z(2026, 10, 17, 9), enc: encOf('Baranath', 2000000, 100000, false, 1) });
    L.save({ fk: Z(2026, 10, 17, 10) + ':902', at: Z(2026, 10, 17, 10), enc: encOf('Rudra', 900000, 30000, true, 0) });
    ok(s1 && s1.res === 'k' && s1.n === 2 && s1.own && s1.own.r === 2 && Math.round(s1.dps) === 10000 && s1.top === 360000, 'özet: sonuç, oyuncu sayısı, kendi sıran, grup DPS, en yüksek hasar');
    ok(L.list()[0].boss === 'Rudra' && L.list()[0].own === null, 'en yeni başta; kendin yoksa own null');
    ok(summarize('x', 1, null) === null && L.save({ fk: '', enc: encOf('A', 1, 1000, true, 1) }) === null && L.save({ fk: '1:1', at: 1, enc: { actors: [] } }) === null, 'geçersiz kayıt reddedilir');
    // çift kayıt yok: aynı fk (birleşme) güncellenir
    L.save({ fk: Z(2026, 10, 17, 9) + ':901', at: Z(2026, 10, 17, 9), enc: encOf('Baranath', 3000000, 120000, true, 1) });
    ok(L.size === 3 && L.list().filter((x) => x.boss === 'Baranath').length === 1 && L.list()[1].res === 'k', 'aynı fk ikinci kez yazılınca tek kayıt, son hali');
    // kalıcılık: yeniden yükleme yalnız indeksi okur; rapor tembel okunur ve geri açılır
    const L2 = new BossLog(bdir); L2.load();
    ok(L2.size === 3 && L2.list().map((x) => x.boss).join() === 'Rudra,Baranath,Rudra', 'dosyadan geri yükleme (sıra korunur)');
    const d = L2.get(Z(2026, 10, 16, 20) + ':900');
    ok(d && d.boss.name === 'Rudra' && d.actors.length === 2 && d.actors[0].skills[0].name === 'Sting' && d.boss.target === undefined, 'rapor okunur (canlı hedef yazılmaz)');
    ok(d && d.replay.casts.length === 2 && d.replay.casts[1].icon === '../assets/skill_icons/x.png' && d.replay.casts[1].name === 'Sting' && d.replay.consumables[0].name === 'Potion' && d.replay.stagger.breaks === 1, 'zaman çizelgesi sözlükten geri açılır');
    ok(d && d.actors[0].skills[0].share === 0.3333, 'ondalıklar 4 basamağa yuvarlanır');
    const raw = fs.readFileSync(path.join(bdir, 'b-' + safeFk(Z(2026, 10, 16, 20) + ':900') + '.json'), 'utf8');
    ok(!raw.includes('xxxxx') && !raw.includes('deathList') && raw.split('Sting').length - 1 === 2, 'gereksiz alanlar yazılmaz; beceri adı tekrarlanmaz');
    ok(L2.get('yok:1') === null && L2.get(null) === null, 'olmayan kayıt null');
    // bozuk dosyalar: yarım indeks satırı, bozuk rapor, eksik rapor çökertmez
    fs.appendFileSync(path.join(bdir, 'index.jsonl'), '{"fk":"yarim","at":');
    fs.writeFileSync(path.join(bdir, 'b-' + safeFk(Z(2026, 10, 17, 10) + ':902') + '.json'), '{bozuk');
    fs.rmSync(path.join(bdir, 'b-' + safeFk(Z(2026, 10, 17, 9) + ':901') + '.json'));
    const L3 = new BossLog(bdir); L3.load();
    ok(L3.size === 3, 'bozuk indeks satırı atlanır: ' + L3.size);
    ok(L3.get(Z(2026, 10, 17, 10) + ':902') === null && L3.get(Z(2026, 10, 17, 9) + ':901') === null, 'bozuk / eksik rapor null döner');
    L3.save({ fk: '5:5', at: Z(2026, 10, 17, 11), enc: encOf('Kaira', 100, 1000, true, 1) });
    const L4 = new BossLog(bdir); L4.load();
    ok(L4.size === 4, 'yarım satırdan sonra ekleme bozulmaz');
    // silme: kalıcı, rapor dosyası da gider
    ok(L4.remove('5:5') && !L4.remove('5:5') && L4.size === 3, 'tek karşılaşma silinir');
    ok(!fs.existsSync(path.join(bdir, 'b-5_5.json')), 'silinen raporun dosyası kalkar');
    const L5 = new BossLog(bdir); L5.load();
    ok(L5.size === 3 && !L5.items.has('5:5'), 'silme yeniden açılışta da geçerli');
    // sıkıştırma: çok sayıda ölü satır → indeks baştan yazılır, yetim rapor dosyası silinir
    for (let i = 0; i < 120; i++) L5.save({ fk: '9:9', at: Z(2026, 10, 1), enc: encOf('Tekrar', 100 + i, 1000, true, 1) });
    fs.writeFileSync(path.join(bdir, 'b-yetim.json'), '{}');
    const L6 = new BossLog(bdir); L6.load();
    const lines = fs.readFileSync(path.join(bdir, 'index.jsonl'), 'utf8').split('\n').filter(Boolean).length;
    ok(L6.size === 4 && lines === 4 && L6.items.get('9:9').total === 219, 'sıkıştırma: ' + lines + ' satır');
    ok(!fs.existsSync(path.join(bdir, 'b-yetim.json')) && fs.existsSync(path.join(bdir, 'b-9_9.json')), 'yetim rapor temizlenir, canlı rapor kalır');
    ok(!fs.readdirSync(bdir).some((f) => f.endsWith('.tmp')), 'geçici dosya kalmaz');

    // meter entegrasyonu: birleşen deneme aynı fk ile güncellenir (çift kayıt yok)
    const L7 = new BossLog(path.join(dir, 'm')); L7.load();
    const m2 = new Meter({ now: () => 2000 });
    m2.ownId = 101;
    let calls = 0;
    m2.onBossSave = (r) => { calls++; L7.save(r); };
    m2.cur = m2.newEncounter(1000);
    m2.promoteBoss(900, { name: 'SplitBoss', max: 50000000, boss: true }, 1000, 101);
    m2.damage({ t: 1000, actor: 101, target: 900, skill: 11000001, damage: 10000 });
    m2.finish();
    m2.cur = m2.newEncounter(2000);
    m2.promoteBoss(900, { name: 'SplitBoss', max: 50000000, boss: true }, 2000, 101);
    m2.damage({ t: 2000, actor: 101, target: 900, skill: 11000001, damage: 15000 });
    m2.finish();
    const ml = L7.list();
    ok(calls === 2 && ml.length === 1 && ml[0].total === 25000 && ml[0].own && ml[0].own.r === 1, 'meter: birleşen deneme tek kayıt (' + calls + ' çağrı, ' + ml.length + ' kayıt)');
    ok(ml.length === 1 && ml[0].fk === m2.snapshot(0, {}).bosses[0].fk, 'meter: kalıcı fk = state.bosses fk = defter fk');

    // liste mantığı: bellek + disk birleşmesi, arama/süzgeç/sıralama, gün gruplama, çipler
    const saved = L2.list();
    const mem = [{ i: 0, fk: 'mem:1', name: 'Yeni Boss', dur: 2000, total: 4000, killed: false, wiped: true, at: Z(2026, 10, 17, 12) }, { i: 1, fk: saved[0].fk, name: 'Rudra', dur: 30000, total: 1, killed: true, at: saved[0].at }];
    const all = BH.merge(saved, mem);
    ok(all.length === 4 && all.filter((x) => x.fk === saved[0].fk).length === 1, 'birleşme: aynı fk bir kez');
    ok(all.find((x) => x.fk === saved[0].fk).mi === 1 && all.find((x) => x.fk === saved[0].fk).total === 900000, 'birleşme: kalıcı özet korunur, bellek sırası işaretlenir');
    const mm = all.find((x) => x.fk === 'mem:1');
    ok(mm && mm.mi === 0 && mm.res === 'w' && mm.dps === 2000, 'yalnız bellekteki kayıt da listelenir');
    ok(BH.view(all, {}).map((x) => x.boss).join() === 'Yeni Boss,Rudra,Baranath,Rudra', 'varsayılan: en yeni başta');
    ok(BH.view(all, { q: 'rud' }).length === 2 && BH.view(all, { q: '  RUDRA ' }).length === 2 && BH.view(all, { q: 'yok' }).length === 0, 'arama (büyük/küçük harf, boşluk)');
    ok(BH.view(all, { boss: 'Baranath' }).length === 1, 'boss süzgeci');
    ok(BH.view(all, { sort: 'dps' })[0].boss === 'Rudra' && BH.view(all, { sort: 'dps' })[0].dps === 30000, 'en yüksek grup DPS');
    const byOwn = BH.view(all, { sort: 'own' });
    ok(byOwn[0].boss === 'Baranath' && byOwn[byOwn.length - 1].own === null, 'en yüksek kendi DPS (kendin olmayanlar sonda)');
    const g = BH.groupDays(BH.view(all, {}));
    ok(g.length === 2 && g[0].items.length === BH.view(all, {}).filter((x) => BH.dayKey(x.at) === g[0].day).length && g[0].day !== g[1].day, 'gün gruplama: ' + g.map((x) => x.day + ':' + x.items.length).join());
    ok(BH.dayKey(new Date(2026, 0, 5, 23, 59).getTime()) === '2026-01-05' && BH.dayKey(new Date(2026, 0, 6, 0, 1).getTime()) === '2026-01-06', 'gün anahtarı yerel gece yarısında değişir');
    const ch = BH.bossChips(all, 1, 'Baranath');
    ok(ch[0].name === 'Rudra' && ch[0].n === 2 && ch.length === 2 && ch[1].name === 'Baranath', 'boss çipleri: en sık + seçili');
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
  return errors;
}

function lockSizeTests() {
  const errors = []; const ok = mk(errors);
  const P = req('lib/panelpos.js');
  // sahte pencere: her kilit aç/kapa işlemi yüksekliği 3 piksel şişiriyor (Windows şeffaf pencere kayması)
  let b = { x: 100, y: 200, width: 400, height: 300 };
  const win = { getBounds: () => ({ ...b }), setBounds: (n) => { b = { ...b, ...n }; } };
  const inflate = () => { b = { ...b, height: b.height + 3 }; };
  for (let i = 0; i < 20; i++) P.keepSize(win, inflate);
  ok(b.height === 300 && b.width === 400, 'kilit 20 kez aç/kapa sonrası boy aynı kalmalı: ' + b.height);
  ok(b.x === 100 && b.y === 200, 'konum korunmalı');
  ok(P.keepSize(win, () => {}) === null, 'boy değişmediyse hiçbir şey yapılmamalı (null)');
  const moved = P.keepSize(win, () => { b = { ...b, y: 210 }; });
  ok(moved === null && b.y === 210, 'yalnız konum değiştiyse geri alınmamalı');
  return errors;
}

module.exports = [
  ['timers: Global/Kore/Tayvan saatleri, Siege Bosses günleri, sıfırlama 07:00Z, DST, alarmlar', timersTests],
  ['ratings: doğrulama, ekle/güncelle/sil, kalıcılık, bozuk dosya, şablon', ratingsTests],
  ['recap: ölüm özeti halka tamponu (taşma, pencere, birleştirme)', recapTests],
  ['pb: kişisel en iyi (ilk deneme, rekor, kısa deneme, bozuk dosya, sınır)', pbTests],
  ['autoshow: otomatik göster/gizle durum makinesi (sahte zaman)', autoshowTests],
  ['mask: yayıncı modu (aynı ad aynı etiket, LRU, sınıf sonradan, buildTable)', maskTests],
  ['engine: itemKind sınıflandırması', itemKindTests],
  ['servers: parseParty sunucu alanı + serverLabel (var/yok/0)', serverTests],
  ['ledger: oyuncu defteri (ad+sunucu kimliği, birleşme, kalıcılık) + hızlı puan / kara liste', ledgerTests],
  ['bosslog: kalıcı boss geçmişi (yaz/oku, indeks, bozuk dosya, silme, sıkıştırma, çift kayıt yok) + liste (arama, süzgeç, sıralama, gün)', bossLogTests],
  ['rate: puanlama ekranı verisi (gün gruplama, özet, ad+sunucu ayrımı, hızlı etiket kalıcılığı)', rateTests],
  ['rate-live: canlı savaş / sağ tık oyuncusu puanlanabilirliği (sunucusuz, aynı ad, adsız, kendi karakter)', rateLiveTests],
  ['blacklist: parti uyarısı oyuncu başına bir kez', blacklistWarnTests],
  ['threat: "boss hedefi sende" uyarısı tamamen kaldırıldı (gösterge duruyor)', threatTests],
  ['drawertabs: tepsi sekme adı çevirisi (beceriler→skills, genel→general)', drawerTabsTests],
  ['geçmişten silme arayüzden kaldırıldı', noDeleteTests],
  ['not: oyuncuya serbest metin notu (kaydet/oku/sınır/geriye uyum)', noteTests],
  ['panelpos: kilit (tıklama geçirme) aç/kapa pencere boyunu büyütmez (20 tekrar)', lockSizeTests],
  ['alerts: eşik tetikleme (bir kez, yeniden başlatma, saat atlaması), uyarı türü süzgeci, savaşta sessiz', alertsTests],
];
