'use strict';
// Kendi becerilerimizin bekleme süreleri.
// Sunucu bekleme süresini (çoğu beceri için) göndermiyor; süre ya elle girilir ya da
// aynı becerinin iki kullanımı arasındaki en kısa aralıktan öğrenilir. 0x4738 paketi gelirse
// (kalan ms) o esas alınır; kalan 0 = beceri hemen hazır (sıfırlama / tetiklenme).

const fs = require('fs');
const path = require('path');
const { baseSkill, isPlayerSkill, classOf } = require('./meter');
const { iconUrl } = require('./icons');

const CHAIN_MS = 1200;       // bundan kısa tekrar = zincir/çok aşamalı kullanım, süreyi yeniden başlatmaz
const MIN_LEARN_MS = 5000;   // 5 sn altı basışlar (proc/reset/kombo/GCD) kesinlikle süre olarak öğrenilmez
const MAX_LEARN_MS = 310000; // 310 sn (~5.1 dk) tavan: 300 sn'lik Vaizel dahil tüm becerileri limitsiz ölçer

// Standart oyun bekleme sürelerine kilitler (oyuncu reaksiyonu ve ağ gecikmesini yuvarlar)
function quantizeCooldown(ms) {
  if (ms < 5000) return ms;
  const sec = ms / 1000;

  // Uzun süreli buff ve beceriler için standart basamaklar (saniye)
  const LONG_STANDARDS = [60, 75, 90, 120, 150, 180, 240, 300];
  for (const std of LONG_STANDARDS) {
    if (Math.abs(sec - std) <= 3.5) {
      return std * 1000;
    }
  }

  // 30–60s arası standart 5'lik basamaklar (35, 40, 45, 50, 55 sn)
  if (sec >= 30 && sec <= 60) {
    const near5 = Math.round(sec / 5) * 5;
    if (Math.abs(sec - near5) <= 1.5) {
      return near5 * 1000;
    }
  }

  // Hızlı beceriler (örn. 8s, 10s, 12s, 14s, 16s, 18s, 20s, 24s): tam saniyeye kilitler
  return Math.round(sec) * 1000;
}

let defaultCooldowns = {};
try {
  const raw = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'cooldowns.json'), 'utf8'));
  for (const [k, v] of Object.entries(raw)) {
    const ms = typeof v === 'number' ? v : (v && v.cdMs);
    if (ms > 0) defaultCooldowns[Number(k)] = ms;
  }
} catch { /* yok */ }

function getDefaultCooldown(base) {
  const b = Number(base);
  if (defaultCooldowns[b]) return defaultCooldowns[b];
  if (b >= 2000000 && b <= 2999999) return 30000;
  return 0;
}

// Sınıf becerilerinde xx70xxxx–xx80xxxx aralığı pasifler (ör. Avcı 1472 Concentrated Fire, 1480 Hunter's Soul)
const isPassiveRange = (base) => { const r = Math.floor(base / 10000) % 100; return r >= 71 && r <= 80; };

class Cooldowns {
  constructor(opts = {}) {
    this.skillName = opts.skillName || ((c) => '#' + c);
    this.emit = opts.emit || (() => {});
    this.now = opts.now || (() => Date.now());
    this.setTimer = opts.setTimer || setTimeout;
    this.clearTimer = opts.clearTimer || clearTimeout;
    this.cfg = opts.config || {};     // base -> { on, cdMs, sound, earlyMs }
    this.learned = opts.learned || {}; // base -> ms
    this.skills = new Map();          // base -> durum
    this.includeEffects = false;
    this.castBases = new Set(opts.castBases || []);     // 0x0238 ile görülen beceriler
    this.activeBases = new Set(opts.activeBases || []); // tür 2 ile görülen beceriler
    this.serverBases = new Set(opts.serverBases || []); // kalan süresini sunucu bildiren beceriler (Deadshot)
    this.serverCds = {};                                // base -> sunucudan hesaplanan tam süre
    this.recentGaps = new Map();                        // base -> number[] (son 5 ölçüm, ortanca hesaplama için)
    this.inCombat = opts.inCombat || null;              // dövüş durumu denetimi
    this.lastCombatEnd = 0;                             // son dövüşün bittiği an (ms)
    this.combatActive = true;
    this.ownClass = opts.ownClass || null;              // oyuncunun sınıfı (farklı sınıfların mantraları eklenmesin)
  }

