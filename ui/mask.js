'use strict';
// Yayıncı modu: oyuncu adlarını yerel takma adlarla maskeler. YALNIZ GÖSTERİM içindir; kayıtlı veriye,
// ölçüm verisine ve oyuncu puanlama kayıtlarına (lib/ratings.js) dokunmaz. Saf veri modeli (DOM yok).
// Tarayıcıda window.MASK, Node'da require('../ui/mask').
(function (root) {
  // Sınıf kimliği → rol. Templar tank, Cleric / Chanter şifacı; kalanlar sınıf adıyla anılır.
  const ROLE_OF = { 12: 'Tank', 17: 'Healer', 18: 'Healer' };
  const CLASS_OF = { 11: 'Gladiator', 13: 'Assassin', 14: 'Ranger', 15: 'Sorcerer', 16: 'Elementalist', 19: 'Brawler' };
  const MAX_ENTRIES = 300; // uzun oturumda harita şişmesin

  function create() {
    const byKey = new Map();   // anahtar → { base, label, generic }
    const counters = new Map(); // taban ad → sayaç

    const baseOf = (cls) => ROLE_OF[cls] || CLASS_OF[cls] || null;
    const next = (base) => { const n = (counters.get(base) || 0) + 1; counters.set(base, n); return base + ' ' + n; };

    return {
      // key: kararlı kimlik (tercihen küçük harfli ad); cls: sınıf kimliği (bilinmiyorsa null)
      // meLabel: kendi satırın için gösterilecek metin (ör. 'Ben'); isMe ise her zaman bu döner
      alias(key, cls, isMe, meLabel) {
        if (isMe) return meLabel || 'Me';
        const k = String(key === null || key === undefined ? '' : key).toLowerCase();
        let e = byKey.get(k);
        const base = baseOf(Number(cls));
        if (!e) {
          // Dolunca haritayı sıfırlamak yerine en eski girişi at: sayaçlar korunur, numaralar oturum boyunca çakışmaz
          if (byKey.size >= MAX_ENTRIES) byKey.delete(byKey.keys().next().value);
          const b = base || 'Player';
          e = { base: b, label: next(b), generic: !base };
          byKey.set(k, e);
        }
        // Etiket bir kez atandıktan sonra DEĞİŞMEZ: sınıf sonradan öğrenilse bile tüm yüzeylerde aynı kalır
        byKey.delete(k); byKey.set(k, e); // en son kullanılan sona (LRU)
        return e.label;
      },
      // Atama yapmadan mevcut etiketi verir (yoksa null); sayaç ilerletmez
      peek(key) { const e = byKey.get(String(key === null || key === undefined ? '' : key).toLowerCase()); return e ? e.label : null; },
      reset() { byKey.clear(); counters.clear(); },
      get size() { return byKey.size; },
    };
  }

  // Ad → tablo anahtarı ('n:' öneki 'constructor' gibi adların nesne özellikleriyle çakışmasını önler)
  const keyOf = (name) => 'n:' + String(name).toLowerCase();

  // Ana süreç: state'teki TÜM oyuncu adlarını (satırlar, ölümler, boss hedefi, grup) maskeden geçirip { anahtar: etiket } tablosu üretir.
  // Sınıfı bilinen girişler önce işlenir; böylece ilk atama mümkünse sınıfa göre yapılır.
  function buildTable(masker, st, charName) {
    const known = [];
    const bare = [];
    const walk = (o, depth) => {
      if (!o || typeof o !== 'object' || depth > 5) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (typeof o.name === 'string' && o.name && 'cls' in o) known.push(o);
      for (const k in o) { const v = o[k]; if (v && typeof v === 'object') walk(v, depth + 1); }
    };
    if (st) {
      walk(st.enc, 0); walk(st.bossEnc, 0); walk(st.deaths, 0);
      for (const e of [st.enc, st.bossEnc]) if (e && e.boss && typeof e.boss.target === 'string' && e.boss.target) bare.push(e.boss.target);
      const p = st.view && st.view.party;
      if (p && p.members) for (const m of p.members) if (typeof m === 'string' && m) bare.push(m);
    }
    const me = charName ? String(charName).toLowerCase() : '';
    const tbl = {};
    const put = (name, cls, own) => {
      const k = keyOf(name);
      if (k in tbl) return;
      tbl[k] = masker.alias(name, cls, !!own || (!!me && String(name).toLowerCase() === me), 'Me');
    };
    for (const o of known) put(o.name, o.cls, o.own === true);
    for (const n of bare) put(n, null, false);
    return tbl;
  }

  // Renderer: ana sürecin gönderdiği tabloyu okuyan, MASK.create() ile aynı alias(...) arayüzü. Tabloda olmayan ad
  // yerel etiket almaz ('…' gösterilir); tablo bir sonraki state'te gelir.
  function createClient() {
    let table = {};
    return {
      apply(t) { if (t && typeof t === 'object') table = t; },
      alias(key, cls, isMe, meLabel) {
        if (isMe) return meLabel || 'Me';
        const lab = table[keyOf(key === null || key === undefined ? '' : key)];
        if (!lab) return '…';
        return lab === 'Me' ? (meLabel || 'Me') : lab;
      },
      reset() { table = {}; },
      get size() { return Object.keys(table).length; },
    };
  }

  const api = { create, createClient, buildTable, keyOf, ROLE_OF, CLASS_OF };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.MASK = api;
})(typeof window !== 'undefined' ? window : globalThis);
