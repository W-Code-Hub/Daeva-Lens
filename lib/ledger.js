'use strict';
// Oyuncu defteri: her boss karşılaşmasında birlikte oynanan oyuncuları kalıcı tutar. Yalnız yerel dosya; ağ yok.
// Dosya app.getPath('userData')/oyuncu_defteri.jsonl: karşılaşma başına TEK satır eklenir (dosya baştan yazılmaz, boyut sınırı yok).
// Aynı karşılaşma birleşme ile güncellenirse aynı fk ile yeni satır eklenir; yüklemede son satır geçerli olur.
// Bellekte: fk → kayıt; oyuncu özeti (kaç kez birlikte, son görülme) tembel kurulur. Oyuncu kimliği = ad + sunucu numarası.
const fs = require('fs');
const path = require('path');

const MAX_NAME = 32;

const pidOf = (name, server) => String(name || '').trim().toLowerCase() + '|' + (Number(server) > 0 ? Number(server) : ''); // lib/ratings.pairKey ile aynı biçim (sunucu yoksa boş)

// Dışarıdan gelen karşılaşma kaydını temizler; kullanılacak oyuncu yoksa null
function cleanRecord(rec) {
  if (!rec || typeof rec !== 'object' || typeof rec.fk !== 'string' || !rec.fk) return null;
  const src = Array.isArray(rec.p) ? rec.p : (Array.isArray(rec.actors) ? rec.actors : []);
  const p = [];
  for (const a of src) {
    if (!a || typeof a !== 'object') continue;
    const n = String((a.n !== undefined ? a.n : a.name) || '').trim().slice(0, MAX_NAME);
    if (!n || n.includes('#')) continue; // adı bilinmeyen oyuncu (Sınıf #id) deftere girmez
    const s = Number(a.s !== undefined ? a.s : a.server);
    const c = Number(a.c !== undefined ? a.c : a.cls);
    const d = Number(a.d !== undefined ? a.d : a.total);
    p.push({ n, s: Number.isInteger(s) && s > 0 && s < 65536 ? s : 0, c: Number.isInteger(c) && c > 0 ? c : 0, d: Number.isFinite(d) && d > 0 ? Math.round(d) : 0 });
  }
  if (!p.length) return null;
  return { fk: rec.fk.slice(0, 64), at: Number(rec.at) || 0, boss: String(rec.boss || '').slice(0, 64), code: Number(rec.code) || 0, dur: Number(rec.dur) || 0, k: rec.killed || rec.k ? 1 : 0, p };
}

class Ledger {
  constructor(file) {
    this.file = file;
    this.fights = new Map(); // fk → temiz kayıt
    this.sum = null;         // pid → { name, server, cls, n, last, boss, dmg }; null = yeniden kurulacak
    this.needNl = false;     // dosya satır sonuyla bitmiyor (yarım yazılmış son satır): eklemeden önce '\n'
  }

  load() {
    let text = '';
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { text = ''; }
    this.fights.clear();
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      try { const r = cleanRecord(JSON.parse(line)); if (r) this.fights.set(r.fk, r); } catch { /* bozuk satır atlanır */ }
    }
    this.needNl = text.length > 0 && !text.endsWith('\n');
    this.sum = null;
    return this.fights.size;
  }

  // Karşılaşmayı ekler (aynı fk varsa günceller). Başarıyla temizlenen kaydı döner, yoksa null.
  record(rec) {
    const r = cleanRecord(rec);
    if (!r) return null;
    this.fights.set(r.fk, r);
    this.sum = null;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.appendFileSync(this.file, (this.needNl ? '\n' : '') + JSON.stringify(r) + '\n');
      this.needNl = false;
    } catch { /* yazılamadı: bellekte kalır */ }
    return r;
  }

  _build() {
    const m = new Map();
    for (const f of this.fights.values()) {
      for (const a of f.p) {
        const id = pidOf(a.n, a.s);
        let e = m.get(id);
        if (!e) { e = { name: a.n, server: a.s, cls: 0, n: 0, last: 0, boss: '', dmg: 0 }; m.set(id, e); }
        e.n++; e.dmg += a.d;
        if (f.at >= e.last) { e.last = f.at; e.boss = f.boss; e.name = a.n; if (a.c) e.cls = a.c; }
      }
    }
    this.sum = m;
    return m;
  }

  // Tek oyuncu özeti ({ n, last, boss, ... } ya da null)
  seen(name, server) { return (this.sum || this._build()).get(pidOf(name, server)) || null; }
  // Panel/çekmece için düz nesne { pid: { n, last, boss, cls } }
  summaries() {
    const o = {};
    for (const [k, e] of (this.sum || this._build())) o[k] = { n: e.n, last: e.last, boss: e.boss, cls: e.cls };
    return o;
  }
  // Karşılaşmalar yeniden eskiye (en çok max tane); kayıt nesneleri salt-okunur kullanılır
  list(max) {
    const a = [...this.fights.values()].sort((x, y) => y.at - x.at);
    return max > 0 ? a.slice(0, max) : a;
  }
  get size() { return this.fights.size; }
}

module.exports = { Ledger, pidOf, cleanRecord };
