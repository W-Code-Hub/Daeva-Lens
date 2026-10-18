'use strict';
// Sınıf bulma (pickOwnClass), sınıfın beceri seti (classSkills) ve bekleme yardımcıları.
// Saf veri modeli (DOM yok, dosya okumaz). Tarayıcıda window.KEYSKILLS, Node'da require('../ui/keyskills').
(function (root) {
  const CLASS_IDS = [11, 12, 13, 14, 15, 16, 17, 18, 19];
  const CLASS_NAMES = { 11: 'Gladiator', 12: 'Templar', 13: 'Assassin', 14: 'Ranger', 15: 'Sorcerer', 16: 'Elementalist', 17: 'Cleric', 18: 'Chanter', 19: 'Brawler' };

  const classOf = (base) => Math.floor(base / 1e6);
  const groupOf = (base) => Math.floor(base / 10000) % 100;
  const validClass = (c) => (CLASS_IDS.includes(Number(c)) ? Number(c) : null);
  function isActiveClassSkill(base, cls) {
    return Number.isInteger(base) && base > 0 && base % 10000 === 0 && classOf(base) === Number(cls) &&
      groupOf(base) >= 1 && groupOf(base) <= 69;
  }

  // Sınıfın aktif beceri seti. table = data/skills.json (kod → ad). Bir grubun adı: tam taban kodu varsa o,
  // yoksa gruptaki en küçük kod ("Deadshot - Lv.1" gibi seviye ekleri atılır).
  function classSkills(cls, table, iconOf) {
    cls = validClass(cls);
    if (!cls || !table) return [];
    const groups = new Map();
    for (const k of Object.keys(table)) {
      const c = Number(k);
      if (!(c > 0)) continue;
      const base = Math.floor(c / 10000) * 10000;
      if (!isActiveClassSkill(base, cls)) continue;
      const g = groups.get(base);
      if (!g || c === base || (g.code !== base && c < g.code)) groups.set(base, { code: c, name: table[k] });
    }
    return [...groups].sort((a, b) => a[0] - b[0]).map(([base, g]) => ({
      base,
      name: String(g.name || base).replace(/\s*-\s*(Lv\.?\s*\d+|Max)$/i, '').trim(),
      icon: iconOf ? iconOf(base) : null,
    }));
  }

  // ---- Kendi sınıfımız (kullanıcı 2026-10-11 06:23: "kişinin karakterini hatırlaması lazım") ----
  // Sınıf karakter adına göre saklanır: { "Player1": 14 }. Sıra: canlı bulunan sınıf (dövüşte, B-31 oylaması)
  // > bu karakter için hatırlanan > kayıtlı becerilerin çoğunluğu (sadece ilk sefer, en az 3 beceri).
  // Dönen { cls, remember }: remember doluysa ana süreç charClasses'a yazar.
  function normCharClasses(raw) {
    const out = {};
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
    for (const [n, c] of Object.entries(raw).slice(0, 50)) if (typeof n === 'string' && n.length <= 40 && validClass(c)) out[n] = Number(c);
    return out;
  }
  function pickOwnClass(o) {
    const live = validClass(o.live);
    const name = typeof o.charName === 'string' && o.charName ? o.charName : null;
    const mem = name && o.charClasses ? validClass(o.charClasses[name]) : null;
    if (live) return { cls: live, remember: name && mem !== live ? live : null };
    if (mem) return { cls: mem, remember: null };
    const count = {};
    for (const b of o.seenBases || []) { const c = validClass(classOf(Number(b))); if (c) count[c] = (count[c] || 0) + 1; }
    const best = Object.entries(count).sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] >= 3) { const c = Number(best[0]); return { cls: c, remember: name ? c : null }; }
    return { cls: null, remember: null };
  }

  // ---- Tuş üstü bekleme süresi (5.4) ----
  // Ana süreç: sadece atanmış becerilerin beklemedeki olanları { taban: [başlangıç, hazır] }.
  // cdOf(base) → { startAt, readyAt } | null. İmza değişmedikçe pencereye bir şey gönderilmez.
  function cdPayload(bases, cdOf, now) {
    const out = {};
    for (const base of bases) {
      const s = cdOf(base);
      if (s && s.readyAt > now && s.readyAt > s.startAt) out[base] = [s.startAt, s.readyAt];
    }
    return out;
  }
  function cdSig(p) {
    return Object.keys(p).sort().map((k) => k + ':' + p[k][0] + ':' + p[k][1]).join(',');
  }
  // Pencere: kalan süre yazısı. 60 sn ve üstü dakika (2m), 10–59 sn tam saniye (18s), 10 sn altı ondalıklı (4.2s).
  function fmtLeft(ms) {
    if (!Number.isFinite(ms) || ms <= 0) return '';
    const s = ms / 1000;
    if (s >= 60) return Math.ceil(s / 60) + 'm';
    if (s >= 10) return Math.ceil(s) + 's';
    return (Math.ceil(s * 10) / 10).toFixed(1) + 's';
  }
  // Perde: kalan oranı (1 = yeni başladı, 0 = bitti). Saat yönünde açılan kısım = 1 - kalan.
  function cdView(entry, now) {
    if (!entry || !Array.isArray(entry) || entry.length < 2) return null;
    const startAt = Number(entry[0]);
    const readyAt = Number(entry[1]);
    const curNow = Number(now) || Date.now();
    if (!Number.isFinite(startAt) || !Number.isFinite(readyAt)) return null;
    const left = readyAt - curNow;
    if (!Number.isFinite(left) || left <= 0) return { done: true, left: 0, frac: 0, text: '' };
    const total = Math.max(1, readyAt - startAt);
    if (!Number.isFinite(total) || total <= 0) return { done: true, left: 0, frac: 0, text: '' };
    const rawFrac = left / total;
    const frac = Number.isFinite(rawFrac) ? Math.max(0, Math.min(1, rawFrac)) : 0;
    return { done: false, left, frac, text: fmtLeft(left) };
  }

  const api = { normCharClasses, pickOwnClass, CLASS_IDS, CLASS_NAMES, validClass, isActiveClassSkill, classSkills, cdPayload, cdSig, fmtLeft, cdView };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.KEYSKILLS = api;
})(typeof window !== 'undefined' ? window : globalThis);
