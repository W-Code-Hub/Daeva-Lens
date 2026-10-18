'use strict';
// Yardımcının satırlarını alır: TCP birleştirme -> çerçeve -> savaş olayları -> DPS + bekleme süreleri.
// Canlı uygulama, kayıt tekrar oynatma ve testler aynı motoru kullanır.

const { Stream } = require('./parser');
const { Combat } = require('./combat');
const { Meter, classOf } = require('./meter');
const { Cooldowns } = require('./cooldowns');
const { OwnTracker, outFrameSizes } = require('./owner');
const { skillName } = require('./skills');

// Faz 8.4: tüketilebilir eşya türü (2.000.000–2.999.999 arası kodlar). Önce kod bloğuna, sonra ada bakılır.
// Dönüş: 'scroll' | 'potion' | 'food' | 'drink' | 'rebirth' | 'item' (türü belli olmayan eşya)
function itemKind(code, name) {
  const c = Number(code) || 0;
  const b = Math.floor(c / 10000) * 10000; // 10.000'lik blok başlangıcı
  const n = String(name || '');
  if (b === 2210000 || /scroll|talisman/i.test(n)) return 'scroll';
  if ((b >= 2010000 && b <= 2020000) || /potion|serum|elixir|brew/i.test(n)) return 'potion';
  if (b === 2160000 || /food|meal|stew|roast/i.test(n)) return 'food';
  if (b === 2110000 || /juice|tea|drink/i.test(n)) return 'drink';
  if (b === 2900000 || /resurrect|rebirth|spiritstone/i.test(n)) return 'rebirth';
  return 'item';
}
const { Kills, pruneMap } = require('./kills');
const { MobsCache } = require('./mobs-cache');
const { mobInfo } = require('./mobs');
const { PartyTracker } = require('./party');

const EVENT_MAX = 300;

