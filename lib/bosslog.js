'use strict';
// Boss karşılaşma geçmişi (kalıcı): her biten boss dövüşünün raporu ayrı bir dosyada, liste için özet satırları tek indekste.
// Klasör app.getPath('userData')/boss_gecmisi/:
//   index.jsonl      karşılaşma başına özet satırı (eklemeli; aynı fk yeniden yazılırsa son satır geçerli, {fk, del:1} = silindi)
//   b-<fk>.json      seçili karşılaşmanın raporu (tıklanınca okunur; açılışta hiçbiri okunmaz)
// Yalnız yerel dosya; ağ yok. Bozuk satır/dosya atlanır, yazılamazsa bellekte kalır. Eski encounters/ klasörüne dokunulmaz.
const fs = require('fs');
const path = require('path');

const MAX_NAME = 64;
const COMPACT_MIN = 100; // indeksteki ölü satır (silinen / eskiyen) bu sayıyı ve canlı kayıt sayısını aşınca dosya baştan yazılır

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const safeFk = (fk) => String(fk).replace(/[^0-9A-Za-z_-]/g, '_').slice(0, 64);

// Dışarıdan (dosyadan) gelen özet satırını temizler; geçersizse null
function cleanSummary(r) {
  if (!r || typeof r !== 'object' || typeof r.fk !== 'string' || !r.fk || r.fk.length > 64) return null;
  const o = {
    fk: r.fk, at: num(r.at), boss: String(r.boss || '').slice(0, MAX_NAME), code: num(r.code), dur: Math.max(0, num(r.dur)),
    res: r.res === 'k' || r.res === 'w' ? r.res : '', n: Math.max(0, num(r.n) | 0), total: Math.max(0, num(r.total)), dps: Math.max(0, num(r.dps)),
    top: Math.max(0, num(r.top)), pb: r.pb ? 1 : 0, own: null,
  };
  if (r.own && typeof r.own === 'object') o.own = { d: Math.max(0, num(r.own.d)), dps: Math.max(0, num(r.own.dps)), r: Math.max(0, num(r.own.r) | 0) };
  return o.at > 0 ? o : null;
}

// meter.snapshot(...).enc (boss görünümü) → liste özeti
function summarize(fk, at, enc, pb) {
  if (!enc || !enc.boss) return null;
  const actors = Array.isArray(enc.actors) ? enc.actors : [];
  const i = actors.findIndex((a) => a && a.own);
  const me = i >= 0 ? actors[i] : null;
  return cleanSummary({
    fk, at, boss: enc.boss.name, code: enc.boss.code, dur: enc.boss.dur || enc.dur,
    res: enc.boss.killed ? 'k' : enc.boss.wiped ? 'w' : '', n: actors.length, total: enc.boss.total, dps: enc.boss.dps,
    top: actors.reduce((m, a) => Math.max(m, num(a && a.total)), 0), pb: !!(pb || enc.boss.pb),
    own: me ? { d: me.total, dps: me.dps, r: i + 1 } : null,
  });
}

// Bu boss savaşındaki ölümler (en çok 10; ad/sınıf/zaman çizelgesi). Opsiyonel alan: eski kayıtta yoktur, bozuksa boş liste döner.
const DEATH_MAX = 10;
function cleanDeaths(list) {
  if (!Array.isArray(list)) return [];
  const str = (v, n) => String(v == null ? '' : v).slice(0, n);
  const out = [];
  for (const d of list) {
    if (!d || typeof d !== 'object' || out.length >= DEATH_MAX) continue;
    out.push({
      player: typeof d.player === 'number' ? d.player : str(d.player, 64),
      name: str(d.name, MAX_NAME), cls: d.cls == null ? null : num(d.cls), own: !!d.own, t: num(d.t), at: num(d.at),
      killerName: d.killerName ? str(d.killerName, MAX_NAME) : null, skillName: d.skillName ? str(d.skillName, MAX_NAME) : null,
      fatalAmount: num(d.fatalAmount), total: num(d.total),
      taken: (Array.isArray(d.taken) ? d.taken : []).slice(0, 8).filter((k) => k && typeof k === 'object').map((k) => ({ name: str(k.name, MAX_NAME), amount: num(k.amount), hits: num(k.hits) })),
      timeline: (Array.isArray(d.timeline) ? d.timeline : []).slice(-30).filter((x) => x && typeof x === 'object').map((x) => ({ dt: num(x.dt), amount: num(x.amount), name: str(x.name, MAX_NAME), dot: !!x.dot, who: x.who ? str(x.who, MAX_NAME) : null, fatal: !!x.fatal })),
      deadFor: d.deadFor == null ? null : num(d.deadFor),
    });
  }
  return out;
}

