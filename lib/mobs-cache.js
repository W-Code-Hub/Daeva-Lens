'use strict';
// Kalıcı Canavar ve Boss Eşleştirme Önbelleği (Faz 2F)
// Konum: %APPDATA%\Daeva Lens\canavarlar.json
// Yalın kimlik verisi: code -> { name, maxHp, boss, dummy }, hpSignature -> { name, code, boss }

const fs = require('fs');
const path = require('path');

let mobsTable = {};
try {
  mobsTable = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'mobs.json'), 'utf8'));
} catch {}

function isGenuineBoss(code, maxHp, givenBossFlag = false) {
  const v = mobsTable[code];
  if (v !== undefined) {
    if (Array.isArray(v) && (v[1] & 1)) return true; // Resmi oyun verisinde boss
    if (maxHp && maxHp >= 5000000) return true;      // 5M+ dev raid boss
    return false; // mobs.json'da var, resmi boss değil ve canı <5M -> KESİNLİKLE BOSS DEĞİL!
  }
  // mobs.json'da bulunmayan canavarlar için:
  if (maxHp && maxHp >= 5000000) return true;
  if (givenBossFlag && maxHp && maxHp >= 1000000) return true;
  return false;
}

class MobsCache {
  constructor(filePath = null, opts = {}) {
    this.filePath = filePath;
    this.saveDebounceMs = opts.saveDebounceMs !== undefined ? opts.saveDebounceMs : 800;
    this.loadDefaults = opts.loadDefaults !== undefined ? opts.loadDefaults : true;
    this.byCode = new Map();       // code (number) -> { code, name, maxHp, boss, dummy }
    this.hpSignature = new Map();  // maxHp (number) -> { code, name, boss } veya 'conflict'
    this.saveTimer = null;
    this.dirty = false;
    this.defaults = new Map();     // B-16b: dahili veritabanının yüklendiği hali (diske sadece farklar yazılır)
    this.writing = null;           // süren arka plan yazımı (Promise)
    if (this.filePath || this.loadDefaults) {
      this.load();
    }
  }

  load() {
    try {
      // 1. Varsa dahili başlangıç verisini yükle (önceden doldurulmuş canavar veritabanı)
      const defaultPath = path.join(__dirname, '..', 'data', 'default-mobs-cache.json');
      if (this.loadDefaults && fs.existsSync(defaultPath)) {
        try {
          const defRaw = JSON.parse(fs.readFileSync(defaultPath, 'utf8'));
          if (defRaw && defRaw.byCode && typeof defRaw.byCode === 'object') {
            for (const [codeStr, entry] of Object.entries(defRaw.byCode)) {
              const code = Number(codeStr);
              if (code > 0 && entry && entry.name && !entry.name.startsWith('Monster #') && entry.name !== '???') {
                const maxHp = Number(entry.maxHp) || 0;
                const isBoss = isGenuineBoss(code, maxHp, !!entry.boss);
                const rec = {
                  code,
                  name: entry.name,
                  maxHp,
                  boss: isBoss,
                  dummy: !!entry.dummy,
                  lastSeen: entry.lastSeen || null
                };
                this.byCode.set(code, rec);
                this.defaults.set(code, { ...rec });
              }
            }
          }
        } catch {}
      }

      // 2. Ardından kullanıcının yerel canavarlar.json dosyasını yükle (varsa)
      if (this.filePath && fs.existsSync(this.filePath)) {
        const raw = JSON.parse(fs.readFileSync(this.filePath, 'utf8'));
        if (raw && raw.byCode && typeof raw.byCode === 'object') {
          for (const [codeStr, entry] of Object.entries(raw.byCode)) {
            const code = Number(codeStr);
            if (code > 0 && entry && entry.name && !entry.name.startsWith('Monster #') && entry.name !== '???') {
              const defEntry = this.byCode.get(code);
              const maxHp = (defEntry && defEntry.maxHp > 0) ? defEntry.maxHp : (Number(entry.maxHp) || 0);
              const lastSeen = entry.lastSeen || (defEntry ? defEntry.lastSeen : null);
              const isBoss = isGenuineBoss(code, maxHp, defEntry ? defEntry.boss : !!entry.boss);
              this.byCode.set(code, {
                code,
                name: entry.name || (defEntry ? defEntry.name : ''),
                maxHp,
                boss: isBoss,
                dummy: !!entry.dummy,
                lastSeen
              });
            }
          }
        }
      }
    } catch {
      // Dosya bozuksa veya yoksa temiz başla
    }
    this.rebuildHpSignatures();
  }

  rebuildHpSignatures() {
    this.hpSignature.clear();
    for (const entry of this.byCode.values()) {
      if (!entry.maxHp || entry.maxHp <= 0) continue;
      // Antrenman kuklaları asla boss ve can imzası olarak kaydedilmez
      if (entry.dummy) continue;
      if (!entry.name || entry.name.startsWith('Monster #') || entry.name === '???') continue;

      const hp = Number(entry.maxHp);
      const existing = this.hpSignature.get(hp);
      if (!existing) {
        this.hpSignature.set(hp, {
          code: entry.code,
          name: entry.name,
          boss: entry.boss
        });
      } else if (existing === 'conflict') {
        // Zaten çakışma olarak işaretlenmiş
      } else if (existing.name !== entry.name) {
        // AYNI HP'ye sahip iki farklı isimli mob var!
        // Çakışma olarak işaretle: asla yanlış tahmin yapılmaz.
        this.hpSignature.set(hp, 'conflict');
      }
    }
  }