class Engine {
  constructor(opts = {}) {
    this.onEvent = opts.onEvent || (() => {});
    this.now = opts.now || (() => Date.now());
    this.streams = new Map();   // gelen yön, bağlantı başına
    this.outStreams = new Map(); // giden yön: Stream nesneleri
    this.lastOwnPos = null;     // son bilinen oyuncu konumu (ışınlanma mesafe hesabı)
    this.lastPkt = 0;
    this.manualOwn = null;
    this.infoOwn = null;        // 0x3336 giriş paketi
    this.ownId = null;
    this.ownSource = null;      // 'elle' | 'giriş' | 'eşleşme'
    this.lastLowHpAt = 0;       // Faz 7: düşük can uyarısı zamanlayıcı
    this.events = [];           // teşhis: son olaylar
    this.recent = [];           // son 20 sn'nin beceri/vuruş olayları: kimlik sonradan bulununca geriye dönük işlenir
    this.counts = { in: 0, out: 0, outFrames: 0 };
    this.charName = opts.charName || null;
    this.mobsCache = opts.mobsCache || new MobsCache();
    this.meter = new Meter({ skillName, idleMs: opts.idleMs || 8000, bossIdleMs: opts.bossIdleMs || 45000, now: this.now, names: opts.names, mobsCache: this.mobsCache });
    this.meter.charName = this.charName;
    this.meter.onFinish = (e) => {
      const endT = e && e.last ? e.last : (typeof this.now === 'function' ? this.now() : Date.now());
      this.cds.combatEnd(endT);
      if (this.ext) { try { this.ext.finish(e); } catch { /* deneysel */ } }
    };
    this.cds = new Cooldowns({
      skillName,
      now: this.now,
      setTimer: opts.setTimer,
      clearTimer: opts.clearTimer,
      config: opts.cdConfig,
      learned: opts.learned,
      castBases: opts.castBases,
      activeBases: opts.activeBases,
      serverBases: opts.serverBases,
      inCombat: (t) => this.inCombat(t),
      emit: (e) => this.cdEvent(e),
    });
    this.owner = new OwnTracker({
      onPick: (id, why) => this.pickOwn(id, 'eşleşme', why),
      onDiag: (e) => { if (e.hit || e.actor === this.ownId) this.diag(e); },
      isOther: (actor) => {
        if (this.ownId !== null && actor === this.ownId) return false;
        if (this.meter.npcIds.has(actor) || this.meter.isSummon(actor) || this.meter.summonOwnerName.has(actor) || this.meter.classes.get(actor) === 10) return true;
        if (!this.charName || typeof this.charName !== 'string') return false;
        const name = this.meter.names.get(actor);
        return !!(name && typeof name === 'string' && name.toLowerCase() !== this.charName.toLowerCase());
      },
    });
    // B-10: Meter, Kills ve Combat aynı önbelleği paylaşır (yukarıda bir kez kuruldu)
    this.kills = new Kills({ mobsCache: this.mobsCache });
    this.meter.targetName = (id) => { const m = this.kills.info(id); return m ? m.name : null; };
    this.meter.targetInfo = (id) => {
      let m = this.kills.info(id);
      const h = this.kills.hp.get(id);
      const code = (m && m.code) || this.kills.mobs.get(id) || null;

      let displayName = m ? m.name : null;
      if (!displayName || displayName === '???' || displayName.startsWith('Monster #')) {
        displayName = null;
        if (code && this.mobsCache) {
          const mc = this.mobsCache.findByCode(code);
          if (mc && mc.name && mc.name !== '???' && !mc.name.startsWith('Monster #')) {
            displayName = mc.name;
          }
        }
        if (!displayName && h && h.max > 0 && this.mobsCache) {
          const byHp = this.mobsCache.findByHp(h.max);
          if (byHp && byHp.name && byHp.name !== '???' && !byHp.name.startsWith('Monster #')) {
            displayName = byHp.name;
            if (!m) m = byHp;
          }
        }
      }

      const isDummy = !!(m && m.dummy) || !!(displayName && /dummy|scarecrow|korkuluk|kukla|training|antrenman/i.test(displayName));
      // Boss tanıma kuralı:
      // 1. mobs.json veya mobsCache içinde resmi boss bayrağı olan tüm boss'lar
      // 2. Canı ≥ 5M olan tüm güçlü yaratıklar (15M, 20M, 80M dev boss'lar) - kuklalar hariç
      const isBoss = !isDummy && (
        !!(m && m.boss) ||
        (h && (h.max >= 5000000 || h.cur >= 5000000))
      );

      if (!displayName && isBoss) {
        displayName = code ? ('Boss #' + code) : 'Boss';
      }

      return {
        name: displayName || null,
        code,
        boss: isBoss,
        dummy: isDummy,
        hp: h ? h.cur : null,
        max: h ? h.max : null
      };
    };
    this.combat = new Combat({ emit: (e) => this.combatEvent(e), mobsCache: this.mobsCache, log: opts.log });
    // Parti üyeliği: gerçek kadro (0x0092) / üye durum akışı (0x1c92) / ayrılma / bölge yüklemesi (lib/party.js). 0x0297 yalnız bilgi.
    if (!this.globalNames) this.globalNames = new Map(); // küresel kimlik → ad (0x0297 + kadro)
    this.ownGlobal = null; // kendi küresel kimliğimiz (0x2036 yalnız kendi bağlantımızı verir)
    this.meter.managed = true;
    this.group = new PartyTracker({
      now: () => this.now(),
      isBusy: () => !!(this.meter.cur && this.now() - this.meter.cur.last < 15000),
      nameOfDbid: (db) => (this.globalNames ? this.globalNames.get(db) : undefined),
      isOwnDbid: (db) => {
        if (this.ownGlobal !== null && db === this.ownGlobal) return true;
        const n = this.globalNames ? this.globalNames.get(db) : null;
        return !!(n && this.charName && typeof this.charName === 'string' && n.toLowerCase() === this.charName.toLowerCase());
      },
      onChange: (s) => {
        this.meter.setGroup(s);
        this.diag({ type: 'group', live: s.live, via: s.via, size: s.size, instance: s.instance, members: s.members });
        this.onEvent({ type: 'group', ...s });
      },
    });
    // Deneysel özellikler (lib/deneysel, yalnız DAEVA_DEV): main.js opts.ext verir; yoksa hiçbir şey değişmez.
    this.ext = opts.ext || null;
    if (this.ext) {
      this.combat.onFrame = (op, body, t) => this.ext.frame(op, body, t);
      this.ext.attach(this);
    }
  }

  inCombat(t) {
    const curT = t || (typeof this.now === 'function' ? this.now() : Date.now());
    const m = this.meter;
    if (m && m.cur) {
      const limit = m.cur.isBoss ? m.bossIdleMs : m.idleMs;
      if (curT - m.cur.last <= limit) return true;
    }
    // Son kendi becerimizden bu yana 15 sn geçmediyse (açılış buff'ı veya dövüş hazırlığı)
    if (this.lastOwnAt && (curT - this.lastOwnAt < 15000)) return true;
    return false;
  }

