'use strict';
// Faz 8.2: oyuncu değerlendirme ve kara liste. Yalnız yerel dosya; ağ yok.
// Dosya app.getPath('userData')/player_ratings.json (ASAR salt-okunur); atomik yazma, 500 ms debounce.
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TAGS = ['blacklist', 'whitelist', 'good-tank', 'good-healer', 'high-dps', 'toxic', 'leaver', 'good', 'slow', 'afk', 'loot'];
const QUICK_TAGS = ['good', 'slow', 'afk', 'loot']; // puanlama ekranındaki hızlı etiketler (aç/kapa)
const SCHEMA = 1;
const MAX_NAME = 32;
const MAX_NOTE = 300;
const MAX_ENTRIES = 5000;
const SAVE_DELAY = 500;

const uuid = () => (crypto.randomUUID ? crypto.randomUUID() : crypto.randomBytes(16).toString('hex'));
const keyOf = (name) => String(name || '').trim().toLowerCase();
const pairKey = (name, server) => keyOf(name) + '|' + String(server || '').trim();

function emptyDoc() {
  return { schemaVersion: SCHEMA, clientId: uuid(), updatedAt: 0, entries: [] };
}

// Girdi doğrulama (IPC için). Geçerliyse { ok:true, value }, değilse { ok:false, error }.
// opts.allowZero: 0 = "puansız" (yalnız kara liste / not kaydı); IPC girişi 1-5 ister, yerel dosya ve hızlı puanlama 0'a izin verir.
function validate(inp, opts) {
  if (!inp || typeof inp !== 'object') return { ok: false, error: 'invalid' };
  const name = typeof inp.targetNickname === 'string' ? inp.targetNickname.trim() : '';
  if (!name || name.length > MAX_NAME) return { ok: false, error: 'name' };
  const rating = inp.rating;
  if (!Number.isInteger(rating) || rating < (opts && opts.allowZero ? 0 : 1) || rating > 5) return { ok: false, error: 'rating' };
  const note = inp.note === undefined || inp.note === null ? '' : inp.note;
  if (typeof note !== 'string' || note.length > MAX_NOTE) return { ok: false, error: 'note' };
  const tagsIn = inp.tags === undefined || inp.tags === null ? [] : inp.tags;
  if (!Array.isArray(tagsIn) || tagsIn.length > TAGS.length) return { ok: false, error: 'tags' };
  const tags = [];
  for (const g of tagsIn) {
    if (typeof g !== 'string' || !TAGS.includes(g)) return { ok: false, error: 'tags' };
    if (!tags.includes(g)) tags.push(g);
  }
  // sunucu: numara (ör. 1301) ya da serbest metin; dosyada hep metin tutulur ('' = bilinmiyor)
  const server = typeof inp.server === 'string' ? inp.server.trim().slice(0, MAX_NAME) : (Number.isInteger(inp.server) && inp.server > 0 ? String(inp.server) : '');
  const gid = inp.targetGlobalId;
  const targetGlobalId = (typeof gid === 'string' && gid.length <= 64) ? gid : (Number.isFinite(gid) ? gid : null);
  const id = typeof inp.id === 'string' && inp.id.length <= 64 ? inp.id : '';
  return { ok: true, value: { id, targetNickname: name, targetGlobalId, server, rating, note, tags } };
}

class Ratings {
  constructor(file, templateFile) {
    this.file = file;
    this.templateFile = templateFile || null;
    this.doc = emptyDoc();
    this.index = new Map(); // küçükHarfAd -> { rating, hasNote, tags }
    this.pairIndex = new Map(); // küçükHarfAd|sunucu -> aynı alanlar (ad + sunucu kimliği)
    this.timer = null;
    this.dirty = false;
    this.onChange = null;
  }

  // İlk kurulum şablonu (data/player_ratings.json); okunamazsa yerleşik boş belge
  _template() {
    try {
      if (this.templateFile) {
        const d = JSON.parse(fs.readFileSync(this.templateFile, 'utf8'));
        if (d && typeof d === 'object' && Array.isArray(d.entries)) {
          const cleaned = d.entries.map((e) => this._clean(e)).filter(Boolean);
          return { schemaVersion: SCHEMA, clientId: uuid(), updatedAt: 0, entries: cleaned };
        }
      }
    } catch { /* yerleşik şablon */ }
    return emptyDoc();
  }