  findByCode(code) {
    if (!code) return null;
    return this.byCode.get(Number(code)) || null;
  }

  findByHp(maxHp) {
    if (!maxHp || maxHp <= 0) return null;
    const match = this.hpSignature.get(Number(maxHp));
    if (!match || match === 'conflict') return null;
    return match;
  }

  learn(code, info = {}) {
    const c = Number(code);
    if (!c || c <= 0) return null;

    let existing = this.byCode.get(c);
    let changed = false;

    const hasValidNewName = info.name &&
      !info.name.startsWith('Monster #') &&
      info.name !== '???' &&
      info.name !== 'Target' &&
      info.name !== 'Hedef';

    const name = (hasValidNewName || info.forceName) ? info.name : (existing ? existing.name : null);
    const maxHp = (info.maxHp && info.maxHp > 0) ? Number(info.maxHp) : (existing ? existing.maxHp : 0);
    const dummy = info.dummy !== undefined ? !!info.dummy : (existing ? existing.dummy : false);
    const rawBoss = info.boss !== undefined ? !!info.boss : (existing ? existing.boss : false);
    const boss = isGenuineBoss(c, maxHp, rawBoss);
    const lastSeen = info.lastSeen || (existing ? existing.lastSeen : null) || new Date().toISOString();

    if (!existing) {
      if (name) {
        existing = {
          code: c,
          name,
          maxHp,
          boss,
          dummy,
          lastSeen
        };
        this.byCode.set(c, existing);
        changed = true;
      }
    } else {
      if (name && (existing.name !== name || info.forceName)) {
        existing.name = name;
        changed = true;
      }
      if (maxHp > 0 && existing.maxHp !== maxHp) {
        existing.maxHp = maxHp;
        changed = true;
      }
      if (existing.boss !== boss) {
        existing.boss = boss;
        changed = true;
      }
      if (dummy && !existing.dummy) {
        existing.dummy = true;
        changed = true;
      }
      if (info.lastSeen && existing.lastSeen !== info.lastSeen) {
        existing.lastSeen = info.lastSeen;
        changed = true;
      }
    }

    if (changed) {
      this.dirty = true;
      this.rebuildHpSignatures();
      this.scheduleSave();
    }
    return existing;
  }

  scheduleSave() {
    if (!this.filePath) return;
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.saveDebounceMs);
  }

  // B-16b: Diske sadece kullanıcının öğrendiği/değiştirdiği kayıtlar yazılır (dahili veritabanıyla aynı
  // olanlar yazılmaz; açılışta zaten oradan yüklenir). Girintisiz JSON. hpSignature yazılmaz:
  // load() onu byCode'dan yeniden kurar. Eski tam dosyalar da aynen yüklenir.
  serialize() {
    const byCodeObj = {};
    for (const [c, val] of this.byCode.entries()) {
      const d = this.defaults.get(c);
      if (d && d.name === val.name && d.maxHp === val.maxHp && d.boss === val.boss && d.dummy === val.dummy &&
          (d.lastSeen || null) === (val.lastSeen || null)) continue;
      byCodeObj[c] = {
        name: val.name,
        maxHp: val.maxHp,
        boss: val.boss,
        dummy: val.dummy,
        ...(val.lastSeen ? { lastSeen: val.lastSeen } : {})
      };
    }
    return JSON.stringify({ updatedAt: new Date().toISOString(), byCode: byCodeObj });
  }

  // Dövüş sırasında: ana thread'i bekletmeden arka planda yazar (geçici dosya + ad değiştirme).
  save() {
    if (!this.filePath || !this.dirty) return Promise.resolve();
    if (this.writing) { this.writeAgain = true; return this.writing; }
    const fsp = fs.promises;
    const file = this.filePath;
    const data = this.serialize();
    this.dirty = false;
    this.writing = (async () => {
      try {
        await fsp.mkdir(path.dirname(file), { recursive: true });
        // Ayrı geçici ad: kapanıştaki senkron yazımla aynı dosyaya karışmasın
        await fsp.writeFile(file + '.tmp-arka', data, 'utf8');
        await fsp.rename(file + '.tmp-arka', file);
      } catch {
        this.dirty = true; // sonraki kayıtta tekrar denensin
      }
    })().finally(() => {
      this.writing = null;
      if (this.writeAgain) { this.writeAgain = false; this.save(); }
    });
    return this.writing;
  }

  // Kapanışta: senkron yazar (süreç bitmeden diske insin).
  saveSync() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.filePath || (!this.dirty && !this.writeAgain)) return;
    try {
      const dir = path.dirname(this.filePath);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(this.filePath + '.tmp', this.serialize(), 'utf8');
      fs.renameSync(this.filePath + '.tmp', this.filePath);
      this.dirty = false;
      this.writeAgain = false;
    } catch {
      // Hata durumunda işlemi engelleme
    }
  }

  // Bekleyen zamanlayıcıyı iptal eder (testler ve kapanış için)
  dispose() {
    if (this.saveTimer) { clearTimeout(this.saveTimer); this.saveTimer = null; }
  }
}

module.exports = { MobsCache };
