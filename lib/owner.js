'use strict';
// Kendi karakterini bulma: giden paket zamanı ↔ gelen beceri kullanımı eşleştirmesi.
//
// İstemci → sunucu yönü şifreli, içi okunmaz; ama her çerçevenin ne zaman ve hangi boyutta
// gittiği görülür. Bir beceriye bastığında istemci sunucuya bir istek çerçevesi gönderir
// (kayıtlarda 37–62 bayt), sunucu ~40–120 ms sonra 0x0238 "X kullandı" bildirimini yollar.
// Senin kullanımlarının hemen öncesinde her seferinde senden bir istek çıkmıştır; yanındaki
// oyuncularınkinde bu sadece tesadüfen olur. Her aktör için olabilirlik oranı (log) toplanır.
//
// Kayıtlarla ölçüldü (2026-10-04 00:51): kendi karakter 17/17 eşleşme, yanındaki Avcı 10/63.

const WINDOW_MS = 400;       // istek → bildirim en fazla bu kadar sonra gelir
const MIN_REQ = 33;          // hareket (31) ve kalp atışı (11) çerçevelerinden büyük
const MAX_REQ = 400;
const HEALTH_MS = 1500;      // giden yön bu kadar sessizse (kayıp/kopma) kullanım değerlendirilmez
const COVER_MS = 20000;      // tesadüf olasılığı bu pencereden hesaplanır
const DECAY_MS = 120000;     // puanlar bu sürede e kat azalır (bölge değişince yeni kimlik öne geçebilsin)
const PICK = 8;              // seçilmek için gereken puan (~4 ardışık eşleşme)
const LEAD = 3.5;            // ikinciden en az bu kadar önde (kalabalık raid'lerde daha hızlı seçim)
const DROP = -6;             // seçili kimliğin puanı bunun altına inerse bırak

class OwnTracker {
  constructor(opts = {}) {
    this.onPick = opts.onPick || (() => {});
    this.onDiag = opts.onDiag || (() => {});
    this.isOther = opts.isOther || (() => false);
    this.req = [];            // istek çerçevelerinin zamanları (son COVER_MS)
    this.lastOut = -1e15;
    this.sizeRate = new Map(); // boyut -> son 5 sn'deki zamanlar (sık gelen boyutlar istek sayılmaz)
    this.scores = new Map();   // aktör -> { s, t, n, hits, lastCast }
    this.own = null;
  }

  // giden çerçeve
  outFrame(t, size) {
    this.lastOut = t;
    let q = this.sizeRate.get(size);
    if (!q) { q = []; this.sizeRate.set(size, q); }
    q.push(t);
    while (q.length && t - q[0] > 5000) q.shift();
    if (size < MIN_REQ || size > MAX_REQ) return;
    if (q.length > 30) return; // saniyede 6'dan sık gelen boyut: periyodik, istek değil
    this.req.push(t);
    while (this.req.length && t - this.req[0] > COVER_MS) this.req.shift();
  }

  // tesadüfen bir isteğin pencereye düşme olasılığı
  chance(t) {
    let cov = 0, last = -1e15;
    for (const o of this.req) {
      if (t - o > COVER_MS) continue;
      const a = Math.max(o, last), b = o + WINDOW_MS;
      if (b > a) cov += b - a;
      last = Math.max(last, b);
    }
    return Math.min(0.9, Math.max(0.03, cov / COVER_MS));
  }

