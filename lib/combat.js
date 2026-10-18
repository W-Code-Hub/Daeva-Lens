'use strict';
// Savaş çözücü: sunucu -> istemci çerçevelerinden hasar, beceri kullanımı ve bekleme süresi
// olaylarını çıkarır. Sadece okur.
//
// Alan düzenleri açık kaynak AION2 DPS meter'lardan (RATmeter / A2Tools, GPL-3) alınıp
// kullanıcının kendi kayıtlarıyla doğrulandı. Ayrıntı: PROTOKOL.md

const { readVarint } = require('./parser');
const { parseSpawn } = require('./mobs');

const OP = {
  DAMAGE: 0x0438,     // hasar
  DOT: 0x0538,        // zamana yayılan hasar
  CAST: 0x0238,       // beceri kullanımı (oyuncu + canavar)
  SKILL_CD: 0x4738,   // bekleme süresi bildirimi (sayı + [beceri u32, kalan ms varint])
  OWN_INFO: 0x3336,   // kendi karakter bilgisi (id + isim)
  OTHER_INFO: 0x4536, // diğer oyuncu bilgisi (id + isim)
  DESPAWN: 0x4236,    // görüş alanından çıktı / öldü
  OWNER: 0x048d,      // varlık + sahibi (çağrı veya ganimet sahibi) + sahibin adı
  SPAWN: 0x4136,      // canavar göründü (varlık + canavar kodu)
  PONG: 0x0336,       // ping yanıtı (10 sn'de bir; istek giden yönde 12–13 baytlık çerçeve)
  HP: 0x008d,         // varlık canı: <id> 02 01 00 <u32 kalan> 00 00 00 00 (A2Tools, GPL-3)
  PARTY: 0x0297,      // grup listesi
  GLOBAL_LINK: 0x2036, // oturum id -> küresel id eşleştirmesi
  GAUGE: 0x05e0,      // boss kırılma (stagger) göstergesi: id(vi) 03 01 azami(u32) değer(u32) durum(u8); kırılma olayı: id 00 03 02
  TELEPORT: 0x3c37,   // ışınlanma / bölge değişimi vektörü (id, kind=3, x, y, z, yaw)
  ROSTER: 0x0092,     // GERÇEK parti kadrosu (üye başına oturum kimliği + küresel kimlik + ad); üye değişince yeniden gelir
  MEMBER: 0x2292,     // tek üye ayrıntısı (kadro ile aynı üye kaydı düzeni): oturum kimliği + küresel kimlik + ad
  STATE: 0x1c92,      // üye durum akışı (ilk u32 = üyenin küresel kimliği); partideyken saniyede birkaç kez
  LEAVE_A: 0x1d97,    // partiden ayrılma / dağılma bildirimi
  LEAVE_B: 0x1f93,    // partiden ayrılma / dağılma bildirimi (parti kimliği + 03)
  ZONE: 0x8356,       // bölge yüklemesi: ~39,7 KB dünya paketi
};

class Reader {
  constructor(b, i = 0) { this.b = b; this.i = i; }
  get left() { return this.b.length - this.i; }
  u8() { if (this.i >= this.b.length) throw RangeError('son'); return this.b[this.i++]; }
  u32() { if (this.i + 4 > this.b.length) throw RangeError('son'); const v = this.b.readUInt32LE(this.i); this.i += 4; return v; }
  vi() { const v = readVarint(this.b, this.i); if (!v) throw RangeError('varint'); this.i = v[1]; return v[0]; }
  skip(n) { if (this.i + n > this.b.length) throw RangeError('son'); this.i += n; }
}

const reasonableSkill = (c) => c >= 1 && c <= 299999999;

// Aion 2 oyun metin çözücü: < 32 olan baytlar önek tekrarıdır (RATmeter BasePlayerInfoProcessor, GPL-3)
function decodeGameString(buf, offset, maxLen) {
  const out = Buffer.alloc(maxLen * 4);
  let w = 0;
  const readEnd = Math.min(buf.length, offset + maxLen);
  for (let i = offset; i < readEnd; i++) {
    const b = buf[i];
    if (b === 0) break;
    if (b < 32) {
      const rep = Math.min(b, w);
      for (let j = 0; j < rep && w < out.length; j++) out[w++] = out[j];
    } else if (w < out.length) {
      out[w++] = b;
    }
  }
  const raw = out.subarray(0, w).toString('utf8');
  const clean = raw.replace(/[^\p{L}\p{N}_\- 丶]/gu, '').trim();
  return clean || null;
}

