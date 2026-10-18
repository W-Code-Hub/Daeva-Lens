'use strict';
const { iconUrl } = require('./icons');
const { pruneMap } = require('./kills');
const { RecapRing, WINDOW_MS: RECAP_WINDOW_MS } = require('./recap');
// DPS ölçer: hasar olaylarını dövüş bölümlerine ayırır ve oyuncu başına toplar.

const CLASSES = {
  10: 'Spirit', 11: 'Gladiator', 12: 'Templar', 13: 'Assassin', 14: 'Ranger',
  15: 'Sorcerer', 16: 'Elementalist', 17: 'Cleric', 18: 'Chanter', 19: 'Brawler',
};

const classOf = (skill) => {
  const c = Math.floor(skill / 1e6);
  return CLASSES[c] ? c : null;
};
// Varlık türü (oyuncu, canavar, çağrı) kimlik eşiğine (20000 gibi sunucu kuralı olmayan yapay sayılara)
// göre değil, protokol paketlerine (0x4136 spawn, 0x0297 party, 0x4536 ad, 0x048d sahip) göre belirlenir.
const isTheostone = (skill) => skill >= 3000000 && skill <= 3099999;
// Oyuncu becerisi mi (canavar saldırıları ayrı tutulur)
const isPlayerSkill = (skill) => classOf(skill) !== null || isTheostone(skill);

class Meter {
  constructor(opts = {}) {
    this.skillName = opts.skillName || ((c) => '#' + c);
    this.idleMs = opts.idleMs || 8000;
    this.bossIdleMs = opts.bossIdleMs || opts.idleMs || 8000;
    this.now = opts.now || (() => Date.now());
    this.maxHistory = 10;
    this.history = [];   // biten bölümler (yeniden eskiye)
    this.bossHistory = []; // sadece bellekte, en fazla 20 boss dövüşü
    this.cur = null;
    this.ownId = null;
    this.names = new Map(opts.names ? (opts.names instanceof Map ? opts.names : Object.entries(opts.names)) : []);
    this.classes = new Map(); // aktör -> sınıf
    this.classVotes = new Map(); // B-31: aktör -> { strong: Map(sınıf -> sayı), weak: Map(sınıf -> sayı) }
    this.playerTargetSkipped = 0; // B-33: hedefi oyuncu olduğu için sayılmayan "hasar" (iyileştirme, kalkan)
    this.summonOwner = new Map(); // çağrı -> sahip
    this.party = null;
    // Parti üyeliği artık 0x0297'den DEĞİL, gerçek kadrodan (0x0092 / üye durum akışı) gelir: motor 'managed' yapar ve
    // setGroup() ile verir. party yalnız partideyken doludur; 0297 (zindan ilanı) yalnız ad/sınıf/GS/CP/sunucu bilgisidir.
    this.managed = false;
    this.instanceLive = false;  // gerçek zindan içindeyiz (bölge yüklemesiyle birlikte kadro geldi): canavar olmayan herkes partidir
    this.lastStats = new Map(); // ad → { gs, cp } (son 0297; üyelik kararı vermez)
    this.finder = null;         // son 0297 ilanı { size, dungeon, members } (bilgi amaçlı)
    this.inferred = new Map();  // kimlik → ad (yalnız gösterim: sınıfı tek aday olan çözülmemiş satır; ad haritasına yazılmaz)
    this.charName = opts.charName || null;
    this.mobsCache = opts.mobsCache || null;
    this.version = 0;
    // Sürüm 2.0 (kayıtla doğrulanan protokol alanları)
    this.nameIds = new Map();         // ad → kimlik (son görülen)
    this.npcIds = new Map();          // 0x4136 ile doğan varlık → zaman. Bu kimlikler oyuncu DEĞİLDİR (B-34: 653 tanesi 20000 altında)
    this.summonOwnerName = new Map(); // adlı doğma (0x4136 b2&1): çağrı/tuzak → sahibinin karakter adı (B-38)
    this.partyClass = new Map();      // ad → sınıf (0x0297 karakter şablonu; kesin, oylamayı geçersiz kılar)
    this.partyServer = new Map();     // ad → sunucu numarası (0x0297 üye kaydı; oyuncu defteri kimliği = ad + sunucu)
    this.partyCls = new Map(); // ad -> sınıf kodu (0x0297 parti listesi; hasar vurmayan üyeler için)
    this.onBossRecord = null;         // oyuncu defteri: boss kaydı arşivlenince/birleşince çağrılır (main.js bağlar)
    this.onBossSave = null;           // kalıcı boss geçmişi: aynı anda rapor anlık görüntüsüyle çağrılır (main.js bağlar)
    this.vitals = new Map();          // oyuncu → { hp, max, t } (0x008d alan 0 / 7)
    this.healSkills = new Set();      // can artışıyla doğrulanmış doğrudan iyileştirme becerileri (taban kod)
    this.healProbe = new Map();       // hedef → doğrulanmayı bekleyen son iyileştirme { t, amount, base, hp }
    this.recapBuf = new Map();        // oyuncu → son darbeler (ölüm özeti için lib/recap.js halka tamponu)
    this.onBossEnd = null;            // Faz 8.14: biten boss denemesi için kişisel en iyi (PB) denetimi (main.js bağlar)
    this.deadAt = new Map();          // oyuncu → ölüm özeti (dirilince silinir)
    this.deathLog = [];               // son 20 ölüm özeti (yeniden eskiye)
    this.gauges = new Map();          // varlık → kırılma göstergesi (0x05e0)
    this.lastPrune = 0;
    this.ownPast = new Map();         // bu oturumda kendi karakterimiz olmuş kimlikler → true (kesin kaynak) / false (tahmin); bölge değişince kimlik yenilenir
  }

  // bölge yüklemesi: kısa süre yabancı elemesi kapalı (kimlik yenilenirken ilk vuruşlar atılmasın)
  noteZone() { this.zoneGraceUntil = this.now() + 30000; }

  // aktörün adı karakter adımızsa (bayat ownId'ye karşı yedek eşleşme)
  isOwnName(actorId) {
    const nm = this.names.get(actorId);
    return !!(this.charName && typeof this.charName === 'string' && nm && typeof nm === 'string' && nm.toLowerCase() === this.charName.toLowerCase());
  }

  hasKnownIdentity() {
    const mems = this.party && this.party.members;
    const memCount = mems ? (mems.size !== undefined ? mems.size : mems.length) : 0;
    return this.ownId !== null || !!this.charName || (!!this.party && memCount > 0);
  }

  isMeOrParty(actorId) {
    if (actorId === null || actorId === undefined) return false;
    if (this.ownId !== null && actorId === this.ownId) return true;
    if (this.ownId !== null && this.resolveOwner(actorId) === this.ownId) return true;

    // Karakter adı eşleşmesi
    if (this.charName && typeof this.charName === 'string') {
      const name = this.names.get(actorId);
      if (name && typeof name === 'string' && name.toLowerCase() === this.charName.toLowerCase()) return true;
    }

    // Parti üyeleri eşleşmesi
    const mems = this.party && this.party.members;
    if (this.party && mems) {
      const name = this.names.get(actorId);
      if (name && typeof name === 'string') {
        if (typeof mems.has === 'function' && mems.has(name)) return true;
        if (Array.isArray(mems) && mems.includes(name)) return true;
        const lowerName = name.toLowerCase();
        for (const m of mems) {
          if (typeof m === 'string' && m.toLowerCase() === lowerName) return true;
        }
      }
      for (const m of mems) {
        if (typeof m === 'string') {
          if (this.nameIds.get(m) === actorId) return true;
          const mLower = m.toLowerCase();
          for (const [n, id] of this.nameIds) {
            if (typeof n === 'string' && n.toLowerCase() === mLower && id === actorId) return true;
          }
        }
      }
      const ownerId = this.resolveOwner(actorId);
      if (ownerId !== null && ownerId !== actorId) return this.isMeOrParty(ownerId);

      // Gerçek zindan içindeysek (özel oturum) ve aktör bir canavar/çağrı değilse, partimizdendir
      // (kadro tam bilindiğinde adı bilinen ama kadroda olmayan oyuncu yabancıdır; yalnız adsız satırlar partiden sayılır)
      if (this.instanceOn && !(this.party.complete && this.names.has(actorId)) && !this.npcIds.has(actorId) && !this.isSummon(actorId) && !this.isSummonCandidate(actorId)) {
        return true;
      }
    }
    return false;
  }

  // Gerçek zindan içinde miyiz: motor yönetiyorsa kadro+bölge kanıtı; yalnız meter kullanılıyorsa eski kural (ilan zindan numarası)
  get instanceOn() {
    return this.managed ? !!(this.party && this.instanceLive) : !!(this.party && this.party.dungeon > 0);
  }

  // Motor: parti durumu değişti. g = { live, members: [ad], size, instance }. live=false → parti yok (bayat satır/sanal satır olmaz).
  setGroup(g) {
    this.managed = true;
    if (!g || !g.live) {
      if (this.party || this.instanceLive) this.version++;
      this.party = null;
      this.instanceLive = false;
      this.inferred = new Map();
      return;
    }
    const members = new Set((g.members || []).filter((n) => typeof n === 'string' && n));
    this.party = { size: g.size || members.size, dungeon: this.finder ? this.finder.dungeon : 0, members, stats: this.lastStats, complete: !!g.complete };
    this.instanceLive = !!g.instance;
    this.version++;
  }

  // Kadro paketi (0x0092 / 0x2292): oturum kimliği → ad. Kayıtla doğrulanmış kesin eşleme; oyuncu olduğu için canavar listesinden çıkar.
  setRosterNames(entries) {
    if (!Array.isArray(entries)) return 0;
    let n = 0;
    for (const m of entries) {
      if (!m || !m.name || !(m.sid > 0)) continue;
      this.npcIds.delete(m.sid);
      this.setName(m.sid, m.name);
      if (m.server > 0 && !this.partyServer.has(m.name) && this.partyServer.size < 400) this.partyServer.set(m.name, m.server);
      n++;
    }
    if (n) this.version++;
    return n;
  }

  // Yalnız gösterim: çözülmemiş ("Sınıf #id") satırlardan, sınıfı kadroda TEK adayla eşleşen ve o sınıfta başka çözülmemiş
  // satır olmayanlara ad verir. Belirsizse (aynı sınıftan 2+ aday ya da 2+ satır) hiçbir şey yapılmaz. Ad haritasına yazılmaz.
  inferNames(actors) {
    const out = new Map();
    this.inferred = out;
    const mems = this.party && this.party.members;
    if (!mems || !mems.size || !Array.isArray(actors)) return out;
    const own = this.ownId;
    const ownResolved = own !== null && own !== undefined && !!this.ownDisplayName();
    const meName = this.ownDisplayName() || (this.charName && typeof this.charName === 'string' ? this.charName : null);
    const meLow = meName ? meName.toLowerCase() : null;
    const cands = new Map(); // sınıf → [ad]
    for (const nm of mems) {
      if (!nm || typeof nm !== 'string') continue;
      if (this.nameIds.has(nm)) continue; // adı bir kimlikte görüldü
      if (meLow && nm.toLowerCase() === meLow) continue;
      const c = this.partyCls.get(nm);
      if (!c) continue;
      if (!cands.has(c)) cands.set(c, []);
      cands.get(c).push(nm);
    }
    if (!cands.size) return out;
    const un = new Map(); // sınıf → [kimlik]
    const add = (id) => { const c = this.classes.get(id); if (!c) return; if (!un.has(c)) un.set(c, []); un.get(c).push(id); };
    for (const a of actors) {
      const id = a && a.id;
      if (typeof id !== 'number' || id === own || this.names.has(id) || this.summonOwnerName.has(id) || this.npcIds.has(id)) continue;
      if (this.isSummonCandidate(id)) continue;
      add(id);
    }
    if (own !== null && own !== undefined && !ownResolved) add(own); // kendimiz de adsız: aday sayımında yer tutar
    for (const [c, ids] of un) {
      const cs = cands.get(c);
      if (ids.length === 1 && cs && cs.length === 1 && ids[0] !== own) out.set(ids[0], cs[0]);
    }
    return out;
  }

  isTargetHitByMeOrParty(targetId) {
    const e = this.cur;
    if (!e || targetId === null || targetId === undefined) return false;
    if (!this.hasKnownIdentity()) {
      if (e.targets && e.targets.has(targetId)) return true;
      if (e.ownTargetDmg && e.ownTargetDmg.has(targetId)) return true;
      if (e.actors) {
        for (const a of e.actors.values()) {
          if (a.targets && a.targets.has(targetId)) return true;
        }
      }
      return false;
    }
    if (e.targets && e.targets.has(targetId)) return true;
    if (e.ownTargetDmg && e.ownTargetDmg.has(targetId)) return true;
    if (e.lastTarget === targetId) return true;
    if (e.actors) {
      for (const a of e.actors.values()) {
        if (this.isMeOrParty(a.id) && a.targets && a.targets.has(targetId)) return true;
      }
    }
    return false;
  }

  // B-31: Sınıf oylaması. Güçlü kanıt: kişinin kendi başlattığı kullanım (tür 02) ve kendi hasarı.
  // Zayıf kanıt: tür 00 kullanım. Başkasının parti buff'ı (ör. Chanter Sprint Mantra) bizim kimliğimizle
  // tür 00 geliyor; bu yüzden zayıf kanıt sadece hiç güçlü kanıt yokken kullanılır. 10 (Spirit) en son tercih.
  noteClass(actor, cls, strong) {
    if (!cls || actor === null || actor === undefined) return;
    if (this.applyPartyClass(actor)) return; // Sürüm 2.0: 0x0297'den kesin sınıf varsa oylama yapılmaz
    let v = this.classVotes.get(actor);
    if (!v) { v = { strong: new Map(), weak: new Map() }; this.classVotes.set(actor, v); }
    const m = strong ? v.strong : v.weak;
    m.set(cls, (m.get(cls) || 0) + 1);
    const pool = v.strong.size ? v.strong : v.weak;
    let best = null, bestN = -1;
    for (const [c, n] of pool) {
      const better = best === null || (best === 10 && c !== 10) || (c !== 10 && n > bestN) || (c === 10 && best === 10 && n > bestN);
      if (better) { best = c; bestN = n; }
    }
    if (best !== null && this.classes.get(actor) !== best) { this.classes.set(actor, best); this.version++; }
  }