  diag(e) {
    const ev = { at: this.now(), ...e };
    this.events.push(ev);
    if (this.events.length > EVENT_MAX) this.events.splice(0, this.events.length - EVENT_MAX);
    this.onEvent({ type: 'diag', ev });
  }

  cdEvent(e) {
    if (e.type === 'ready' || e.type === 'warn') this.diag({ type: 'alert', kind: e.type, base: e.base, name: e.name, why: e.why });
    if (e.type === 'ready-silent') { this.diag({ type: 'ready-silent', base: e.base, name: e.name, why: e.why }); return; }
    this.onEvent(e);
  }

  setCharName(name) {
    if (!name || typeof name !== 'string') {
      if (this.charName !== null) {
        this.charName = null;
        if (this.meter) this.meter.setCharName ? this.meter.setCharName(null) : (this.meter.charName = null);
        this.onEvent({ type: 'char-name', name: null });
      }
      return;
    }
    const clean = name.trim();
    if (!clean) {
      if (this.charName !== null) {
        this.charName = null;
        if (this.meter) this.meter.setCharName ? this.meter.setCharName(null) : (this.meter.charName = null);
        this.onEvent({ type: 'char-name', name: null });
      }
      return;
    }
    if (this.charName === clean) return;
    this.charName = clean;
    if (this.meter) this.meter.setCharName ? this.meter.setCharName(clean) : (this.meter.charName = clean);
    if (this.manualOwn === null) {
      const cleanLower = clean.toLowerCase();
      for (const [id, n] of this.meter.names) {
        if (n && typeof n === 'string' && n.toLowerCase() === cleanLower && this.ownId !== id) {
          if (!this.lastPkt || (this.meter.cur && this.meter.cur.actors.has(id))) {
            this.owner.seed(id, this.curT || this.now());
            this.pickOwn(id, 'isim', 'karakter adı eşleşti: ' + clean);
            break;
          }
        }
      }
    }
    if (this.ownId !== null && !this.meter.names.has(this.ownId)) {
      this.meter.setName(this.ownId, clean);
    }
    this.onEvent({ type: 'char-name', name: clean });
  }

  pickOwn(id, source, why) {
    if (this.manualOwn !== null) return;
    if (source === 'eşleşme' && this.infoOwn !== null && id === null) return;
    if (id === this.ownId) return;
    // Ad paketiyle (isim) doğrulanmış kimliği zayıf "giden istek" eşleşmesi devralamaz / bıraktıramaz.
    if (source === 'eşleşme' && this.ownId !== null && this.ownSource === 'isim' && this.charName && typeof this.charName === 'string') {
      const on = this.meter.names.get(this.ownId);
      if (on && typeof on === 'string' && on.toLowerCase() === this.charName.toLowerCase()) return;
    }

    // Karakter adı biliniyorsa ve bu aktörün gerçek adı başka bir oyuncuysa, ASLA pickOwn yapma!
    if (id !== null && this.charName && typeof this.charName === 'string') {
      const existingName = this.meter.names.get(id);
      if (existingName && typeof existingName === 'string' && existingName.toLowerCase() !== this.charName.toLowerCase()) {
        return;
      }
    }

    // Kimlik geçmişi: kesin kaynak (ya da adı karakter adımız) → eski kendi kimlikleri biten dövüşlerde de birleştirilir
    const trustedOwn = id !== null && (source === 'isim' || source === 'giriş' || source === 'ganimet' || source === 'küresel-bağlantı' ||
      (!!this.charName && typeof this.charName === 'string' && String(this.meter.names.get(id) || '').toLowerCase() === this.charName.toLowerCase()));
    if (id === null) {
      const dropName = this.ownId !== null ? this.meter.names.get(this.ownId) : null;
      const dropIsMe = !!(dropName && this.charName && typeof dropName === 'string' && typeof this.charName === 'string' && dropName.toLowerCase() === this.charName.toLowerCase());
      if (this.ownId !== null && !dropIsMe) this.meter.forgetOwnAlias(this.ownId); // eşleştirici bıraktı: bizim değilmiş
    } else {
      this.meter.noteOwnAlias(id, trustedOwn);
    }
    const oldId = this.ownId !== null ? this.ownId : (this.lastKnownOwnId || null);
    this.ownId = id;
    if (id !== null) this.lastKnownOwnId = id;
    this.ownSource = id === null ? null : source;
    if (oldId !== null && id !== null && oldId !== id && this.meter) {
      this.meter.migrateActor(oldId, id);
    }
    // Sadece kesin doğrulanmış kaynaklarda (isim, giriş, ganimet) isim haritalanır.
    // Tahmini paket eşleşmesinde henüz adı bilinmeyen bir aktöre zorla charName yazılmaz.
    if (id !== null && this.charName && (source === 'isim' || source === 'giriş' || source === 'ganimet' || source === 'küresel-bağlantı')) {
      if (!this.meter.names.has(id)) {
        this.meter.setName(id, this.charName);
      }
    }
    if (id !== null && !this.charName) {
      const n = this.meter.names.get(id);
      if (n) this.setCharName(n);
    }
    this.meter.setOwn(id);
    if (trustedOwn) this.meter.adoptOwnAliases(id); // eski kimliğin "Player #N" satırı yetim kalmasın
    this.diag({ type: 'own', id, source, why });
    this.onEvent({ type: 'own', id, source, why });
    if (id !== null) this.replayRecent(id);
  }