// 0x0438 gövdesi (Sürüm 2.0, 58 kayıt / 266.215 çerçeveyle bayt bayt doğrulandı; %99,9'u sonuna kadar tam okunuyor):
//   hedef(vi) sw(vi) fb(vi) aktör(vi) beceri(u32) sayaç(u8) tür(vi; 3 = kritik)
//   [sw&2: bayrak(u8) u8 yön(u8)]  örnek(u32 = beceri*100+seviye)  vuruşNo(u32)  çarpan(vi, /10000)
//   [sw&4: hasar(vi)]  [sw&0x10 ve sw&2 yoksa: u8]  [sw&0x20: n(u8) + n×vi]  [sw&0x40: n(u8) + n×u32]  kuyruk(2 bayt)  [fb&4: vi]
// sw&4 yoksa paket HASAR TAŞIMAZ (sadece etki bildirimi; Denetim Raporu'nun "%64,2 kayıp" iddiası bu yüzden geçersiz).
// sw&0x20 listesi ("alt vuruşlar") hasara EKLENMEZ: canavar canı (0x008d) ölçümünde düşüş 1.800 vakada ana hasara,
// sadece 4 vakada ana+alt toplamına eşit çıktı. Sayısı yalnızca bilgi olarak taşınır (multi).
function parseDamage(body) {
  const r = new Reader(body);
  const target = r.vi();
  const sw = r.vi();
  if (sw > 255 || !(sw & 4)) return null;
  r.vi();
  const actor = r.vi();
  const skill = r.u32();
  if (!reasonableSkill(skill)) return null;
  r.u8();
  const dmgType = r.vi();
  let flag = 0, dir = 0;
  if (sw & 2) { flag = r.u8() & 0x7f; r.u8(); dir = r.u8(); }
  r.u32(); r.skip(4);
  r.vi();
  const damage = Math.abs(r.vi());
  let multi = 0;
  let absorbed = 0;
  const subHits = [];
  try {
    if ((sw & 0x10) && !(sw & 2)) r.u8();
    if (sw & 0x20) {
      const n = r.u8();
      for (let k = 0; k < n; k++) subHits.push(Math.abs(r.vi()));
      multi = n;
    }
    if (sw & 0x40) {
      const n = r.u8();
      for (let k = 0; k < n; k++) {
        r.u32();
      }
      absorbed = Math.abs(r.vi());
    }
  } catch { /* isteğe bağlı kuyruk eksik: hasar yine geçerli */ }
  return {
    target, actor, skill, damage,
    self: actor === target,
    crit: dmgType === 3,
    glancing: dmgType === 4,
    back: (dir & 1) !== 0 || (flag & 1) !== 0,
    parry: (flag & 2) !== 0,
    perfect: (flag & 4) !== 0,
    double: (flag & 8) !== 0,
    multi,
    subHits,
    absorbed,
  };
}

// 0x0538 (zamana yayılan etki), Sürüm 2.0'da kayıtla ve can (0x008d) değişimiyle doğrulandı:
//   hedef(vi) etki(u8) aktör(vi) vi örnek(u32 = beceri*100+seviye) miktar(vi) [etki&1 ve etki&2: tik(vi)] ...
//   etki&2 ve etki&1 yok: DoT tiki, hasar = miktar (canavar canı düşüşüyle birebir)
//   etki&1 (HoT): miktar = KALAN iyileştirme havuzu; etki&2 varsa ardından gelen tik(vi) gerçek iyileştirmedir
//   (oyuncu canı artışıyla 3.150 vakada birebir). Eskiden etki=11 paketlerindeki havuz yanlışlıkla hasar sayılıyordu.
//   etki = 0: etki bitti bildirimi, miktar yok.
function parseDot(body) {
  const r = new Reader(body);
  const target = r.vi();
  const eff = r.u8();
  if (!(eff & 3)) return null;
  const actor = r.vi();
  r.vi();
  const raw = r.u32();
  const skill = Math.floor(raw / 100);
  if (!reasonableSkill(skill)) return null;
  const amount = Math.abs(r.vi());
  if (eff & 1) {
    let tick = amount;
    if (eff & 2) {
      tick = Math.abs(r.vi());
      if (tick <= 0) return null;
    }
    return { kind: 'heal', target, actor, skill, amount: tick, hot: true, self: actor === target };
  }
  if (actor === target) return null;
  return { kind: 'damage', target, actor, skill, damage: amount, dot: true };
}

