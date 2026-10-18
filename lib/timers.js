'use strict';
// Dünya boss / etkinlik zamanlayıcıları (Faz 8.3). Ağ isteği yok: yalnız yerel saat + Intl (DST uyumlu).
// Tüm hesap fonksiyonları saftır: "şimdi" (ms) dışarıdan verilir, böylece sabit tarihlerle sınanabilir.
//
// Saat verisi topluluk bilgisine dayanır (resmi API yok); EVENTS ve REGIONS tablosunu değiştirmek yeterlidir.

const KST = 'Asia/Seoul';

// Bölge: tz = sunucu saat dilimi (Global sunucuda "yerel sunucu saati"), sched = hangi çizelge, reset = sıfırlama.
const REGIONS = {
  'asia-kr': { label: 'Korea (Asia/Seoul)', tz: 'Asia/Seoul', sched: 'kr' },
  'asia-tw': { label: 'Taiwan (Asia/Taipei)', tz: 'Asia/Taipei', sched: 'tw' },
  'global-asia': { label: 'Global - Asia (Asia/Seoul)', tz: 'Asia/Seoul', sched: 'global' },
  'global-na-east': { label: 'Global - North America East (America/New_York)', tz: 'America/New_York', sched: 'global' },
  'global-na-west': { label: 'Global - North America West (America/Los_Angeles)', tz: 'America/Los_Angeles', sched: 'global' },
  'global-eu': { label: 'Global - Europe (Europe/Berlin)', tz: 'Europe/Berlin', sched: 'global' },
  'global-sa': { label: 'Global - South America (America/Sao_Paulo)', tz: 'America/Sao_Paulo', sched: 'global' },
};
const DEFAULT_REGION = 'global-eu';

// Çizelge girdisi: { tz, days: [0..6] (0=Pazar, o saat diliminin günü) | null, at: [[saat, dakika], ...] }
const range = (a, b, step) => { const r = []; for (let h = a; h <= b; h += step) r.push([h, 0]); return r; };
const hhmm = (list) => list.map(([h, m]) => [h, m]);

// durMin: etkinliğin sürdüğü / açık kaldığı dakika. Kaynak: Shugo.gg/timers (tz:null = bölgenin kendi sunucu saati).
const HOURLY30 = Array.from({ length: 24 }, (_, h) => [h, 30]);
const HOURLY00 = range(0, 23, 1);
const RIFT = [2, 5, 8, 11, 14, 17, 20, 23].map((h) => [h, 0]);
const KAIRA_KR = [0, 4, 8, 12, 16, 20].map((h) => [h, 0]);
const EVENTS = [
  { id: 'invasion', name: 'Dimensional Invasion', durMin: 15,
    global: { tz: null, days: null, at: HOURLY30 }, kr: { tz: null, days: null, at: HOURLY30 }, tw: { tz: null, days: null, at: HOURLY30 } },
  { id: 'shugo', name: 'Shugo Festival', durMin: 10,
    global: { tz: null, days: null, at: HOURLY00 }, kr: { tz: null, days: null, at: HOURLY00 }, tw: { tz: null, days: null, at: HOURLY00 } },
  { id: 'kaira', name: 'Watcher Kaira', durMin: 30,
    global: { tz: null, days: null, at: [1, 4, 7, 10, 13, 16, 19, 22].map((h) => [h, 0]) },
    kr: { tz: null, days: null, at: KAIRA_KR }, tw: { tz: null, days: null, at: KAIRA_KR } },
  { id: 'rift', name: 'Spacetime Rift', durMin: 60, // portal ilk 10 dk açık
    global: { tz: null, days: null, at: RIFT }, kr: { tz: null, days: null, at: RIFT }, tw: { tz: null, days: null, at: RIFT } },
  { id: 'nahma', name: 'Guardian Lord Nahma', durMin: 30,
    global: { tz: null, days: [5, 0], at: [[21, 0]] },
    kr: { tz: null, days: [5, 0], at: hhmm([[22, 0], [22, 30], [23, 0]]) },
    tw: { tz: null, days: [5, 0], at: [[22, 0]] } },
  { id: 'siege', name: 'Artifact Siege', durMin: 30,
    global: { tz: null, days: [1, 4, 6], at: [[21, 0]] },
    kr: { tz: null, days: [3, 6], at: hhmm([[21, 20], [21, 50], [22, 20]]) },
    tw: { tz: null, days: [3, 6], at: [[21, 30]] } },
  { id: 'siegeboss', name: 'Siege Bosses (Tamasa / Argo / Kaira)', durMin: 30,
    global: { tz: null, days: [1, 4, 6], at: [[21, 30]] },
    kr: { tz: null, days: [3, 6], at: hhmm([[21, 45], [22, 15], [22, 45]]) },
    tw: { tz: null, days: [3, 6], at: [[21, 45]] } },
];
const EVENT_IDS = EVENTS.map((e) => e.id);

// Sıfırlama (Shugo.gg): Global günlük+haftalık 16:00 KST (07:00 UTC); Kore 05:00 KST; Tayvan 05:00 Taipei. Haftalık: Çarşamba.
const RESET = {
  global: { tz: KST, hour: 16, weekday: 3 },
  kr: { tz: KST, hour: 5, weekday: 3 },
  tw: { tz: 'Asia/Taipei', hour: 5, weekday: 3 },
};

const normRegion = (r) => (Object.prototype.hasOwnProperty.call(REGIONS, r) ? r : DEFAULT_REGION);

