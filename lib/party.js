'use strict';
// Parti durumu izleyicisi: "partideyim / parti bitti" kararını verir. Saf mantık; ağ yok, dosya yok, zaman dışarıdan gelir.
//
// Kayıtlarla (2026-10-10..14, 6 oturum) doğrulanan kurallar (ayrıntı: PROTOKOL.md "Parti üyeliği"):
//  - Gerçek kadro 0x0092 paketidir (≥2 kişi). Zindana girişte bölge yüklemesiyle birlikte (0..4 sn) gelir; üye değişince
//    güncel kadro yeniden gelir. Kadroda yalnız ben varsam (184 bayt) parti yoktur.
//  - 0x0297 "zindan ilanı"dır, üyelik kanıtı DEĞİL (partiden ayrılınca gelmez, bayat kalır): yalnız ad/sınıf/GS/CP bilgisi.
//  - Üye durum akışı 0x1c92 partideyken sürekli gelir, ayrılınca 5 sn içinde kesilir.
//  - Ayrılma/dağılma: 0x1d97 ya da 0x1f93 (ardından 0x1c92 hiç gelmedi).
//  - Zindandan çıkışta bölge yüklemesi olur ama kadro paketi gelmez → bölge yüklemesinden sonra 10 sn kadro yoksa parti bitti.
const ZONE_ROSTER_WAIT_MS = 10000; // bölge yüklemesinden sonra kadro beklenen süre (girişlerde 0..4 sn)
const INSTANCE_ROSTER_MS = 8000;   // kadro bölge yüklemesinden en çok bu kadar sonra gelirse "gerçek zindan içi"
const QUIET_MS = 150000;           // yedek: kadro da durum akışı da bu kadar süredir yok
const STATE_WINDOW_MS = 30000;     // "0x1c92 son 30 sn" = partideyim (kadro görülmediyse)
const LEAVE_GRACE_MS = 3000;       // ayrılmadan hemen sonra uçuştaki durum paketleri partiyi diriltmesin
const FINDER_FRESH_MS = 120000;    // kadro yokken zindan içi sayılması için ilanın en çok bu kadar yeni olması

class PartyTracker {
  // opts: now(), onChange(durum), nameOfDbid(dbid) → ad | undefined, isOwnDbid(dbid) → bool
  constructor(opts = {}) {
    this.now = opts.now || (() => Date.now());
    this.onChange = opts.onChange || (() => {});
    this.nameOfDbid = opts.nameOfDbid || (() => undefined);
    this.isOwnDbid = opts.isOwnDbid || (() => false);
    this.live = false;
    this.via = null;        // 'roster' | 'state'
    this.since = 0;
    this.rosterAt = 0;
    this.stateAt = 0;
    this.zoneAt = 0;
    this.leaveAt = -1e12;
    this.instance = false;
    this.names = new Set();
    this.size = 0;
    this.finder = null;     // { at, dungeon, count }
    this.stateDb = new Map(); // küresel kimlik → son görülme
    this.lastReason = null;
  }

  snapshot() {
    return { live: this.live, via: this.via, members: [...this.names], size: this.size, instance: this.live && this.instance, complete: this.live && this.via === 'roster' };
  }

  _sig() { return (this.live ? 1 : 0) + '|' + (this.instance ? 1 : 0) + '|' + this.size + '|' + [...this.names].join('\u0001'); }

  _emit(before) { if (before !== this._sig()) { try { this.onChange(this.snapshot()); } catch { /* dinleyici izleyiciyi bozamaz */ } } }

  _end(now, reason) {
    const before = this._sig();
    this.live = false;
    this.via = null;
    this.instance = false;
    this.names = new Set();
    this.size = 0;
    this.stateDb = new Map();
    this.leaveAt = now;
    this.lastReason = reason;
    this._emit(before);
  }

  onZone(now = this.now()) { this.zoneAt = now; }