// 0x008d varlık durumu (Sürüm 2.0, 103.508 çerçevenin hepsi tam okundu):
//   id(vi) tür(u8: 1 = u32 liste, 2 = u64 liste, 3 = ikisi)  [n(u8) × (alan(u8) değer(u32))]  [n(u8) × (alan(u8) değer(u64))]
//   u64 alan 0 = anlık can, u64 alan 7 = azami can (değişen azami can dahil). Eskiden sadece "02 01 00" biçimi okunuyordu.
function parseVitals(body) {
  const v = readVarint(body, 0);
  if (!v) return null;
  let i = v[1];
  const kind = body[i++];
  if (kind !== 1 && kind !== 2 && kind !== 3) return null;
  let hp = null, max = null;
  if (kind & 1) {
    const n = body[i++];
    if (i + n * 5 > body.length) return null;
    i += n * 5;
  }
  if (kind & 2) {
    const n = body[i++];
    if (i + n * 9 > body.length) return null;
    for (let k = 0; k < n; k++) {
      const f = body[i];
      const val = Number(body.readBigUInt64LE(i + 1));
      if (f === 0) hp = val; else if (f === 7) max = val;
      i += 9;
    }
  }
  if (hp === null && max === null) return null;
  if ((hp !== null && hp > 4000000000) || (max !== null && max > 4000000000)) return null;
  return { id: v[0], hp, max };
}

// 0x05e0 boss kırılma göstergesi (Sürüm 2.0, kayıtla bulundu): azami 150/600/750/1200; boss'a vurdukça azalır,
// 0'a inince "00 03 02" kırılma olayı gelir, ~5 sn sonra azamiye döner. Durum 2 = normal; durum 3'ün anlamı doğrulanmadı.
function parseGauge(body) {
  const v = readVarint(body, 0);
  if (!v) return null;
  const i = v[1];
  if (body.length === i + 3 && body[i] === 0 && body[i + 1] === 3) return { id: v[0], broken: true };
  if (body.length < i + 11 || body[i] !== 3 || body[i + 1] !== 1) return null;
  const max = body.readUInt32LE(i + 2);
  const val = body.readUInt32LE(i + 6);
  if (!max || max > 1000000 || val > max) return null;
  return { id: v[0], max, val, state: body[i + 10] };
}

// 0x0238: aktör(vi) 00 beceri(u32) sıra(u8) tür(u8; 02 = hedefli kullanım, 00 = yan etki) hedef(vi) ...
function parseCast(body) {
  const r = new Reader(body);
  const actor = r.vi();
  r.u8();
  const skill = r.u32();
  if (!reasonableSkill(skill)) return null;
  r.u8();
  const kind = r.left ? r.u8() : 0;
  let target = null;
  if (r.left > 0) {
    const tv = readVarint(body, r.i);
    if (tv && tv[0] > 0) target = tv[0];
  }
  return { actor, skill, kind, target };
}

// 0x4738: sayı(u8) × [beceri(u32) kalanMs(vi)]
function parseSkillCd(body) {
  const r = new Reader(body);
  const n = r.u8();
  const out = [];
  for (let k = 0; k < n && k < 64; k++) out.push({ skill: r.u32(), ms: r.vi() });
  return out;
}

function tryParseCombatPower(data) {
  const minCP = 10000;
  const maxCP = 2000000;
  const pairSize = 16;
  if (data.length < pairSize) return 0;
  const startOffset = data.length - pairSize;
  const minOffset = Math.max(0, startOffset - 255);
  for (let offset = startOffset; offset >= minOffset; offset--) {
    const curLow = data.readUInt32LE(offset);
    const curHigh = data.readUInt32LE(offset + 4);
    if (curHigh !== 0 || curLow < minCP || curLow > maxCP) continue;
    const highLow = data.readUInt32LE(offset + 8);
    const highHigh = data.readUInt32LE(offset + 12);
    if (highHigh === 0 && highLow >= minCP && highLow <= maxCP && curLow <= highLow) {
      return curLow;
    }
  }
  return 0;
}

// 0x3336 / 0x4536: id(vi) 4 bayt, bayrak(u8 &1) isimUzunluk(vi) isim(utf8)
function parseName(body, isOwn = false) {
  const r = new Reader(body);
  const id = r.vi();
  r.skip(4);
  if (!(r.u8() & 1)) return null;
  const n = r.vi();
  if (n < 1 || n > 64 || r.left < n) return null;
  const name = decodeGameString(body, r.i, n);
  if (!name || /^\d+$/.test(name)) return null;
  const cp = isOwn ? tryParseCombatPower(body) : 0;
  return { id, name, ...(cp > 0 ? { cp } : {}) };
}