  setOwnClass(cls) {
    if (cls && this.ownClass !== cls) {
      this.ownClass = cls;
    }
  }

  combatEnd(t) {
    this.lastCombatEnd = t || (typeof this.now === 'function' ? this.now() : Date.now());
    this.combatActive = false;
  }

  isCombatActive(t) {
    if (typeof this.inCombat === 'function') {
      return !!this.inCombat(t);
    }
    return this.combatActive;
  }

  emitBases() {
    this.emit({ type: 'bases', castBases: [...this.castBases], activeBases: [...this.activeBases], serverBases: [...this.serverBases] });
  }

  entry(base, raw) {
    let s = this.skills.get(base);
    if (!s) {
      s = { base, raw, name: this.skillName(raw), uses: 0, lastCast: 0, readyAt: 0, startAt: 0, src: null, timers: [] };
      this.skills.set(base, s);
      this.emit({ type: 'new-skill', base, raw, name: s.name });
    }
    return s;
  }

  // 4 Katmanlı Hibrit Süre Önceliği:
  // 1. Elle Girilen (Ayarlar)
  // 2. Sunucu Paketi (0x4738 bildirimi)
  // 3. Taban Tablosu (data/cooldowns.json resmi süre)
  // 4. Öğrenilen (dinamik iki kullanım aralığı)
  durationOf(base) {
    const b = Number(base);
    const c = this.cfg[b];
    if (c && c.cdMs > 0) return { ms: c.cdMs, src: 'elle' };

    const s = this.skills.get(b);
    const sMax = (s && s.serverMax) || this.serverCds[b] || 0;
    if (sMax > 0 && this.serverBases.has(b)) return { ms: sMax, src: 'sunucu' };

    const def = getDefaultCooldown(b);
    const learned = this.learned[b] || 0;

    // Pasif / Seviye indirimi: Eğer ölçülen süre taban süreden daha kısaysa (en az 1 sn fark),
    // oyuncunun pasifli kısa süresi önceliklidir!
    if (learned > 0 && def > 0 && learned <= def - 1000) return { ms: learned, src: 'pasif/öğrenildi' };

    if (def > 0) return { ms: def, src: 'varsayılan' };
    if (learned > 0) return { ms: learned, src: 'öğrenildi' };
    return { ms: 0, src: null };
  }

  // Kullanım sinyalleri (kayıtlarla doğrulandı):
  //  * 0x0238 tür 2: hedefli kullanım (Gale Arrow, Griffon Arrow, Dodge...). Her zaman sayılır.
  //  * 0x0238 tür 0: hedefsiz/kendine buff kullanımları da böyle geliyor (Ozan mantraları,
  //    Insulting Roar, Healing Light) ama hedefli becerilerin yan etkileri de (Snipe -> 14020047).
  //    Bu yüzden sadece o beceri hiç tür 2 ile görülmediyse sayılır.
  //  * Hasar: şarjlı beceriler (Deadshot) 0x0238 göndermeyebiliyor; o beceri hiç 0x0238 ile
  //    görülmediyse kendi vuruşumuz kullanım sayılır.
  //  * İksirler (201xxxx, 202xxxx): eşya kullanımı, doğrudan soğuma başlatır.
  cast(ev) {
    if (!ev.own) return;
    const potion = ev.skill >= 2000000 && ev.skill <= 2999999;
    if (!potion && !isPlayerSkill(ev.skill)) return;
    const cls = classOf(ev.skill);
    if (!potion && this.ownClass && cls && cls !== this.ownClass) return;
    const base = potion ? ev.skill : baseSkill(ev.skill);
    if (!this.castBases.has(base)) { this.castBases.add(base); this.emitBases(); }
    if (potion || ev.kind === 2) {
      if (!this.activeBases.has(base)) { this.activeBases.add(base); this.emitBases(); }
      this.use(base, ev.skill, ev.t, potion ? 'iksir' : 'kullanım');
    } else if (!this.activeBases.has(base) || this.includeEffects) {
      this.use(base, ev.skill, ev.t, 'hedefsiz');
    }
  }

  damage(ev) {
    if (!ev.own || ev.dot) return;
    const potion = ev.skill >= 2000000 && ev.skill <= 2999999;
    if (!potion && !isPlayerSkill(ev.skill)) return;
    const cls = classOf(ev.skill);
    if (!potion && this.ownClass && cls && cls !== this.ownClass) return;
    const base = potion ? ev.skill : baseSkill(ev.skill);
    if (this.castBases.has(base)) return;
    this.use(base, ev.skill, ev.t, 'vuruş');
  }

