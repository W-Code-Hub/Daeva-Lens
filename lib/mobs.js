'use strict';
// Canavar adları: data/mobs.json (RATmeter oyun verisi, GPL-3; 9 869 canavar).
// Biçim: kod -> "Ad" ya da [ "Ad", bayrak ] (bayrak &1 = boss, &2 = antrenman kuklası)
const fs = require('fs');
const path = require('path');

let table = {};
try { table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'mobs.json'), 'utf8')); } catch { /* yok */ }

function mobInfo(code, mobsCache = null) {
  if (mobsCache) {
    const cached = mobsCache.findByCode(code);
    if (cached) return cached;
  }
  const v = table[code];
  if (v === undefined) return null;
  return Array.isArray(v) ? { code, name: v[0], boss: !!(v[1] & 1), dummy: !!(v[1] & 2) } : { code, name: v, boss: false, dummy: false };
}

// 0x4136 (varlık göründü), Sürüm 2.0: tarama yok, alanlar sırayla okunur. 58 kayıttaki 7.537 çerçevenin hepsi okundu.
//   id(vi) b0(u8) b1(u8) b2(u8) [b2&1: adUzunluk(u8) ad(utf8)] kod(u32) bayrak(u8) 02 x y z w(f32) u16
//   [bayrak&8: 12 bayt (hedef nokta)] canlı(u8) anlıkCan(vi) azamiCan(vi) ...
// Eski 80 baytlık desen taraması 139 çerçevede yanlış can okuyordu (ör. 67) ve data/mobs.json'da olmayan 332 varlığı atıyordu.
// b2&1 ile gelen ad, varlığın SAHİBİNİN karakter adıdır: bu varlık bir oyuncu çağrısı / tuzağıdır (855 vuruş eşleşmesi).
function parseSpawn(body, readVarint) {
  const v = readVarint(body, 0);
  if (!v) return null;
  let i = v[1];
  if (i + 3 > body.length) return null;
  const b2 = body[i + 2];
  i += 3;
  let owner = null;
  if (b2 & 1) {
    const n = body[i++];
    if (!n || i + n > body.length) return null;
    owner = decodeName(body.subarray(i, i + n));
    i += n;
  }
  if (i + 6 > body.length) return null;
  const code = body.readUInt32LE(i);
  const fl = body[i + 4];
  if (body[i + 5] !== 2 || code <= 0 || code > 0xffffff) return null;
  i += 6 + 18 + (fl & 8 ? 12 : 0);
  if (i + 1 > body.length) return null;
  const alive = body[i++];
  if (alive > 1) return null;
  const c = readVarint(body, i);
  const m = c ? readVarint(body, c[1]) : null;
  let curHp = c ? c[0] : 0;
  let maxHp = m ? m[0] : 0;
  if (maxHp > 4000000000 || curHp > maxHp) { curHp = 0; maxHp = 0; }
  return { id: v[0], code, maxHp, curHp, alive: alive === 1, ...(owner ? { owner } : {}) };
}

function decodeName(b) {
  const s = b.toString('utf8').replace(/[^\p{L}\p{N}_\- 丶]/gu, '').trim();
  return s || null;
}

module.exports = { mobInfo, parseSpawn };