// 0x048d: varlık(vi) 4 bayt sahip(vi) sunucu(u16) adUzunluk(u8) ad(utf8) ...
function parseOwner(body) {
  const r = new Reader(body);
  const id = r.vi();
  r.skip(4);
  const owner = r.vi();
  if (!owner || owner === id) return null;
  const server = r.u8() | (r.u8() << 8);
  const n = r.u8();
  if (n < 1 || n > 64 || r.left < n) return null;
  const name = decodeGameString(body, r.i, n);
  if (!name || /^\d+$/.test(name)) return null;
  return { id, owner, name, server };
}

// Sürüm 2.0: 0x0297 üyesinde adın hemen arkasındaki u32 karakter şablonudur; 4'erli gruplar sınıfı verir.
// Kayıtlarda 21 oyuncunun 21'inde beceri sınıfıyla birebir: 5–8 Gladiator, 9–12 Templar, 13–16 Ranger,
// 17–20 Assassin, 25–28 Sorcerer, 29–32 Cleric, 33–36 Chanter. 21–24 ve 37+ kayıtlarda görülmedi (Elementalist /
// Brawler olabilir ama doğrulanmadı): null döner, sınıf eski yöntemle (beceri oylaması) bulunur.
// Denetim Raporu'ndaki "sınıf baytı 11–19" iddiası kayıtla uymadı (o bayt 1/3/4 geliyor).
const TEMPLATE_CLASS = [11, 12, 14, 13, null, 15, 17, 18];
function classFromTemplate(n) {
  if (!Number.isInteger(n) || n < 5) return null;
  return TEMPLATE_CLASS[(n - 5) >> 2] || null;
}

// 0x0297 grup listesi = zindan ilanı (RATmeter düzeni; Faz 6.0'da kayıtla ve oyunla doğrulandı, PROTOKOL.md):
function parseParty(body) {
  const r = new Reader(body);
  let bitBuf = 0, bitLeft = 0;
  const bit = () => { if (!bitLeft) { bitBuf = r.u8(); bitLeft = 8; } const b = bitBuf & 1; bitBuf >>= 1; bitLeft--; return b; };
  const str = () => { const n = r.u8(); if (r.left < n) throw RangeError('str'); const s = decodeGameString(body, r.i, n) || ''; r.i += n; return s; };
  r.u32();
  str();
  const size = r.u8();
  const dungeon = r.u32();
  r.u8(); r.u8(); r.skip(8); bit(); r.u8(); r.u8();
  const count = r.vi();
  if (count > 48 || size > 48) return null;
  const members = [];
  const memberDetails = [];
  for (let i = 0; i < count; i++) {
    const m = r.u8();
    r.u8();
    const dbidLow = r.u32();
    const server = r.u32() >>> 16; // sunucu numarası << 16 (alt 16 bit 0); Siel(Avrupa)=1301, Israphel=2301 (83/83 oyuncu NCSOFT tablosuyla eşleşti)
    const globalId = dbidLow;
    const name = str();
    const tmpl = r.u32(); // Sürüm 2.0: karakter şablonu → sınıf (classFromTemplate)
    const level = r.u32();
    if (m & 1) r.u32();
    const gearScore = r.u32();
    if (m & 2) bit();
    bit();
    if (m & 4) r.skip(2);
    if (m & 8) r.skip(2);
    r.u8();
    let combatPower = 0;
    try { combatPower = Number(r.b.readBigUInt64LE(r.i)); } catch {}
    r.skip(8);
    const tickets = r.vi();
    if (tickets > 64) return null;
    for (let j = 0; j < tickets; j++) { r.u8(); r.u32(); }
    if (m & 16) r.skip(8);
    r.u8(); r.u8();
    if (level > 200) return null;
    // Faz 6.2a (2026-10-11): zindan ilanındaki boş yer adı boş, seviyesi 0 gelir (kayıtla görüldü).
    // Eskiden bütün paket atılıyordu; grup dolana kadar liste güncellenmiyordu. Artık sadece boş yer atlanır.
    if (!name) continue;
    members.push(name);
    memberDetails.push({ name, globalId, server, level, gearScore, combatPower, cls: classFromTemplate(tmpl) });
  }
  return { size, dungeon, members, memberDetails };
}

