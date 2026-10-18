'use strict';
// Vurgu renkleri (Aion2 Key Overlay'deki temalar): panel ve çekmece birlikte kullanır
const THEMES = {
  gold: { name: 'Gold (Aion)', rgb: '242, 179, 61' },
  ice: { name: 'Ice Blue', rgb: '94, 196, 255' },
  purple: { name: 'Purple', rgb: '177, 132, 255' },
  neon: { name: 'Neon Green', rgb: '96, 240, 150' },
};
// Hex (#RRGGBB veya #RGB) -> "r, g, b" string
function hexToRgb(hex) {
  if (!hex || typeof hex !== 'string') return null;
  const h = hex.replace('#', '').trim();
  if (h.length === 3) {
    const r = parseInt(h[0] + h[0], 16);
    const g = parseInt(h[1] + h[1], 16);
    const b = parseInt(h[2] + h[2], 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return `${r}, ${g}, ${b}`;
  }
  if (h.length === 6) {
    const r = parseInt(h.substring(0, 2), 16);
    const g = parseInt(h.substring(2, 4), 16);
    const b = parseInt(h.substring(4, 6), 16);
    if (isNaN(r) || isNaN(g) || isNaN(b)) return null;
    return `${r}, ${g}, ${b}`;
  }
  return null;
}

// "r, g, b" string -> "#RRGGBB"
function rgbToHex(rgbStr) {
  if (!rgbStr || typeof rgbStr !== 'string') return '#f2b33d';
  const parts = rgbStr.split(',').map((x) => parseInt(x.trim(), 10));
  if (parts.length < 3 || parts.some(isNaN)) return '#f2b33d';
  const toHex = (n) => Math.max(0, Math.min(255, n)).toString(16).padStart(2, '0');
  return `#${toHex(parts[0])}${toHex(parts[1])}${toHex(parts[2])}`;
}

// Ayarlardan vurgu rengini çözer (main.js accentRgb bunu kullanır; test 21 de bunu dener)
function resolveAccent(settings) {
  if (settings && settings.accent === 'custom' && settings.customAccentRgb) return settings.customAccentRgb;
  if (settings && THEMES[settings.accent]) return THEMES[settings.accent].rgb;
  return THEMES.gold.rgb;
}

// Genel kısayollar (Faz 4.5): varsayılanlar + kullanıcının değiştirdikleri
const DEFAULT_SHORTCUTS = Object.freeze({
  toggle: 'CommandOrControl+Shift+D',
  clickThrough: 'CommandOrControl+Shift+L',
  reset: 'CommandOrControl+Shift+R',
  posLock: 'CommandOrControl+Shift+K',
});
function mergeShortcuts(...parts) {
  return Object.assign({}, DEFAULT_SHORTCUTS, ...parts.filter((p) => p && typeof p === 'object'));
}

module.exports = { THEMES, hexToRgb, rgbToHex, resolveAccent, DEFAULT_SHORTCUTS, mergeShortcuts };