  remember(e) {
    const t = e.t;
    this.recent.push(e);
    while (this.recent.length && t - this.recent[0].t > 20000) this.recent.shift();
  }

  // kimlik bulunmadan önceki kullanımlar bekleme sürelerine eklensin
  replayRecent(id) {
    const ownCls = this.meter.classes.get(id);
    if (ownCls) this.cds.setOwnClass(ownCls);
    for (const e of this.recent) {
      if (e.actor !== id) continue;
      const cls = classOf(e.skill);
      if (ownCls && cls && cls !== ownCls) continue;
      if (e.type === 'cast') this.cds.cast({ ...e, own: true });
      else this.cds.damage({ ...e, own: true });
    }
    this.recent = [];
  }

  combatEvent(e) {
    this.combatEventCore(e);
    if (this.ext) { try { this.ext.event(e); } catch { /* deneysel modül sayacı bozamaz */ } }
  }

  combatEventCore(e) {
    switch (e.type) {
      case 'damage': {
        const dmgActorName = this.meter.names.get(e.actor);
        if (this.charName && typeof this.charName === 'string' && dmgActorName && typeof dmgActorName === 'string' && dmgActorName.toLowerCase() === this.charName.toLowerCase() && this.ownId !== e.actor && this.manualOwn === null) {
          this.pickOwn(e.actor, 'isim', 'karakter adı eşleşti: ' + this.charName);
        }
        // Faz 8.6: boss'un vurduğu kişi = boss hedefi göstergesi (kullanıcıya dönük "hedef sende" uyarısı kaldırıldı)
        if (!classOf(e.skill) && e.target !== null && e.target !== undefined) {
          const ti = this.meter.targetInfo && this.meter.targetInfo(e.actor);
          const isBossAttack = (this.meter.cur && this.meter.cur.isBoss && this.meter.cur.bossId === e.actor) || (ti && ti.boss);
          if (isBossAttack && this.meter.noteBossTarget) this.meter.noteBossTarget(e.actor, e.target, e.t || this.now(), 'hit');
        }
        this.meter.damage(e);
        if (this.ownId === null && !e.dot && classOf(e.skill)) this.remember(e);
        this.cds.damage({ ...e, own: e.actor === this.ownId });
        return;
      }
      case 'cast': {
        const cls = classOf(e.skill);
        const isPotion = e.skill >= 2000000 && e.skill <= 2999999;
        if (cls) this.meter.noteClass(e.actor, cls, e.kind === 2); // B-31: tür 00 zayıf kanıt
        const castActorName = this.meter.names.get(e.actor);
        if (this.charName && typeof this.charName === 'string' && castActorName && typeof castActorName === 'string' && castActorName.toLowerCase() === this.charName.toLowerCase() && this.ownId !== e.actor && this.manualOwn === null) {
          this.pickOwn(e.actor, 'isim', 'karakter adı eşleşti: ' + this.charName);
        }
        // Faz 8.6: boss'un hedefi (sadece pasif 0x0238 paket verisi)
        if (!cls && !isPotion && e.actor !== this.ownId && e.kind === 2 && this.meter.noteBossTarget) {
          const mc = this.meter.cur;
          const ti2 = this.meter.targetInfo && this.meter.targetInfo(e.actor);
          const bossCast = (mc && mc.isBoss && mc.bossId === e.actor) || (ti2 && ti2.boss);
          if (bossCast) this.meter.noteBossTarget(e.actor, e.target, this.capT || e.t || this.now(), 'cast');
        }
        const capTime = this.capT || e.t || this.now();
        if (cls) this.meter.recordSummonCast(e.actor, e.skill, capTime);
        if (e.kind === 2 && cls && cls !== 10) this.owner.cast(e.actor, e.skill, capTime);
        e.own = e.actor === this.ownId;
        if (cls || isPotion) {
          this.meter.recordCast(e.actor, e.skill, capTime, e.target, e.kind);
        }
        if (isPotion) {
          this.meter.recordConsumable(e.actor, e.skill, capTime);
          if (e.own) {
            this.diag({ type: 'potion', skill: e.skill, name: skillName(e.skill) });
            this.onEvent({ type: 'potion', skill: e.skill, name: skillName(e.skill), itemKind: itemKind(e.skill, skillName(e.skill)), t: capTime });
          }
        }
        if (e.own) {
          // B-31: bekleme süreleri de oylanmış sınıfı kullanır (parti buff'ı sınıfı bir anlığına değiştirmesin).
          // Sınıf henüz güçlü kanıtla belli değilken gelen tür 00 kullanım başkasının buff'ı olabilir: listeye alınmaz.
          if (this.meter.hasStrongClass(this.ownId)) this.cds.setOwnClass(this.meter.classes.get(this.ownId));
          else if (e.kind !== 2 && cls) { e.own = false; }
          this.lastOwnAt = this.now();
          this.diag({ type: 'cast', skill: e.skill, name: skillName(e.skill), kind: e.kind });
        }
        else if (this.ownId === null && cls) this.remember(e);
        this.cds.cast(e);
        return;
      }
      case 'heal':
        // Sürüm 2.0: 0x0538 HoT tiki ya da kendine gelen 0x0438 değeri (iyileştirme/kalkan/buff adayı)
        this.meter.heal(e);
        return;
      case 'gauge': {
        const prevG = this.meter.gauges.get(e.id);
        const wasBroken = prevG ? prevG.broken : false;
        this.meter.gauge(e);
        if (e.broken && !wasBroken) {
          this.diag({ type: 'stagger', id: e.id, t: e.t });
          this.onEvent({ type: 'stagger', id: e.id, t: e.t });
        }
        return;
      }
      case 'max-hp': {
        const h = this.kills.hp.get(e.id);
        if (h && e.max > 0) h.max = e.max;
        this.meter.hpUpdate(e.id, null, e.max, e.t);
        return;
      }
      case 'cd':
        this.diag({ type: 'server-cd', skill: e.skill, name: skillName(e.skill), ms: e.ms });
        this.cds.serverCd(e);
        return;
      case 'own-info':
        this.infoOwn = e.id;
        this.setCharName(e.name);
        this.owner.seed(e.id, e.t);
        this.pickOwn(e.id, 'giriş', 'giriş paketi 0x3336 (' + e.name + ')');
        return;
      case 'name':
        this.meter.setName(e.id, e.name);
        const isNameMatch = this.charName && typeof this.charName === 'string' && typeof e.name === 'string' && e.name.toLowerCase() === this.charName.toLowerCase();
        if (isNameMatch && this.ownId !== e.id && this.manualOwn === null) {
          this.owner.seed(e.id, this.curT);
          this.pickOwn(e.id, 'isim', 'karakter adı eşleşti: ' + e.name);
        } else if (this.charName && typeof this.charName === 'string' && this.ownId === e.id && typeof e.name === 'string' && e.name.toLowerCase() !== this.charName.toLowerCase() && this.manualOwn === null) {
          // Bu aktörün gerçek ismi geldi ve kayıtlı karakter adımızla uyuşmuyor!
          // Daha önce tesadüfi paket eşleşmesiyle bu kişi seçildiyse derhal sahipliği bırak.
          this.meter.forgetOwnAlias(e.id); // başka oyuncuymuş: eski kimlik olarak birleştirilmesin
          if (this.lastKnownOwnId === e.id) this.lastKnownOwnId = null; // sonraki seçimde onun satırı bize taşınmasın
          this.ownId = null;
          this.owner.own = null;
          this.meter.setOwn(null);
          this.onEvent({ type: 'own', id: null, why: 'isim uyuşmazlığı: ' + e.name + ' !== ' + this.charName });
        } else if (!this.charName && this.ownId === e.id) {
          this.setCharName(e.name);
        }
        this.onEvent({ type: 'name', id: e.id, name: e.name });
        return;
      case 'owner':
        this.kills.markDead(e.id);
        this.meter.targetDead(e.id);
        if (e.owner === this.ownId && e.name) {
          this.setCharName(e.name);
        } else if (this.charName && typeof this.charName === 'string' && typeof e.name === 'string' && e.name.toLowerCase() === this.charName.toLowerCase() && this.ownId !== e.owner && this.manualOwn === null) {
          this.owner.seed(e.owner, this.curT);
          this.pickOwn(e.owner, 'ganimet', 'ganimet sahibi adı eşleşti: ' + e.name);
        }
        return;
      case 'spawn': {
        if (e.owner) {
          // Sürüm 2.0: adlı doğma = oyuncunun çağrısı/tuzağı; ad sahibinin karakter adıdır (canavar listesine girmez)
          this.meter.noteSummonSpawn(e.id, e.owner, e.t);
          return;
        }
        this.meter.noteNpc(e.id, e.t);
        this.kills.spawn(e.id, e.code, e.maxHp, e.curHp);
        if (e.code > 0 && this.mobsCache) {
          const info = mobInfo(e.code, this.mobsCache);
          if (info && info.name && !info.name.startsWith('Monster #') && info.name !== '???') {
            this.mobsCache.learn(e.code, {
              name: info.name,
              maxHp: e.maxHp,
              boss: info.boss,
              dummy: info.dummy
            });
          }
        }
        return;
      }
      case 'hp': {
        this.kills.setHp(e.id, e.hp, e.max);
        this.meter.hpUpdate(e.id, e.hp, e.max, e.t);
        const hpObj = this.kills.hp.get(e.id);
        const maxHp = (hpObj && hpObj.max > 0) ? hpObj.max : (e.max || 0);
        // Faz 7: Oyuncu canı %25 veya altına düştüğünde düşük can nabız uyarısı (4 sn'de en fazla 1 kez)
        if (this.ownId !== null && e.id === this.ownId && maxHp > 0 && e.hp > 0 && (e.hp / maxHp) <= 0.25) {
          const capTime = e.t || this.now();
          if (!this.lastLowHpAt || capTime - this.lastLowHpAt >= 4000) {
            this.lastLowHpAt = capTime;
            this.diag({ type: 'lowhp', hp: e.hp, max: maxHp, pct: e.hp / maxHp });
            this.onEvent({ type: 'lowhp', hp: e.hp, max: maxHp, t: capTime });
          }
        }
        const code = this.kills.mobs.get(e.id);
        if (code && hpObj && hpObj.max > 0 && this.mobsCache) {
          let info = mobInfo(code, this.mobsCache);
          if ((!info || !info.name || info.name === '???' || info.name.startsWith('Monster #')) && hpObj.max > 0) {
            const byHp = this.mobsCache.findByHp(hpObj.max);
            if (byHp && byHp.name && byHp.name !== '???' && !byHp.name.startsWith('Monster #')) {
              info = byHp;
            }
          }
          if (info && info.name && !info.name.startsWith('Monster #') && info.name !== '???') {
            this.mobsCache.learn(code, {
              name: info.name,
              maxHp: hpObj.max,
              boss: info.boss || hpObj.max >= 5000000,
              dummy: info.dummy
            });
          }
        }
        if (e.hp >= 5000000 || (hpObj && hpObj.max >= 5000000)) {
          const ti = this.meter.targetInfo(e.id);
          if (ti && ti.boss && this.meter.cur && this.meter.isTargetHitByMeOrParty(e.id)) {
            this.meter.promoteBoss(e.id, ti, e.t);
          }
        }
        this.meter.bossHpUpdate(e.id, e.hp, hpObj ? hpObj.max : 0, e.t);
        if (e.hp === 0) {
          this.meter.targetDead(e.id);
          this.kills.markDead(e.id);
        }
        this.meter.version++;
        return;
      }
      case 'pong':
        // ping: son giden ping isteğinden (12–13 bayt) bu yanıta kadar geçen süre
        if (this.pingReqAt && this.capT - this.pingReqAt < 3000) { this.ping = this.capT - this.pingReqAt; this.pingAt = this.now(); this.pingReqAt = 0; }
        return;
      case 'zone-load':
        this.group.onZone(this.now());
        this.meter.noteZone();
        // bölge/zindan girişinde sunucu yeni oturum kimliği verebilir: elle seçilmediyse adıyla yeniden eşle
        if (this.manualOwn === null && this.charName && typeof this.charName === 'string') {
          const cl = this.charName.toLowerCase();
          for (const [id, n] of this.meter.names) {
            if (id !== this.ownId && n && typeof n === 'string' && n.toLowerCase() === cl) {
              this.owner.seed(id, this.curT || this.now());
              this.pickOwn(id, 'isim', 'bölge geçişinde karakter adı yeni kimlikle eşleşti: ' + this.charName);
              break;
            }
          }
        }
        return;
      case 'roster': {
        const ms = Array.isArray(e.members) ? e.members : [];
        // oturum kimliği → ad (kesin; kayıtla doğrulandı). Kendimizi küresel kimlikle de buluruz.
        for (const m of ms) {
          if (this.globalNames && m.dbid) this.globalNames.set(m.dbid, m.name);
          if (!(m.sid > 0)) continue; // oturum kimliği henüz atanmamış üye: yalnız kadro üyeliği (kimlik sonra 0x2292 ile gelir)
          if (this.ownGlobal !== null && m.dbid === this.ownGlobal && this.ownId !== m.sid && this.manualOwn === null) {
            this.owner.seed(m.sid, e.t);
            this.pickOwn(m.sid, 'küresel-bağlantı', 'kadroda küresel kimlik eşleşti: ' + m.name);
          }
          this.combatEventCore({ type: 'name', id: m.sid, name: m.name });
        }
        this.meter.setRosterNames(ms);
        this.group.onRoster(ms, this.now());
        return;
      }
      case 'roster-member': {
        const ms = Array.isArray(e.members) ? e.members : [];
        for (const m of ms) {
          if (this.globalNames && m.dbid) this.globalNames.set(m.dbid, m.name);
          if (m.sid > 0) this.combatEventCore({ type: 'name', id: m.sid, name: m.name });
        }
        this.meter.setRosterNames(ms);
        this.group.onMember(ms, this.now());
        return;
      }
      case 'party-state':
        this.group.onState(e.dbid, this.now());
        return;
      case 'party-leave':
        this.group.onLeave(this.now());
        return;
      case 'party':
        this.group.onFinder(e, this.now());
        if (!e || !e.members || e.members.length === 0 || (e.size <= 1 && e.members.length <= 1 && !e.dungeon)) {
          this.meter.setParty(null, { info: true });
          this.diag({ type: 'party-clear' });
          this.onEvent({ type: 'party-clear' });
          return;
        }
        if (e.memberDetails) {
          if (!this.globalNames) this.globalNames = new Map();
          for (const m of e.memberDetails) if (m.globalId && m.name) this.globalNames.set(m.globalId, m.name);
          if (this.globalNames.size > 2000) pruneMap(this.globalNames, 1000); // boyut sınırı: en eski girişler atılır
        }
        this.meter.setParty(e, { info: true }); // yalnız bilgi (ad/sınıf/GS/CP/sunucu); üyelik kararı kadro/durum akışından
        if (e.memberDetails) this.meter.setPartyClasses(e.memberDetails); // Sürüm 2.0: kesin sınıf (karakter şablonu)
        this.diag({ type: 'party', size: e.size, members: e.members });
        this.onEvent({ type: 'party', ...e });
        return;
      case 'global-link':
        this.ownGlobal = e.globalId;
        if (this.globalNames && this.globalNames.has(e.globalId)) {
          const name = this.globalNames.get(e.globalId);
          this.meter.setName(e.sessionId, name);
          if (this.charName && typeof this.charName === 'string' && typeof name === 'string' && name.toLowerCase() === this.charName.toLowerCase() && this.ownId !== e.sessionId && this.manualOwn === null) {
            this.owner.seed(e.sessionId, e.t);
            this.pickOwn(e.sessionId, 'küresel-bağlantı', 'karakter adı eşleşti: ' + name);
          }
        }
        return;
      case 'death':
        this.meter.death(e.id);
        this.kills.markDead(e.id);
        return;
      case 'despawn':
        this.meter.targetDespawn(e.id);
        this.kills.markDespawn(e.id);
        return;
      case 'teleport': {
        if (e.id === this.ownId) {
          const prev = this.lastOwnPos;
          this.lastOwnPos = { x: e.x, y: e.y, z: e.z };
          if (prev) {
            const dist = Math.hypot(e.x - prev.x, e.y - prev.y, e.z - prev.z);
            // Sadece gerçek bölge / harita değişimi veya obelisk dirilişinde (en az 40.000 birim mesafe)
            if (dist > 40000) {
              const cur = this.meter.cur;
              const now = e.t || this.now();
              // Aktif bir boss dövüşünde değilsek veya son vuruştan bu yana rölantideysek dövüşü bitir
              if (cur && (!cur.isBoss || now - cur.last > 10000)) {
                this.meter.finish();
              }
              this.meter.prune(now);
            }
          }
        }
        return;
      }
      default:
    }
  }

