'use strict';
// Ölüm özeti (Death Recap) için sınırlı boyutlu halka tampon. Saf veri modeli: DOM, dosya, ağ yok.
// Her oyuncunun son vuruşları sabit uzunlukta (tipli) dizilerde tutulur; yeni vuruşta yeni dizi kurulmaz,
// en eski kayıt ezilir (GC baskısı yok). Okuma (snapshot) yalnızca ölüm anında, bir kez yapılır.

const CAP = 128;           // oyuncu başına en çok kayıt (10 sn'de bu kadar vuruş fazlasıyla yeter)
const WINDOW_MS = 10000;   // özet penceresi

class RecapRing {
  constructor(cap = CAP) {
    this.cap = cap;
    this.t = new Float64Array(cap);
    this.actor = new Float64Array(cap);   // -1 = bilinmiyor
    this.skill = new Float64Array(cap);
    this.amount = new Float64Array(cap);
    this.dot = new Uint8Array(cap);
    this.head = 0;   // bir sonraki yazılacak yuva
    this.size = 0;
  }

  push(t, actor, skill, amount, dot) {
    const i = this.head;
    this.t[i] = t;
    this.actor[i] = actor === null || actor === undefined ? -1 : actor;
    this.skill[i] = skill === null || skill === undefined ? -1 : skill;
    this.amount[i] = amount;
    this.dot[i] = dot ? 1 : 0;
    this.head = (i + 1) % this.cap;
    if (this.size < this.cap) this.size++;
  }

  // en yeni kaydın zamanı (yoksa -Infinity)
  lastT() {
    return this.size ? this.t[(this.head - 1 + this.cap) % this.cap] : -Infinity;
  }

  // Son windowMs içindeki kayıtlar, eskiden yeniye. Yalnızca ölüm anında çağrılır.
  snapshot(now, windowMs = WINDOW_MS) {
    const out = [];
    const start = (this.head - this.size + this.cap) % this.cap;
    for (let k = 0; k < this.size; k++) {
      const i = (start + k) % this.cap;
      if (now - this.t[i] > windowMs) continue;
      out.push({
        t: this.t[i],
        actor: this.actor[i] === -1 ? null : this.actor[i],
        skill: this.skill[i] === -1 ? null : this.skill[i],
        amount: this.amount[i],
        dot: this.dot[i] === 1,
      });
    }
    return out;
  }

  // Kimlik birleşmesinde (ör. geçici kimlik gerçek kimliğe) iki tamponu zaman sırasıyla birleştirir. Seyrek çağrılır.
  static merge(a, b) {
    const all = a.snapshot(Infinity, Infinity).concat(b.snapshot(Infinity, Infinity)).sort((x, y) => x.t - y.t);
    const r = new RecapRing(Math.max(a.cap, b.cap));
    for (const x of all.slice(-r.cap)) r.push(x.t, x.actor, x.skill, x.amount, x.dot);
    return r;
  }
}

module.exports = { RecapRing, CAP, WINDOW_MS };