// Raporun Boss sekmesinin kullandığı kısmı (iyileştirme/ölüm/canlı hedef alanları yazılmaz). Zaman çizelgesi olayları
// sözlükle sıkıştırılır: beceri adı ve simgesi her olayda tekrarlanmaz; get() aynı biçime geri açar.
function packDetail(enc) {
  const dict = []; // [ad, simge] listesi; olaylar sıra numarasıyla başvurur
  const seen = new Map();
  const keyOf = (code, name, icon) => {
    const k = String(code) + '|' + (name || '');
    if (!seen.has(k)) { seen.set(k, dict.length); dict.push([name || '', icon || null]); }
    return seen.get(k);
  };
  const rp = enc.replay || {};
  const casts = (rp.casts || []).map((c) => [c.t, c.actor, c.skill, c.target || null, c.kind || 0, keyOf(c.skill, c.name, c.icon)]);
  const cons = (rp.consumables || []).map((c) => [c.t, c.actor, c.itemSkill, keyOf(c.itemSkill, c.name, c.icon)]);
  const boss = { ...enc.boss }; delete boss.target;
  return {
    v: 1, boss, isBoss: true, start: enc.start, dur: enc.dur, total: enc.total, taken: enc.taken || 0, deaths: enc.deaths || 0,
    actors: enc.actors || [], dl: cleanDeaths(enc.deathList),
    replay: { duration: rp.duration, start: rp.start, stagger: rp.stagger || {}, dict, casts, consumables: cons },
  };
}
function unpackDetail(d) {
  if (!d || typeof d !== 'object' || !d.boss || typeof d.boss !== 'object' || !Array.isArray(d.actors)) return null;
  const rp = d.replay && typeof d.replay === 'object' ? d.replay : {};
  const dict = Array.isArray(rp.dict) ? rp.dict : [];
  const nm = (k) => (Number.isInteger(k) && Array.isArray(dict[k]) ? dict[k] : ['', null]);
  const arr = (x) => (Array.isArray(x) ? x.filter(Array.isArray) : []);
  return {
    boss: d.boss, isBoss: true, live: false, start: num(d.start), dur: num(d.dur), total: num(d.total), taken: num(d.taken), deaths: num(d.deaths),
    actors: d.actors.filter((a) => a && typeof a === 'object').map((a) => ({ ...a, skills: Array.isArray(a.skills) ? a.skills : [] })),
    replay: {
      duration: num(rp.duration), start: num(rp.start), stagger: rp.stagger && typeof rp.stagger === 'object' ? rp.stagger : {},
      casts: arr(rp.casts).map((c) => ({ t: c[0], actor: c[1], skill: c[2], target: c[3], kind: c[4], name: nm(c[5])[0], icon: nm(c[5])[1] })),
      consumables: arr(rp.consumables).map((c) => ({ t: c[0], actor: c[1], itemSkill: c[2], name: nm(c[3])[0], icon: nm(c[3])[1] })),
    },
    deathList: cleanDeaths(d.dl), heal: null, takenBy: null, target: null, focus: null,
  };
}
// Ondalıklar 4 basamağa yuvarlanır (pay/kritik oranları için yeterli; dosya küçülür)
const round = (_k, v) => (typeof v === 'number' && !Number.isInteger(v) && Number.isFinite(v) ? Math.round(v * 1e4) / 1e4 : v);