  // B-31: Sınıf güçlü kanıta (tür 02 ya da hasar) dayanıyor mu?
  hasStrongClass(actor) {
    const n = this.names.get(actor);
    if (n && this.partyClass.has(n)) return true;
    const v = this.classVotes.get(actor);
    return !!(v && v.strong.size);
  }

  // Hedef bilinen bir oyuncu mu? (kendimiz, adı ya da sınıfı bilinen; kimlik eşiği değil kanıta dayalı)
  isKnownPlayer(id) {
    if (id === null || id === undefined) return false;
    if (id === this.ownId) return true;
    if (this.isSummon(id) || this.summonOwnerName.has(id)) return false;
    if (this.npcIds.has(id) && !this.names.has(id)) return false;
    if (this.names.has(id)) return true;
    if (this.party && this.party.members) {
      for (const m of this.party.members) {
        if (this.nameIds.get(m) === id) return true;
      }
    }
    const cls = this.classes.get(id);
    if (cls && cls >= 11 && cls <= 19 && !this.npcIds.has(id)) {
      if (cls === 11 || cls === 12 || cls === 13 || cls === 18 || cls === 19) return true;
      if (this.party && this.party.dungeon > 0) return true;
      if (!this.isSummonCandidate(id)) return true;
    }
    return false;
  }

  // Sürüm 2.0: kesin çağrı mı (adlı doğma paketi). Sezgisel summonOwner burada KULLANILMAZ:
  // canavar da yanlışlıkla oraya düşebiliyor (dünya bossu kaydında boss'a giden bütün hasar kayboluyordu).
  isSummon(id) {
    return this.summonOwnerName.has(id);
  }

  // Çağrı / ruh adayı mı (oyuncu değil, çağrı/ruh/tuzak)
  isSummonCandidate(id) {
    if (id === null || id === undefined) return false;
    if (id === this.ownId) return false;
    if (this.names.has(id)) return false;
    if (this.party && this.party.members) {
      for (const m of this.party.members) {
        if (this.nameIds.get(m) === id) return false;
      }
    }
    if (this.isSummon(id) || this.summonOwnerName.has(id) || this.summonOwner.has(id)) return true;
    if (this.npcIds.has(id) || this.classes.get(id) === 10) return true;
    const cls = this.classes.get(id);
    // Sentetik test uyumluluğu: doğma paketi ve ad paketi beslenmemiş, açık alanda parti üyesi olmayan,
    // çağrı sınıfı taşıyan (10, 14 tuzak, 16 ruh, 17 hizmetkâr, 15 öksüz) yüksek ID'li test aktörleri
    if (id >= 20000 && (!cls || cls === 10 || cls === 14 || cls === 16 || cls === 17 || cls === 15)) {
      const mems = this.party && this.party.members;
      const memCount = mems ? (mems.size !== undefined ? mems.size : mems.length) : 0;
      if (mems && memCount > 0) {
        let isKnownPartyMember = false;
        for (const m of mems) {
          if (this.nameIds.get(m) === id) { isKnownPartyMember = true; break; }
        }
        if (isKnownPartyMember) return false;
        return true;
      }
      if (this.party && this.party.dungeon > 0) return false;
      return true;
    }
    return false;
  }

  // 0x0297 karakter şablonundan gelen kesin sınıfı uygular; uyguladıysa true
  applyPartyClass(actor) {
    const n = this.names.get(actor);
    if (!n || !this.partyClass.size) return false;
    const c = this.partyClass.get(n);
    if (!c) return false;
    if (this.classes.get(actor) !== c) { this.classes.set(actor, c); this.version++; }
    return true;
  }

  setPartyClasses(details) {
    if (!Array.isArray(details)) return;
    for (const m of details) {
      if (!m || !m.name || !m.cls) continue;
      this.partyClass.set(m.name, m.cls);
      const id = this.nameIds.get(m.name);
      if (id !== undefined) this.applyPartyClass(id);
    }
  }

  // Sürüm 2.0: 0x4136 doğma. Adsız = canavar/NPC; adlı = o adlı oyuncunun çağrısı/tuzağı.
  noteNpc(id, t) {
    this.npcIds.delete(id);
    this.npcIds.set(id, t || 0);
  }

  noteSummonSpawn(id, ownerName, t) {
    this.noteNpc(id, t);
    this.summonOwnerName.set(id, ownerName);
    const o = this.ownerByName(id);
    if (o !== null) this.summonOwner.set(id, o);
    if (this.summonOwner.size > 5000) pruneMap(this.summonOwner, 2500);
    this.version++;
  }

  ownerByName(actorId) {
    const n = this.summonOwnerName.get(actorId);
    if (!n) return null;
    if (this.ownId !== null && this.charName && n === this.charName) return this.ownId;
    const id = this.nameIds.get(n);
    return id !== undefined && id !== actorId && !this.npcIds.has(id) ? id : null;
  }

  setOwn(id) {
    if (this.ownId !== null && id !== null && this.ownId !== id) {
      this.migrateActor(this.ownId, id);
    }
    this.ownId = id;
    this.version++;
  }
  setOwner(id, owner) { if (this.summonOwner.get(id) !== owner) { this.summonOwner.set(id, owner); this.version++; } }

  // Kendi kimlik geçmişi: sunucu her bölge/zindan girişinde karaktere yeni oturum kimliği verir. Eski kimlik
  // biten dövüşlerde adsız ("Player #N") ikinci bir satır olarak kalmasın diye hatırlanır.
  noteOwnAlias(id, trusted) {
    if (id === null || id === undefined) return;
    const prev = this.ownPast.get(id);
    this.ownPast.delete(id);
    this.ownPast.set(id, !!trusted || prev === true);
    if (this.ownPast.size > 64) this.ownPast.delete(this.ownPast.keys().next().value); // boyut sınırı
  }

  // Eşleştirici kimliği bıraktı ya da gerçek adı başka biri çıktı: bu kimlik bizim değil, birleştirilmez
  forgetOwnAlias(id) {
    if (id === null || id === undefined) return;
    this.ownPast.delete(id);
  }

  // Kesin kaynakla (isim / giriş / ganimet / küresel bağlantı) yeni kimlik bulununca: aynı oturumdaki eski kendi
  // kimliklerimizi güncel ve BİTEN dövüşlerde (geçmiş, boss kayıtları) bu kimliğe birleştir. Eski kimlik bu arada başka
  // adlı bir oyuncuya ya da canavara geçtiyse (kimlik yeniden kullanıldı) dokunulmaz.
  adoptOwnAliases(toId) {
    if (toId === null || toId === undefined || this.ownPast.get(toId) !== true) return 0;
    const me = this.charName && typeof this.charName === 'string' ? this.charName.toLowerCase() : null;
    let n = 0;
    for (const alias of [...this.ownPast.keys()]) {
      if (alias === toId) continue;
      this.ownPast.delete(alias);
      const nm = this.names.get(alias);
      if (nm && typeof nm === 'string' && (!me || nm.toLowerCase() !== me)) continue;
      if (!nm && this.npcIds.has(alias)) continue;
      this.migrateActor(alias, toId, { stored: true });
      n++;
    }
    if (n) this.version++;
    return n;
  }

  migrateActor(fromId, toId, opts) {
    if (!fromId || !toId || fromId === toId) return;
    const mergeInto = (map) => {
      const fromA = map.get(fromId);
      if (!fromA) return;
      let toA = map.get(toId);
      if (!toA) {
        fromA.id = toId;
        map.set(toId, fromA);
        map.delete(fromId);
        return;
      }
      toA.total += fromA.total;
      toA.hits += fromA.hits;
      toA.crits += fromA.crits;
      toA.backs += fromA.backs;
      toA.absorbed = (toA.absorbed || 0) + (fromA.absorbed || 0);
      toA.glancing = (toA.glancing || 0) + (fromA.glancing || 0);
      toA.subHits = (toA.subHits || 0) + (fromA.subHits || 0);
      toA.subHitDmg = (toA.subHitDmg || 0) + (fromA.subHitDmg || 0);
      toA.max = Math.max(toA.max, fromA.max);
      toA.first = Math.min(toA.first, fromA.first);
      toA.last = Math.max(toA.last, fromA.last);
      for (const t of fromA.targets) toA.targets.add(t);
      for (const [sk, s] of fromA.skills) {
        let ts = toA.skills.get(sk);
        if (!ts) {
          const newByTarget = new Map();
          if (s.byTarget) {
            for (const [tgt, dta] of s.byTarget) newByTarget.set(tgt, { ...dta });
          }
          toA.skills.set(sk, { ...s, targets: new Set(s.targets), byTarget: newByTarget });
        } else {
          ts.total += s.total;
          ts.hits += s.hits;
          ts.crits += s.crits;
          ts.max = Math.max(ts.max, s.max);
          ts.min = Math.min(ts.min, s.min);
          ts.backs += s.backs;
          ts.perfect += s.perfect;
          ts.double += s.double;
          ts.parry += s.parry;
          ts.absorbed = (ts.absorbed || 0) + (s.absorbed || 0);
          ts.glancing = (ts.glancing || 0) + (s.glancing || 0);
          ts.subHits = (ts.subHits || 0) + (s.subHits || 0);
          ts.subHitDmg = (ts.subHitDmg || 0) + (s.subHitDmg || 0);
          ts.critDmg += s.critDmg;
          ts.last = Math.max(ts.last, s.last);
          for (const t of s.targets) ts.targets.add(t);
          if (s.byTarget) {
            if (!ts.byTarget) ts.byTarget = new Map();
            for (const [tgt, dta] of s.byTarget) {
              let td = ts.byTarget.get(tgt);
              if (!td) {
                ts.byTarget.set(tgt, { ...dta });
              } else {
                td.total += dta.total;
                td.hits += dta.hits;
                td.crits += dta.crits;
                td.backs += dta.backs;
                td.absorbed = (td.absorbed || 0) + (dta.absorbed || 0);
                td.glancing = (td.glancing || 0) + (dta.glancing || 0);
                td.subHits = (td.subHits || 0) + (dta.subHits || 0);
                td.subHitDmg = (td.subHitDmg || 0) + (dta.subHitDmg || 0);
                td.max = Math.max(td.max, dta.max);
                td.min = Math.min(td.min, dta.min);
                td.critDmg += dta.critDmg;
                td.first = Math.min(td.first, dta.first);
                td.last = Math.max(td.last, dta.last);
              }
            }
          }
        }
      }
      map.delete(fromId);
    };

    // Kimlik birleştirme: güncel dövüş her zaman; opts.stored ise biten dövüşler ve boss kayıtları da
    // (aynı karakterin eski oturum kimliği geçmişte adsız "Player #N" satırı olarak kalmasın). Aynı kayıt hem
    // history hem bossHistory'de durabilir: bir kez işlenir.
    const recs = [];
    if (this.cur) recs.push(this.cur);
    if (opts && opts.stored) {
      for (const x of this.history) if (x && !recs.includes(x)) recs.push(x);
      for (const x of this.bossHistory) if (x && !recs.includes(x)) recs.push(x);
    }
    for (const rec of recs) {
      if (rec.actors) mergeInto(rec.actors);
      if (rec.bossActors) mergeInto(rec.bossActors);
      if (rec.casts) {
        for (const c of rec.casts) {
          if (c.actor === fromId) c.actor = toId;
          if (c.target === fromId) c.target = toId;
        }
      }
      if (rec.consumables) {
        for (const c of rec.consumables) if (c.actor === fromId) c.actor = toId;
      }
      const toA = rec.actors && rec.actors.get(toId);
      if (toA && (fromId === this.ownId || toId === this.ownId)) {
        if (!rec.ownTargetDmg) rec.ownTargetDmg = new Map();
        else rec.ownTargetDmg.clear();
        if (!rec.targets) rec.targets = new Set();
        for (const t of toA.targets) rec.targets.add(t);
        for (const s of toA.skills.values()) {
          if (s.byTarget) {
            for (const [tgt, dta] of s.byTarget) {
              rec.ownTargetDmg.set(tgt, (rec.ownTargetDmg.get(tgt) || 0) + dta.total);
            }
          }
        }
      }
      if (rec.heal && rec.heal.has(fromId)) {
        const fromH = rec.heal.get(fromId);
        let toH = rec.heal.get(toId);
        if (!toH) {
          fromH.id = toId;
          rec.heal.set(toId, fromH);
        } else {
          toH.first = Math.min(toH.first, fromH.first);
          toH.last = Math.max(toH.last, fromH.last);
          for (const [skKey, sk] of fromH.skills) {
            let tsk = toH.skills.get(skKey);
            if (!tsk) {
              toH.skills.set(skKey, { ...sk, targets: new Set(sk.targets) });
            } else {
              tsk.heals += sk.heals;
              tsk.amount += sk.amount;
              tsk.eff += sk.eff;
              tsk.over += sk.over;
              tsk.selfEff += sk.selfEff;
              tsk.unknown += sk.unknown;
              for (const tgt of sk.targets) tsk.targets.add(tgt);
            }
          }
        }
        rec.heal.delete(fromId);
      }
      if (rec.takenBy && rec.takenBy.has(fromId)) {
        const fromT = rec.takenBy.get(fromId);
        let toT = rec.takenBy.get(toId);
        if (!toT) {
          fromT.id = toId;
          rec.takenBy.set(toId, fromT);
        } else {
          toT.amount += fromT.amount;
          toT.hits += fromT.hits;
          toT.ticks += fromT.ticks;
          if (fromT.biggest > toT.biggest) {
            toT.biggest = fromT.biggest;
            toT.biggestSkill = fromT.biggestSkill;
          }
          for (const [sk, s] of fromT.skills) {
            let ts = toT.skills.get(sk);
            if (!ts) {
              toT.skills.set(sk, { ...s, sources: new Set(s.sources) });
            } else {
              ts.amount += s.amount;
              ts.hits += s.hits;
              ts.ticks += s.ticks;
              if (s.biggest > ts.biggest) ts.biggest = s.biggest;
              for (const src of s.sources) ts.sources.add(src);
            }
          }
        }
        rec.takenBy.delete(fromId);
      }
    }
    if (this.vitals && this.vitals.has(fromId)) {
      const v = this.vitals.get(fromId);
      if (!this.vitals.has(toId)) {
        this.vitals.set(toId, v);
      }
      this.vitals.delete(fromId);
    }
    if (this.recapBuf && this.recapBuf.has(fromId)) {
      const bFrom = this.recapBuf.get(fromId);
      const bTo = this.recapBuf.get(toId);
      if (!bTo) {
        this.recapBuf.set(toId, bFrom);
      } else {
        this.recapBuf.set(toId, RecapRing.merge(bTo, bFrom));
      }
      this.recapBuf.delete(fromId);
    }
    if (this.names.has(fromId)) {
      const n = this.names.get(fromId);
      if (!this.names.has(toId)) this.names.set(toId, n);
      if (this.nameIds.get(n) === fromId) this.nameIds.set(n, toId);
      this.names.delete(fromId);
    }
    if (this.classes.has(fromId)) {
      const c = this.classes.get(fromId);
      if (!this.classes.has(toId)) this.classes.set(toId, c);
      this.classes.delete(fromId);
    }
    if (this.classVotes.has(fromId)) {
      const fromV = this.classVotes.get(fromId);
      const toV = this.classVotes.get(toId);
      if (!toV) {
        this.classVotes.set(toId, fromV);
      } else {
        for (const [c, n] of fromV.strong) {
          toV.strong.set(c, (toV.strong.get(c) || 0) + n);
        }
        for (const [c, n] of fromV.weak) {
          toV.weak.set(c, (toV.weak.get(c) || 0) + n);
        }
        if (!this.applyPartyClass(toId)) {
          const pool = toV.strong.size ? toV.strong : toV.weak;
          let best = null, bestN = -1;
          for (const [c, n] of pool) {
            const better = best === null || (best === 10 && c !== 10) || (c !== 10 && n > bestN) || (c === 10 && best === 10 && n > bestN);
            if (better) { best = c; bestN = n; }
          }
          if (best !== null && this.classes.get(toId) !== best) { this.classes.set(toId, best); }
        }
      }
      this.classVotes.delete(fromId);
    }
    this.version++;
  }
  setParty(p, opts) {
    const infoOnly = !!(opts && opts.info);
    if (!p) { if (!infoOnly) this.party = null; else this.finder = null; }
    else {
      // Faz 6.2b (S-17): grup üyelerinin GS/CP'si, sadece canlı 0x0297'den (parti.json'da yok). Her paket bir öncekinin yerine geçer (son gelen).
      const stats = new Map();
      for (const m of p.memberDetails || []) {
        if (!m || !m.name) continue;
        const gs = m.gearScore > 0 && m.gearScore < 100000 ? m.gearScore : 0;
        const cp = m.combatPower >= 1000 && m.combatPower <= 10000000 ? m.combatPower : 0;
        if (gs || cp) stats.set(m.name, { gs, cp });
        if (m.cls && this.partyCls.size < 400) this.partyCls.set(m.name, m.cls);
        if (m.server > 0) {
          if (this.partyServer.size >= 400) this.partyServer.delete(this.partyServer.keys().next().value); // boyut sınırı
          this.partyServer.set(m.name, m.server);
        }
      }
      const members = (p.members instanceof Set) ? p.members : new Set(p.members || []);
      this.lastStats = stats;
      this.finder = { size: p.size, dungeon: p.dungeon, members };
      if (infoOnly) { if (this.party) this.party.stats = stats; } // yalnız bilgi: üyelik/parti durumu değişmez
      else this.party = { size: p.size, dungeon: p.dungeon, members, stats };
    }
    this.version++;
  }
  get inGroup() {
    const mems = this.party && this.party.members;
    const memCount = mems ? (mems.size !== undefined ? mems.size : mems.length) : 0;
    if (this.managed) return !!this.party; // motor yönetiyorsa party yalnız gerçekten partideyken doludur
    return !!this.party && (memCount >= 2 || (this.party.dungeon > 0));
  }

