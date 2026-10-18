'use strict';
// Faz 8.17: oyunla otomatik göster/gizle. SAF durum makinesi (Electron, DOM, süreç listesi yok).
// Oyun varlığı yalnız Npcap yakalama sinyalinden (son oyun paketi zamanı) anlaşılır; süreç listeleme,
// pencere numaralandırma veya bellek okuma YAPILMAZ (anti-cheat güvenliği).
// Kural özeti:
//  - Açılışta panel görünür. Son oyun paketinden (hiç gelmediyse açılıştan) bu yana hideAfterMs aşılırsa gizle.
//  - Oyun paketi gelince panel gizliyse göster.
//  - Kullanıcı elle açtıysa ya da Ayarlar çekmecesi açıksa gizleme; elle gizlediyse otomatik gösterme.
//  - Elle kararlar bir sonraki oyun oturumunda (sessizlikten sonra ilk paket) sıfırlanır.

const HIDE_AFTER_MS = 30000;   // varsayılan gizlenme süresi (ayar: autoHideSec)
const HIDE_SEC_MIN = 10;
const HIDE_SEC_MAX = 300;
const HIDE_SEC_DEFAULT = HIDE_AFTER_MS / 1000;

// Ayar değerini (sn) doğrular: tamsayı, 10-300 arası; geçersizse varsayılan 30
function normHideSec(v) {
  const n = typeof v === 'number' ? v : (typeof v === 'string' && v.trim() !== '' ? Number(v) : NaN);
  if (!Number.isFinite(n)) return HIDE_SEC_DEFAULT;
  return Math.min(HIDE_SEC_MAX, Math.max(HIDE_SEC_MIN, Math.round(n)));
}

function create(opts = {}) {
  let hideAfterMs = opts.hideAfterMs > 0 ? opts.hideAfterMs : HIDE_AFTER_MS;
  let enabled = opts.enabled !== false;
  let lastPkt = 0;                       // son oyun paketi (0 = hiç gelmedi)
  let startAt = Number(opts.now) || 0;   // açılış anı (ilk paketten önceki sessizlik buradan sayılır)
  let override = null;                   // null | 'shown' | 'hidden' (kullanıcının son elle kararı)
  let idle = false;                      // sessizlik eşiği aşıldı: bir sonraki paket yeni oturumdur
  let autoHidden = false;                // son gizleme otomatikti

  const ref = () => (lastPkt || startAt);

  return {
    get enabled() { return enabled; },
    get override() { return override; },
    get idle() { return idle; },
    get autoHidden() { return autoHidden; },
    get hideAfterMs() { return hideAfterMs; },
    setEnabled(v) { enabled = !!v; },
    // Gizlenme süresi (sn, ayar autoHideSec); doğrulanır
    setHideSec(sec) { hideAfterMs = normHideSec(sec) * 1000; },
    // İlk çağrıda açılış anını belirler (now verilmediyse)
    start(now) { startAt = now; lastPkt = 0; idle = false; override = null; autoHidden = false; },
    // Oyun paketi geldi. Dönüş: 'show' (paneli göster) ya da null
    gamePacket(now, visible) {
      if (lastPkt && now - lastPkt > hideAfterMs) idle = true; // tick çalışmamış olsa da boşluk yeni oturumdur
      if (idle) { override = null; idle = false; }             // yeni oturum: elle kararlar sıfırlanır
      lastPkt = now;
      if (!enabled) return null;
      if (!visible && override !== 'hidden') { autoHidden = false; return 'show'; }
      return null;
    },
    // Düzenli çağrı. ctx: { visible, drawerOpen }. Dönüş: 'hide' ya da null
    tick(now, ctx) {
      if (!enabled) return null;
      if (now - ref() <= hideAfterMs) return null;
      idle = true;
      const c = ctx || {};
      if (!c.visible || c.drawerOpen || override === 'shown') return null;
      autoHidden = true;
      return 'hide';
    },
    // Kullanıcı paneli tepsiden / kısayoldan / düğmeyle elle açtı ya da gizledi
    manualShow() { override = 'shown'; autoHidden = false; },
    manualHide() { override = 'hidden'; autoHidden = false; },
  };
}

module.exports = { create, normHideSec, HIDE_AFTER_MS, HIDE_SEC_MIN, HIDE_SEC_MAX, HIDE_SEC_DEFAULT };
