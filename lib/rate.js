'use strict';
// Puanlama ekranı veri toplayıcı: defterdeki boss karşılaşmaları (yeniden eskiye, gün anahtarlı) + her oyuncunun özeti.
// Saf mantık: Ledger ve Ratings nesnelerini okur, ağ ve dosya yok. Oyuncu kimliği = ad + sunucu numarası.
const { pidOf, cleanRecord } = require('./ledger');

const MAX_ENCS = 200;
const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

// Karşılaşmadaki oyuncu satırları (özet + puan); me = kendi karakter (küçük harf, listeden çıkar)
function playersOf(ledger, ratings, list, me) {
  const players = [];
  for (const a of list) {
    if (me && a.n.toLowerCase() === me) continue;
    const key = pidOf(a.n, a.s);
    const sum = ratings.lookup(a.n, a.s > 0 ? String(a.s) : ''); // panel rozetiyle aynı eşleşme: önce ad+sunucu, yoksa sunucusuz eski kayıt
    const seen = ledger.seen(a.n, a.s);
    const tags = sum ? sum.tags : [];
    players.push({
      key, n: a.n, s: a.s, c: a.c, d: a.d,
      times: seen ? seen.n : 1, avg: sum ? sum.rating : 0, rating: sum ? Math.round(sum.rating) : 0,
      tags, bl: tags.includes('blacklist'), note: sum && sum.note ? sum.note : '',
    });
  }
  players.sort((x, y) => y.d - x.d);
  return players;
}

// opts: { me: kendi karakter adı (listeden çıkar), max,
//         live: { at, boss, actors } sürmekte olan savaş (henüz deftere yazılmamış; sanal karşılaşma 'live'),
//         pick: { name, server } panelde sağ tıklanan oyuncu (hiçbir karşılaşmada yoksa tek kişilik sanal karşılaşma 'pick') }
function collect(ledger, ratings, opts) {
  const me = opts && opts.me ? String(opts.me).toLowerCase() : '';
  const max = (opts && opts.max) || MAX_ENCS;
  const encs = [];
  const all = new Set(); const rated = new Set(); const black = new Set();
  const push = (e) => {
    let bl = 0; let todo = 0;
    for (const p of e.players) {
      all.add(p.key);
      if (p.rating > 0) rated.add(p.key);
      if (p.bl) { black.add(p.key); bl++; } else if (p.rating <= 0) todo++;
    }
    encs.push({ fk: e.fk, at: e.at, day: dayKey(e.at), boss: e.boss, killed: !!e.k, kind: e.kind || '', count: e.players.length, bl, todo, players: e.players });
  };
  const live = opts && opts.live ? cleanRecord({ fk: 'live', at: opts.live.at, boss: opts.live.boss, actors: opts.live.actors }) : null;
  if (live) { const pl = playersOf(ledger, ratings, live.p, me); if (pl.length) push({ fk: 'live', at: live.at, boss: live.boss, kind: 'live', players: pl }); }
  // Tüm puanlananlar: ratings.js'te kalıcı (ad+sunucu) olan herkes, savaş kaydı olmasa da; sonradan görülebilir/değiştirilebilir
  if (opts && opts.rated) {
    const seenIds = new Set(); const rp = [];
    for (const e of ratings.list()) {
      const sv = Number(e.server) > 0 ? Number(e.server) : 0;
      const n = String(e.targetNickname || '').trim();
      if (!n || n.includes('#') || (me && n.toLowerCase() === me)) continue;
      const id = pidOf(n, sv);
      if (seenIds.has(id)) continue;
      seenIds.add(id);
      const sn = ledger.seen(n, sv);
      rp.push({ n, s: sv, c: sn ? sn.cls : 0, d: 0 });
    }
    if (rp.length) push({ fk: 'rated', at: Date.now(), boss: '', kind: 'rated', players: playersOf(ledger, ratings, rp, me) });
  }
  for (const f of ledger.list(max)) push({ fk: f.fk, at: f.at, boss: f.boss, k: f.k, players: playersOf(ledger, ratings, f.p, me) });
  const pk = opts && opts.pick ? cleanRecord({ fk: 'pick', p: [{ n: opts.pick.name, s: opts.pick.server }] }) : null;
  if (pk && !(me && pk.p[0].n.toLowerCase() === me)) {
    const id = pidOf(pk.p[0].n, pk.p[0].s);
    const nameOnly = pk.p[0].n.toLowerCase();
    // sunucu bilinmiyorsa (0) aynı adlı herhangi bir kayıt da yeter; sunucu varsa tam eşleşme aranır
    const found = encs.some((e) => e.players.some((p) => p.key === id || (!pk.p[0].s && p.n.toLowerCase() === nameOnly)));
    if (!found) push({ fk: 'pick', at: Date.now(), boss: pk.p[0].n, kind: 'pick', players: playersOf(ledger, ratings, pk.p, me) });
  }
  return { encs, total: all.size, rated: rated.size, black: black.size };
}

module.exports = { collect, dayKey, MAX_ENCS };