  // Aktörlerin son kullandığı çağırma/tuzak becerilerini kaydet (tüm sınıflar için)
  recordSummonCast(actor, skill, t) {
    if (this.isSummonCandidate(actor)) return; // bir ruh veya çağrı asla sahip adayı olamaz
    if (!this.recentSummonCasts) this.recentSummonCasts = [];
    const cls = classOf(skill);
    const base = baseSkill(skill);
    this.recentSummonCasts.push({ actor, skill, cls, base, t: t || this.now() });
    const cutoff = (t || this.now()) - 20000;
    while (this.recentSummonCasts.length && this.recentSummonCasts[0].t < cutoff) {
      this.recentSummonCasts.shift();
    }
  }

  // Çağrının sahibini zincir boyunca kök oyuncuya kadar izler (çağrı → çağrı → oyuncu).
  // Döngüye karşı korumalı. Kök bir oyuncu değilse null döner.
  resolveOwner(actorId) {
    if (actorId === null || actorId === undefined) return null;
    const byName = this.ownerByName(actorId); // Sürüm 2.0: doğma paketindeki sahip adı (kesin)
    if (byName !== null) return byName;
    if (!this.npcIds.has(actorId) && !this.summonOwner.has(actorId) && this.classes.get(actorId) !== 10 && !this.isSummonCandidate(actorId)) return null;
    let x = actorId;
    const seen = new Set();
    while (this.isSummonCandidate(x) && this.summonOwner.has(x) && !seen.has(x)) {
      seen.add(x);
      x = this.summonOwner.get(x);
    }
    return x !== actorId && x !== null && x !== undefined && !this.isSummonCandidate(x) ? x : null;
  }

  findSummonOwner(actorId, candidateActors) {
    if (this.summonOwner.size > 5000) pruneMap(this.summonOwner, 2500); // boyut sınırı: en eski girişler atılır
    if (actorId === null || actorId === undefined) return null;
    if (!this.isSummonCandidate(actorId)) return null;
    const byName = this.ownerByName(actorId); // Sürüm 2.0: doğma paketindeki sahip adı (kesin)
    if (byName !== null) { this.summonOwner.set(actorId, byName); return byName; }
    if (this.summonOwnerName.has(actorId)) return null; // sahibi adıyla belli ama kimliği henüz görülmedi: tahmin yapılmaz
    const aCls = this.classes.get(actorId);
    if (this.summonOwner.has(actorId)) {
      const o = this.resolveOwner(actorId);
      if (o !== null) return o;
    }

    let targetClasses = aCls ? [aCls] : [10, 16, 17, 18];
    if (aCls === 10 || aCls === 16) targetClasses = [16, 10];
    else if (aCls === 17 || aCls === 18) targetClasses = [18, 17];
    else if (aCls === 15) targetClasses = [15];
    else if (aCls === 14) targetClasses = [14];

    const now = typeof this.now === 'function' ? this.now() : Date.now();

    // 1. Kural: Son 20 sn içinde bu sınıftan çağırma/tuzak becerisi kullanan gerçek aktör var mı?
    if (this.recentSummonCasts && this.recentSummonCasts.length) {
      for (let i = this.recentSummonCasts.length - 1; i >= 0; i--) {
        const sc = this.recentSummonCasts[i];
        if (now - sc.t > 20000) break;
        if (sc.actor !== actorId && !this.isSummonCandidate(sc.actor) && targetClasses.includes(sc.cls)) {
          this.summonOwner.set(actorId, sc.actor);
          return sc.actor;
        }
      }
    }

    // 2. Kural: Parti üyeleri arasında bu sınıfa sahip olan var mı?
    const mems = this.party && this.party.members;
    const memCount = mems ? (mems.size !== undefined ? mems.size : mems.length) : 0;
    if (mems && memCount > 0) {
      for (const [id, name] of this.names) {
        const inParty = typeof mems.has === 'function' ? mems.has(name) : (Array.isArray(mems) ? mems.includes(name) : false);
        if (!this.isSummonCandidate(id) && inParty) {
          const pCls = this.classes.get(id) || (this.partyClass && this.partyClass.get(name));
          if (pCls && targetClasses.includes(pCls)) {
            this.summonOwner.set(actorId, id);
            return id;
          }
        }
      }
      for (const m of mems) {
        const id = this.nameIds.get(m);
        if (id !== undefined && id !== actorId && !this.isSummonCandidate(id)) {
          const pCls = this.classes.get(id) || (this.partyClass && this.partyClass.get(m));
          if (pCls && targetClasses.includes(pCls)) {
            this.summonOwner.set(actorId, id);
            return id;
          }
        }
      }
    }

    // 3. Genel dövüş alanı: Dövüşteki gerçek diğer oyuncularla eşleştir
    if (candidateActors && candidateActors.length) {
      const players = candidateActors.filter((c) => {
        if (c.id === actorId || this.isSummonCandidate(c.id)) return false;
        const cCls = this.classes.get(c.id);
        if (cCls && !targetClasses.includes(cCls)) return false;
        if (this.names.has(c.id) || c.id === this.ownId) return true;
        if (cCls !== 10 && !this.npcIds.has(c.id)) return true;
        return false;
      });

      if (players.length > 0) {
        players.sort((x, y) => {
          const xNamed = this.names.has(x.id) ? 1 : 0;
          const yNamed = this.names.has(y.id) ? 1 : 0;
          if (xNamed !== yNamed) return yNamed - xNamed;
          return y.total - x.total;
        });
        const chosen = players[0].id;
        this.summonOwner.set(actorId, chosen);
        return chosen;
      }
    }

    // 4. Kendi karakterimiz bu sınıftaysa ve alanda başka kimse yoksa
    if (this.ownId !== null && !this.isSummonCandidate(this.ownId)) {
      const myCls = this.classes.get(this.ownId);
      if (myCls && targetClasses.includes(myCls)) {
        this.summonOwner.set(actorId, this.ownId);
        return this.ownId;
      }
    }

    // 5. Yakındaki / alandaki bilinen oyuncular arasında bu sınıfa sahip olan var mı?
    for (const [id, name] of this.names) {
      if (id === actorId || this.isSummonCandidate(id)) continue;
      const pCls = this.classes.get(id);
      if (pCls && targetClasses.includes(pCls)) {
        this.summonOwner.set(actorId, id);
        return id;
      }
    }

    return null;
  }