  use(base, raw, t, via) {
    const s = this.entry(base, raw);
    s.via = via;
    const prevCast = s.lastCast || 0;
    const gap = prevCast ? t - prevCast : Infinity;
    s.uses++;
    s.isReady = false;
    if (gap < CHAIN_MS) { s.lastCast = t; return; }

    const inCombatNow = this.isCombatActive(t);

    // Bekleme süresi öğrenme (Dövüş İçi Filtresi & Quantized Ortanca):
    // 1. Tabloda olmayan beceriler VEYA taban süreden en az 1 sn daha kısa basılan (pasif indirimi olan) beceriler
    // 2. 5 sn'den kısa basışlar (MIN_LEARN_MS = 5000) proc/reset/kombo kabul edilir, asla öğrenilmez.
    // 3. İki basış arasında dövüş sonlandıysa (this.lastCombatEnd > prevCast) veya şu an dövüşte
    //    değilsek bu aralık gezinme/şehir boşluğu kabul edilir, öğrenilmez.
    // 4. Dövüş kesintisiz sürdüğü sürece 8 sn'den 300 sn'ye kadar tüm aralıklar limitsiz ölçülür.
    // 5. Son 5 ölçümün ortancası (median) alınır ve standart sürelere kilitlenir (quantizeCooldown).
    const def = getDefaultCooldown(base);
    const droppedCombat = prevCast > 0 && this.lastCombatEnd > prevCast;
    const isPassiveEligible = def > 0 && gap <= def - 1000;
    const isPotion = Number(base) >= 2000000 && Number(base) <= 2999999;
    const canLearn = !isPotion && (!def || isPassiveEligible) && !this.serverBases.has(base) &&
      gap !== Infinity && gap >= MIN_LEARN_MS && gap <= MAX_LEARN_MS &&
      !droppedCombat && inCombatNow && s.inCombat !== false;

    if (canLearn) {
      let samples = this.recentGaps.get(base);
      if (!samples) {
        samples = [];
        this.recentGaps.set(base, samples);
      }
      samples.push(gap);
      if (samples.length > 5) samples.shift();

      let med;
      if (samples.length === 1) {
        med = samples[0];
      } else {
        const sorted = [...samples].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        med = sorted.length % 2 !== 0 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
      }
      let quantized = quantizeCooldown(med);
      if (def > 0 && Math.abs(quantized - def) <= 2000) {
        quantized = def; // Reaksiyon gecikmesi sapmasını sıfırla, taban süreye kilitle
      }

      // Güvenlik Koruması: Eğer bu beceri taban tablosunda varsa ve süresi tabandan kısaysa (pasif indirimi),
      // anlık tek bir sıfırlanma (proc) hatasına karşı en az 2 kararlı ölçüm doğrulaması aranır!
      const isConfirmed = !def || (quantized >= def) || samples.length >= 2;
      if (isConfirmed && this.learned[base] !== quantized) {
        this.learned[base] = quantized;
        this.emit({ type: 'learned', base, ms: quantized });
      }
    }

    s.lastCast = t;
    s.inCombat = inCombatNow;

    const d = this.durationOf(base);
    if (d.ms > 0) this.start(s, t, d.ms, d.src);
    else this.emit({ type: 'changed' });
  }

