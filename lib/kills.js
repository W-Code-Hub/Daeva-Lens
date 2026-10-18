'use strict';
// Canavar kodu/adı ve can takibi (hedef barı ve boss tanıma için)
const { mobInfo } = require('./mobs');

function pruneMap(map, targetSize) {
  const toDelete = map.size - targetSize;
  if (toDelete <= 0) return;
  let count = 0;
  for (const key of map.keys()) {
    map.delete(key);
    if (++count >= toDelete) break;
  }
}

function pruneSet(set, targetSize) {
  const toDelete = set.size - targetSize;
  if (toDelete <= 0) return;
  let count = 0;
  for (const item of set) {
    set.delete(item);
    if (++count >= toDelete) break;
  }
}

class Kills {
  constructor(opts = {}) {
    this.mobsCache = opts.mobsCache || null;
    this.mobs = new Map();   // varlık -> kod
    this.hp = new Map();     // varlık -> { cur, max, dead }
    this.dead = new Set();   // yakın zamanda ölen varlık id'leri (mükerrer ölüm engelleme)
  }

  spawn(id, code, maxHp, curHp) {
    if (this.dead.has(id)) this.dead.delete(id);
    this.mobs.set(id, code);
    // Sürüm 2.0: doğma paketi anlık canı da taşır (yarı canlı görünen canavar)
    if (maxHp > 0) this.hp.set(id, { cur: curHp > 0 && curHp <= maxHp ? curHp : maxHp, max: maxHp });
    // ölen canavarın adı geçmiş dövüşlerde görünmeye devam etsin; sadece çok büyürse eskileri at
    if (this.mobs.size > 20000) pruneMap(this.mobs, 10000);
    if (this.hp.size > 5000) pruneMap(this.hp, 2000);
    if (this.dead.size > 5000) pruneSet(this.dead, 2500);
  }

  setHp(id, hp, max) {
    const h = this.hp.get(id);
    if (h) {
      h.cur = hp;
      if (max > 0) h.max = max;
      if (hp > h.max) h.max = hp;
    } else {
      this.hp.set(id, { cur: hp, max: max > 0 && max >= hp ? max : hp });
      if (this.hp.size > 5000) pruneMap(this.hp, 2000);
    }
  }

  markDead(id) {
    if (this.dead.has(id)) return null;
    this.dead.add(id);

    const h = this.hp.get(id);
    if (h) {
      h.cur = 0;
      h.dead = true;
    }

    let code = this.mobs.get(id);
    if (!code && h && h.max > 0 && this.mobsCache) {
      const byHp = this.mobsCache.findByHp(h.max);
      if (byHp && byHp.code) code = byHp.code;
    }

    return code || null;
  }

  markDespawn(id) {
    const h = this.hp.get(id);
    if (h && !h.dead) {
      this.hp.delete(id);
    }
  }

  info(id) {
    const code = this.mobs.get(id);
    let res = null;
    if (code !== undefined) {
      res = mobInfo(code, this.mobsCache);
    }
    const isBadName = !res || !res.name || res.name === '???' || res.name.startsWith('Monster #');
    if (isBadName && this.mobsCache) {
      if (code) {
        const mc = this.mobsCache.findByCode(code);
        if (mc && mc.name && mc.name !== '???' && !mc.name.startsWith('Monster #')) {
          return { ...(res || {}), ...mc, code };
        }
      }
      const h = this.hp.get(id);
      if (h && h.max > 0) {
        const byHp = this.mobsCache.findByHp(h.max);
        if (byHp && byHp.name && byHp.name !== '???' && !byHp.name.startsWith('Monster #')) {
          return { ...(res || {}), ...byHp, code: (res && res.code) ? res.code : byHp.code };
        }
      }
    }
    return res;
  }
}

module.exports = { Kills, pruneMap };