  // Çağrılan yaratıkların/hizmetkârların/ruhların ve aynı oyuncunun değişen ID'lerinin hasarını birleştir
  mergeSummons(actors) {
    const out = new Map();
    const nameToKey = new Map();

    const myName = (this.ownId !== null ? this.names.get(this.ownId) : null) || this.charName;
    if (this.ownId !== null && myName && typeof myName === 'string') {
      nameToKey.set(myName.toLowerCase(), this.ownId);
    }
    // Bilinen tüm oyuncu isimlerini nameIds üzerinden bağla
    for (const [name, id] of this.nameIds) {
      if (name && typeof name === 'string' && id !== null && id !== undefined && !this.npcIds.has(id)) {
        nameToKey.set(name.toLowerCase(), id);
      }
    }
    // Sürüm 2.0: adlı çağrı satırı sahibinin satırına düşsün diye önce gerçek oyuncu adları
    for (const a of actors) {
      const n = this.names.get(a.id);
      if (n && typeof n === 'string' && !nameToKey.has(n.toLowerCase()) && !this.npcIds.has(a.id)) {
        nameToKey.set(n.toLowerCase(), a.id);
      }
    }

    for (const a of actors) {
      let key = a.id;
      const rawName = this.names.get(a.id) || this.summonOwnerName.get(a.id);
      const aName = (rawName && typeof rawName === 'string') ? rawName : null;
      const aNameLower = aName ? aName.toLowerCase() : null;

      if (a.id === this.ownId) {
        key = this.ownId;
        if (aNameLower) nameToKey.set(aNameLower, this.ownId);
      } else if (aNameLower && nameToKey.has(aNameLower)) {
        key = nameToKey.get(aNameLower);
      } else if (a.id !== this.ownId) {
        const owner = this.resolveOwner(a.id) || (this.isSummonCandidate(a.id) ? this.findSummonOwner(a.id, actors) : null);
        if (owner) {
          this.summonOwner.set(a.id, owner);
          key = owner;
        } else if (aNameLower) {
          nameToKey.set(aNameLower, a.id);
          key = a.id;
        }
      }
      let m = out.get(key);
      if (!m) {
        const clonedSkills = new Map();
        for (const [k, s] of a.skills) {
          const byTargetClone = new Map();
          if (s.byTarget) {
            for (const [tgt, dta] of s.byTarget) byTargetClone.set(tgt, { ...dta });
          }
          clonedSkills.set(k, { ...s, targets: new Set(s.targets), byTarget: byTargetClone });
        }
        m = {
          ...a,
          id: key,
          absorbed: a.absorbed || 0,
          glancing: a.glancing || 0,
          subHits: a.subHits || 0,
          subHitDmg: a.subHitDmg || 0,
          skills: clonedSkills,
          targets: new Set(a.targets),
        };
        out.set(key, m);
        continue;
      }
      m.total += a.total;
      m.hits += a.hits;
      m.crits += a.crits;
      m.backs += a.backs;
      m.absorbed = (m.absorbed || 0) + (a.absorbed || 0);
      m.glancing = (m.glancing || 0) + (a.glancing || 0);
      m.subHits = (m.subHits || 0) + (a.subHits || 0);
      m.subHitDmg = (m.subHitDmg || 0) + (a.subHitDmg || 0);
      m.max = Math.max(m.max, a.max);
      m.first = Math.min(m.first, a.first);
      m.last = Math.max(m.last, a.last);
      for (const t of a.targets) m.targets.add(t);
      for (const [k, s] of a.skills) {
        let o = m.skills.get(k);
        if (!o) {
          const byTargetClone = new Map();
          if (s.byTarget) {
            for (const [tgt, dta] of s.byTarget) byTargetClone.set(tgt, { ...dta });
          }
          m.skills.set(k, { ...s, targets: new Set(s.targets), byTarget: byTargetClone });
        } else {
          o.total += s.total;
          o.hits += s.hits;
          o.crits += s.crits;
          o.max = Math.max(o.max, s.max);
          o.min = Math.min(o.min, s.min);
          o.backs += s.backs;
          o.perfect += s.perfect;
          o.double += s.double;
          o.parry += s.parry;
          o.absorbed = (o.absorbed || 0) + (s.absorbed || 0);
          o.glancing = (o.glancing || 0) + (s.glancing || 0);
          o.subHits = (o.subHits || 0) + (s.subHits || 0);
          o.subHitDmg = (o.subHitDmg || 0) + (s.subHitDmg || 0);
          o.critDmg += s.critDmg;
          o.last = Math.max(o.last, s.last);
          for (const t of s.targets) o.targets.add(t);
          if (s.byTarget) {
            if (!o.byTarget) o.byTarget = new Map();
            for (const [tgt, dta] of s.byTarget) {
              let td = o.byTarget.get(tgt);
              if (!td) {
                o.byTarget.set(tgt, { ...dta });
              } else {
                td.total += dta.total;
                td.hits += dta.hits;
                td.crits += dta.crits;
                td.backs += dta.backs;
                td.absorbed = (td.absorbed || 0) + (dta.absorbed || 0);
                td.glancing = (td.glancing || 0) + (dta.glancing || 0);
                td.subHits = (td.subHits || 0) + (dta.subHits || 0);
                td.subHitDmg = (td.subHitDmg || 0) + (dta.subHitDmg || 0);
                td.max = Math.max(td.max, dta.max);
                td.min = Math.min(td.min, dta.min);
                td.critDmg += dta.critDmg;
                td.first = Math.min(td.first, dta.first);
                td.last = Math.max(td.last, dta.last);
              }
            }
          }
        }
      }
    }
    return [...out.values()];
  }
  setCharName(name) {
    if (!name || typeof name !== 'string') {
      this.charName = null;
      this.version++;
      return;
    }
    const clean = name.trim();
    this.charName = clean || null;
    this.version++;
  }

  setName(id, name) {
    if (!name || typeof name !== 'string') return;
    const clean = name.trim();
    if (!clean) return;
    this.names.set(id, clean);
    this.nameIds.set(clean, id);
    if (this.partyClass.size) this.applyPartyClass(id);
    this.version++;
  }

  reset() {
    if (this.cur) this.finish();
    this.history = [];
    this.version++;
  }

  clearBosses() {
    this.bossHistory = [];
    this.version++;
  }

  newEncounter(t) {
    return {
      start: t, last: t, actors: new Map(), targets: new Set(), ownTargetDmg: new Map(),
      taken: 0, takenHits: 0, deaths: 0, lastTarget: null, lastTargetAt: 0, lastOwnHitAt: 0,
      lastGroupHitAt: t,
      isBoss: false, bossId: null, bossName: null, bossCode: null, bossMaxHp: 0,
      bossActors: new Map(), bossTotalDamage: 0, bossFirst: 0, bossLast: 0,
      bossKilled: false, bossKilledAt: 0, bossChecked: new Set(),
      heal: new Map(), takenBy: new Map(), deathList: [], // Sürüm 2.0
      casts: [], consumables: [], staggerBreaks: 0, staggeredMs: 0, staggerBurstDmg: 0, staggerWindows: [], // Faz 7: Zaman Tüneli & Replay
    };
  }

  recordCast(actor, skill, t, target, kind) {
    if (!this.cur) return;
    if (!this.cur.casts) this.cur.casts = [];
    if (this.cur.casts.length >= 1500) return;
    const resolved = this.resolveOwner(actor) || actor;
    const name = this.skillName ? this.skillName(skill) : ('#' + skill);
    this.cur.casts.push({
      t,
      actor: resolved,
      skill,
      name,
      target: target || null,
      kind: kind || 0,
      icon: iconUrl(skill),
    });
  }

  recordConsumable(actor, itemSkill, t) {
    if (!this.cur) return;
    if (!this.cur.consumables) this.cur.consumables = [];
    if (this.cur.consumables.length >= 300) return;
    const resolved = this.resolveOwner(actor) || actor;
    const name = this.skillName ? this.skillName(itemSkill) : ('#' + itemSkill);
    this.cur.consumables.push({
      t,
      actor: resolved,
      itemSkill,
      name,
      icon: iconUrl(itemSkill),
    });
  }

  // t: ms
  tick(t) {
    if (t - this.lastPrune > 30000) { this.lastPrune = t; this.prune(t); }
    if (this.cur) {
      const isBoss = this.cur.isBoss && (!this.hasKnownIdentity() || this.isTargetHitByMeOrParty(this.cur.bossId));
      const limit = isBoss ? this.bossIdleMs : this.idleMs;
      // Grup/kendi vuruş zaman aşımı (Fikir 1):
      // Bizim veya partimizin son vuruşundan (lastGroupHitAt) bu yana limit geçmişse,
      // alandaki yabancı oyuncular başka hedeflere veya boss'a vurmaya devam etse bile sayacımız kapanır ve DPS erimez!
      if (this.cur.lastGroupHitAt && (t - this.cur.lastGroupHitAt > limit)) {
        this.finish();
        return;
      }
      if (t - this.cur.last > limit) this.finish();
    }
  }

  finish() {
    const e = this.cur;
    this.cur = null;
    if (!e) return;
    if (e.isBoss && e.bossId !== null) {
      const g = this.gauges.get(e.bossId);
      if (g) {
        let stagMs = e.staggeredMs || 0;
        if (g.broken && g.brokenAt) {
          const rem = Math.max(0, (e.bossLast || e.last) - g.brokenAt);
          stagMs += rem;
          if (e.staggerWindows && e.staggerWindows.length) {
            const lw = e.staggerWindows[e.staggerWindows.length - 1];
            if (lw && (!lw.dur || lw.dur === 0)) lw.dur = rem;
          }
        }
        const burst = e.staggerBurstDmg !== undefined ? e.staggerBurstDmg : g.burstDmg;
        e.staggerSummary = { breaks: e.staggerBreaks !== undefined ? e.staggerBreaks : g.breaks, burstDmg: burst, staggeredMs: stagMs, windows: (e.staggerWindows || []).slice() };
      }
    }
    if (typeof this.onFinish === 'function') this.onFinish(e);
    if (e.actors.size) {
      this.history.unshift(e);
      if (this.history.length > this.maxHistory) this.history.pop();
    }
    if (e.isBoss && e.bossTotalDamage > 0) {
      this.archiveBoss(e);
    }
    this.version++;
  }

  totalDamageOf(e) {
    let sum = 0;
    for (const a of e.actors.values()) sum += a.total;
    return sum;
  }

  archiveBoss(e) {
    const prev = this.bossHistory[0];
    const SPLIT_WINDOW_MS = 90000;
    const canMerge = prev && prev.bossId === e.bossId && !prev.bossKilled && !prev.bossWiped && !e.bossWiped && (e.bossFirst - prev.bossLast <= SPLIT_WINDOW_MS);
    if (canMerge) {
      prev.bossLast = Math.max(prev.bossLast, e.bossLast);
      prev.bossTotalDamage += e.bossTotalDamage;
      if (e.bossKilled) {
        prev.bossKilled = true;
        prev.bossKilledAt = e.bossKilledAt;
        prev.bossWiped = false;
      }
      if (e.bossMaxHp) prev.bossMaxHp = Math.max(prev.bossMaxHp, e.bossMaxHp);
      prev.allTotal = (prev.allTotal || prev.bossTotalDamage || 0) + this.totalDamageOf(e);
      for (const [id, a] of e.bossActors) {
        let pa = prev.bossActors.get(id);
        if (!pa) {
          pa = { id: a.id, total: 0, hits: 0, crits: 0, backs: 0, first: a.first, last: a.last, max: 0, skills: new Map(), targets: new Set(a.targets), absorbed: 0, glancing: 0, subHits: 0, subHitDmg: 0 };
          prev.bossActors.set(id, pa);
        }
        pa.total += a.total;
        pa.hits += a.hits;
        pa.crits += a.crits;
        pa.backs += a.backs;
        pa.absorbed = (pa.absorbed || 0) + (a.absorbed || 0);
        pa.glancing = (pa.glancing || 0) + (a.glancing || 0);
        pa.subHits = (pa.subHits || 0) + (a.subHits || 0);
        pa.subHitDmg = (pa.subHitDmg || 0) + (a.subHitDmg || 0);
        pa.max = Math.max(pa.max, a.max);
        pa.first = Math.min(pa.first, a.first);
        pa.last = Math.max(pa.last, a.last);
        for (const t of a.targets) pa.targets.add(t);
        for (const [sk, s] of a.skills) {
          let ps = pa.skills.get(sk);
          if (!ps) {
            const byTargetClone = new Map();
            if (s.byTarget) {
              for (const [tgt, dta] of s.byTarget) byTargetClone.set(tgt, { ...dta });
            }
            ps = { ...s, targets: new Set(s.targets), byTarget: byTargetClone };
            pa.skills.set(sk, ps);
          } else {
            ps.total += s.total;
            ps.hits += s.hits;
            ps.crits += s.crits;
            ps.max = Math.max(ps.max, s.max);
            ps.min = Math.min(ps.min, s.min);
            ps.backs += s.backs;
            ps.perfect += s.perfect;
            ps.double += s.double;
            ps.parry += s.parry;
            ps.absorbed = (ps.absorbed || 0) + (s.absorbed || 0);
            ps.glancing = (ps.glancing || 0) + (s.glancing || 0);
            ps.subHits = (ps.subHits || 0) + (s.subHits || 0);
            ps.subHitDmg = (ps.subHitDmg || 0) + (s.subHitDmg || 0);
            ps.critDmg += s.critDmg;
            ps.last = Math.max(ps.last, s.last);
            for (const t of s.targets) ps.targets.add(t);
            if (s.byTarget) {
              if (!ps.byTarget) ps.byTarget = new Map();
              for (const [tgt, dta] of s.byTarget) {
                let td = ps.byTarget.get(tgt);
                if (!td) {
                  ps.byTarget.set(tgt, { ...dta });
                } else {
                  td.total += dta.total;
                  td.hits += dta.hits;
                  td.crits += dta.crits;
                  td.backs += dta.backs;
                  td.absorbed = (td.absorbed || 0) + (dta.absorbed || 0);
                  td.glancing = (td.glancing || 0) + (dta.glancing || 0);
                  td.subHits = (td.subHits || 0) + (dta.subHits || 0);
                  td.subHitDmg = (td.subHitDmg || 0) + (dta.subHitDmg || 0);
                  td.max = Math.max(td.max, dta.max);
                  td.min = Math.min(td.min, dta.min);
                  td.critDmg += dta.critDmg;
                  td.first = Math.min(td.first, dta.first);
                  td.last = Math.max(td.last, dta.last);
                }
              }
            }
          }
        }
      }
      if (e.staggerSummary) {
        if (!prev.staggerSummary) {
          prev.staggerSummary = { ...e.staggerSummary };
        } else {
          const addBreaks = e.staggerBreaks !== undefined ? e.staggerBreaks : e.staggerSummary.breaks;
          const addMs = e.staggeredMs !== undefined ? e.staggeredMs : e.staggerSummary.staggeredMs;
          const addBurst = e.staggerBurstDmg !== undefined ? e.staggerBurstDmg : e.staggerSummary.burstDmg;
          prev.staggerSummary.breaks = (prev.staggerSummary.breaks || 0) + (addBreaks || 0);
          prev.staggerSummary.burstDmg = (prev.staggerSummary.burstDmg || 0) + (addBurst || 0);
          prev.staggerSummary.staggeredMs = (prev.staggerSummary.staggeredMs || 0) + (addMs || 0);
        }
      }
      if (e.staggerWindows && e.staggerWindows.length) {
        if (!prev.staggerWindows) prev.staggerWindows = [];
        prev.staggerWindows = prev.staggerWindows.concat(e.staggerWindows);
      }
      if (e.casts && e.casts.length) {
        if (!prev.casts) prev.casts = [];
        prev.casts = prev.casts.concat(e.casts).slice(-1500);
      }
      if (e.consumables && e.consumables.length) {
        if (!prev.consumables) prev.consumables = [];
        prev.consumables = prev.consumables.concat(e.consumables).slice(-300);
      }
      this.checkPersonalBest(prev);
      this.recordBoss(prev);
      return;
    }
    e.allTotal = this.totalDamageOf(e);
    if (this.mobsCache && e.bossCode && e.bossName && e.bossName !== 'Boss' && !e.bossName.startsWith('Boss #') && e.bossName !== '???') {
      this.mobsCache.learn(e.bossCode, {
        name: e.bossName,
        maxHp: e.bossMaxHp,
        boss: true
      });
    }
    this.bossHistory.unshift(e);
    if (this.bossHistory.length > 20) this.bossHistory.pop();
    this.checkPersonalBest(e);
    this.recordBoss(e);
  }