  onFinder(info, now = this.now()) {
    if (!info) return;
    const count = Array.isArray(info.members) ? info.members.length : (info.members && info.members.size) || 0;
    this.finder = { at: now, dungeon: info.dungeon || 0, count };
    if (this.live && this.via === 'state') { const before = this._sig(); this._refreshState(now); this._emit(before); }
  }

  onRoster(members, now = this.now()) {
    if (!Array.isArray(members) || members.length < 2) { this._end(now, 'yalnız-ben'); return; }
    const before = this._sig();
    const wasLive = this.live;
    const zoneRecent = this.zoneAt > 0 && now - this.zoneAt >= 0 && now - this.zoneAt <= INSTANCE_ROSTER_MS;
    this.instance = zoneRecent || (wasLive && this.instance);
    this.live = true;
    this.via = 'roster';
    if (!wasLive) this.since = now;
    this.rosterAt = now;
    this.names = new Set(members.map((m) => m.name).filter(Boolean));
    this.size = Math.max(members.length, this.names.size);
    this._emit(before);
  }

  onMember(members, now = this.now()) {
    if (!this.live || !Array.isArray(members)) return;
    const before = this._sig();
    for (const m of members) if (m && m.name) this.names.add(m.name);
    this.size = Math.max(this.size, this.names.size);
    this._emit(before);
  }

  onState(dbid, now = this.now()) {
    if (!dbid) return;
    this.stateAt = now;
    this.stateDb.set(dbid, now);
    if (this.stateDb.size > 64) this.stateDb.delete(this.stateDb.keys().next().value);
    if (this.live && this.via === 'roster') return;
    if (!this.live && now - this.leaveAt <= LEAVE_GRACE_MS) return;
    const before = this._sig();
    if (!this.live) {
      const others = this._recentOthers(now);
      if (!others.length) return;
      this.live = true;
      this.via = 'state';
      this.since = now;
      this.rosterAt = 0;
    }
    this._refreshState(now);
    this._emit(before);
  }

  _recentOthers(now) {
    const out = [];
    for (const [db, t] of this.stateDb) if (now - t <= STATE_WINDOW_MS && !this.isOwnDbid(db)) out.push(db);
    return out;
  }

  // kadro görülmedi: durum akışındaki üyelerin adları 0x0297'den küresel kimlikle çözülür (üyelik kararı durum akışındadır)
  _refreshState(now) {
    const others = this._recentOthers(now);
    const names = new Set();
    for (const db of others) { const n = this.nameOfDbid(db); if (n) names.add(n); }
    this.names = names;
    this.size = others.length + 1;
    // kadro yokken zindan içi kanıtı: taze zindan ilanı. Bir kez doğrulanınca parti sürdükçe kalır (ilan 60-200 sn susabilir).
    this.instance = this.instance || !!(this.finder && this.finder.dungeon > 0 && this.finder.count >= 2 && now - this.finder.at <= FINDER_FRESH_MS);
  }

  onLeave(now = this.now()) {
    if (this.live) this._end(now, 'ayrılma');
    else this.leaveAt = now;
  }

  tick(now = this.now()) {
    if (!this.live) return;
    if (this.via === 'state') {
      if (!this._recentOthers(now).length) { this._end(now, 'durum-akışı-kesildi'); return; }
      const before = this._sig();
      this._refreshState(now);
      this._emit(before);
    }
    // bölge yüklemesi + 10 sn kadro yok = parti bitti (yalnız kadroyla doğrulanmış partide; kadro yokken durum akışının kesilmesi karar verir)
    if (this.via === 'roster' && this.zoneAt > Math.max(this.rosterAt, this.since) && now - this.zoneAt > ZONE_ROSTER_WAIT_MS) { this._end(now, 'bölge-yüklemesi-kadro-yok'); return; }
    if (now - Math.max(this.rosterAt, this.stateAt, this.since) > QUIET_MS) this._end(now, 'sessiz');
  }
}

module.exports = { PartyTracker, ZONE_ROSTER_WAIT_MS, INSTANCE_ROSTER_MS, QUIET_MS, STATE_WINDOW_MS, LEAVE_GRACE_MS, FINDER_FRESH_MS };
