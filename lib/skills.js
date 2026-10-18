'use strict';
// Beceri adları: data/skills.json (RATmeter oyun verisi, GPL-3)
const fs = require('fs');
const path = require('path');

let table = {};
try { table = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'skills.json'), 'utf8')); } catch { /* yok */ }

function skillName(code) {
  const c = Number(code);
  const tries = [c, c - (c % 10), c - (c % 100), c - (c % 10000), c * 10, c * 10 + 1];
  if (c >= 3000000 && c <= 3099999) tries.unshift(Math.floor(c / 10) * 10);
  for (const k of tries) if (table[k]) return table[k];
  return 'Skill ' + c;
}


module.exports = { skillName };