  // Faz 8.14: biten (öldürülen) boss denemesinde kendi DPS'in dışarıdaki PB deposuna sorulur; rekorsa dövüş kaydına işaretlenir.
  checkPersonalBest(e) {
    try {
      if (typeof this.onBossEnd !== 'function' || !e || !e.bossKilled || this.ownId === null) return;
      const a = e.bossActors && e.bossActors.get(this.ownId);
      if (!a || !(a.total > 0)) return;
      const dur = Math.max(1000, (e.bossKilledAt || e.bossLast || e.last) - (e.bossFirst || e.start));
      const dps = a.total / (dur / 1000);
      const r = this.onBossEnd({ code: e.bossCode, name: e.bossName, dps, dur });
      if (r && r.isNew) { e.pbNew = true; e.pbPrev = r.prev; e.pbDps = dps; this.version++; }
    } catch { /* PB hatası ölçümü etkilemesin */ }
  }

  promoteBoss(targetId, ti, t, actorId) {
    const e = this.cur;
    if (!e) return;
    if (typeof ti === 'number' && t === undefined) { t = ti; ti = null; }
    if (ti) {
      const nm = (ti.name || '').toLowerCase();
      if (nm.includes('dummy') || nm.includes('scarecrow') || nm.includes('korkuluk') || nm.includes('kukla') || nm.includes('training') || nm.includes('antrenman')) {
        return; // Antrenman korkulukları ve kuklalar asla boss olamaz
      }
    }
    // Biz veya partimiz bu hedefi vurmadıysa terfi etme!
    const isHittingNow = actorId !== undefined && actorId !== null && (this.isMeOrParty(actorId) || !this.hasKnownIdentity());
    if (!isHittingNow && !this.isTargetHitByMeOrParty(targetId)) {
      return;
    }
    if (e.isBoss && e.bossId === targetId) {
      if (ti && ti.name && (e.bossName === 'Boss' || e.bossName.startsWith('Boss #'))) e.bossName = ti.name;
      if (ti && ti.max && !e.bossMaxHp) e.bossMaxHp = ti.max;
      return;
    }
    // Mevcut boss canlıyken ve hasar almışken minyon/add vuruşları boss'un yerini almasın.
    // Ancak oyuncu doğrudan yeni boss'u hedeflediyse veya eski boss'a hiç vurmadıysa/eski boss hareketsizse yeni boss'a geç.
    if (e.isBoss && e.bossId && e.bossId !== targetId && e.bossTotalDamage > 200000 && !e.bossKilled) {
      const isPlayerHittingNewBoss = e.lastTarget === targetId || (e.ownTargetDmg && e.ownTargetDmg.has(targetId));
      const playerHitOldBoss = e.ownTargetDmg && e.ownTargetDmg.has(e.bossId);
      const oldBossStale = e.bossLast && (t - e.bossLast > 8000);
      if (!isPlayerHittingNewBoss && (playerHitOldBoss || !oldBossStale)) {
        return;
      }
    }
    e.isBoss = true;
    e.bossId = targetId;
    let realName = ti && ti.name && ti.name !== '???' && !ti.name.startsWith('Monster') && ti.name !== 'Boss' ? ti.name : null;
    e.bossCode = (ti && ti.code) || null;
    e.bossMaxHp = (ti && ti.max) || 0;

    if (!realName && this.mobsCache) {
      if (e.bossCode) {
        const mc = this.mobsCache.findByCode(e.bossCode);
        if (mc && mc.name && !mc.name.startsWith('Monster #') && mc.name !== '???') {
          realName = mc.name;
        }
      }
      if (!realName && e.bossMaxHp > 0) {
        const mh = this.mobsCache.findByHp(e.bossMaxHp);
        if (mh && mh.name) {
          realName = mh.name;
          if (mh.code && !e.bossCode) e.bossCode = mh.code;
        }
      }
    }

    e.bossName = realName || (e.bossCode ? `Boss #${e.bossCode}` : 'Boss');
    if (realName && e.bossCode && this.mobsCache) {
      this.mobsCache.learn(e.bossCode, {
        name: realName,
        maxHp: e.bossMaxHp,
        boss: true
      });
    }

    // Retroactively rebuild bossActors and bossTotalDamage from e.actors for targetId
    e.bossActors.clear();
    e.bossTotalDamage = 0;
    let earliestHit = t || e.last;
    for (const [actorId, a] of e.actors) {
      if (a.targets.has(targetId)) {
        for (const [skKey, s] of a.skills) {
          if (s.targets.has(targetId)) {
            const td = s.byTarget && s.byTarget.get(targetId);
            const targetDmg = td ? td.total : (s.targets.size === 1 ? s.total : 0);
            if (targetDmg <= 0) continue;
            const targetHits = td ? td.hits : (s.targets.size === 1 ? s.hits : 1);
            const targetCrits = td ? td.crits : (s.targets.size === 1 ? s.crits : 0);
            const targetBacks = td ? td.backs : (s.targets.size === 1 ? s.backs : 0);
            const targetAbsorbed = td ? (td.absorbed || 0) : (s.targets.size === 1 ? (s.absorbed || 0) : 0);
            const targetGlancing = td ? (td.glancing || 0) : (s.targets.size === 1 ? (s.glancing || 0) : 0);
            const targetSubHits = td ? (td.subHits || 0) : (s.targets.size === 1 ? (s.subHits || 0) : 0);
            const targetSubHitDmg = td ? (td.subHitDmg || 0) : (s.targets.size === 1 ? (s.subHitDmg || 0) : 0);
            const targetMax = td ? td.max : s.max;
            const targetFirst = td ? td.first : s.first;
            const targetLast = td ? td.last : s.last;
            const targetMin = td ? td.min : s.min;
            const targetCritDmg = td ? td.critDmg : (targetCrits ? s.critDmg : 0);
            let ba = e.bossActors.get(actorId);
            if (!ba) {
              ba = { id: actorId, total: 0, hits: 0, crits: 0, backs: 0, first: targetFirst, last: targetLast, max: 0, skills: new Map(), targets: new Set([targetId]), absorbed: 0, glancing: 0, subHits: 0, subHitDmg: 0 };
              e.bossActors.set(actorId, ba);
            }
            ba.total += targetDmg;
            ba.hits += targetHits;
            ba.crits += targetCrits;
            ba.backs += targetBacks;
            ba.absorbed = (ba.absorbed || 0) + targetAbsorbed;
            ba.glancing = (ba.glancing || 0) + targetGlancing;
            ba.subHits = (ba.subHits || 0) + targetSubHits;
            ba.subHitDmg = (ba.subHitDmg || 0) + targetSubHitDmg;
            ba.max = Math.max(ba.max, targetMax);
            ba.first = Math.min(ba.first, targetFirst);
            ba.last = Math.max(ba.last, targetLast);
            const bossTd = td ? { ...td } : { total: targetDmg, hits: targetHits, crits: targetCrits, backs: targetBacks, absorbed: targetAbsorbed, glancing: targetGlancing, subHits: targetSubHits, subHitDmg: targetSubHitDmg, max: targetMax, min: targetMin, critDmg: targetCritDmg, first: targetFirst, last: targetLast };
            ba.skills.set(skKey, {
              ...s,
              total: targetDmg,
              hits: targetHits,
              crits: targetCrits,
              backs: targetBacks,
              absorbed: targetAbsorbed,
              glancing: targetGlancing,
              subHits: targetSubHits,
              subHitDmg: targetSubHitDmg,
              max: targetMax,
              min: targetMin,
              critDmg: targetCritDmg,
              first: targetFirst,
              last: targetLast,
              targets: new Set([targetId]),
              byTarget: new Map([[targetId, bossTd]]),
            });
            e.bossTotalDamage += targetDmg;
            if (targetFirst && targetFirst < earliestHit) earliestHit = targetFirst;
          }
        }
      }
    }
    e.bossFirst = earliestHit;
    e.bossLast = t || e.last;
    this.version++;
  }

  damage(d) {
    if (!d || d.damage <= 0) return;
    const t = d.t;
    if (!isPlayerSkill(d.skill)) {
      // canavarın oyunculara vurduğu: sadece "alınan hasar" için
      if (this.cur && d.target === this.ownId) {
        this.cur.taken += d.damage;
        this.cur.takenHits++;
        this.cur.lastGroupHitAt = t;
        this.version++;
      }
      if (this.isKnownPlayer(d.target)) this.recordTaken(d);
      return;
    }
    // B-33: Oyuncunun bilinen bir oyuncuya "hasarı" iyileştirme, kalkan ya da koruma etkisidir
    // (kayıtlarda: Recuperation, Light of Regeneration, Protection Circle, Guarding Seal …). Hasar sayılmaz.
    // PvP hasarı da bu yüzden şimdilik sayılmaz (Faz 6.1'de ayrı ele alınacak).
    if (this.isKnownPlayer(d.target)) {
      this.playerTargetSkipped++;
      // Sürüm 2.0: oyuncudan oyuncuya giden değer iyileştirme, kalkan ya da buff olabilir; paket ayırt etmiyor.
      // İyileştirme adayı olarak işlenir; becerisi hedefin canını gerçekten artırınca (0x008d) iyileştirme sayılır.
      if (!d.dot) this.heal({ t, target: d.target, actor: d.actor, skill: d.skill, amount: Math.abs(d.damage), direct: true });
      return;
    }
    if (this.isSummon(d.target)) { this.playerTargetSkipped++; return; } // çağrıya giden (iyileştirme/buff) hasar değildir
    const cls = classOf(d.skill);
    if (cls) this.noteClass(d.actor, cls, true);
    if (this.isSummonCandidate(d.actor) && this.resolveOwner(d.actor) === null) {
      this.findSummonOwner(d.actor, this.cur ? [...this.cur.actors.values()] : null);
    }
    this.tick(t);

    const isOwn = d.actor === this.ownId || (this.ownId !== null && this.resolveOwner(d.actor) === this.ownId);
    const meOrParty = isOwn || this.isMeOrParty(d.actor);
    const knownIdentity = this.hasKnownIdentity();

    // 💡 Fikir 1: Biz veya partimiz vurmadan dövüş ve sayaç ASLA başlamasın.
    if (!this.cur) {
      if (knownIdentity && !meOrParty) {
        const isDungeon = !!(this.party && this.party.dungeon > 0);
        if (!isDungeon && !(this.now() < (this.zoneGraceUntil || 0))) {
          return; // Çevredeki yabancıların açık alandaki vuruşları yeni bir dövüş başlatamaz!
        }
      }
      this.cur = this.newEncounter(t);
    }
    const e = this.cur;
    e.last = t;

    if (meOrParty) {
      e.lastGroupHitAt = t;
    }

    if (this.targetInfo) {
      const ti = this.targetInfo(d.target);
      if (ti && ti.boss) {
        if (!e.isBoss || e.bossId !== d.target) {
          // Boss terfisi: Sadece biz veya partimiz hedefe vurduğunda veya kimlik henüz bilinmiyorken
          if (meOrParty || !knownIdentity) {
            this.promoteBoss(d.target, ti, t, d.actor);
          }
        } else {
          if (ti.name && (e.bossName === 'Boss' || e.bossName.startsWith('Boss #'))) e.bossName = ti.name;
          if (ti.max && !e.bossMaxHp) e.bossMaxHp = ti.max;
        }
      }
    }

    if (isOwn) {
      e.targets.add(d.target);
      e.lastTarget = d.target;
      e.lastTargetAt = t;
      e.lastOwnHitAt = t;
      e.ownTargetDmg.set(d.target, (e.ownTargetDmg.get(d.target) || 0) + d.damage);
    }
    addHit(e.actors, d, t);
    if (!e.targetRate) e.targetRate = new Map();
    const tr = e.targetRate.get(d.target);
    if (!tr) e.targetRate.set(d.target, { first: t, dmg: d.damage }); else tr.dmg += d.damage;

    if (e.isBoss && d.target === e.bossId) {
      if (!d.dot && e.bossKilled) {
        e.bossKilled = false;
        e.bossKilledAt = 0;
      }
      if (!e.bossKilled) {
        addHit(e.bossActors, d, t);
        e.bossTotalDamage += d.damage;
        const g = this.gauges.get(e.bossId);
        if (g && g.broken) {
          g.burstDmg += d.damage; // kırılma (patlama) penceresinde vurulan
          e.staggerBurstDmg = (e.staggerBurstDmg || 0) + d.damage;
        }
        if (!e.bossFirst) e.bossFirst = t;
        e.bossLast = t;
      }
    }
    this.version++;
  }

  // ---------------------------------------------------------------------------
  // Sürüm 2.0: iyileştirme (HPS), alınan hasar, ölüm özeti, kırılma göstergesi
  // ---------------------------------------------------------------------------

