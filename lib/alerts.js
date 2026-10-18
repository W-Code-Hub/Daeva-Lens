'use strict';
// Zamanlayıcı uyarıları: saf mantık (Electron'a bağlı değil, testte doğrudan denenir). Ağ yok.
//  - createScheduler: hangi eşiğin ne zaman tetikleneceği (her eşik bir olay için bir kez)
//  - decide: uyarı türü + "savaşta sessiz" kararı -> ses / TTS / yazı kutusu
//  - normalize: ayarları doğrular

const STEP_CHOICES = [15, 10, 5, 1, 0]; // dakika; 0 = başlangıç
const DEFAULT_STEPS = [10, 5, 1, 0];
const MODES = ['sound', 'text', 'both', 'off'];
const COMBAT_POLICIES = ['quiet', 'normal'];
const TOAST_MODES = ['hold', 'auto'];
const SOUND_CHOICES = ['chime', 'can', 'gong', 'ping', 'soft', 'alarm', 'horn', 'harp', 'bip', 'yukselen'];
const FIGHT_WINDOW_MS = 8000;  // son bu kadar ms içinde hasar/beceri varsa "savaşta"
const MAX_GAP_MS = 30000;      // iki kontrol arası bundan uzunsa (uyku, saat atlaması) eski eşikler ateşlenmez

const clampInt = (v, lo, hi, def) => {
  const n = Math.round(Number(v));
  return Number.isFinite(n) ? Math.min(hi, Math.max(lo, n)) : def;
};

function normSteps(v) {
  if (!Array.isArray(v)) return DEFAULT_STEPS.slice();
  const out = STEP_CHOICES.filter((s) => v.includes(s)); // yalnız bilinen eşikler, büyükten küçüğe
  return out;
}

// settings nesnesini yerinde doğrular (bozuk/eksik değerler varsayılana döner)
function normalize(s) {
  s.timerAlertMode = MODES.includes(s.timerAlertMode) ? s.timerAlertMode : 'both';
  s.timerAlertSteps = normSteps(s.timerAlertSteps);
  s.timerSound = SOUND_CHOICES.includes(s.timerSound) ? s.timerSound : 'chime';
  s.timerVolume = clampInt(s.timerVolume, 0, 100, 70);
  s.timerBeep = s.timerBeep === true;
  s.timerTts = s.timerTts === true;
  s.timerToastMode = TOAST_MODES.includes(s.timerToastMode) ? s.timerToastMode : 'auto';
  s.timerToastSec = clampInt(s.timerToastSec, 3, 300, 15);
  s.timerCombat = COMBAT_POLICIES.includes(s.timerCombat) ? s.timerCombat : 'quiet';
  return s;
}

// Zamanlayıcı: her saniye tick(); bir önceki kontrolden bu yana geçen eşikleri döndürür.
// Uygulama (yeniden) açılınca ilk tick yalnız zamanı işaretler: geçmiş eşikler tekrarlanmaz.
function createScheduler(TIMERS) {
  let last = null;
  const fired = new Set();
  return {
    tick(nowMs, regionId, enabled, steps) {
      const prev = last;
      last = nowMs;
      if (prev === null || nowMs < prev || nowMs - prev > MAX_GAP_MS) return []; // ilk çağrı / saat geri / uyku sonrası
      for (const k of fired) if (Number(k.split('|')[1]) < nowMs - 3600000) fired.delete(k);
      const list = Array.isArray(steps) ? steps : [];
      if (!list.length || !enabled) return [];
      const maxMs = Math.max(...list) * 60000;
      const out = [];
      for (const ev of TIMERS.EVENTS) {
        if (enabled[ev.id] !== true) continue;
        const reg = TIMERS.REGIONS[TIMERS.normRegion(regionId)];
        const sched = ev[reg.sched];
        for (const start of TIMERS.slotsIn(sched, reg.tz, prev, nowMs + maxMs + 1000)) {
          for (const step of list) {
            const at = start - step * 60000;
            if (at <= prev || at > nowMs) continue;
            const key = `${ev.id}|${start}|${step}`;
            if (fired.has(key)) continue;
            fired.add(key);
            out.push({ key, id: ev.id, name: ev.name, step, start });
          }
        }
      }
      return out.sort((a, b) => a.start - b.start || a.step - b.step);
    },
  };
}

// Savaşta mı? lastHitMs/lastOwnMs: son hasar / kendi beceri zamanı (ms, bilinmiyorsa 0)
function inFight(nowMs, lastHitMs, lastOwnMs) {
  return nowMs - (lastHitMs || 0) < FIGHT_WINDOW_MS || nowMs - (lastOwnMs || 0) < FIGHT_WINDOW_MS;
}

// Bir uyarı için ne yapılacağı: { sound, tts, toast: null | 'full' | 'quiet' }
//  'full'  = Gizle düğmeli / ayara göre kalan kutu, 'quiet' = tıklanamaz, ~6 sn'de kaybolan sessiz yazı
function decide(cfg, fighting) {
  const none = { sound: false, tts: false, toast: null };
  if (!cfg || cfg.timerAlertMode === 'off') return none;
  if (fighting && cfg.timerCombat !== 'normal') return { sound: false, tts: false, toast: 'quiet' };
  const snd = cfg.timerAlertMode === 'sound' || cfg.timerAlertMode === 'both';
  const txt = cfg.timerAlertMode === 'text' || cfg.timerAlertMode === 'both';
  return { sound: snd && cfg.timerBeep !== false, tts: snd && cfg.timerTts !== false, toast: txt ? 'full' : null };
}

// İngilizce konuşma metni (TTS sabit İngilizce): "Siege boss in 5 minutes"
function ttsText(name, step, lang) {
  // Parantez içi (örn. '(Tamasa / Argo / Kaira)') okunmaz; yazı kutusu tam adı gösterir
  name = String(name).replace(/\s*\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  if (lang === 'tr') return step === 0 ? `${name} şimdi başlıyor` : `${name} ${step} dakika sonra başlıyor`; // Türkçe: ad çağıran tarafından zaten çevrilmiş gelir
  if (step === 0) return `${name} is starting now`;
  return `${name} in ${step} ${step === 1 ? 'minute' : 'minutes'}`;
}

module.exports = { STEP_CHOICES, DEFAULT_STEPS, MODES, COMBAT_POLICIES, TOAST_MODES, SOUND_CHOICES, FIGHT_WINDOW_MS, MAX_GAP_MS, normalize, normSteps, createScheduler, inFight, decide, ttsText };