  // 0x0238 tür 2 oyuncu becerisi
  cast(actor, skill, t) {
    if (this.isOther(actor)) return; // Başka bir oyuncu olduğu biliniyorsa asla kendi karakterimiz sayılamaz
    if (t - this.lastOut > HEALTH_MS) return; // giden yön görünmüyor: karar verme
    let lag = null;
    for (let i = this.req.length - 1; i >= 0; i--) {
      const d = t - this.req[i];
      if (d < 0) continue;
      if (d > WINDOW_MS) break;
      lag = d;
      break;
    }
    const p = this.chance(t);
    const hit = lag !== null;
    let r = this.scores.get(actor);
    if (!r) { r = { s: 0, t, n: 0, hits: 0, lastCast: t }; this.scores.set(actor, r); }
    r.s *= Math.exp(-(t - r.t) / DECAY_MS);
    r.t = t;
    r.n++;
    r.lastCast = t;
    r.stale = false; // kesin kimlikten sonra yeni kanıt geldi
    if (hit) r.hits++;
    r.s += hit ? Math.log(0.95 / p) : Math.log(0.05 / (1 - p));
    this.onDiag({ type: 'own-evidence', actor, skill, hit, lag, p: Math.round(p * 100) / 100, score: Math.round(r.s * 10) / 10 });

    // Hızlı ilk vuruş tespiti: başka oyuncu olmadığı biliniyorsa ve ilk vuruş paketi eşleştiyse
    if (!this.isOther(actor) && this.own === null && hit && r.hits >= 1 && (this.scores.size <= 2 || r.s >= 3.5)) {
      this.own = actor;
      this.onPick(actor, 'ilk vuruş hızlı eşleşmesi');
      return;
    }

    this.decide(t);
  }

  decide(t) {
    let best = null, second = -Infinity;
    for (const [a, r] of this.scores) {
      if (this.isOther(a)) continue;
      const s = r.s * Math.exp(-(t - r.t) / DECAY_MS);
      if (!best || s > best.s) { if (best) second = Math.max(second, best.s); best = { a, s }; } else second = Math.max(second, s);
    }
    if (!best) return;
    const cur = this.own !== null ? this.scores.get(this.own) : null;
    const curS = cur ? cur.s * Math.exp(-(t - cur.t) / DECAY_MS) : -Infinity;
    if (this.own !== null && curS < DROP) {
      const old = this.own;
      this.own = null;
      this.onPick(null, `kimlik ${old} bırakıldı (puan ${curS.toFixed(1)})`);
    }
    if (best.a === this.own) return;
    // Kesin kimlik (seed) sonrası hiç beceri kullanmamış eski aday (ör. bölge değişiminden kalan eski kimlik) birikmiş
    // puanıyla kesin kimliği ezemez; aksi halde iki kimlik arasında gidip gelinir ve eski kimlik ayrı satır kalır.
    const bestR = this.scores.get(best.a);
    if (this.own !== null && bestR && bestR.stale) return;
    const idle = !cur || t - cur.lastCast > 10000;
    if (best.s >= PICK && best.s - second >= LEAD && (this.own === null || idle || best.s > curS + LEAD)) {
      this.own = best.a;
      const r = this.scores.get(best.a);
      this.onPick(best.a, `giden istek eşleşmesi ${r.hits}/${r.n}, puan ${best.s.toFixed(1)}`);
    }
  }

  // teşhis ekranı için
  table(t) {
    return [...this.scores].map(([a, r]) => ({ actor: a, n: r.n, hits: r.hits, score: Math.round(r.s * Math.exp(-(t - r.t) / DECAY_MS) * 10) / 10 }))
      .sort((x, y) => y.score - x.score).slice(0, 8);
  }

  // giriş paketi (0x3336) kimliği kesin söylediyse eşleştirme ondan başlasın
  seed(actor, t) {
    for (const [a, r] of this.scores) if (a !== actor) r.stale = true; // eski adaylar yeni kanıt gelene dek bekler
    this.scores.set(actor, { s: PICK + LEAD, t, n: 0, hits: 0, lastCast: t });
    this.own = actor;
  }

  reset() { this.scores.clear(); this.own = null; }
}

const { readVarint } = require('./parser');

// Giden yön: her TCP parçası kayıtlarda tam olarak bir çerçeve. Uzunluk varint'i açık;
// çerçeve boyu = L - 4 + varint uzunluğu (2 baytlık varint'te L - 2; gelen yönden farklı).
function outFrameSizes(buf) {
  const out = [];
  let i = 0;
  while (i < buf.length) {
    const v = readVarint(buf, i);
    if (!v) {
      if (out.length > 0) return out;
      out.push(buf.length);
      return out;
    }
    const tot = v[0] + (v[1] - i) - 4;
    if (tot <= 0 || i + tot > buf.length) {
      if (out.length > 0) return out;
      out.push(buf.length);
      return out;
    }
    out.push(tot);
    i += tot;
  }
  return out;
}

module.exports = { OwnTracker, outFrameSizes };