// 0x3c37: ışınlanma / bölge değişimi / obelisk diriliş vektörü: id(vi) tür(u8) x(f32) y(f32) z(f32) yaw(f32)
// 0x0092 kadro / 0x2292 üye ayrıntısı: üye kaydı = [oturum kimliği u32][sunucu u16][u16] + '$' + 36 karakterlik GUID metni
// + [küresel kimlik u32][u16 0][sunucu u16][ad uzunluğu u8][ad]. Kayıtla doğrulandı (2026-10-14, 188 üye kaydı: oturum
// kimliği → ad, oyun içi ad paketiyle %100 uyuştu, 0 çelişki; küresel kimlik 0x0297 üye kaydıyla birebir aynı).
// Alanları sabit konuma bağlamak yerine GUID imzasından çapa alır: bilinmeyen ara alanlar çözücüyü bozmaz.
const GUID_RE = /^[0-9A-Fa-f]{8}-[0-9A-Fa-f]{4}-[0-9A-Fa-f]{4}-/;
function parseRosterMembers(body) {
  const out = [];
  if (!Buffer.isBuffer(body)) return out;
  const seen = new Set();
  for (let i = 8; i + 37 + 9 <= body.length; i++) {
    if (body[i] !== 0x24 || !GUID_RE.test(body.toString('latin1', i + 1, i + 20))) continue;
    const g = i + 37;
    const nl = body[g + 8];
    if (nl < 1 || nl > 40 || g + 9 + nl > body.length) continue;
    const sid = body.readUInt32LE(i - 8);
    const dbid = body.readUInt32LE(g);
    const server = body.readUInt16LE(g + 6);
    const name = decodeGameString(body, g + 9, nl);
    i = g + 9 + nl - 1;
    if (!name || /^\d+$/.test(name) || sid > 0xffffff || !dbid || seen.has(dbid)) continue;
    seen.add(dbid);
    out.push({ sid, dbid, name, server });
  }
  return out;
}

function parseTeleport(body) {
  const v = readVarint(body, 0);
  if (!v || v[1] + 17 > body.length) return null;
  let i = v[1];
  const kind = body.readUInt8(i++);
  const x = body.readFloatLE(i); i += 4;
  const y = body.readFloatLE(i); i += 4;
  const z = body.readFloatLE(i); i += 4;
  const yaw = body.readFloatLE(i);
  return { id: v[0], kind, x, y, z, yaw };
}

class Combat {
  constructor(opts = {}) {
    this.emit = opts.emit || (() => {});
    this.mobsCache = opts.mobsCache || null;
    this.names = new Map();
    this.stats = { frames: 0, damage: 0, heal: 0, casts: 0, cds: 0, errors: 0 };
    this.ops = new Map(); // opcode -> sayı (teşhis ekranı)
    this.onFrame = null;
  }

  frame(op, body, t) {
    this.stats.frames++;
    this.ops.set(op, (this.ops.get(op) || 0) + 1);
    // Deneysel (yalnız DAEVA_DEV): ham çerçeve kancası. Son kullanıcı sürümünde atanmaz (null).
    if (this.onFrame) { try { this.onFrame(op, body, t); } catch { /* deneysel modül sayacı bozamaz */ } }
    try {
      this._frame(op, body, t);
    } catch {
      this.stats.errors++;
    }
  }

