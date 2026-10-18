'use strict';
// Beceri simgeleri: assets/skill_icons/ içinde pakete gömülü (oyunun CDN'ine istek atılmaz). Adlandırma RATmeter'dan (GPL-3).
// Arayüz sayfaları ui/ altında olduğu için yol ui/'ye göredir; dosya yoksa simge yoktur (null).
const fs = require('fs');
const path = require('path');

const DIR = path.join(__dirname, '..', 'assets', 'skill_icons');
const REL = '../assets/skill_icons';
const CLASS = { 11: 'GL', 12: 'TE', 13: 'AS', 14: 'RA', 15: 'SO', 16: 'EL', 17: 'CL', 18: 'CH', 19: 'GT' };

let overrides = {};
try { overrides = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'skill_icons.json'), 'utf8')); } catch { /* yok */ }

const cache = new Map();
function iconUrl(code) {
  if (cache.has(code)) return cache.get(code);
  const stem = compute(Number(code));
  const r = stem && fs.existsSync(path.join(DIR, stem + '.png')) ? `${REL}/${stem}.png` : null;
  cache.set(code, r);
  return r;
}

function compute(c) {
  if (!(c > 0)) return null;
  const s = String(c);
  if (c > 999) {
    const o = overrides[s.slice(0, 4)];
    if (o) return o;
  }
  if (c >= 3000000 && c <= 3099999) {
    // teostone: 30Q II.. -> Icon_Item_Usable_Godstone_WP_r_<hex>
    const icon = parseInt(s.slice(5, 7), 10);
    if (!(icon > 0)) return null;
    return `Icon_Item_Usable_Godstone_WP_r_${icon.toString(16).padStart(3, '0')}`;
  }
  const code = s.padStart(8, '0').slice(0, 8);
  const cls = CLASS[code.slice(0, 2)];
  if (!cls) return null;
  if (code.slice(2, 6) === '0000' && code.slice(6) !== '00') return null;
  let sub = parseInt(code.slice(2, 4), 10);
  let suffix = '';
  if (sub >= 70) { suffix = 'Passive_'; sub -= 70; }
  return `ICON_${cls}_SKILL_${suffix}${String(sub).padStart(3, '0')}`;
}

module.exports = { iconUrl };
