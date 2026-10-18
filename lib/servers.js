'use strict';
// Sunucu numarası (0x0297 grup listesi, üye kaydındaki u32 >>> 16) → okunur etiket. Saf veri; ağ yok.
// Tablo data/servers.json (anahtar = numara, { region, name, race }). Tarayıcıda window.SERVERS, Node'da require('../lib/servers').
(function (root) {
  const REGION = { eu: 'EU', nae: 'NA-E', naw: 'NA-W', as: 'AS', la: 'LA' };
  let cached = null;

  function table() {
    if (cached) return cached;
    try { cached = JSON.parse(require('fs').readFileSync(require('path').join(__dirname, '..', 'data', 'servers.json'), 'utf8')); } catch { cached = {}; }
    return cached;
  }

  // Numara yok / 0 / geçersiz → '?'; tabloda yoksa 'S<numara>'; varsa 'Siel (EU)'. tbl verilmezse (Node) dosyadan okunur.
  function serverLabel(id, tbl) {
    const n = Number(id);
    if (!Number.isInteger(n) || n <= 0) return '?';
    const t = tbl || (typeof require === 'function' ? table() : {});
    const e = Object.prototype.hasOwnProperty.call(t, String(n)) ? t[String(n)] : null;
    if (!e || typeof e.name !== 'string' || !e.name) return 'S' + n;
    return e.name + ' (' + (REGION[e.region] || String(e.region || '').toUpperCase() || '?') + ')';
  }

  const api = { serverLabel, REGION };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.SERVERS = api;
})(typeof window !== 'undefined' ? window : globalThis);