  setOwnManual(id) {
    this.manualOwn = id;
    this.ownId = id;
    this.ownSource = 'elle';
    this.meter.setOwn(id);
    this.diag({ type: 'own', id, source: 'elle', why: 'sağ tık: bu benim karakterim' });
    this.onEvent({ type: 'own', id, source: 'elle' });
  }

  clearOwnManual() {
    this.manualOwn = null;
    this.ownId = null;
    this.ownSource = null;
    this.meter.setOwn(null);
    this.owner.reset();
    if (this.infoOwn !== null) this.pickOwn(this.infoOwn, 'giriş', 'giriş paketi');
  }

  setMobName(code, name) {
    if (this.mobsCache && code && name) {
      this.mobsCache.learn(code, { name, forceName: true });
    }
  }

  // msg: yardımcının JSON satırı
  packet(msg) {
    if (msg.type !== 'pkt' || !msg.data) return;
    const t = this.now();
    this.curT = t;
    // eşleştirme için yakalama anı (yardımcının zaman damgası; boru/işlem gecikmesinden etkilenmez)
    this.capT = typeof msg.t === 'number' ? msg.t : t;
    if (msg.dir === 'out') {
      this.counts.out++;
      const s = this.streams.get(msg.conn);
      if (!s || !s.game) return; // sadece oyun protokolü konuşan bağlantı (HTTPS vb. değil)
      let os = this.outStreams.get(msg.conn);
      if (!os) {
        os = new Stream((op, body, tot) => {
          this.counts.outFrames++;
          if (tot === 12 || tot === 13) this.pingReqAt = this.capT;
          this.owner.outFrame(this.capT, tot);
        }, true);
        this.outStreams.set(msg.conn, os);
      }
      os.push(msg.seq, Buffer.from(msg.data, 'base64'), this.now());
      return;
    }
    if (msg.dir !== 'in') return;
    this.counts.in++;
    this.lastPkt = t;
    let s = this.streams.get(msg.conn);
    if (!s) {
      const st = new Stream((op, body) => { st.frames = (st.frames || 0) + 1; if (st.frames > 20) st.game = true; this.combat.frame(op, body, this.curT); }, false);
      s = st;
      this.streams.set(msg.conn, s);
      this.diag({ type: 'conn', conn: msg.conn });
    }
    s.lastSeen = t;
    this._inPacket = true;
    try {
      s.push(msg.seq, Buffer.from(msg.data, 'base64'), this.now());
    } finally {
      this._inPacket = false;
    }
  }