  // 0x4738. Kayıtlarda Deadshot için hep "kalan 0" geliyor ve beceri hiç kullanılmamışken de
  // geliyor (tetiklenme/sıfırlama bildirimi). "Hazır" uyarısı sadece beceri gerçekten
  // bekliyorsa (kullanıldı, süre dolmadı) verilir; zaten hazırsa sessizce hazır işaretlenir.
  serverCd(ev) {
    const base = baseSkill(ev.skill);
    if (!isPlayerSkill(ev.skill)) return;
    const cls = classOf(ev.skill);
    if (this.ownClass && cls && cls !== this.ownClass) return;
    const s = this.entry(base, ev.skill);
    if (ev.ms > 0) {
      // Canlı kayıt (2026-10-06): Deadshot kullanılınca sunucu kalan süreyi ara ara geri sayıyor
      // (16850 → 4600 → 2750 → 0), ama her kullanımda değil. Kullanımdan sonraki ilk bildirimden
      // tam süre (kalan + kullanımdan beri geçen) öğrenilir; bildirim gelmeyen kullanımlarda o süre işler.
      if (!this.serverBases.has(base)) { this.serverBases.add(base); this.emitBases(); }
      const since = s.lastCast ? ev.t - s.lastCast : Infinity;
      if (since < 5000 && s.serverFor !== s.lastCast) {
        s.serverFor = s.lastCast;
        const full = Math.round(ev.ms + since);
        s.serverMax = Math.max(s.serverMax || 0, full);
        this.serverCds[base] = s.serverMax;
        if (this.learned[base] !== s.serverMax) {
          this.learned[base] = s.serverMax;
          this.emit({ type: 'learned', base, ms: s.serverMax });
        }
      }
      if (ev.ms >= 1000) {
        this.start(s, ev.t, ev.ms, 'sunucu');
      }
      return;
    }
    const since = s.lastCast ? this.now() - s.lastCast : Infinity;
    // Kullanımdan sonraki ilk 3 sn içinde gelen kalan=0 paketleri henüz sunucunun kullanımı işlemediği
    // ve ağda geciken eski paketlerdir; erken/hatalı ses çalmaması için atlanır.
    const waiting = s.uses > 0 && !s.isReady && since >= 3000;
    if (!waiting) {
      if (!s.isReady && since >= 3000) { s.isReady = true; s.readyAt = 0; this.clear(s); }
      this.emit({ type: 'ready-silent', base, name: s.name, why: s.uses ? 'sunucu 0x4738 kalan=0, henüz hazır değil veya zaten hazırdı' : 'sunucu 0x4738 kalan=0, beceri bu oturumda hiç kullanılmadı' });
      this.emit({ type: 'changed' });
      return;
    }
    const ago = (since / 1000).toFixed(1);
    this.ready(s, true, `sunucu 0x4738 kalan=0, son kullanım ${ago} sn önce`);
  }

  start(s, t, ms, src) {
    this.clear(s);
    s.isReady = false;
    s.startAt = t;
    s.readyAt = t + ms;
    s.src = src;
    const c = this.cfg[s.base];
    if (c && c.on) {
      const left = s.readyAt - this.now();
      const early = c.earlyMs > 0 ? c.earlyMs : 0;
      const why = `zamanlayıcı ${(ms / 1000).toFixed(1)} sn (${src})`;
      if (early && left - early > 0) s.timers.push(this.setTimer(() => this.emit({ type: 'warn', base: s.base, name: s.name, why }), left - early));
      s.timers.push(this.setTimer(() => this.ready(s, false, why), Math.max(0, left)));
    }
    this.emit({ type: 'changed' });
  }

  ready(s, fromServer, why) {
    this.clear(s);
    const now = this.now();
    // sunucu aynı "hazır" bildirimini birkaç saniye içinde art arda gönderebiliyor
    const skip = fromServer ? now - (s.lastServerReady || -1e9) < 5000 || s.isReady : s.isReady;
    if (fromServer) s.lastServerReady = now;
    s.readyAt = 0;
    s.isReady = true;
    const c = this.cfg[s.base];
    if (c && c.on && !skip) this.emit({ type: 'ready', base: s.base, name: s.name, fromServer, why });
    this.emit({ type: 'changed' });
  }

  clear(s) {
    for (const h of s.timers) this.clearTimer(h);
    s.timers = [];
  }

  setConfig(cfg) {
    this.cfg = cfg || {};
    // açık zamanlayıcıları yeni ayarlarla kur
    const now = this.now();
    for (const s of this.skills.values()) {
      if (s.readyAt > now) this.start(s, s.startAt, s.readyAt - s.startAt, s.src);
      else this.clear(s);
    }
  }

  list() {
    const now = this.now();
    return [...this.skills.values()]
      .sort((a, b) => b.lastCast - a.lastCast)
      .map((s) => {
        const d = this.durationOf(s.base);
        return {
          base: s.base, name: s.name, icon: iconUrl(s.raw), uses: s.uses, lastCast: s.lastCast,
          readyAt: s.readyAt, startAt: s.startAt, left: Math.max(0, s.readyAt - now), src: d.src,
          learnedMs: this.learned[s.base] || 0, defaultMs: getDefaultCooldown(s.base), cdMs: d.ms, via: s.via || null,
          passive: isPassiveRange(s.base),
        };
      });
  }
}

module.exports = { Cooldowns, getDefaultCooldown, quantizeCooldown };