  // h: { t, target, actor, skill, amount, self?, hot?, direct? }
  // Kaynaklar: 0x0538 HoT tiki (etki&1, protokolle kesin iyileştirme) ve 0x0438 oyuncu → oyuncu / kendine değer.
  // 0x0438 değeri kalkan ya da buff da olabildiği için doğrudan değerler, becerisi bir kez hedefin canını
  // ölçülebilir biçimde artırana kadar (healSkills) iyileştirme görünümüne girmez.
  heal(h) {
    if (!h || !(h.amount > 0) || h.target === null || h.target === undefined) return;
    const classSkill = classOf(h.skill) !== null;
    const self = h.self || h.actor === h.target;
    const targetIsPlayer = this.isKnownPlayer(h.target) || (classSkill && !this.npcIds.has(h.target)) || (self && !this.npcIds.has(h.target));
    if (!targetIsPlayer) return; // canavarın kendini iyileştirmesi, çağrıya gelen değerler sayılmaz
    if (!classSkill && !self) return;
    const base = baseSkill(h.skill);
    if (h.direct && classSkill && !this.healSkills.has(base)) {
      const v0 = this.vitals.get(h.target);
      this.healProbe.set(h.target, { t: h.t, amount: h.amount, base, hp: v0 ? v0.hp : null });
    }
    const e = this.cur;
    if (!e) return; // iyileştirme dövüş başlatmaz (Fikir 1)
    if (!e.heal) e.heal = new Map();
    let healer = h.actor;
    const owner = this.resolveOwner(h.actor);
    if (owner !== null) healer = owner;
    const v = this.vitals.get(h.target);
    let eff = h.amount;
    let known = false;
    if (v && v.max > 0 && v.hp !== null && v.hp !== undefined) {
      eff = Math.min(h.amount, Math.max(0, v.max - v.hp));
      known = true;
      // aynı can güncellemesinden önce gelen ikinci iyileştirme aynı boşluğu tekrar doldurmasın
      // (sadece kesin iyileştirmede; doğrulanmamış kalkan/buff değeri canı doldurmuş sayılmaz)
      if (h.hot || this.healSkills.has(base)) v.hp = Math.min(v.max, v.hp + eff);
    }
    let a = e.heal.get(healer);
    if (!a) { a = { id: healer, first: h.t, last: h.t, skills: new Map() }; e.heal.set(healer, a); }
    a.last = h.t;
    const key = (classSkill ? '' : 'item:') + base;
    let sk = a.skills.get(key);
    if (!sk) {
      sk = { skill: base, raw: h.skill, item: !classSkill, hot: false, heals: 0, amount: 0, eff: 0, over: 0, selfEff: 0, unknown: 0, targets: new Set() };
      a.skills.set(key, sk);
    }
    sk.heals++;
    sk.amount += h.amount;
    sk.eff += eff;
    sk.over += h.amount - eff;
    if (!known) sk.unknown += h.amount;
    if (self) sk.selfEff += eff;
    if (h.hot) sk.hot = true;
    sk.targets.add(h.target);
    this.version++;
  }

  // 0x008d: oyuncunun canı / azami canı. Ölüm (can 0) ve dirilme buradan anlaşılır; 0x4236 oyuncular için gelmiyor.
  hpUpdate(id, hp, max, t) {
    if (!this.isKnownPlayer(id)) return;
    let v = this.vitals.get(id);
    if (!v) { v = { hp: null, max: 0, t }; this.vitals.set(id, v); }
    v.t = t;
    if (max > 0) v.max = max;
    if (hp === null || hp === undefined) return;
    const prev = v.hp;
    v.hp = hp;
    const p = this.healProbe.get(id);
    if (p) {
      const before = p.hp !== null && p.hp !== undefined ? p.hp : prev;
      if (t - p.t <= 1000 && before !== null && before !== undefined && hp > before) {
        const d = hp - before;
        // Sadece birebir eşitlik kanıt sayılır (kayıtlarda 966 vaka); "cana tavan yaptı" gibi gevşek kural
        // kalkan/buff becerilerini (Defiance, Crossguard) yanlışlıkla iyileştirme yapıyordu.
        if (d === p.amount && !this.healSkills.has(p.base)) { this.healSkills.add(p.base); this.version++; }
      }
      this.healProbe.delete(id);
    }
    if (hp === 0 && prev !== 0 && !this.deadAt.has(id)) this.onDeath(id, t);
    else if (hp > 0 && this.deadAt.has(id)) {
      const r = this.deadAt.get(id);
      r.deadFor = Math.max(0, t - r.t);
      this.deadAt.delete(id);
      this.version++;
    }
  }

  // Canavarın oyuncuya vurduğu (alınan hasar raporu + ölüm özeti tamponu)
  recordTaken(d) {
    const t = d.t;
    let buf = this.recapBuf.get(d.target);
    if (!buf) { buf = new RecapRing(); this.recapBuf.set(d.target, buf); }
    buf.push(t, d.actor, d.skill, d.damage, d.dot); // sabit boyutlu halka: yeni dizi kurulmaz
    const e = this.cur;
    if (!e) return;
    if (!e.takenBy) e.takenBy = new Map();
    let r = e.takenBy.get(d.target);
    if (!r) { r = { id: d.target, amount: 0, hits: 0, ticks: 0, biggest: 0, biggestSkill: null, fatal: null, skills: new Map() }; e.takenBy.set(d.target, r); }
    r.amount += d.damage;
    if (d.dot) r.ticks++; else r.hits++;
    if (d.damage > r.biggest) { r.biggest = d.damage; r.biggestSkill = d.skill; }
    let s = r.skills.get(d.skill);
    if (!s) { s = { skill: d.skill, amount: 0, hits: 0, ticks: 0, biggest: 0, sources: new Set() }; r.skills.set(d.skill, s); }
    s.amount += d.damage;
    if (d.dot) s.ticks++; else s.hits++;
    if (d.damage > s.biggest) s.biggest = d.damage;
    s.sources.add(d.actor);
    this.version++;
  }

  onDeath(id, t) {
    const ring = this.recapBuf.get(id);
    const buf = ring ? ring.snapshot(t, RECAP_WINDOW_MS) : [];
    const last = buf.length ? buf[buf.length - 1] : null;
    const agg = new Map();
    for (const x of buf) {
      const o = agg.get(x.skill) || { skill: x.skill, name: this.skillName(x.skill), amount: 0, hits: 0 };
      o.amount += x.amount;
      o.hits++;
      agg.set(x.skill, o);
    }
    const mobName = (aid) => {
      if (aid === null || aid === undefined) return null;
      if (this.names.has(aid)) return this.names.get(aid);
      const n = this.targetName ? this.targetName(aid) : null;
      return n || null;
    };
    const recap = {
      player: id,
      name: this.label(id),
      cls: this.classes.get(id) || null, // yayıncı modunda rol/sınıf tabanlı takma ad için
      own: id === this.ownId,
      t,
      at: Date.now(),
      killer: last ? last.actor : null,
      killerName: last ? mobName(last.actor) : null,
      skill: last ? last.skill : null,
      skillName: last ? this.skillName(last.skill) : null,
      fatalAmount: last ? last.amount : 0,
      total: buf.reduce((n, x) => n + x.amount, 0),
      taken: [...agg.values()].sort((x, y) => y.amount - x.amount),
      // Faz 8.9: kim / hangi beceri / ne kadar; son vuruş (öldüren) fatal olarak işaretli
      timeline: buf.map((x, i) => ({ dt: Math.round((x.t - t) / 100) / 10 + 0, amount: x.amount, name: this.skillName(x.skill), dot: x.dot, who: mobName(x.actor), fatal: i === buf.length - 1 })),
      deadFor: null,
    };
    this.deathLog.unshift(recap);
    if (this.deathLog.length > 20) this.deathLog.pop();
    this.deadAt.set(id, recap);
    this.recapBuf.delete(id);
    const e = this.cur;
    if (e) {
      if (!e.deathList) e.deathList = [];
      e.deathList.push(recap);
      if (id === this.ownId) e.deaths++;
      const r = e.takenBy && e.takenBy.get(id);
      if (r && last) r.fatal = last.skill;
    }
    this.version++;
  }

  // 0x05e0 kırılma göstergesi
  gauge(g) {
    if (!g || g.id === null || g.id === undefined) return;
    let s = this.gauges.get(g.id);
    if (!s) { s = { id: g.id, max: 0, val: 0, state: 0, broken: false, breaks: 0, brokenAt: 0, burstDmg: 0, staggeredMs: 0, t: g.t }; this.gauges.set(g.id, s); }
    s.t = g.t;
    if (g.broken) {
      if (!s.broken) {
        s.broken = true; s.breaks++; s.brokenAt = g.t;
        if (this.cur && this.cur.isBoss && this.cur.bossId === g.id) {
          this.cur.staggerBreaks = (this.cur.staggerBreaks || 0) + 1;
          if (!this.cur.staggerWindows) this.cur.staggerWindows = [];
          this.cur.staggerWindows.push({ start: g.t, dur: 0 });
        }
      }
      s.val = 0;
    } else {
      if (s.broken && (g.val >= g.max || g.state === 0 || g.state === 1)) {
        s.broken = false;
        const dur = Math.max(0, g.t - s.brokenAt);
        s.staggeredMs += dur;
        if (this.cur && this.cur.isBoss && this.cur.bossId === g.id) {
          this.cur.staggeredMs = (this.cur.staggeredMs || 0) + dur;
          if (this.cur.staggerWindows && this.cur.staggerWindows.length) {
            const lw = this.cur.staggerWindows[this.cur.staggerWindows.length - 1];
            if (lw && (!lw.dur || lw.dur === 0)) lw.dur = dur;
          }
        }
      }
      s.max = g.max;
      s.val = g.val;
      s.state = g.state;
    }
    if (this.cur && this.cur.bossId === g.id) this.version++;
  }

  staggerOf(e) {
    if (!e || !e.isBoss || e.bossId === null || e.bossId === undefined) return null;
    if (e === this.cur) {
      const g = this.gauges.get(e.bossId);
      if (!g || !g.max) return null;
      return { live: true, max: g.max, val: g.val, pct: g.max ? g.val / g.max : 0, state: g.state, broken: g.broken, breaks: g.breaks, burstDmg: g.burstDmg };
    }
    return e.staggerSummary ? { live: false, ...e.staggerSummary } : null;
  }

  // Uzun oturumlarda harita birikmesini önler (her 30 sn). Bölge değişimi paketine güvenilmez; yaş ve üst sınırla budanır.
  prune(t) {
    const cap = (m, n) => { if (m.size > n) { const drop = m.size - Math.floor(n * 0.8); let k = 0; for (const key of m.keys()) { if (k++ >= drop) break; if (key === this.ownId) continue; m.delete(key); } } };
    for (const [id, v] of this.vitals) if (t - v.t > 600000 && id !== this.ownId) this.vitals.delete(id);
    for (const [id, b] of this.recapBuf) if (!b.size || t - b.lastT() > 30000) this.recapBuf.delete(id);
    for (const [id, p] of this.healProbe) if (t - p.t > 5000) this.healProbe.delete(id);
    for (const [id, g] of this.gauges) if (t - g.t > 600000 && !(this.cur && this.cur.bossId === id)) this.gauges.delete(id);
    for (const [id, r] of this.deadAt) if (t - r.t > 1800000) this.deadAt.delete(id);
    cap(this.npcIds, 30000);
    cap(this.summonOwnerName, 5000);
    cap(this.summonOwner, 5000);
    cap(this.classVotes, 5000);
    cap(this.classes, 20000);
    if (this.names.size > 20000) {
      cap(this.names, 20000);
      this.nameIds = new Map();
      for (const [id, n] of this.names) this.nameIds.set(n, id);
    }
  }

  // Görünüm süzgeci (DPS, Şifa ve Alınan listeleri için ortak). null = herkes.
  // me: sadece sen (karakter bilinmiyorsa herkes, seçebilsin diye)
  // party: grup üyeleri (ad eşleşmesi) + sen; grup yoksa sadece sen
  viewFilter(view) {
    const own = this.ownId;
    if (view === 'me') {
      if (own === null) return null;
      return (a) => a.id === own || this.isOwnName(a.id);
    }
    if (view === 'party') {
      if (this.party && this.party.members) {
        return (a) => this.isMeOrParty(a.id);
      }
      if (own !== null) return (a) => a.id === own;
      return null;
    }
    return null;
  }

  // Arayüz: iyileştirme görünümü (grup HPS kendi kendine iyileştirmeyi içermez; iksir/yemek ayrı)
  healView(e, dur, keep) {
    if (!e || !e.heal || !e.heal.size) return null;
    const rows = [];
    let total = 0;
    for (const a of e.heal.values()) {
      if (keep && !keep(a)) continue; // Ben/Grup görünümü: DPS listesiyle aynı süzgeç
      let group = 0, self = 0, amount = 0, over = 0, heals = 0, items = 0, unknown = 0;
      const skills = [];
      for (const sk of a.skills.values()) {
        if (sk.item) { items += sk.eff; continue; }
        if (!sk.hot && !this.healSkills.has(sk.skill)) continue; // doğrulanmamış (kalkan/buff olabilir)
        group += sk.eff - sk.selfEff;
        self += sk.selfEff;
        amount += sk.amount;
        over += sk.over;
        heals += sk.heals;
        unknown += sk.unknown;
        skills.push({ skill: sk.skill, name: this.skillName(sk.raw) + (sk.hot ? ' (HoT)' : ''), icon: iconUrl(sk.raw), eff: sk.eff, self: sk.selfEff, amount: sk.amount, over: sk.over, heals: sk.heals, targets: sk.targets.size, hot: sk.hot });
      }
      if (!(group + self + items > 0)) continue;
      total += group;
      const aLbl = this.label(a.id);
      const aOwn = a.id === this.ownId || (this.charName && typeof this.charName === 'string' && aLbl && aLbl.toLowerCase() === this.charName.toLowerCase());
      rows.push({
        id: a.id, own: aOwn, name: aLbl, cls: this.classes.get(a.id) || null,
        group, self, items, amount, over, heals, unknown,
        hps: group / (dur / 1000), overPct: amount ? over / amount : 0,
        skills: skills.sort((x, y) => y.eff - x.eff),
      });
    }
    if (!rows.length) return null;
    for (const r of rows) r.share = total ? r.group / total : 0;
    rows.sort((x, y) => (y.group - x.group) || (y.self - x.self));
    return { total, hps: total / (dur / 1000), actors: rows };
  }