  _clean(e) {
    if (!e || typeof e !== 'object') return null;
    const v = validate(e, { allowZero: true });
    if (!v.ok || !e.id || typeof e.id !== 'string') return null;
    return {
      id: e.id, targetNickname: v.value.targetNickname, targetGlobalId: v.value.targetGlobalId, server: v.value.server,
      rating: v.value.rating, note: v.value.note, tags: v.value.tags,
      authorId: typeof e.authorId === 'string' ? e.authorId : '', authorNickname: typeof e.authorNickname === 'string' ? e.authorNickname.slice(0, MAX_NAME) : '',
      createdAt: Number(e.createdAt) || 0, updatedAt: Number(e.updatedAt) || 0, signature: '', // sunucu senkronu için ayrılmış yer
    };
  }

  load() {
    let doc = null;
    let text = null;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch (err) { if (err.code !== 'ENOENT') text = ''; }
    if (text !== null) {
      try {
        const d = JSON.parse(text);
        if (!d || typeof d !== 'object' || d.schemaVersion !== SCHEMA || !Array.isArray(d.entries)) throw new Error('bad');
        doc = {
          schemaVersion: SCHEMA, clientId: typeof d.clientId === 'string' && d.clientId ? d.clientId : uuid(),
          updatedAt: Number(d.updatedAt) || 0, entries: d.entries.map((e) => this._clean(e)).filter(Boolean).slice(0, MAX_ENTRIES),
        };
      } catch {
        try { fs.copyFileSync(this.file, this.file + '.bak'); } catch { /* yedek alınamadı */ }
        doc = null;
      }
    }
    const fresh = !doc;
    this.doc = doc || this._template();
    this._reindex();
    if (fresh) { this.dirty = true; this.flush(); }
    return this.doc;
  }

  _reindex() {
    const sums = new Map();   // küçükHarfAd → tüm sunucular (eski davranış)
    const pairs = new Map();  // küçükHarfAd|sunucu → yalnız o oyuncu (ad + sunucu kimliği)
    const add = (map, k, e) => {
      let s = map.get(k);
      if (!s) { s = { sum: 0, n: 0, hasNote: false, note: '', noteAt: -1, tags: new Set() }; map.set(k, s); }
      if (e.rating > 0) { s.sum += e.rating; s.n++; } // 0 = puansız (yalnız kara liste / not)
      if (e.note) { s.hasNote = true; if ((e.updatedAt || 0) >= s.noteAt) { s.note = e.note; s.noteAt = e.updatedAt || 0; } }
      for (const g of e.tags) s.tags.add(g);
    };
    for (const e of this.doc.entries) {
      add(sums, keyOf(e.targetNickname), e);
      add(pairs, pairKey(e.targetNickname, e.server), e);
    }
    const fin = (s) => ({ rating: s.n ? Math.round((s.sum / s.n) * 10) / 10 : 0, hasNote: s.hasNote, note: s.note, tags: [...s.tags] });
    this.index = new Map();
    for (const [k, s] of sums) this.index.set(k, fin(s));
    this.pairIndex = new Map();
    for (const [k, s] of pairs) this.pairIndex.set(k, fin(s));
  }