  _frame(op, body, t) {
    switch (op) {
      case OP.DAMAGE: {
        const d = parseDamage(body);
        if (!d) return;
        // Sürüm 2.0: kendine gelen "hasar" (aktör = hedef) kayıtlarda hep iyileştirme/kalkan/buff değeri; hasar sayılmaz
        if (d.self) { this.stats.heal++; this.emit({ type: 'heal', t, target: d.target, actor: d.actor, skill: d.skill, amount: Math.abs(d.damage), self: true, direct: true }); return; }
        this.stats.damage++;
        this.emit({ type: 'damage', t, ...d });
        return;
      }
      case OP.DOT: {
        const d = parseDot(body);
        if (!d) return;
        if (d.kind === 'heal') { this.stats.heal++; this.emit({ type: 'heal', t, target: d.target, actor: d.actor, skill: d.skill, amount: d.amount, hot: true, self: d.self }); return; }
        this.stats.damage++;
        this.emit({ type: 'damage', t, target: d.target, actor: d.actor, skill: d.skill, damage: d.damage, dot: true });
        return;
      }
      case OP.GAUGE: {
        const g = parseGauge(body);
        if (g) this.emit({ type: 'gauge', t, ...g });
        return;
      }
      case OP.CAST: {
        const c = parseCast(body);
        if (c) { this.stats.casts++; this.emit({ type: 'cast', t, ...c }); }
        return;
      }
      case OP.SKILL_CD: {
        for (const e of parseSkillCd(body)) { this.stats.cds++; this.emit({ type: 'cd', t, ...e }); }
        return;
      }
      case OP.OWN_INFO: {
        const p = parseName(body, true);
        if (p) { if (this.names.size > 20000) this.names.clear(); this.names.set(p.id, p.name); this.emit({ type: 'name', ...p }); this.emit({ type: 'own-info', t, id: p.id, name: p.name }); }
        return;
      }
      case OP.OTHER_INFO: {
        const p = parseName(body, false);
        if (p) { if (this.names.size > 20000) this.names.clear(); this.names.set(p.id, p.name); this.emit({ type: 'name', ...p }); }
        return;
      }
      case OP.PONG: this.emit({ type: 'pong', t }); return;
      case OP.HP: {
        const p = parseVitals(body);
        if (!p) return;
        if (p.hp !== null) this.emit({ type: 'hp', t, id: p.id, hp: p.hp, ...(p.max !== null ? { max: p.max } : {}) });
        else this.emit({ type: 'max-hp', t, id: p.id, max: p.max });
        return;
      }
      case OP.SPAWN: {
        const p = parseSpawn(body, readVarint, this.mobsCache);
        if (p) this.emit({ type: 'spawn', t, ...p });
        return;
      }
      case OP.DESPAWN: {
        const v = readVarint(body, 0);
        if (v && body.length >= v[1] + 2 && body[v[1]] === 0) {
          if (body[v[1] + 1] === 3) this.emit({ type: 'death', t, id: v[0] });
          else this.emit({ type: 'despawn', t, id: v[0] });
        }
        return;
      }
      case OP.TELEPORT: {
        const p = parseTeleport(body);
        if (p) this.emit({ type: 'teleport', t, ...p });
        return;
      }
      case OP.OWNER: {
        const o = parseOwner(body);
        if (o) {
          if (!this.names.has(o.owner)) { this.names.set(o.owner, o.name); this.emit({ type: 'name', id: o.owner, name: o.name }); }
          this.emit({ type: 'owner', t, id: o.id, owner: o.owner, name: o.name });
        }
        return;
      }
      case OP.PARTY: {
        const p = parseParty(body);
        if (p) this.emit({ type: 'party', ...p });
        return;
      }
      case OP.ROSTER: {
        const members = parseRosterMembers(body);
        this.emit({ type: 'roster', t, members });
        return;
      }
      case OP.MEMBER: {
        const members = parseRosterMembers(body);
        if (members.length) this.emit({ type: 'roster-member', t, members });
        return;
      }
      case OP.STATE: {
        if (body.length < 6) return;
        const dbid = body.readUInt32LE(0);
        if (!dbid) return;
        // saniyede çok kez gelir: üye başına en çok 2 sn'de bir bildirilir
        if (!this.stateSeen) this.stateSeen = new Map();
        const last = this.stateSeen.get(dbid);
        if (last !== undefined && t - last < 2000 && t >= last) return;
        if (this.stateSeen.size > 200) this.stateSeen.clear();
        this.stateSeen.set(dbid, t);
        this.emit({ type: 'party-state', t, dbid });
        return;
      }
      case OP.LEAVE_A:
      case OP.LEAVE_B:
        this.emit({ type: 'party-leave', t, op });
        return;
      case OP.ZONE:
        // yalnız büyük dünya paketi bölge yüklemesidir; 5 sn içindeki tekrarlar tek sayılır
        if (body.length < 20000) return;
        if (this.lastZoneT !== undefined && t - this.lastZoneT < 5000 && t >= this.lastZoneT) return;
        this.lastZoneT = t;
        this.emit({ type: 'zone-load', t });
        return;
      case OP.GLOBAL_LINK: {
        try {
          const r = new Reader(body);
          r.vi();
          r.skip(4);
          const sessionId = r.vi();
          r.skip(4);
          const globalId = r.u32();
          if (sessionId > 0 && globalId > 0) this.emit({ type: 'global-link', t, sessionId, globalId });
        } catch {}
        return;
      }
      default:
    }
  }
}

module.exports = { Combat, parseDamage, parseDot, parseVitals, parseGauge, parseCast, parseSkillCd, parseName, parseOwner, parseParty, parseRosterMembers, parseTeleport, classFromTemplate, decodeGameString, OP };