  // Arayüz: alınan hasar görünümü (oyuncu başına, beceri kırılımı)
  takenView(e, keep) {
    if (!e || !e.takenBy || !e.takenBy.size) return null;
    const rows = [];
    let total = 0;
    for (const r of e.takenBy.values()) {
      if (keep && !keep(r)) continue; // Ben/Grup görünümü: DPS listesiyle aynı süzgeç
      total += r.amount;
      const rLbl = this.label(r.id);
      const rOwn = r.id === this.ownId || (this.charName && typeof this.charName === 'string' && rLbl && rLbl.toLowerCase() === this.charName.toLowerCase());
      rows.push({
        id: r.id, own: rOwn, name: rLbl, cls: this.classes.get(r.id) || null,
        amount: r.amount, hits: r.hits, ticks: r.ticks, biggest: r.biggest,
        biggestName: r.biggestSkill ? this.skillName(r.biggestSkill) : null,
        fatal: r.fatal ? this.skillName(r.fatal) : null,
        skills: [...r.skills.values()].sort((x, y) => y.amount - x.amount).slice(0, 12).map((s) => ({
          skill: s.skill, name: this.skillName(s.skill), amount: s.amount, hits: s.hits, ticks: s.ticks, biggest: s.biggest,
          share: r.amount ? s.amount / r.amount : 0,
          from: [...s.sources].slice(0, 3).map((x) => (this.targetName ? this.targetName(x) : null) || null).filter(Boolean),
        })),
      });
    }
    for (const r of rows) r.share = total ? r.amount / total : 0;
    rows.sort((x, y) => y.amount - x.amount);
    return { total, actors: rows };
  }

  death(id) {
    if (this.cur) {
      if (id === this.ownId) {
        this.cur.deaths++;
      }
      if (this.cur.lastTarget === id) {
        this.cur.lastTarget = null;
        this.cur.lastTargetAt = 0;
      }
      this.bossDead(id);
      this.version++;
    }
  }

  targetDead(id) {
    if (this.cur) {
      if (this.cur.lastTarget === id) {
        this.cur.lastTarget = null;
        this.cur.lastTargetAt = 0;
      }
      this.bossDead(id);
      this.version++;
    }
  }

  targetDespawn(id) {
    if (this.cur) {
      if (this.cur.lastTarget === id) {
        this.cur.lastTarget = null;
        this.cur.lastTargetAt = 0;
      }
      if (this.cur.isBoss && this.cur.bossId === id && !this.cur.bossKilled) {
        this.cur.bossWiped = true;
        this.cur.bossKilled = false;
        this.finish();
      }
      this.version++;
    }
  }

  bossDead(id) {
    const e = this.cur;
    if (e && e.isBoss && e.bossId === id && !e.bossKilled) {
      e.bossKilled = true;
      e.bossKilledAt = typeof this.now === 'function' ? this.now() : Date.now();
      this.version++;
    }
  }

  bossHpUpdate(id, hp, maxHp, t) {
    const e = this.cur;
    if (!e || !e.isBoss || e.bossId !== id || hp <= 0) return;

    if (maxHp && !e.bossMaxHp) e.bossMaxHp = maxHp;
    const fullHp = e.bossMaxHp || maxHp || 0;

    if (!e.bossLowestHp || hp < e.bossLowestHp) {
      e.bossLowestHp = hp;
    }

    // Kesin ve Anında Boss Reset / Wipe Algılama:
    // Boss ile dövüşürken hasar verilmişse (canı inmişse) ve sunucudan gelen paketle
    // canı tam azami canına (%100'e) geri fırladıysa:
    // DİKKAT: Boss sadece %98-%99'dayken ve henüz hiç canı inmemişken (ör. dövüşün başında)
    // birkaç saniye vuruş gitmedi diye ASLA wipe sayılamaz!
    // Gerçek bir reset için boss canının önceden belirgin şekilde (< %90) düşmüş olması gerekir.
    const hasBeenDamaged = e.bossTotalDamage > 10000 || (fullHp > 0 && e.bossLowestHp < fullHp * 0.99);
    const hasSubstantiallyDropped = fullHp > 0 && e.bossLowestHp < fullHp * 0.90;
    const now = t || (typeof this.now === 'function' ? this.now() : Date.now());
    const idleTime = e.lastGroupHitAt ? (now - e.lastGroupHitAt) : (e.bossLast ? (now - e.bossLast) : 0);

    if (hasBeenDamaged && fullHp > 0 && hp >= fullHp && (e.bossLowestHp < fullHp * 0.98 || idleTime > 5000)) {
      e.bossKilled = false;
      e.bossWiped = true;
      this.finish();
      return;
    }

    // İkinci emniyet: Boss canı daha önce %90'ın altına inmiş, sonra agro kırılıp %98'e çıkmışsa ve son 8 saniyedir bizden vuruş gitmiyorsa:
    if (idleTime > 8000 && hasSubstantiallyDropped && fullHp > 0 && hp >= fullHp * 0.98) {
      e.bossKilled = false;
      e.bossWiped = true;
      this.finish();
    }
  }

  // Faz 6.2b: grup üyesiyse { gs, cp } (yoksa boş). Sadece ad bilinen ve grup paketinde geçen oyuncu.
  memberStats(id) {
    const st = (this.party && this.party.stats) || this.lastStats;
    const pn = typeof id === 'string' && id.startsWith('p:') ? id.slice(2) : null;
    const n = pn || ((st && st.size) || this.partyServer.size ? (this.names.get(id) || (id === this.ownId ? this.ownDisplayName() : null)) : null);
    const v = n && st ? st.get(n) : null;
    const sv = n ? this.partyServer.get(n) : 0;
    const o = v ? { gs: v.gs || 0, cp: v.cp || 0 } : {};
    if (sv > 0) o.server = sv; // sunucu numarası (oyuncu defteri / puanlama kimliği)
    return o;
  }

  // Oyuncu defteri: biten boss kaydını (arşivlenen ya da öncekine birleşen) sade bir nesne olarak dışarı verir. Yalnız bellek okur.
  // Boss geçmişi (onBossSave): aynı anlık görüntünün raporu kalıcı geçmişe yazılır (aynı fk = aynı karşılaşma, birleşmede güncellenir).
  recordBoss(e) {
    const toLedger = typeof this.onBossRecord === 'function';
    const toLog = typeof this.onBossSave === 'function';
    if ((!toLedger && !toLog) || !e) return;
    try {
      const s = this.snapshot(0, { boss: 0, bossView: true });
      const b = this.bossHistory[0]; // archiveBoss: yeni kayıt da, birleşen kayıt da başta durur
      if (!s.enc || !b) return;
      const fk = (b.bossFirst || b.start) + ':' + (b.bossId === undefined ? '' : b.bossId);
      if (toLedger) {
        try {
          this.onBossRecord({
            fk,
            boss: b.bossName || ('Boss #' + (b.bossCode || b.bossId)), code: b.bossCode || 0,
            at: b.bossFirst || b.start, dur: s.enc.dur, killed: !!b.bossKilled,
            actors: s.enc.actors.map((a) => ({ name: a.name, cls: a.cls || 0, server: a.server || 0, total: a.total, own: !!a.own })),
          });
        } catch { /* defter hatası ölçümü etkilemesin */ }
      }
      if (toLog) { try { this.onBossSave({ fk, at: b.bossFirst || b.start, pb: !!b.pbNew, enc: s.enc }); } catch { /* geçmiş hatası ölçümü etkilemesin */ } }
    } catch { /* defter hatası ölçümü etkilemesin */ }
  }

  // Faz 8.6: boss'un o an kime saldırdığı (0x0238 hedefli kullanım ya da boss'tan oyuncuya giden 0x0438 vuruşu).
  // Sadece bilinen oyuncu hedef sayılır; pasif paket verisi, bellek okunmaz.
  noteBossTarget(actor, target, t, src) {
    const c = this.cur;
    if (!c || !c.isBoss || c.bossId === null || c.bossId !== actor) return;
    if (!this.isKnownPlayer(target)) return;
    // vuruş (alan hasarı gürültüsü) 3 sn içinde gelen beceri kaynaklı hedefi ezmez
    if (src === 'hit' && c.bossTargetSrc === 'cast' && t - (c.bossTargetAt || 0) < 3000) return;
    if (c.bossTargetId !== target) this.version++;
    c.bossTargetId = target;
    c.bossTargetAt = t;
    c.bossTargetSrc = src;
  }

  // Boss'un son hedefi (ad bilinmiyorsa ve 8 sn'den eskiyse null: rozet gizlenir)
  bossTargetName(e, now) {
    if (!e || e !== this.cur || e.bossTargetId === undefined || e.bossTargetId === null) return null;
    if (now - (e.bossTargetAt || 0) > 8000) return null;
    const n = this.names.get(e.bossTargetId) || (e.bossTargetId === this.ownId ? this.charName : null);
    return (n && typeof n === 'string') ? n : null;
  }

  // Kendi karakterin görünen adı: ad paketi > karakter adı (ayar) > parti listesinden çıkarım. Çıkarım yalnız gösterim içindir
  // (ad haritasına yazılmaz) ve yalnız tek aday kalınca yapılır: adı başka kimlikte görülen ya da sınıfı tutmayan üye elenir.
  ownDisplayName() {
    const own = this.ownId;
    if (own === null || own === undefined) return null;
    const n = this.names.get(own);
    if (n && typeof n === 'string') return n;
    if (this.charName && typeof this.charName === 'string') return this.charName;
    const mems = this.party && this.party.members;
    if (!mems || !mems.size) return null;
    const oc = this.classes.get(own) || null;
    let pick = null;
    for (const nm of mems) {
      if (!nm || typeof nm !== 'string') continue;
      const id = this.nameIds.get(nm);
      if (id !== undefined && id !== own) continue; // bu ad başka bir oyuncunun
      const pc = this.partyCls.get(nm) || null;
      if (oc && pc && oc !== pc) continue; // sınıf tutmuyor
      if (pick !== null) return null; // birden çok aday: belirsiz, tahmin etme
      pick = nm;
    }
    return pick;
  }

  label(id) {
    if (id === null || id === undefined) return 'Unknown';
    if (typeof id === 'string' && id.startsWith('p:')) return id.slice(2); // hasar vurmayan parti üyesi (sanal satır)
    const n = this.names.get(id);
    if (n && typeof n === 'string') return n;
    if (id === this.ownId) { const on = this.ownDisplayName(); if (on) return on; } // adsız kendi satırımız: karakter adı / parti listesi
    const sn = this.summonOwnerName.get(id);
    if (sn && typeof sn === 'string') return sn;
    const inf = this.inferred.get(id);
    if (inf) return inf; // sınıfı kadroda tek aday: yalnız gösterim
    const c = this.classes.get(id);
    return (c && CLASSES[c] ? CLASSES[c] : 'Player') + ' #' + id;
  }

