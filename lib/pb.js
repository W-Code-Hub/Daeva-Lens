'use strict';
// Kişisel en iyi skor (PB): boss adı/kodu başına kendi en yüksek DPS'in. Yerel dosya (ağ yok).
// Yazma atomik (tmp + rename) ve ertelemelidir (debounce); bozuk dosya sessizce boş sayılır.
const fs = require('fs');
const path = require('path');

const SAVE_DELAY = 1500;
const MAX_ENTRIES = 500;
const MIN_DUR_MS = 5000;     // 5 sn'den kısa denemeler rekor sayılmaz (anlamsız yüksek DPS)

// Boss anahtarı: tercihen boss kodu (kimlik), yoksa ad
function keyOf(bossCode, bossName) {
  if (Number.isFinite(bossCode) && bossCode > 0) return 'c' + bossCode;
  const n = String(bossName || '').trim().toLowerCase();
  return n && n !== 'boss' && n !== '???' ? 'n' + n.slice(0, 64) : null;
}

class PersonalBests {
  constructor(file) {
    this.file = file;
    this.map = new Map(); // anahtar -> { name, dps, at }
    this.dirty = false;
    this.timer = null;
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const src = raw && typeof raw === 'object' && raw.bests && typeof raw.bests === 'object' ? raw.bests : {};
      for (const [k, v] of Object.entries(src)) {
        if (v && Number.isFinite(v.dps) && v.dps > 0) this.map.set(k, { name: String(v.name || '').slice(0, 64), dps: v.dps, at: Number(v.at) || 0 });
      }
    } catch { /* dosya yok ya da bozuk: boş başla */ }
  }

  get(bossCode, bossName) {
    const k = keyOf(bossCode, bossName);
    return k ? this.map.get(k) || null : null;
  }

  // Dönüş: { isNew, prev } — isNew yalnızca daha önce kayıt VARSA ve geçildiyse true (ilk deneme "rekor" sayılmaz, kayıt altına alınır)
  submit(bossCode, bossName, dps, durMs, now = Date.now()) {
    const k = keyOf(bossCode, bossName);
    if (!k || !Number.isFinite(dps) || dps <= 0 || !(durMs >= MIN_DUR_MS)) return { isNew: false, prev: null, recorded: false };
    const old = this.map.get(k) || null;
    if (old && dps <= old.dps) return { isNew: false, prev: old.dps, recorded: false };
    this.map.set(k, { name: String(bossName || '').slice(0, 64), dps: Math.round(dps), at: now });
    if (this.map.size > MAX_ENTRIES) { // en eski kayıtlar atılır
      const sorted = [...this.map].sort((a, b) => a[1].at - b[1].at);
      for (let i = 0; i < sorted.length - MAX_ENTRIES; i++) this.map.delete(sorted[i][0]);
    }
    this._changed();
    return { isNew: !!old, prev: old ? old.dps : null, recorded: true };
  }

  _changed() {
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY);
    if (this.timer.unref) this.timer.unref();
  }

  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return false;
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ v: 1, bests: Object.fromEntries(this.map) }, null, 1));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* yok */ }
      return false;
    }
  }
}

module.exports = { PersonalBests, keyOf, MIN_DUR_MS };
