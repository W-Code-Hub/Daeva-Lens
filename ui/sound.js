(() => {
'use strict';
// Bildirim sesleri: dosya gerekmez, Web Audio ile üretilir. Kullanıcı kendi dosyasını da ekleyebilir.

const SOUNDS = [
  { id: 'stagger', name: 'Boss Stagger (Gong/Break)' },
  { id: 'lowhp', name: 'Low HP Pulse (Heartbeat)' },
  { id: 'threat', name: 'Threat Alert (Double Warn)' },
  { id: 'potion', name: 'Potion Drop' },
  { id: 'can', name: 'Bell' },
  { id: 'bip', name: 'Beep' },
  { id: 'cift', name: 'Double beep' },
  { id: 'yukselen', name: 'Rising' },
  { id: 'damla', name: 'Drop' },
  { id: 'gong', name: 'Gong' },
  { id: 'chime', name: 'Chime' },
  { id: 'ping', name: 'Ping' },
  { id: 'soft', name: 'Soft' },
  { id: 'alarm', name: 'Alarm' },
  { id: 'horn', name: 'Horn' },
  { id: 'harp', name: 'Harp' },
  { id: 'oku', name: 'Text-to-Speech (TTS)' },
  { id: 'sessiz', name: 'Silent (visual only)' },
];

const ALERT_TTS = {
  stagger: { tr: 'Boss kırıldı!', en: 'Boss staggered!' },
  lowhp: { tr: 'Canın azaldı!', en: 'Low health warning!' },
  potion: { tr: 'İksir basıldı!', en: 'Potion used!' },
};

function getAlertTts(kind, lang) {
  const l = lang || ((typeof I18N !== 'undefined' && I18N.getLang) ? I18N.getLang() : (typeof document !== 'undefined' && document.documentElement.lang === 'tr' ? 'tr' : 'en'));
  const entry = ALERT_TTS[kind];
  if (!entry) return null;
  return entry[l === 'tr' ? 'tr' : 'en'];
}

let ctx = null;
function ac() {
  if (!ctx || ctx.state === 'closed') {
    const AudioCtx = window.AudioContext || window.webkitAudioContext;
    if (AudioCtx) ctx = new AudioCtx();
  }
  if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
    ctx.resume().catch(() => {});
  }
  return ctx;
}

function tone(c, out, { f, f2, type = 'sine', t0 = 0, dur = 0.3, gain = 0.5, attack = 0.005 }) {
  try {
    const o = c.createOscillator();
    const g = c.createGain();
    o.type = type;
    const s = Math.max(c.currentTime, c.currentTime + (t0 || 0));
    const safeDur = Math.max(0.02, dur || 0.3);
    const safeGain = Math.max(0.0001, Math.min(2.0, gain || 0.5));
    const safeAttack = Math.max(0.003, Math.min(safeDur * 0.4, attack || 0.005));
    o.frequency.setValueAtTime(Math.max(20, f), s);
    if (f2 && f2 > 0) o.frequency.exponentialRampToValueAtTime(Math.max(20, f2), s + safeDur);
    g.gain.setValueAtTime(0.0001, s);
    g.gain.exponentialRampToValueAtTime(safeGain, s + safeAttack);
    g.gain.exponentialRampToValueAtTime(0.0001, s + safeDur);
    o.connect(g).connect(out);
    o.start(s);
    o.stop(s + safeDur + 0.05);
  } catch {}
}

const SYNTH = {
  can: (c, o) => { tone(c, o, { f: 1318, dur: 1.4, gain: 0.45 }); tone(c, o, { f: 2637, dur: 0.8, gain: 0.15 }); tone(c, o, { f: 3951, dur: 0.4, gain: 0.06 }); },
  bip: (c, o) => tone(c, o, { f: 1040, type: 'square', dur: 0.14, gain: 0.18 }),
  cift: (c, o) => { tone(c, o, { f: 988, type: 'square', dur: 0.1, gain: 0.16 }); tone(c, o, { f: 1319, type: 'square', t0: 0.13, dur: 0.12, gain: 0.16 }); },
  yukselen: (c, o) => tone(c, o, { f: 520, f2: 1560, type: 'triangle', dur: 0.32, gain: 0.4 }),
  damla: (c, o) => tone(c, o, { f: 1600, f2: 420, dur: 0.18, gain: 0.5 }),
  gong: (c, o) => { tone(c, o, { f: 196, dur: 2.2, gain: 0.5, attack: 0.01 }); tone(c, o, { f: 293.7, dur: 1.6, gain: 0.25 }); tone(c, o, { f: 523, dur: 0.9, gain: 0.1 }); },
  tik: (c, o) => tone(c, o, { f: 1800, dur: 0.05, gain: 0.25, attack: 0.002 }),
  // Zamanlayıcı uyarı sesleri (Faz 9): kısa, dosyasız, Web Audio ile üretilir
  chime: (c, o) => { tone(c, o, { f: 880, dur: 0.9, gain: 0.35 }); tone(c, o, { f: 1319, t0: 0.12, dur: 0.9, gain: 0.3 }); tone(c, o, { f: 1760, t0: 0.24, dur: 1.1, gain: 0.25 }); },
  ping: (c, o) => tone(c, o, { f: 1568, dur: 0.5, gain: 0.4, attack: 0.002 }),
  soft: (c, o) => { tone(c, o, { f: 523, type: 'triangle', dur: 0.7, gain: 0.35, attack: 0.04 }); tone(c, o, { f: 659, type: 'triangle', t0: 0.18, dur: 0.8, gain: 0.3, attack: 0.04 }); },
  alarm: (c, o) => { for (let i = 0; i < 3; i++) { tone(c, o, { f: 880, type: 'square', t0: i * 0.28, dur: 0.14, gain: 0.16 }); tone(c, o, { f: 660, type: 'square', t0: i * 0.28 + 0.14, dur: 0.14, gain: 0.16 }); } },
  horn: (c, o) => { tone(c, o, { f: 220, f2: 233, type: 'sawtooth', dur: 0.9, gain: 0.2, attack: 0.08 }); tone(c, o, { f: 330, f2: 349, type: 'sawtooth', dur: 0.9, gain: 0.12, attack: 0.08 }); },
  harp: (c, o) => { [523, 659, 784, 1047].forEach((f, i) => tone(c, o, { f, t0: i * 0.11, dur: 0.9, gain: 0.3, attack: 0.003 })); },
  stagger: (c, o) => {
    // Derin gong + zırh kırılma/çınlama: 110Hz sub-gong, 220Hz ve 440Hz metalik gövde, 880->240Hz kırılma piki
    tone(c, o, { f: 110, f2: 65, type: 'triangle', dur: 2.4, gain: 0.65, attack: 0.005 });
    tone(c, o, { f: 220, dur: 1.8, gain: 0.35, attack: 0.008 });
    tone(c, o, { f: 440, dur: 1.2, gain: 0.22, attack: 0.005 });
    tone(c, o, { f: 880, f2: 240, type: 'sawtooth', dur: 0.25, gain: 0.28, attack: 0.003 });
  },
  lowhp: (c, o) => {
    // Nabız / Kalp atışı: gerçekçi çift vuruş (lub-dub) - hem dahili hoparlör hem kulaklıkta tok ve net
    // Lub: derin bas + işitilebilir gövde
    tone(c, o, { f: 80, f2: 45, type: 'triangle', t0: 0, dur: 0.18, gain: 0.7, attack: 0.008 });
    tone(c, o, { f: 160, f2: 85, type: 'sine', t0: 0, dur: 0.12, gain: 0.45, attack: 0.005 });
    // Dub: derin bas + işitilebilir gövde
    tone(c, o, { f: 70, f2: 40, type: 'triangle', t0: 0.16, dur: 0.22, gain: 0.65, attack: 0.008 });
    tone(c, o, { f: 140, f2: 75, type: 'sine', t0: 0.16, dur: 0.14, gain: 0.4, attack: 0.005 });
  },
  threat: (c, o) => {
    // Keskin çift uyarı alarmı: 880Hz ve 1760Hz testere dişi ikili ping
    tone(c, o, { f: 880, type: 'sawtooth', t0: 0, dur: 0.09, gain: 0.35, attack: 0.003 });
    tone(c, o, { f: 1760, type: 'sawtooth', t0: 0.11, dur: 0.13, gain: 0.4, attack: 0.003 });
  },
  potion: (c, o) => {
    // Hafif damla / iksir içme: 650Hz -> 2100Hz yükselen su damlası ve rezonans
    tone(c, o, { f: 650, f2: 2100, type: 'sine', t0: 0, dur: 0.14, gain: 0.45, attack: 0.003 });
    tone(c, o, { f: 1400, dur: 0.08, gain: 0.22, attack: 0.003 });
  },
};

// Sesli okuma kuyruğu: aynı anda gelen okumalar birbirini kesmez, sırayla okunur.
// Kuyruk en çok 5 öğe tutar (taşarsa en eskisi atılır); 12 sn'den eski öğe okunmaz (gecikmiş uyarı anlamsız).
const TTS_MAX = 5;
const TTS_STALE_MS = 12000;
const ttsQ = [];
let ttsBusy = null;

function pickVoice(prefix) {
  try {
    const voices = speechSynthesis.getVoices() || [];
    return voices.find((x) => x.lang && x.lang.toLowerCase() === prefix.toLowerCase()) || voices.find((x) => x.lang && x.lang.toLowerCase().startsWith(prefix.slice(0, 2).toLowerCase())) || null;
  } catch { return null; }
}

function ttsNext() {
  if (ttsBusy) return;
  let it = null;
  while (ttsQ.length) {
    const c = ttsQ.shift();
    if (Date.now() - c.at <= TTS_STALE_MS) { it = c; break; }
  }
  if (!it) return;
  try {
    const u = new SpeechSynthesisUtterance(it.text);
    u.lang = it.lang;
    u.volume = it.volume;
    u.rate = it.rate;
    const voice = pickVoice(it.lang);
    if (voice) u.voice = voice;
    ttsBusy = u;
    window._ttsKeep = u; // Chromium tutulmayan konuşma nesnesini çöp toplayıp sesi çıkarmayabiliyor
    let done = false;
    let wd = 0;
    const fin = () => {
      if (done) return;
      done = true;
      clearTimeout(wd);
      if (ttsBusy === u) ttsBusy = null;
      if (window._ttsKeep === u) window._ttsKeep = null;
      ttsNext();
    };
    u.onend = u.onerror = fin;
    wd = setTimeout(fin, 10000); // bitiş olayı hiç gelmezse kuyruk takılmasın
    try { speechSynthesis.resume(); } catch {}
    speechSynthesis.speak(u);
  } catch { ttsBusy = null; }
}

function ttsEnqueue(text, lang, volume, rate) {
  if (!text || typeof speechSynthesis === 'undefined') return;
  if (ttsQ.length >= TTS_MAX) ttsQ.shift();
  ttsQ.push({ text: String(text), lang, volume: Math.min(1, Math.max(0.01, volume)), rate, at: Date.now() });
  ttsNext();
}

// Zamanlayıcı uyarısı sesli okuma: sabit İngilizce, mümkünse en-US/en-* ses; yoksa varsayılan ses
function speak(text, volume = 0.7, lang = 'en') {
  try {
    const v = Number(volume);
    if (!text || !Number.isFinite(v) || v <= 0) return;
    ttsEnqueue(text, lang === 'tr' ? 'tr-TR' : 'en-US', v, 1.05);
  } catch { /* yok */ }
}

let customs = [];
function setCustomSounds(list) { customs = list || []; }


function play(id, volume = 0.8, label = '', kind = null) {
  const v = typeof volume === 'number' ? volume : Number(volume);
  if (!id || id === 'sessiz' || id === 'none' || !Number.isFinite(v) || v <= 0) return;
  const safeVol = Math.min(1.5, Math.max(0.001, v));
  if (id === 'oku') {
    try {
      const currentLang = (typeof I18N !== 'undefined' && I18N.getLang)
        ? I18N.getLang()
        : (typeof document !== 'undefined' && document.documentElement.lang === 'tr' ? 'tr' : 'en');
      let text = label;
      const k = kind || (ALERT_TTS[label] ? label : null);
      // Faz 8.4: eşya uyarısında panelin ilettiği gerçek eşya adı/tür adı sabit metni ezmesin
      if (k && ALERT_TTS[k] && !(k === 'potion' && label && label !== 'potion')) {
        text = getAlertTts(k, currentLang);
      }
      if (!text) text = 'ready';
      ttsEnqueue(text, currentLang === 'tr' ? 'tr-TR' : 'en-US', safeVol, 1.15);
    } catch { /* yok */ }
    return;
  }
  const custom = customs.find((s) => s.id === id);
  if (custom) {
    try {
      const a = new Audio('file:///' + custom.file.replace(/\\/g, '/'));
      a.volume = Math.min(1, Math.max(0.01, safeVol));
      a.play().catch(() => {});
    } catch {}
    return;
  }
  const fn = SYNTH[id] || SYNTH.can;
  const c = ac();
  if (!c) return;
  const playDirect = () => {
    try {
      if (c.state === 'closed') return;
      const g = c.createGain();
      g.gain.value = safeVol;
      g.connect(c.destination);
      fn(c, g);
    } catch { /* sessiz devam */ }
  };
  if ((c.state === 'suspended' || c.state === 'interrupted') && typeof c.resume === 'function') {
    c.resume().then(() => {
      if (c.state === 'running') playDirect();
    }).catch(() => {});
  } else if (c.state === 'running') {
    playDirect();
  }
}

if (typeof window !== 'undefined') {
  const unlockAudio = () => {
    try {
      if (!ctx || ctx.state === 'closed') {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (AudioCtx) ctx = new AudioCtx();
      }
      if (ctx && (ctx.state === 'suspended' || ctx.state === 'interrupted')) {
        ctx.resume().catch(() => {});
      }
    } catch {}
  };
  window.addEventListener('pointerdown', unlockAudio, { passive: true });
  window.addEventListener('keydown', unlockAudio, { passive: true });
  window.addEventListener('click', unlockAudio, { passive: true });
}

window.Sound = { SOUNDS, ALERT_TTS, getAlertTts, play, speak, setCustomSounds, ac };
})();