  // Arayüz için özet. which: 0 = güncel (yoksa son biten), n = geçmişten
  snapshot(which = 0, opts = {}) {
    const list = [];
    if (this.cur) list.push(this.cur);
    list.push(...this.history);

    const bosses = this.bossHistory.map((x, i) => {
      const dur = Math.max(1000, (x.bossLast || x.last) - (x.bossFirst || x.start));
      const at = x.bossFirst || x.start;
      const d = new Date(at);
      const hh = String(d.getHours()).padStart(2, '0');
      const mm = String(d.getMinutes()).padStart(2, '0');
      return {
        i,
        name: x.bossName || ('Boss #' + (x.bossCode || x.bossId)),
        dur,
        total: x.bossTotalDamage,
        killed: !!x.bossKilled,
        code: x.bossCode || 0,
        wiped: !!x.bossWiped,
        pb: !!x.pbNew,
        at,
        fk: at + ':' + (x.bossId === undefined ? '' : x.bossId), // oyuncu defteri karşılaşma kimliği (recordBoss ile aynı)
        timeStr: `${hh}:${mm}`,
      };
    });

    let e = null;
    if (opts.boss !== undefined && opts.boss !== null) {
      e = this.bossHistory[opts.boss] || null;
    } else {
      e = list[which] || null;
    }

    const encounters = list.map((x, i) => ({ i, start: x.start, dur: Math.max(0, x.last - x.start), live: x === this.cur }));
    if (!e) return { encounters, bosses, enc: null };

    const ownOrPartyHitBoss = !e.isBoss || !e.bossId || !this.hasKnownIdentity() || this.isTargetHitByMeOrParty(e.bossId) || (e.ownTargetDmg && (e.ownTargetDmg.get(e.bossId) || 0) > 0);
    const isBossFight = !!(e.isBoss && e.bossTotalDamage > 0 && ownOrPartyHitBoss);
    const useBossView = isBossFight && (opts.bossView !== false);

    let dur = 0;
    let actors = [];
    let total = 0;

    const own = this.ownId;
    const isSummonGhost = (a) => {
      if (a.id === own || this.names.has(a.id) || this.summonOwnerName.has(a.id)) return false;
      if (this.isKnownPlayer(a.id)) return false;
      if (this.isSummonCandidate(a.id)) return true;
      return false;
    };

    if (useBossView) {
      dur = Math.max(1000, (e.bossKilledAt || e.bossLast || e.last) - (e.bossFirst || e.start));
      actors = this.mergeSummons([...e.bossActors.values()]).filter((a) => !isSummonGhost(a));
      total = e.bossTotalDamage || actors.reduce((s, a) => s + a.total, 0) || 1;
      if (!actors.length && e.actors.size > 0) {
        actors = this.mergeSummons([...e.actors.values()]).filter((a) => !isSummonGhost(a));
        total = actors.reduce((s, a) => s + a.total, 0) || 1;
      }
    } else {
      dur = Math.max(1000, e.last - e.start);
      actors = this.mergeSummons([...e.actors.values()]).filter((a) => !isSummonGhost(a));
      total = actors.reduce((s, a) => s + a.total, 0) || 1;
    }

    const hitsMine = (a) => a.id === own || [...a.targets].some((x) => e.targets.has(x));
    let view = opts.view || 'all';
    let needOwn = false;
    if (view === 'me') {
      if (own !== null && actors.some((a) => a.id === own)) actors = actors.filter((a) => a.id === own);
      else if (actors.some((a) => this.isOwnName(a.id))) actors = actors.filter((a) => this.isOwnName(a.id)); // kimlik bayat: ada göre
      else needOwn = true; // karakter bilinmiyor / bulunamadı: seçebilsin diye hepsini göster
    } else if (view === 'party') {
      const pFilter = this.viewFilter('party');
      if (pFilter) actors = actors.filter(pFilter);
      const pTotal = actors.reduce((s, a) => s + a.total, 0);
      total = pTotal > 0 ? pTotal : 1;
    } else if (opts.onlyMine && own !== null && e.targets.size > 0 && !useBossView) {
      actors = actors.filter(hitsMine);
      const mTotal = actors.reduce((s, a) => s + a.total, 0);
      if (mTotal > 0) total = mTotal;
    }
    actors.sort((x, y) => y.total - x.total);
    // Parti üyeleri hasar vurmasa da listede görünsün (ad parti listesinden; hasar 0). Yalnız süren dövüşte ve yalnız bu
    // çıktıda (e.actors'a yazılmaz: geçmiş, boss kaydı, defter etkilenmez). Sanal satır kimliği 'p:' + ad (metin).
    if (e === this.cur) this.inferNames(actors); else if (this.inferred.size) this.inferred = new Map();
    const meName = this.ownDisplayName() || (this.charName && typeof this.charName === 'string' ? this.charName : null);
    if (e === this.cur && view !== 'me' && this.party && this.party.members && this.party.members.size) {
      const have = new Set(actors.map((a) => String(this.label(a.id)).toLowerCase()));
      const meLow = meName ? meName.toLowerCase() : null;
      // kendi satırımız ya da adsız ("Sınıf #id") bir satır varsa kendi adımız ayrıca eklenmez (çift satır olmasın)
      const ownOrAnon = actors.some((a) => (own !== null && a.id === own) || (!this.names.has(a.id) && !this.summonOwnerName.has(a.id)));
      // kendi satırımız var ama adı çıkarılamadı (belirsiz): sınıfı bizimle aynı, adı hiç görülmemiş üyeler bizim olabilir, eklenmez
      const ownCls = !meName && own !== null && actors.some((a) => a.id === own) ? (this.classes.get(own) || null) : null;
      for (const nm of this.party.members) {
        if (!nm || typeof nm !== 'string') continue;
        const low = nm.toLowerCase();
        if (have.has(low)) continue;
        if (meLow && low === meLow && ownOrAnon) continue;
        if (opts.showIdle === false && !(meLow && low === meLow)) continue; // ayar kapalı: hasar vurmayan diğer üyeler gizlenir (kendi satırımız her zaman kalır)
        if (ownCls && this.partyCls.get(nm) === ownCls && !this.nameIds.has(nm)) continue;
        have.add(low);
        actors.push({ id: 'p:' + nm, idle: true, total: 0, hits: 0, crits: 0, backs: 0, max: 0, targets: new Set(), skills: new Map() });
      }
    }

    // dövüşün adı: en çok vurduğun canavar (+ kaç farklı hedef)
    let target = null;
    if (this.targetName && e.ownTargetDmg.size) {
      const names = new Map();
      for (const [id, dmg] of e.ownTargetDmg) { const n = this.targetName(id); if (n) names.set(n, (names.get(n) || 0) + dmg); }
      const best = [...names].sort((x, y) => y[1] - x[1])[0];
      if (best) target = { name: best[0], kinds: names.size, count: e.ownTargetDmg.size };
    }
    // şu an vurduğun hedef: ad + can (008d) + bu hızla kaç saniyede ölür
    let focus = null;
    const now = typeof this.now === 'function' ? this.now() : Date.now();
    const TARGET_TIMEOUT_MS = 5000; // 5 sn oyuncudan hedefe hasar gelmediyse hedef aktif sayılmaz
    if (this.targetInfo && e.lastTarget !== undefined && e.lastTarget !== null) {
      const targetAge = e.lastTargetAt ? (now - e.lastTargetAt) : Infinity;
      const ownHitAge = e.lastOwnHitAt ? (now - e.lastOwnHitAt) : Infinity;
      if (e === this.cur && targetAge <= TARGET_TIMEOUT_MS && ownHitAge <= TARGET_TIMEOUT_MS) {
        const ti = this.targetInfo(e.lastTarget);
        if (ti && (ti.name || ti.max) && ti.hp > 0) {
          let rate = 0; // hedefe herkesin son 10 sn'deki hasar hızı
          const tRec = e.targetRate && e.targetRate.get(e.lastTarget);
          if (tRec && e.last - tRec.first > 1000) rate = tRec.dmg / ((e.last - tRec.first) / 1000);
          focus = { id: e.lastTarget, name: ti.name, boss: ti.boss, hp: ti.hp, max: ti.max, ttk: rate > 0 && ti.hp > 0 ? ti.hp / rate : null };
        }
      }
    }

    if (!focus && isBossFight && e.bossId && this.targetInfo && e === this.cur) {
      const ti = this.targetInfo(e.bossId);
      if (ti && (ti.name || ti.max) && ti.hp > 0) {
        let rate = 0;
        const tRec = e.targetRate && e.targetRate.get(e.bossId);
        if (tRec && e.last - tRec.first > 1000) rate = tRec.dmg / ((e.last - tRec.first) / 1000);
        focus = { id: e.bossId, name: ti.name || e.bossName, boss: true, hp: ti.hp, max: ti.max || e.bossMaxHp, ttk: rate > 0 && ti.hp > 0 ? ti.hp / rate : null };
      }
    }

    let boss = null;
    if (isBossFight) {
      const bDur = Math.max(1000, (e.bossKilledAt || e.bossLast || e.last) - (e.bossFirst || e.start));
      const drop = e.bossKilled ? (e.bossMaxHp || 0) : ((e.bossMaxHp || 0) - (e.bossLowestHp || 0));
      const coverage = drop > 0 ? Math.min(1, +(e.bossTotalDamage / drop).toFixed(3)) : null;
      boss = {
        name: e.bossName || ('Boss #' + (e.bossCode || e.bossId)),
        code: e.bossCode,
        maxHp: e.bossMaxHp || 0,
        total: e.bossTotalDamage,
        dps: e.bossTotalDamage / (bDur / 1000),
        dur: bDur,
        killed: !!e.bossKilled,
        wiped: !!e.bossWiped,
        pb: !!e.pbNew,
        pbPrev: e.pbPrev || 0,
        coverage,
        allTotal: e.allTotal || this.totalDamageOf(e),
        stagger: this.staggerOf(e),
        target: this.bossTargetName(e, now), // Faz 8.6: boss'un şu anki hedefi (oyuncu adı)
      };
    }

    return {
      encounters,
      bosses,
      view,
      needOwn,
      deaths: this.deathLog.slice(0, 10),
      enc: {
        target,
        focus,
        boss,
        heal: this.healView(e, dur, this.viewFilter(view)),
        takenBy: this.takenView(e, this.viewFilter(view)),
        deathList: (e.deathList || []).slice(-10),
        replay: {
          duration: dur,
          start: isBossFight ? (e.bossFirst || e.start) : e.start,
          casts: (e.casts || []).slice(-1500),
          consumables: (e.consumables || []).slice(-300),
          stagger: {
            ...(this.staggerOf(e) || {}),
            windows: (e.staggerWindows && e.staggerWindows.length) ? e.staggerWindows.slice() : ((e.staggerSummary && e.staggerSummary.windows) || []),
          },
        },
        isBoss: isBossFight,
        live: e === this.cur,
        start: e.start,
        dur,
        total,
        taken: e.taken,
        deaths: e.deaths,
        actors: actors.map((a) => {
          const lbl = this.label(a.id);
          const isOwn = a.id === this.ownId || (this.charName && typeof this.charName === 'string' && lbl && lbl.toLowerCase() === this.charName.toLowerCase()) ||
            !!(a.idle && meName && lbl.toLowerCase() === meName.toLowerCase());
          return {
            id: a.id,
            ...(a.idle ? { idle: true } : {}), // hasar vurmayan parti üyesi (sanal satır; kimliği metin)
            own: isOwn,
            name: lbl,
            cls: this.classes.get(a.id) || (typeof a.id === 'string' ? (this.partyCls.get(a.id.slice(2)) || null) : null),
          ...this.memberStats(a.id),
          total: a.total,
          dps: a.total / (dur / 1000),
          share: a.total / (total || 1),
          hits: a.hits,
          crit: a.hits ? a.crits / a.hits : 0,
          back: a.hits ? a.backs / a.hits : 0,
          glancing: a.hits ? (a.glancing || 0) / a.hits : 0,
          absorbed: a.absorbed || 0,
          subHits: a.subHits || 0,
          subHitDmg: a.subHitDmg || 0,
          max: a.max,
          skills: [...a.skills.values()].sort((x, y) => y.total - x.total).map((s) => ({
            skill: s.skill,
            name: this.skillName(s.raw) + (s.dot ? ' (DoT)' : ''),
            icon: iconUrl(s.raw),
            total: s.total,
            share: s.total / (a.total || 1),
            hits: s.hits,
            crit: s.hits ? s.crits / s.hits : 0,
            avg: s.hits ? s.total / s.hits : 0,
            max: s.max,
            min: s.min === Infinity ? 0 : s.min,
            back: s.hits ? s.backs / s.hits : 0,
            perfect: s.hits ? s.perfect / s.hits : 0,
            double: s.hits ? s.double / s.hits : 0,
            parry: s.hits ? s.parry / s.hits : 0,
            glancing: s.hits ? (s.glancing || 0) / s.hits : 0,
            absorbed: s.absorbed || 0,
            subHits: s.subHits || 0,
            subHitDmg: s.subHitDmg || 0,
            avgCrit: s.crits ? s.critDmg / s.crits : 0,
            avgNormal: s.hits - s.crits ? (s.total - s.critDmg) / (s.hits - s.crits) : 0,
            dps: s.total / (dur / 1000),
            targets: s.targets.size,
            dot: s.dot,
          })),
        };
      }),
      },
    };
  }
}

// Aynı becerinin farklı özelleşme/seviye kodlarını tek satırda topla (14110340 -> 14110000)
function baseSkill(code) {
  if (code >= 10000000) return Math.floor(code / 10000) * 10000;
  return code;
}

function addHit(map, d, t) {
  let a = map.get(d.actor);
  if (!a) {
    a = { id: d.actor, total: 0, hits: 0, crits: 0, backs: 0, first: t, last: t, max: 0, skills: new Map(), targets: new Set(), absorbed: 0, glancing: 0, subHits: 0, subHitDmg: 0 };
    map.set(d.actor, a);
  }
  const subHitsCount = (d.subHits && d.subHits.length) ? d.subHits.length : 0;
  const subHitsSum = subHitsCount > 0 ? d.subHits.reduce((acc, v) => acc + v, 0) : 0;

  a.total += d.damage; a.hits++; a.last = t;
  if (d.crit) a.crits++;
  if (d.back) a.backs++;
  if (d.glancing) a.glancing = (a.glancing || 0) + 1;
  if (d.absorbed) a.absorbed = (a.absorbed || 0) + d.absorbed;
  if (subHitsCount > 0) {
    a.subHits = (a.subHits || 0) + subHitsCount;
    a.subHitDmg = (a.subHitDmg || 0) + subHitsSum;
  }
  if (d.damage > a.max) a.max = d.damage;
  a.targets.add(d.target);

  const key = d.dot ? 'dot:' + baseSkill(d.skill) : baseSkill(d.skill);
  let s = a.skills.get(key);
  if (!s) {
    s = { skill: baseSkill(d.skill), raw: d.skill, dot: !!d.dot, total: 0, hits: 0, crits: 0, max: 0, min: Infinity, backs: 0, perfect: 0, double: 0, parry: 0, glancing: 0, absorbed: 0, subHits: 0, subHitDmg: 0, critDmg: 0, first: t, last: t, targets: new Set(), byTarget: new Map() };
    a.skills.set(key, s);
  }
  s.total += d.damage; s.hits++; s.last = t; s.targets.add(d.target);
  if (d.glancing) s.glancing = (s.glancing || 0) + 1;
  if (d.absorbed) s.absorbed = (s.absorbed || 0) + d.absorbed;
  if (subHitsCount > 0) {
    s.subHits = (s.subHits || 0) + subHitsCount;
    s.subHitDmg = (s.subHitDmg || 0) + subHitsSum;
  }
  if (!s.byTarget) s.byTarget = new Map();
  let td = s.byTarget.get(d.target);
  if (!td) {
    td = { total: 0, hits: 0, crits: 0, backs: 0, glancing: 0, absorbed: 0, subHits: 0, subHitDmg: 0, max: 0, min: Infinity, critDmg: 0, first: t, last: t };
    s.byTarget.set(d.target, td);
  }
  td.total += d.damage; td.hits++; td.last = t;
  if (d.damage < td.min) td.min = d.damage;
  if (d.damage > td.max) td.max = d.damage;
  if (d.crit) { td.crits++; td.critDmg += d.damage; }
  if (d.back) td.backs++;
  if (d.glancing) td.glancing = (td.glancing || 0) + 1;
  if (d.absorbed) td.absorbed = (td.absorbed || 0) + d.absorbed;
  if (subHitsCount > 0) {
    td.subHits = (td.subHits || 0) + subHitsCount;
    td.subHitDmg = (td.subHitDmg || 0) + subHitsSum;
  }
  if (d.damage < s.min) s.min = d.damage;
  if (d.back) s.backs++;
  if (d.perfect) s.perfect++;
  if (d.double) s.double++;
  if (d.parry) s.parry++;
  if (d.crit) { s.crits++; s.critDmg += d.damage; }
  if (d.damage > s.max) s.max = d.damage;
  return a;
}

module.exports = { Meter, baseSkill, classOf, isPlayerSkill, CLASSES };