  summary(name) { return this.index.get(keyOf(name)) || null; }
  // Ad + sunucu kimliğiyle özet (aynı ad farklı sunucu = ayrı oyuncu). Sunucu numarası yoksa/'' ise yalnız sunucusuz kayıtlar eşleşir.
  // Panel rozeti / kara liste uyarısı için: önce tam eşleşme, yoksa sunucusuz (eski) kayıt
  lookup(name, server) { return this.pairIndex.get(pairKey(name, server)) || (server ? this.pairIndex.get(pairKey(name, '')) : null) || null; }
  isBlacklisted(name, server) { const s = this.lookup(name, server); return !!(s && s.tags.includes('blacklist')); }
  // Ad + sunucuya ait kayıt (bu kullanıcının kendi kaydı öncelikli)
  find(name, server) {
    const k = keyOf(name); const sv = String(server || '').trim();
    return this.doc.entries.find((x) => keyOf(x.targetNickname) === k && (x.server || '') === sv && x.authorId === this.doc.clientId)
      || this.doc.entries.find((x) => keyOf(x.targetNickname) === k && (x.server || '') === sv) || null;
  }
  // Çekmece hızlı puanlama: yalnız verilen alanlar değişir (rating 0-5, blacklist true/false, note metin ≤ 300); not (patch.note verilmezse) ve diğer etiketler korunur.
  // Puansız ve kara listesiz ve notsuz ve etiketsiz kalan kayıt silinir. Geçerliyse { ok:true, entry|null }.
  quick(name, server, patch, authorNickname) {
    const nm = String(name || '').trim();
    if (!nm || nm.length > MAX_NAME) return { ok: false, error: 'name' };
    const sv = Number.isInteger(server) && server > 0 ? String(server) : '';
    const cur = this.find(nm, sv);
    let rating = cur ? cur.rating : 0;
    let tags = cur ? cur.tags.slice() : [];
    if (patch && patch.rating !== undefined) {
      if (!Number.isInteger(patch.rating) || patch.rating < 0 || patch.rating > 5) return { ok: false, error: 'rating' };
      rating = patch.rating;
    }
    if (patch && patch.blacklist !== undefined) {
      tags = tags.filter((g) => g !== 'blacklist');
      if (patch.blacklist) tags.push('blacklist');
    }
    if (patch && patch.tags && typeof patch.tags === 'object') {
      for (const g of QUICK_TAGS) {
        if (typeof patch.tags[g] !== 'boolean') continue;
        tags = tags.filter((x) => x !== g);
        if (patch.tags[g]) tags.push(g);
      }
    }
    let note = cur ? cur.note : '';
    if (patch && patch.note !== undefined) {
      if (typeof patch.note !== 'string') return { ok: false, error: 'note' };
      note = patch.note.trim();
      if (note.length > MAX_NOTE) return { ok: false, error: 'note' };
    }
    if (!rating && !tags.length && !note) { if (cur) this.remove(cur.id); return { ok: true, entry: null }; }
    const e = this.upsert({ id: cur ? cur.id : '', targetNickname: nm, targetGlobalId: cur ? cur.targetGlobalId : null, server: sv, rating, note, tags }, authorNickname);
    return e ? { ok: true, entry: e } : { ok: false, error: 'full' };
  }
  get clientId() { return this.doc.clientId; }
  list() { return this.doc.entries; }
  // Panel için düz nesne { küçükAd: { r: ortalama, n: notVar(0/1), b: kara(0/1) } }
  indexObject() {
    const o = {};
    for (const [k, s] of this.index) o[k] = { r: s.rating, n: s.hasNote ? 1 : 0, b: s.tags.includes('blacklist') ? 1 : 0 };
    // ad|sunucu anahtarları (panel: sunucusu bilinen oyuncu için tam eşleşme; 'ad|' = sunucusuz eski kayıt)
    for (const [k, s] of this.pairIndex) o[k] = { r: s.rating, n: s.hasNote ? 1 : 0, b: s.tags.includes('blacklist') ? 1 : 0 };
    return o;
  }

  // Ekle veya güncelle (aynı id, yoksa aynı ad+sunucu). Girdi önce validate() ile geçmeli.
  upsert(value, authorNickname) {
    const now = Date.now();
    const k = keyOf(value.targetNickname);
    let e = null;
    if (value.id) e = this.doc.entries.find((x) => x.id === value.id) || null;
    if (!e) e = this.doc.entries.find((x) => keyOf(x.targetNickname) === k && (x.server || '') === (value.server || '') && x.authorId === this.doc.clientId) || null;
    if (!e) {
      if (this.doc.entries.length >= MAX_ENTRIES) return null;
      e = { id: uuid(), createdAt: now, signature: '' };
      this.doc.entries.push(e);
    }
    Object.assign(e, {
      targetNickname: value.targetNickname, targetGlobalId: value.targetGlobalId, server: value.server,
      rating: value.rating, note: value.note, tags: value.tags.slice(),
      authorId: this.doc.clientId, authorNickname: String(authorNickname || '').slice(0, MAX_NAME), updatedAt: now, signature: '',
    });
    this._changed();
    return e;
  }

  remove(id) {
    const i = this.doc.entries.findIndex((x) => x.id === id);
    if (i < 0) return false;
    this.doc.entries.splice(i, 1);
    this._changed();
    return true;
  }

  _changed() {
    this.doc.updatedAt = Date.now();
    this._reindex();
    this.dirty = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => { this.timer = null; this.flush(); }, SAVE_DELAY);
    if (this.timer.unref) this.timer.unref();
    if (typeof this.onChange === 'function') { try { this.onChange(); } catch { /* arayüz yok */ } }
  }

  // Atomik yazma: tmp dosyaya yaz, sonra yeniden adlandır
  flush() {
    if (this.timer) { clearTimeout(this.timer); this.timer = null; }
    if (!this.dirty) return false;
    const tmp = this.file + '.tmp';
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify(this.doc, null, 2));
      fs.renameSync(tmp, this.file);
      this.dirty = false;
      return true;
    } catch {
      try { fs.unlinkSync(tmp); } catch { /* yok */ }
      return false;
    }
  }
}

module.exports = { Ratings, validate, TAGS, QUICK_TAGS, MAX_NAME, MAX_NOTE, keyOf, pairKey };
