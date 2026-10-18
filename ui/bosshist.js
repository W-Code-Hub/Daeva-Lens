'use strict';
// Boss sekmesi "Geçmiş karşılaşmalar" listesinin saf mantığı (DOM yok): kalıcı özetlerle bu oturumun bellekteki boss
// kayıtlarını birleştirme, arama / boss süzgeci / sıralama, gün gruplama, boss çipleri. Tarayıcıda window.BOSSHIST, Node'da require.
(function (root) {
  // Boss kodu → zindan tablosu (tarayıcıda lib/dungeons.js önce yüklenir)
  const DG = root.DUNGEONS || (typeof require === 'function' ? require('../lib/dungeons.js') : null);
  const RUN_GAP = 20 * 60 * 1000; // aynı zindandaki iki dövüş arasında bundan uzun boşluk = yeni koşu
  // Yerel takvim günü anahtarı (YYYY-MM-DD)
  const dayKey = (ms) => { const d = new Date(ms); return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0'); };

  // saved: dosyadaki özetler; mem: state.bosses (bu oturum). Aynı fk bir kez listelenir; kalıcı özet daha ayrıntılıdır.
  // Bellekteki kaydın sırası (i) korunur: seçilince canlı rapor akışı (selectBoss) kullanılır.
  function merge(saved, mem) {
    const out = new Map();
    for (const s of saved || []) if (s && s.fk) out.set(s.fk, { ...s, mi: -1 });
    (mem || []).forEach((b, i) => {
      if (!b || !b.fk) return;
      const o = out.get(b.fk);
      if (o) { o.mi = i; return; }
      const dur = Math.max(1000, b.dur || 0);
      out.set(b.fk, { fk: b.fk, at: b.at || 0, boss: b.name || '', code: b.code || 0, dur, res: b.killed ? 'k' : b.wiped ? 'w' : '', n: 0, total: b.total || 0, dps: (b.total || 0) / (dur / 1000), top: 0, pb: b.pb ? 1 : 0, own: null, mi: i });
    });
    return [...out.values()];
  }

  // opts: { q: arama metni (boss adı), boss: boss adı süzgeci ('' = hepsi), sort: 'new' | 'dps' | 'own' }
  function view(items, opts) {
    const o = opts || {};
    const q = String(o.q || '').trim().toLowerCase();
    let a = (items || []).filter((x) => (!o.boss || x.boss === o.boss) && (!q || String(x.boss).toLowerCase().includes(q)));
    if (o.sort === 'dps') a = a.sort((x, y) => (y.dps - x.dps) || (y.at - x.at));
    else if (o.sort === 'own') a = a.sort((x, y) => ((y.own ? y.own.dps : -1) - (x.own ? x.own.dps : -1)) || (y.at - x.at));
    else a = a.sort((x, y) => y.at - x.at);
    return a;
  }

  // Zindan koşusu gruplama. Her kayıt koduna göre zindana bağlanır (kodsuz / eşleşmeyen = açık dünya, tek kart).
  // Aynı zindandaki dövüşler, bir önceki dövüşün bitişinden itibaren gap ms içinde başlıyorsa aynı koşudur; zindan değişirse ya da
  // uzun boşluk olursa yeni koşu. Mini boss (tam boss sayılmayan mekanik) ayrı koşu açmaz, açık koşuya girer.
  // Ana boss kesilince koşu tamamlanır: aynı zindanda sonra gelen tam boss, 20 dk beklemeden yeni koşu açar (ana boss verisi olmayan zindan değişmez).
  // Dönüş (yeniden eskiye): { run: false, item } | { run: true, key, dungeon, kind, mode, at, last, items (eskiden yeniye), bosses, fights, res, dps, ownDps, boss }
  function groupRuns(items, gap) {
    const g = gap > 0 ? gap : RUN_GAP;
    const asc = (items || []).slice().sort((a, b) => (a.at - b.at) || String(a.fk).localeCompare(String(b.fk)));
    const out = [];
    const open = new Map(); // zindan sırası → açık koşu
    for (const x of asc) {
      const d = DG && x.code ? DG.lookup(x.code) : null;
      if (!d) { out.push({ run: false, item: x }); continue; }
      let r = open.get(d.id);
      if (!r || x.at - r.end > g || (r.done && !d.mini)) {
        r = { run: true, key: 'run:' + x.fk, dungeon: d.name, did: d.id, kind: d.kind, mode: '', at: x.at, last: x.at, end: x.at, items: [] };
        open.set(d.id, r); out.push(r);
      }
      r.items.push(x);
      r.last = Math.max(r.last, x.at);
      r.end = Math.max(r.end, x.at + (x.dur || 0));
      if (!r.mode && d.mode) r.mode = d.mode;
      x.mini = d.mini;
      x.main = d.main;
      if (d.main && x.res === 'k') r.done = true;
    }
    for (const r of out) {
      if (!r.run) continue;
      const full = r.items.filter((x) => !x.mini);
      const base = full.length ? full : r.items;
      r.bosses = new Set(base.map((x) => x.code)).size;
      r.fights = r.items.length;
      r.res = r.items.some((x) => x.res === 'k') ? 'k' : r.items.every((x) => x.res === 'w') ? 'w' : '';
      r.dps = r.items.reduce((m, x) => Math.max(m, x.dps || 0), 0);
      r.ownDps = r.items.reduce((m, x) => Math.max(m, x.own ? x.own.dps : -1), -1);
      r.boss = r.dungeon;
    }
    return out.reverse();
  }

  // Gruplanmış görünüm: view() süzgeçleri koşuya da uygulanır (içindeki herhangi bir dövüş ya da zindan adı eşleşirse görünür).
  // opts: { q, boss, sort: 'new' | 'dps' | 'own' | 'dur', kind: 'all' | 'dungeon' | 'world',
  //         names: (fk) => oyuncu adları (küçük harf, metin) — arama oyuncu adını da arar }
  function viewRuns(items, opts) {
    const o = opts || {};
    const q = String(o.q || '').trim().toLowerCase();
    const names = typeof o.names === 'function' ? o.names : null;
    const byName = (x) => !!(q && names && String(names(x.fk) || '').toLowerCase().includes(q));
    const hit = (x) => (!o.boss || x.boss === o.boss) && (!q || String(x.boss).toLowerCase().includes(q) || byName(x));
    const kind = o.kind === 'dungeon' || o.kind === 'world' ? o.kind : 'all';
    let a = groupRuns(items).filter((e) => (kind === 'dungeon' && !e.run) || (kind === 'world' && e.run) ? false
      : (e.run ? (!o.boss || e.items.some((x) => x.boss === o.boss)) && (!q || e.dungeon.toLowerCase().includes(q) || e.items.some(hit)) : hit(e.item)));
    const at = (e) => (e.run ? e.at : e.item.at);
    const dps = (e) => (e.run ? e.dps : e.item.dps);
    const own = (e) => (e.run ? e.ownDps : e.item.own ? e.item.own.dps : -1);
    const dur = (e) => (e.run ? e.items.reduce((n, x) => n + (x.dur || 0), 0) : e.item.dur || 0);
    if (o.sort === 'dps') a = a.sort((x, y) => (dps(y) - dps(x)) || (at(y) - at(x)));
    else if (o.sort === 'own') a = a.sort((x, y) => (own(y) - own(x)) || (at(y) - at(x)));
    else if (o.sort === 'dur') a = a.sort((x, y) => (dur(y) - dur(x)) || (at(y) - at(x)));
    else a = a.sort((x, y) => at(y) - at(x));
    return a;
  }

  // Sağ sütunun durumu. sel: { fk: seçili dövüş / sabit kart, run: seçili zindan koşusu başlığı }
  // 'fight' = rapor + oyuncular görünür; 'pick-boss' = zindan başlığı seçili, önce içinden boss seçilir; 'empty' = hiçbir kart seçili değil.
  // Oyuncular yalnız 'fight' durumunda görünür.
  function rightMode(sel) {
    const s = sel || {};
    if (s.fk) return 'fight';
    if (s.run) return 'pick-boss';
    return 'empty';
  }
  const playersVisible = (sel) => rightMode(sel) === 'fight';

  // Kart tıklaması → yeni seçim ve zindan koşusunun açık/kapalı durumu. entry: { run: true, key } | { fk }
  function clickCard(sel, entry, openSet) {
    const s = sel || { fk: '', run: '' };
    if (entry && entry.run) {
      const open = new Set(openSet || []);
      if (open.has(entry.key)) open.delete(entry.key); else open.add(entry.key);
      return { sel: { fk: '', run: entry.key }, open };
    }
    return { sel: { fk: entry && entry.fk ? entry.fk : s.fk, run: '' }, open: new Set(openSet || []) };
  }

  // Oyuncu satırı süzgeci: all | todo (puansız, kara listede değil) | black
  const playerShown = (p, f) => !f || f === 'all' || (f === 'todo' && p.rating <= 0 && !p.bl) || (f === 'black' && p.bl);

  // Sıralı listeyi ardışık günlere böler: [{ day, at, items }]
  function groupDays(items) {
    const g = [];
    for (const e of items || []) {
      const x = e.run ? e : e.item || e; // koşu girdisi ya da düz kayıt
      const k = dayKey(x.at);
      if (!g.length || g[g.length - 1].day !== k) g.push({ day: k, at: x.at, items: [] });
      g[g.length - 1].items.push(e);
    }
    return g;
  }

  // Boss çipleri: en sık görülen boss adları (en çok max tane); seçili olan listede yoksa sona eklenir
  function bossChips(items, max, selected) {
    const m = new Map();
    for (const x of items || []) if (x.boss) m.set(x.boss, (m.get(x.boss) || 0) + 1);
    const a = [...m].sort((x, y) => (y[1] - x[1]) || x[0].localeCompare(y[0])).slice(0, max > 0 ? max : 6).map(([name, n]) => ({ name, n }));
    if (selected && !a.some((c) => c.name === selected) && m.has(selected)) a.push({ name: selected, n: m.get(selected) });
    return a;
  }

  // Rapor özet kutuları: yalnız kayıtta olan veri. Olmayan değer null (ekranda "–"); uydurma yok.
  // enc: { boss: { dur, total, allTotal, dps }, actors: [{ own, dps }] }
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  function summary(enc) {
    const b = enc && enc.boss;
    if (!b) return null;
    const mine = ((enc.actors) || []).find((a) => a && a.own);
    return { dur: num(b.dur), total: num(b.total), allTotal: num(b.allTotal) != null ? b.allTotal : num(b.total), groupDps: num(b.dps), ownDps: mine ? num(mine.dps) : null };
  }
  // Boss koduna göre "ana boss" bilgisi: zindan tablosunda işaretliyse true, tabloda yoksa/işaretsizse false (rozet gösterilmez)
  const isMainBoss = (code) => !!(DG && code && DG.lookup(code) && DG.lookup(code).main);

  const api = { summary, isMainBoss, dayKey, merge, view, groupDays, bossChips, groupRuns, viewRuns, rightMode, playersVisible, clickCard, playerShown, RUN_GAP };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.BOSSHIST = api;
})(typeof window !== 'undefined' ? window : globalThis);