// Geçici dosyaya yazıp yerine taşır (yarım dosya kalmaz); taşıma olmazsa doğrudan yazar
function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  try { fs.writeFileSync(tmp, text); fs.renameSync(tmp, file); } catch {
    try { fs.rmSync(tmp, { force: true }); } catch { /* yok */ }
    fs.writeFileSync(file, text);
  }
}

class BossLog {
  constructor(dir) {
    this.dir = dir;
    this.index = path.join(dir, 'index.jsonl');
    this.items = new Map(); // fk → özet
    this.dead = 0;          // indeksteki geçersiz kalmış satır sayısı
    this.needNl = false;
  }

  load() {
    let text = '';
    try { text = fs.readFileSync(this.index, 'utf8'); } catch { text = ''; }
    this.items.clear();
    let lines = 0;
    for (const line of text.split('\n')) {
      if (!line.trim()) continue;
      lines++;
      try {
        const r = JSON.parse(line);
        if (r && r.del && typeof r.fk === 'string') { this.items.delete(r.fk); continue; }
        const s = cleanSummary(r);
        if (s) this.items.set(s.fk, s);
      } catch { /* bozuk satır atlanır */ }
    }
    this.dead = lines - this.items.size;
    this.needNl = text.length > 0 && !text.endsWith('\n');
    if (this.dead > COMPACT_MIN && this.dead > this.items.size) this.compact();
    return this.items.size;
  }

  _append(obj) {
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      fs.appendFileSync(this.index, (this.needNl ? '\n' : '') + JSON.stringify(obj) + '\n');
      this.needNl = false;
      return true;
    } catch { return false; }
  }

  // Biten (ya da birleşen) karşılaşmayı yazar; aynı fk varsa günceller (çift kayıt olmaz). Özet ya da null döner.
  save(rec) {
    if (!rec || typeof rec.fk !== 'string' || !rec.fk) return null;
    const s = summarize(rec.fk, rec.at, rec.enc, rec.pb);
    if (!s) return null;
    try {
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(path.join(this.dir, 'b-' + safeFk(s.fk) + '.json'), JSON.stringify(packDetail(rec.enc), round));
    } catch { /* rapor yazılamadı: özet yine listelenir, rapor açılmaz */ }
    if (this.items.has(s.fk)) this.dead++;
    this.items.set(s.fk, s);
    this._append(s);
    return s;
  }

  // Seçili karşılaşmanın raporu (yoksa / bozuksa null)
  get(fk) {
    if (typeof fk !== 'string' || !this.items.has(fk)) return null;
    try { return unpackDetail(JSON.parse(fs.readFileSync(path.join(this.dir, 'b-' + safeFk(fk) + '.json'), 'utf8'))); } catch { return null; }
  }

  remove(fk) {
    if (typeof fk !== 'string' || !this.items.has(fk)) return false;
    this.items.delete(fk);
    this.dead += 2;
    try { fs.rmSync(path.join(this.dir, 'b-' + safeFk(fk) + '.json'), { force: true }); } catch { /* sonra temizlenir */ }
    this._append({ fk, del: 1 });
    return true;
  }

  // İndeksi yalnız canlı kayıtlarla baştan yazar; kayıtsız kalmış rapor dosyalarını siler
  compact() {
    try {
      const rows = this.list().reverse().map((s) => JSON.stringify(s) + '\n').join('');
      fs.mkdirSync(this.dir, { recursive: true });
      writeAtomic(this.index, rows);
      this.dead = 0; this.needNl = false;
      const keep = new Set([...this.items.keys()].map((k) => 'b-' + safeFk(k) + '.json'));
      for (const f of fs.readdirSync(this.dir)) if (/^b-.*\.json$/.test(f) && !keep.has(f)) { try { fs.rmSync(path.join(this.dir, f), { force: true }); } catch { /* yok */ } }
      return true;
    } catch { return false; }
  }

  // Özetler yeniden eskiye
  list() { return [...this.items.values()].sort((a, b) => b.at - a.at); }
  get size() { return this.items.size; }
}

module.exports = { BossLog, summarize, cleanSummary, packDetail, unpackDetail, cleanDeaths, safeFk };