// --- saat dilimi yardımcıları ---------------------------------------------------------------
const fmtCache = new Map();
function fmtFor(tz) {
  let f = fmtCache.get(tz);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: tz, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' });
    fmtCache.set(tz, f);
  }
  return f;
}
// Verilen anda tz'nin UTC'den farkı (ms)
function tzOffset(ms, tz) {
  const p = {};
  for (const x of fmtFor(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return Date.UTC(p.year, p.month - 1, p.day, p.hour % 24, p.minute, p.second) - Math.floor(ms / 1000) * 1000;
}
// tz'deki duvar saati (y,mo,d,h,mi) -> UTC ms. DST geçişlerinde ikinci geçişle düzeltilir.
function zonedToUtc(y, mo, d, h, mi, tz) {
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  const o1 = tzOffset(guess, tz);
  let utc = guess - o1;
  const o2 = tzOffset(utc, tz);
  if (o2 !== o1) utc = guess - o2;
  return utc;
}
// ms anının tz'deki takvim günü
function zonedDate(ms, tz) {
  const p = {};
  for (const x of fmtFor(tz).formatToParts(new Date(ms))) if (x.type !== 'literal') p[x.type] = Number(x.value);
  return { y: p.year, mo: p.month, d: p.day };
}

// Bir çizelgenin [fromMs, toMs] aralığındaki başlangıçları (artan sıra)
function slotsIn(sched, serverTz, fromMs, toMs) {
  const tz = sched.tz || serverTz;
  const out = [];
  const a = zonedDate(fromMs - 86400000, tz);
  const b = zonedDate(toMs + 86400000, tz);
  const end = Date.UTC(b.y, b.mo - 1, b.d);
  for (let c = Date.UTC(a.y, a.mo - 1, a.d); c <= end; c += 86400000) {
    const cd = new Date(c); // yalnız takvim bileşenleri (UTC) kullanılır
    const wd = cd.getUTCDay();
    if (sched.days && !sched.days.includes(wd)) continue;
    for (const [h, m] of sched.at) {
      const s = zonedToUtc(cd.getUTCFullYear(), cd.getUTCMonth() + 1, cd.getUTCDate(), h, m, tz);
      if (s >= fromMs && s <= toMs) out.push(s);
    }
  }
  return out.sort((x, y) => x - y);
}

function scheduleOf(ev, regionId) {
  const reg = REGIONS[normRegion(regionId)];
  return { sched: ev[reg.sched], tz: reg.tz };
}

// Bir etkinlik için şimdiye göre durum: { next: sonraki başlangıç, active: sürüyorsa {start,end} }
function eventInfo(ev, regionId, nowMs) {
  const { sched, tz } = scheduleOf(ev, regionId);
  const dur = ev.durMin * 60000;
  let active = null;
  for (const s of slotsIn(sched, tz, nowMs - dur, nowMs)) if (s <= nowMs && nowMs < s + dur) active = { start: s, end: s + dur };
  let next = null;
  for (const span of [2, 9]) { // önce 2 gün, bulunamazsa 9 gün (haftalık etkinlikler)
    const l = slotsIn(sched, tz, nowMs + 1, nowMs + span * 86400000).filter((s) => s > nowMs);
    if (l.length) { next = l[0]; break; }
  }
  return { id: ev.id, name: ev.name, durMin: ev.durMin, next, active };
}

// Tüm etkinlikler, yaklaşan sırayla (sürenler en başta)
function allInfo(regionId, nowMs) {
  const list = EVENTS.map((ev) => eventInfo(ev, regionId, nowMs));
  const key = (i) => (i.active ? i.active.start - 1e15 : (i.next == null ? 1e18 : i.next));
  return list.sort((a, b) => key(a) - key(b));
}

// Günlük / haftalık sıfırlama
function resetInfo(regionId, nowMs) {
  const reg = REGIONS[normRegion(regionId)];
  const r = RESET[reg.sched];
  const all = slotsIn({ tz: r.tz, days: null, at: [[r.hour, 0]] }, r.tz, nowMs + 1, nowMs + 9 * 86400000).filter((s) => s > nowMs);
  const daily = all[0] || null;
  const weekly = slotsIn({ tz: r.tz, days: [r.weekday], at: [[r.hour, 0]] }, r.tz, nowMs + 1, nowMs + 9 * 86400000).filter((s) => s > nowMs)[0] || null;
  return { daily, weekly };
}

// Alarm eşikleri (saniye): doğuma 10 dk, 5 dk, 0 dk
const ALARM_STEPS = [600, 300, 0];
const GRACE_MS = 5000; // sistem uykusu / takılma sonrası eski alarmları ateşleme

// Şu an ateşlenmesi gereken alarmlar: [{ key, id, name, step, start }]. Çağıran "key"i bir kümede tutup tekrarı engeller.
function dueAlarms(regionId, nowMs, enabled) {
  const out = [];
  for (const ev of EVENTS) {
    if (!enabled || enabled[ev.id] !== true) continue;
    const { sched, tz } = scheduleOf(ev, regionId);
    for (const s of slotsIn(sched, tz, nowMs - GRACE_MS, nowMs + 600000 + 1000)) {
      for (const step of ALARM_STEPS) {
        const at = s - step * 1000;
        if (at <= nowMs && nowMs - at < GRACE_MS) out.push({ key: `${ev.id}|${s}|${step}`, id: ev.id, name: ev.name, step, start: s });
      }
    }
  }
  return out;
}

module.exports = { REGIONS, DEFAULT_REGION, EVENTS, EVENT_IDS, ALARM_STEPS, normRegion, zonedToUtc, slotsIn, eventInfo, allInfo, resetInfo, dueAlarms };