  tick() {
    const now = this.now();
    this.meter.tick(now);
    this.group.tick(now);
    // kayıp paket bekleyen akışları zaman aşımıyla ilerlet
    for (const s of this.streams.values()) s.checkGap(now);
    for (const s of this.outStreams.values()) s.checkGap(now);
    // 1 dakikadır veri gelmeyen bağlantıyı bırak (kanal/bölge değişimi)
    for (const [k, s] of this.streams) {
      if (now - s.lastSeen > 60000) {
        this.streams.delete(k);
        this.outStreams.delete(k);
      }
    }
    for (const [k] of this.outStreams) {
      if (!this.streams.has(k)) this.outStreams.delete(k);
    }
  }

  // teşhis ekranı
  diagnostics() {
    const now = this.now();
    const ops = [...this.combat.ops].sort((a, b) => b[1] - a[1]).slice(0, 40).map(([op, n]) => [op.toString(16).padStart(4, '0'), n]);
    return {
      own: { id: this.ownId, source: this.ownSource, manual: this.manualOwn, info: this.infoOwn, candidates: this.owner.table(this.capT || now) },
      counts: { ...this.counts, ...this.combat.stats },
      conns: [...this.streams].map(([k, s]) => ({ conn: k, game: !!s.game, gaps: s.gaps, ageMs: now - s.lastSeen })),
      outAgeMs: this.capT ? this.capT - this.owner.lastOut : Infinity,
      ops,
      events: this.events.slice(-80),
    };
  }
}

module.exports = { Engine, itemKind };
