'use strict';
// Daeva Lens: Aion 2 için DPS ölçer + beceri bekleme süresi sesli bildirimi.
// Oyunun ağ trafiğinin kopyasını pasif olarak okur. Oyuna, belleğine veya paketlere dokunmaz.

const { app, BrowserWindow, Tray, Menu, ipcMain, globalShortcut, dialog, screen, shell, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { Capture } = require('./lib/capture');
const { Engine } = require('./lib/engine');
const { Ratings } = require('./lib/ratings');
const RATE = require('./lib/rate');
const { Ledger } = require('./lib/ledger');
const { BossLog } = require('./lib/bosslog');
const { PersonalBests } = require('./lib/pb');
const AutoShow = require('./lib/autoshow');
const DrawerTabs = require('./lib/drawertabs');
const MASK = require('./ui/mask');
const { MobsCache } = require('./lib/mobs-cache');
const PanelPos = require('./lib/panelpos');
const DrawerPos = require('./lib/drawerpos');
const Collide = require('./lib/collide');
const { hexToRgb, resolveAccent, DEFAULT_SHORTCUTS, mergeShortcuts } = require('./lib/themes');
const I18N = require('./ui/i18n');
const KEYSKILLS = require('./ui/keyskills');
const t = (x) => I18N.t(x);

// Geliştirme sürümü: kod paketlenmeden kaynak klasöründen yüklenir (bkz. tools/dev-bootstrap)
const DEV = process.env.DAEVA_DEV === '1';
// Deneysel özellikler (Shugo.GG karşılaştırması, 2026-10-11): sadece geliştirme sürümünde yüklenir.
// Son kullanıcı paketine lib/deneysel ve ui/dev hiç girmez (package.json build.files).
const TIMERS = require('./lib/timers');
const ALERTS = require('./lib/alerts');
let LABS = null;
if (DEV) { try { LABS = require('./lib/deneysel'); } catch (err) { LABS = null; } } // dosya yoksa sessizce atla
let labs = null;      // lib/deneysel Labs örneği (motorun ext'i)
let labsWin = null;   // ui/dev/labs.html
let sharedMasker = null; // yayıncı modu takma ad haritası (oturum boyunca)
let playback = null;  // uygulama içi kayıt oynatma { file, speed, clock, stop, done, n }
let dev = null;       // geliştirme araçları (lib/dev)
const OLD_DATA = path.join(app.getPath('appData'), 'Aion2 Savas Paneli');
app.setPath('userData', path.join(app.getPath('appData'), 'Daeva Lens'));
app.setAppUserModelId('com.daevalens.app');
if (app.commandLine) app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }

const DATA = () => app.getPath('userData');
const SETTINGS_FILE = () => path.join(DATA(), 'ayarlar.json');
const LOG_FILE = () => path.join(DATA(), 'gunluk.log');
// S-10 (Faz 6, 2026-10-11): eski 'kimlik → ad' önbelleği. Kimlikler oturum değişince başkasına geçtiği için
// (kayıtla doğrulandı) artık kullanılmıyor; açılışta bir kez silinir.
const OLD_PLAYERS_FILE = () => path.join(DATA(), 'oyuncular.json');
const PARTY_FILE = () => path.join(DATA(), 'parti.json'); // oturumlar arası grup üyeleri önbelleği
const MOBS_FILE = () => path.join(DATA(), 'canavarlar.json'); // oturumlar arası canavar ve boss veritabanı (Faz 2F)

function loadParty() {
  try {
    const raw = JSON.parse(fs.readFileSync(PARTY_FILE(), 'utf8'));
    // bayat grup önbelleği yok sayılır (5 dk'dan eski ya da zaman damgasız): açılışta eski parti/zindan ilanı gelmesin
    if (raw && raw.members && raw.members.length > 0 && typeof raw.at === 'number' && Date.now() - raw.at >= 0 && Date.now() - raw.at <= 300000) return raw;
  } catch {}
  return null;
}
function saveParty(p) {
  try {
    if (p && p.members && p.members.length > 0) {
      fs.promises.writeFile(PARTY_FILE(), JSON.stringify({ size: p.size, dungeon: p.dungeon || 0, members: p.members, at: Date.now() }, null, 2)).catch(() => {});
    }
  } catch {}
}
function clearParty() {
  try {
    if (fs.existsSync(PARTY_FILE())) fs.unlinkSync(PARTY_FILE());
  } catch {}
}

function removeOldPlayersFile() {
  try {
    if (fs.existsSync(OLD_PLAYERS_FILE())) { fs.unlinkSync(OLD_PLAYERS_FILE()); log('S-10: eski oyuncular.json silindi'); }
  } catch {}
}

let mobsCache = null;
function loadMobsCache() {
  try {
    mobsCache = new MobsCache(MOBS_FILE());
  } catch {
    mobsCache = new MobsCache(null);
  }
}

// ---------------------------------------------------------------------------
// Günlük ve ayarlar
// ---------------------------------------------------------------------------

// B-19: gunluk.log 2 MB'ı geçince gunluk.1.log'a taşınır (bir önceki yedeğin üstüne), yenisi başlar.
// En fazla ~4 MB yer kaplar.
const LOG_MAX_BYTES = 2 * 1024 * 1024;
let logSize = -1;
let logHook = null; // Faz 5.0-K.2: geliştirme sürümünde satırlar oturum kaydına da gider (lib/dev.js)
let logFlushing = false;
let logFlushPending = false;
let logQueue = [];
let logFlushTimer = null;

function flushLogSync() {
  if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
  if (!logQueue.length) return;
  const chunk = logQueue.join('');
  logQueue = [];
  try {
    if (logSize < 0) { try { logSize = fs.statSync(LOG_FILE()).size; } catch { logSize = 0; } }
    if (logSize > LOG_MAX_BYTES) {
      try { fs.renameSync(LOG_FILE(), LOG_FILE().replace(/\.log$/, '.1.log')); } catch {}
      logSize = 0;
    }
    fs.appendFileSync(LOG_FILE(), chunk);
    logSize += Buffer.byteLength(chunk);
  } catch {}
}

async function flushLogAsync() {
  if (logFlushTimer) { clearTimeout(logFlushTimer); logFlushTimer = null; }
  if (logFlushing) {
    logFlushPending = true;
    return;
  }
  if (!logQueue.length) return;
  logFlushing = true;
  logFlushPending = false;
  const chunk = logQueue.join('');
  logQueue = [];
  try {
    let size = 0;
    try {
      const st = await fs.promises.stat(LOG_FILE());
      size = st.size;
    } catch { size = 0; }
    logSize = size;
    if (logSize > LOG_MAX_BYTES) {
      try {
        await fs.promises.rename(LOG_FILE(), LOG_FILE().replace(/\.log$/, '.1.log'));
        logSize = 0;
      } catch {}
    }
    await fs.promises.appendFile(LOG_FILE(), chunk);
    logSize += Buffer.byteLength(chunk);
  } catch {} finally {
    logFlushing = false;
    if (logFlushPending || logQueue.length >= 50) {
      flushLogAsync();
    } else if (logQueue.length > 0 && !logFlushTimer) {
      logFlushTimer = setTimeout(flushLogAsync, 200);
    }
  }
}

function log(...a) {
  const line = new Date().toISOString() + ' ' + a.map((x) => (typeof x === 'string' ? x : JSON.stringify(x))).join(' ') + '\n';
  if (logHook) { try { logHook(line); } catch { /* yok say */ } }
  logQueue.push(line);
  if (logQueue.length >= 50) {
    if (logFlushTimer) clearTimeout(logFlushTimer);
    flushLogAsync();
  } else if (!logFlushTimer) {
    logFlushTimer = setTimeout(flushLogAsync, 200);
  }
}

process.on('uncaughtException', (err) => {
  try { log('ANA SUREC HATA (uncaughtException):', (err && err.stack) || err); } catch { console.error(err); }
});
process.on('unhandledRejection', (reason) => {
  try { log('ANA SUREC RED (unhandledRejection):', (reason && reason.stack) || reason); } catch { console.error(reason); }
});

const DEFAULTS = {
  panelBounds: null,
  panelHomeTop: false,     // Faz 5.0-P.1: panelBounds.y = üst barın ev konumu (eski kayıtta alt yarıdaki panel alt kenara bağlıydı)
  opacity: 0.92,
  clickThrough: false,
  posLock: false,          // konum kilidi: pencere sürüklenemez (tıklama normal çalışır)
  onlyMine: true,
  view: 'auto',
  autoStart: false,
  accent: 'gold',          // gold | ice | purple | neon | custom
  customAccent: '#f2b33d', // özel renk (hex)
  customAccentRgb: '242, 179, 61', // özel renk (r, g, b)
  shortcuts: { ...DEFAULT_SHORTCUTS },
  charClasses: {},     // Faz 5.2: karakter adı → sınıf (sadece kendi karakterlerin), ör. { "Player1": 14 }
  idleSec: 8,
  volume: 0.8,
  combatOnlySound: false,
  showCooldowns: false,
  cdViewMode: 'icons', // 'icons' | 'bars'
  cdOnlyOnCooldown: false, // sadece bekleme süresindeyken göster
  showTarget: false,
  showGS: false,        // Faz 6.2b (S-17): grup üyesinin adının yanında Gear Score (0x0297)
  showCP: false,        // Faz 6.2b (S-17): grup üyesinin adının yanında Combat Power (0x0297)
  bossView: true,      // boss dövüşünde sadece boss hasarı (false ise tüm hasar)
  visualToasts: false,  // panel üzerinde görsel bildirim rozetleri (toast)
  soundStagger: false,  // Faz 7: boss kırılma uyarısı sesi (gong/break)
  soundLowHp: false,    // Faz 7: düşük can nabız sesi
  soundPotion: false,   // Faz 7: iksir içme su damlası sesi
  itemTts: 'off',     // Faz 8.4: eşya sesli uyarısı: 'kind' (kısa tür adı) | 'name' (tam eşya adı) | 'off'
  bossTarget: false,    // Faz 8.6: boss kartında "Hedef: <oyuncu>" rozeti
  showIdleParty: false, // hasar vurmayan parti üyeleri de 0 hasarla listede görünsün
  soundChoiceStagger: 'stagger',
  soundChoiceLowHp: 'lowhp',
  soundChoicePotion: 'potion',
  maxRows: 8,
  cd: {},        // base -> { on, cdMs, sound, earlyMs }
  learned: {},   // base -> ms
  seenSkills: {},  // bir kez görülen kendi becerilerin: base -> { name, raw } (listede hep görünsün)
  castBases: [],   // 0x0238 ile görülen beceriler
  activeBases: [], // hedefli (tür 2) kullanımı görülen beceriler
  serverBases: [], // kalan süresini sunucu bildiren beceriler
  customSounds: [], // { id, name, file }
  ownManual: null,
  uiScale: 'auto',  // 'auto' (ekrana göre) ya da sayı
  lang: null,       // 'tr' | 'en' (boşsa Windows diline göre)
  charName: null,   // kullanıcının karakter adı (otomatik öğrenilir veya elle girilir)
  panelZoom: null,  // kayıtlı panel boyutunun hangi ölçekte olduğu
  deneysel: {},           // yalnız geliştirme: deneysel özellik anahtarları { buffs: true, ... } (lib/deneysel FEATURES)
  deneyselBolge: 'global-eu', // yalnız geliştirme: etkinlik zamanlayıcısının sunucu bölgesi
  deneyselUstte: false,   // yalnız geliştirme: Deneysel penceresi oyunun üstünde kalsın
  timersOn: false,         // Faz 8.3: dünya boss / etkinlik zamanlayıcıları (genel gösterim)
  timerRegion: 'global-eu', // Faz 8.3: sunucu bölgesi (lib/timers REGIONS)
  timerAlarms: {},        // Faz 8.3: etkinlik başına alarm { invasion: true, ... } (varsayılan hepsi kapalı)
  timerAlertMode: 'off', // Faz 9: uyarı türü 'sound' | 'text' | 'both' | 'off'
  timerAlertSteps: [10, 5, 1, 0], // Faz 9: kaç dakika kala uyarılsın (15/10/5/1; 0 = başlangıç)
  timerSound: 'chime',    // Faz 9: uyarı sesi (Web Audio ile üretilir)
  timerVolume: 70,        // Faz 9: uyarı ses seviyesi 0-100 (sentez sesi + sesli okuma)
  timerBeep: false,        // Faz 9: uyarı sesi (zil) çal; sesli okumadan bağımsız
  timerTts: false,         // Faz 9: uyarıyı İngilizce sesli oku
  timerToastMode: 'auto', // Faz 9: ekran uyarısı 'hold' (Gizle'ye basana kadar) | 'auto' (N sn sonra kapanır)
  timerToastSec: 15,      // Faz 9: otomatik kapanma süresi (sn)
  timerCombat: 'quiet',   // Faz 9: savaşta 'quiet' (ses yok, kısa sessiz yazı) | 'normal'
  playerRatingsOn: true,  // Faz 8.2: oyuncu değerlendirme / kara liste rozetleri (yerel dosya, ağ yok)
  deathRecap: true,       // Faz 8.9: Ölümler sekmesinde tıklayınca açılan ölüm özeti zaman tüneli (kim / hangi beceri / ne kadar)
  blacklistAlert: false,   // Kara listedeki oyuncu partiye girince panelde kırmızı uyarı (oyuncu başına oturumda bir kez; yerel, ağ yok)
  personalBest: false,     // Faz 8.14: boss kişisel en iyi DPS rekoru bildirimi ve altın kupa rozeti (yerel dosya)
  streamerMode: false,    // Faz 8.13: yayıncı modu: oyuncu adları yalnız gösterimde takma adla maskelenir
  screenProtect: false,   // açılırsa panel ekran görüntüsü/yayın yakalamadan gizlenir (setContentProtection); varsayılan kapalı
  autoShowWithGame: true, // Faz 8.17: oyun trafiği (Npcap) gelmeyince autoHideSec sn sonra panel gizlenir, paket gelince kendiliğinden görünür
  autoHideSec: 30,        // paket gelmeyince panelin gizlenme süresi (sn, 10-300; paket akışına bakılır; yardımcı exe yalnız süreç listesinden oyun bağlantılarını bulur, oyun belleği okunmaz)
};

let settings = { ...DEFAULTS };

// Faz 8.3: yalnız bilinen etkinlik kimlikleri ve yalnız true değerleri tutulur
function cleanTimerAlarms(v) {
  const o = {};
  if (v && typeof v === 'object') for (const id of TIMERS.EVENT_IDS) if (v[id] === true) o[id] = true;
  return o;
}

function loadSettings() {
  migrateOldData();
  let raw0 = {}; // dosyadaki ham ayarlar (varsayılanlar karışmadan; eski ayar çevirileri için)
  try {
    const raw = JSON.parse(fs.readFileSync(SETTINGS_FILE(), 'utf8'));
    if (raw && typeof raw === 'object') raw0 = raw;
    settings = { ...DEFAULTS, ...raw };
    if (raw && raw.shortcuts) {
      settings.shortcuts = mergeShortcuts(raw.shortcuts);
    }
  } catch {
    settings = { ...DEFAULTS };
  }
  // Faz 8.3: bölge ilk kez seçiliyorsa eski deneysel bölge değerinden al; geçersizse varsayılan
  if (raw0.timerRegion === undefined && raw0.deneyselBolge) settings.timerRegion = raw0.deneyselBolge;
  settings.timerRegion = TIMERS.normRegion(settings.timerRegion);
  settings.timersOn = settings.timersOn === true;
  settings.timerAlarms = cleanTimerAlarms(settings.timerAlarms);
  ALERTS.normalize(settings);
  settings.charClasses = KEYSKILLS.normCharClasses(settings.charClasses);
  // Discord webhook ve Paylaşım resmi özellikleri kaldırıldı: eski discord*/sharecard* ve Faz 8.7 boss uyarı ayarlarını sil
  for (const k of ['bossAoeAlert', 'bossAoeVoice']) delete settings[k];
  // "Boss hedefi sende" uyarısı kaldırıldı: eski ses/seçim ayarlarını sil
  for (const k of ['soundThreat', 'soundChoiceThreat']) delete settings[k];
  delete settings.miniMode; // mini mod kaldırıldı: eski kayıtlı ayar yok sayılır
  delete settings.autoSize; // "Panel boyutunu otomatik ayarla" tiki kaldırıldı: panel her zaman içeriğe göre boyutlanır
  settings.autoHideSec = AutoShow.normHideSec(settings.autoHideSec);
  for (const k of Object.keys(settings)) if (k.startsWith('sharecard')) delete settings[k];
  for (const k of Object.keys(settings)) if (k.startsWith('discord')) delete settings[k];
  // Skill Bar HUD kaldırıldı: eski skillbar* ayarlarını sil
  for (const k of Object.keys(settings)) if (k.startsWith('skillbar')) delete settings[k];
  // Eski tuş göstergesi (kaldırıldı): kalan keys*/skillBindings/hiddenKeys ayarlarını temizle
  for (const k of Object.keys(settings)) if (k.startsWith('keys') || k === 'skillBindings' || k === 'hiddenKeys') delete settings[k];
  // Eski sürümden kalan hatalı öğrenilmiş süreleri (5 sn altı veya resmi taban süresiyle birebir aynı olanlar) temizle
  if (settings.learned) {
    const { getDefaultCooldown } = require('./lib/cooldowns');
    for (const [base, ms] of Object.entries(settings.learned)) {
      const b = Number(base);
      if (ms < 5000 || (getDefaultCooldown(b) > 0 && ms === getDefaultCooldown(b))) {
        delete settings.learned[base];
      }
    }
  }
  // A-1 (Hata Avı, 2026-10-12): Eskiden burada "ana sınıf" dışındaki becerilerin ayarları (cd, learned,
  // seenSkills, castBases, activeBases) her açılışta siliniyordu; ikinci sınıfta karakteri olan kullanıcı
  // o karakterin seslerini her gün kaybediyordu. Beceri kodu sınıfı zaten taşıdığı için sınıflar dosyada
  // karışmadan yan yana durur; liste gösterilirken o anki sınıfa göre süzülür (skillRows), bekleme süreleri
  // de kendi sınıfımız dışındaki kullanımları almaz (lib/cooldowns.js ownClass). Açılışta hiçbir şey silinmez.
}

// Aion2 Combat Panel (1.x) ayarlarını bir kez taşı. Öğrenilen süreler ve beceri kümeleri
// eski kimlik tahmininin yanlışlarıyla kirlendiği için (başka sınıfların becerileri) alınmaz.
function migrateOldData() {
  try {
    if (fs.existsSync(SETTINGS_FILE()) || !fs.existsSync(path.join(OLD_DATA, 'ayarlar.json'))) return;
    const old = JSON.parse(fs.readFileSync(path.join(OLD_DATA, 'ayarlar.json'), 'utf8'));
    for (const k of ['learned', 'castBases', 'activeBases', 'ownManual']) delete old[k];
    fs.mkdirSync(DATA(), { recursive: true });
    const oldSounds = path.join(OLD_DATA, 'sesler');
    if (fs.existsSync(oldSounds)) {
      fs.cpSync(oldSounds, path.join(DATA(), 'sesler'), { recursive: true });
      old.customSounds = (old.customSounds || []).map((c) => ({ ...c, file: path.join(DATA(), 'sesler', path.basename(c.file)) }));
    }
    fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(old, null, 1));
    log('eski ayarlar taşındı', OLD_DATA);
  } catch (err) { log('eski ayarlar taşınamadı', err.message); }
}
let saveTimer = null;
function saveSettings() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(async () => {
    if (dev) dev.settingsSaved(settings); // Faz 5.0-K.2: geliştirme kaydına sadece değişen ayarlar
    try {
      await fs.promises.mkdir(DATA(), { recursive: true });
      await fs.promises.writeFile(SETTINGS_FILE() + '.tmp', JSON.stringify(settings, null, 1));
      await fs.promises.rename(SETTINGS_FILE() + '.tmp', SETTINGS_FILE());
    } catch (err) { log('ayarlar yazılamadı', err.message); }
  }, 300);
}

// ---------------------------------------------------------------------------
// Motor ve yardımcı
// ---------------------------------------------------------------------------

const status = { running: false, backend: null, error: null, waiting: false, conns: 0, lastPkt: 0, recording: null, vpnHint: null };
let engine = null;

// Kendi sınıfımız: dövüşte bulunan (B-31 oylaması, panelle aynı kaynak) > karakter adına göre hatırlanan >
// kayıtlı becerilerin çoğunluğu. Uygulama açılır açılmaz, dövüşe girmeden menü doğru sınıfla gelir.
function ownClassAuto() {
  const live = engine ? KEYSKILLS.validClass((engine.ownId !== null && engine.meter.classes.get(engine.ownId)) || engine.cds.ownClass || null) : null;
  const charName = settings.charName || (engine && engine.ownId !== null ? engine.meter.names.get(engine.ownId) : null) || null;
  const r = KEYSKILLS.pickOwnClass({ live, charName, charClasses: settings.charClasses, seenBases: Object.keys(settings.seenSkills || {}) });
  if (r.remember && charName) {
    settings.charClasses = KEYSKILLS.normCharClasses({ ...settings.charClasses, [charName]: r.remember });
    saveSettings();
  }
  return r.cls;
}
// Kendi sınıfımız için tek kaynak
function currentOwnClass() {
  return (engine && engine.ownId !== null && engine.meter.classes.get(engine.ownId)) || (engine && engine.cds.ownClass) || ownClassAuto() || null;
}
let capture = null;
let panelWin = null;
let tray = null;
let selectedEnc = 0; // 0 = güncel
let selectedBoss = null; // null = normal dövüşler, sayı = boss geçmişi indeksi
let rec = null;
let zoom = 1;   // arayüz ölçeği (uiZoom)
const accentRgb = () => resolveAccent(settings);
// Windows ile başladıysa panel oyun trafiği gelene kadar gizli kalır
let startHidden = process.argv.includes('--gizli');      // { stream, file, until }

// "Sadece dövüşte ses": son 10 sn'de hasar ya da son 30 sn'de kendi beceri kullanımın varsa dövüştesin.
// (Deadshot'u kullanıp beklerken hasar olmasa da hazır sesi duyulmalı.)
function inCombat() {
  const m = engine.meter;
  const now = Date.now();
  return (!!m.cur && now - m.cur.last < 10000) || now - (engine.lastOwnAt || 0) < 30000;
}

function soundFor(base) {
  const c = settings.cd[base] || {};
  return { sound: c.sound || 'can', volume: settings.volume };
}

function onEngineEvent(e) {
  switch (e.type) {
    case 'ready':
    case 'warn': {
      const isTimer = e.why && e.why.includes('zamanlayıcı');
      if (settings.combatOnlySound && !inCombat() && !e.fromServer && !isTimer) return;
      const s = soundFor(e.base);
      send(panelWin, 'alert', { kind: e.type, base: e.base, name: e.name, sound: e.type === 'warn' ? 'tik' : s.sound, volume: settings.volume, visual: settings.visualToasts === true });
      return;
    }
    case 'changed':
      return;
    case 'stagger':
      if (settings.soundStagger === true || settings.visualToasts === true) {
        const snd = (settings.soundStagger === true) ? (settings.soundChoiceStagger || 'stagger') : 'sessiz';
        const isTr = (settings.lang === 'tr' || (typeof I18N !== 'undefined' && I18N.getLang && I18N.getLang() === 'tr'));
        send(panelWin, 'alert', {
          kind: 'stagger',
          sound: snd,
          volume: settings.volume,
          name: t('Boss Stagger'),
          tts: isTr ? 'Boss kırıldı!' : 'Boss staggered!',
          visual: settings.visualToasts === true,
        });
      }
      return;
    case 'lowhp':
      if (settings.soundLowHp === true || settings.visualToasts === true) {
        const snd = (settings.soundLowHp === true) ? (settings.soundChoiceLowHp || 'lowhp') : 'sessiz';
        const isTr = (settings.lang === 'tr' || (typeof I18N !== 'undefined' && I18N.getLang && I18N.getLang() === 'tr'));
        send(panelWin, 'alert', {
          kind: 'lowhp',
          sound: snd,
          volume: settings.volume,
          name: t('Low HP Alert'),
          tts: isTr ? 'Canın azaldı!' : 'Low health warning!',
          visual: settings.visualToasts === true,
        });
      }
      return;
    case 'potion':
      if (settings.soundPotion === true || settings.visualToasts === true) {
        let snd = (settings.soundPotion === true) ? (settings.soundChoicePotion || 'potion') : 'sessiz';
        if (snd === 'oku' && settings.itemTts === 'off') snd = 'potion'; // TTS kapalıysa konuşma yerine iksir sesi
        const isTr = (settings.lang === 'tr' || (typeof I18N !== 'undefined' && I18N.getLang && I18N.getLang() === 'tr'));
        send(panelWin, 'alert', {
          kind: 'potion',
          sound: snd,
          volume: settings.volume,
          name: e.name || t('Potion'),
          tts: itemTtsText(e),
          visual: settings.visualToasts === true,
        });
      }
      return;
    case 'bases':
      settings.castBases = e.castBases;
      settings.activeBases = e.activeBases;
      settings.serverBases = e.serverBases;
      saveSettings();
      return;
    case 'learned':
      settings.learned[e.base] = e.ms;
      saveSettings();
      return;
    case 'own':
      log('kendi karakter', e.id, e.source, e.why || '');
      if (e.id && !settings.charName) {
        const n = engine.meter.names.get(e.id);
        if (n) {
          settings.charName = n;
          saveSettings();
        }
      }
      return;
    case 'name':
      if (e.id && e.name) {
        if (!settings.charName && engine && engine.ownId === e.id) {
          settings.charName = e.name;
          saveSettings();
          broadcast(true);
        }
      }
      return;
    case 'char-name':
      if (e.name && settings.charName !== e.name) {
        settings.charName = e.name;
        saveSettings();
        broadcast(true);
      }
      return;
    case 'diag':
      if (dev) dev.event(e.ev);
      return;
    case 'party':
      log('grup', e.size, 'zindan', e.dungeon, e.members.join(', '));
      saveParty(e);
      partyNow = Array.isArray(e.memberDetails) ? e.memberDetails.slice(0, 40) : null;
      warnBlacklisted(e.memberDetails);
      return;
    case 'party-clear':
      partyNow = null;
      clearParty();
      return;
    case 'new-skill':
      if (!settings.seenSkills[e.base]) { settings.seenSkills[e.base] = { name: e.name, raw: e.raw }; saveSettings(); }
      send(panelWin, 'skills-changed');
      return;
    default:
  }
}

// Oyuncu defteri (userData/oyuncu_defteri.jsonl): biten her boss karşılaşmasındaki oyuncular kalıcı yazılır. Kayıt oynatma ve
// "Oyuncu puanlama" kapalıyken yazılmaz (oynatılan eski kayıt bugünün tarihiyle deftere girmesin).
let ledger = null;
function getLedger() {
  if (!ledger) { ledger = new Ledger(path.join(DATA(), 'oyuncu_defteri.jsonl')); ledger.load(); }
  return ledger;
}
function onBossRecord(rec) {
  if (playback || settings.playerRatingsOn === false) return;
  if (getLedger().record(rec)) send(drawerWin, 'ratings-changed', null);
}

// Kalıcı boss geçmişi (userData/boss_gecmisi/): biten her boss dövüşünün özeti indekse, raporu ayrı dosyaya yazılır.
// Liste açılışta yalnız indeksten okunur; rapor tıklanınca okunur. Kayıt oynatılırken yazılmaz (defterle aynı kural).
let bossLog = null;
function getBossLog() {
  if (!bossLog) { bossLog = new BossLog(path.join(DATA(), 'boss_gecmisi')); bossLog.load(); }
  return bossLog;
}
function onBossSave(r) {
  if (playback) return;
  if (getBossLog().save(r)) send(drawerWin, 'boss-log-changed', null);
}

// Kara listedeki oyuncu partiye girince panelde bir kez uyarı (oyuncu başına oturum başına). Ad yayıncı modunda maskelenir.
const blWarned = new Set();
function warnBlacklisted(details) {
  if (settings.playerRatingsOn === false || settings.blacklistAlert !== true || !Array.isArray(details)) return;
  const r = getRatings();
  for (const m of details) {
    if (!m || !m.name || (settings.charName && m.name.toLowerCase() === settings.charName.toLowerCase())) continue;
    const id = m.name.toLowerCase() + '|' + (m.server || 0);
    if (blWarned.has(id) || !r.isBlacklisted(m.name, m.server > 0 ? String(m.server) : '')) continue;
    blWarned.add(id);
    const shown = settings.streamerMode ? getMasker().alias(m.name, m.cls || null, false, 'Me') : m.name;
    send(panelWin, 'alert', { kind: 'blacklist', sound: 'threat', volume: settings.volume, name: t('Blacklisted player in party') + ': ' + shown, visual: settings.visualToasts === true });
  }
}

// Faz 8.14: kişisel en iyi (userData/personal_bests.json). Ayar kapalıysa hiçbir şey okunmaz/yazılmaz.
let personalBests = null;
function onBossEnd(b) {
  if (settings.personalBest !== true) return null;
  if (!personalBests) { personalBests = new PersonalBests(path.join(DATA(), 'personal_bests.json')); personalBests.load(); }
  const r = personalBests.submit(b.code, b.name, b.dps, b.dur);
  if (r.isNew) {
    const isTr = (settings.lang === 'tr' || (typeof I18N !== 'undefined' && I18N.getLang && I18N.getLang() === 'tr'));
    const k = b.dps >= 1e6 ? (b.dps / 1e6).toFixed(2) + 'M' : b.dps >= 1e3 ? (b.dps / 1e3).toFixed(1) + 'K' : String(Math.round(b.dps));
    send(panelWin, 'alert', {
      kind: 'pb', sound: 'sessiz', volume: settings.volume,
      name: t('New record!') + ' ' + (b.name || 'Boss') + ' · ' + k + ' DPS',
      visual: settings.visualToasts === true,
    });
  }
  return r;
}

// ---------------------------------------------------------------------------
// Yayıncı modu: TEK takma ad kaynağı (panel, çekmece). Renderer'lar state.mask tablosunu okur.
function getMasker() { if (!sharedMasker) sharedMasker = MASK.create(); return sharedMasker; }

function makeEngine(opts = {}) {
  if (LABS) {
    if (!labs) labs = new LABS.Labs({ dataDir: DATA, log, flags: settings.deneysel, region: settings.deneyselBolge });
    else labs.reset();
  }
  engine = new Engine({
    ...(opts.now ? { now: opts.now } : {}),
    ...(labs ? { ext: labs } : {}),
    charName: settings.charName,
    idleMs: settings.idleSec * 1000,
    bossIdleMs: 45000,
    cdConfig: settings.cd,
    learned: settings.learned,
    castBases: settings.castBases,
    activeBases: settings.activeBases,
    serverBases: settings.serverBases,
    mobsCache: mobsCache,
    onEvent: onEngineEvent,
    log: (...a) => log(...a),
  });
  engine.meter.onBossEnd = onBossEnd;
  engine.meter.onBossRecord = onBossRecord;
  engine.meter.onBossSave = onBossSave;
  const savedParty = loadParty();
  if (savedParty) engine.meter.setParty(savedParty, { info: true }); // yalnız ad/sınıf bilgisi; parti durumu kadro paketinden gelir
  if (settings.ownManual) engine.setOwnManual(settings.ownManual);
}

let pktErrors = 0;

function onHelperLine(line) {
  if (rec) rec.stream.write(line + '\n');
  if (dev) dev.line(line);
  let m;
  try { m = JSON.parse(line); } catch { return; }
  if (m.type === 'pkt') {
    if (playback) return; // geliştirme: kayıt oynatılırken canlı trafik motora girmez
    status.lastPkt = Date.now();
    if (startHidden && panelWin) { startHidden = false; panelWin.showInactive(); updateTray(); }
    autoShowPacket();
    // motor hatası yardımcı akışını kesmesin; ilk 5 hata + sonra her 100.'sü loga yazılır
    try { engine.packet(m); } catch (err) {
      pktErrors++;
      if (pktErrors <= 5 || pktErrors % 100 === 0) log('[paket hatası]', pktErrors, err && err.message);
    }
    return;
  }
  if (m.type === 'conns') { status.conns = (m.conns || []).length; return; }
  if (m.type === 'stats') return;
  if (m.type === 'error') status.error = m.msg;
  log('[yardımcı]', m.type, m.msg || '');
}

// ---------------------------------------------------------------------------
// Trafik kaydı (yeni paketleri incelemek için; varsayılan kapalı)
// ---------------------------------------------------------------------------

function startRecording(sec = 90) {
  if (rec) return;
  const dir = path.join(DATA(), 'kayitlar');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'kayit-' + new Date().toISOString().replace(/[:.]/g, '-') + '.jsonl');
  rec = { stream: fs.createWriteStream(file), file, until: Date.now() + sec * 1000 };
  rec.timer = setTimeout(stopRecording, sec * 1000);
  status.recording = rec.until;
  log('kayıt başladı', file);
  if (panelWin && !panelWin.isDestroyed()) send(panelWin, 'notice', `${t('Traffic recording started')} (${sec}s)`);
  updateTray();
}

function stopRecording() {
  if (!rec) return;
  clearTimeout(rec.timer);
  rec.stream.end();
  log('kayıt bitti', rec.file);
  if (panelWin && !panelWin.isDestroyed()) send(panelWin, 'notice', t('Recording finished'));
  if (tray && tray.displayBalloon) tray.displayBalloon({ title: t('Recording finished'), content: path.basename(rec.file) });
  rec = null;
  status.recording = null;
  updateTray();
}

// Kayıt dosyasını gerçek zamanlı oynat (deneme için): --tekrar=<kayit.jsonl>
function replayFile(file) {
  let lines;
  try { lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean); } catch (err) { log('tekrar dosyası okunamadı', err.message); return; }
  status.running = true; status.backend = 'tekrar';
  const msgs = [];
  for (const l of lines) { try { const m = JSON.parse(l); if (m.type === 'pkt') msgs.push(m); } catch { /* yok say */ } }
  if (!msgs.length) return;
  const t0 = msgs[0].t, start = Date.now();
  const speed = Number(process.env.DAEVA_TEKRAR_HIZ || 1); // geliştirme: hızlı oynatma
  let i = 0;
  const step = () => {
    const el = (Date.now() - start) * speed;
    if (playback) { log('tekrar durdu: Deneysel oynatma başladı'); return; } // iki kayıt aynı motora karışmasın
    while (i < msgs.length && msgs[i].t - t0 <= el) { status.lastPkt = Date.now(); if (dev) dev.line(JSON.stringify(msgs[i])); engine.packet(msgs[i++]); }
    if (i < msgs.length) setTimeout(step, 20);
    else log('tekrar bitti');
  };
  step();
}

// ---------------------------------------------------------------------------
// Pencereler
// ---------------------------------------------------------------------------

function send(win, ch, data) {
  if (win && !win.isDestroyed()) win.webContents.send(ch, data);
}

const MIN_H = 60;
let legacyBottom = null; // eski kayıt: alt kenar (ilk boy ölçümünde ev konumuna çevrilir)
let lastFitBounds = null; // fitPanel'in son verdiği yer (kendi taşımamızı kullanıcı taşıması sanmamak için)
let isFitting = false;
const isOwnFit = (b) => !!lastFitBounds && ['x', 'y', 'width', 'height'].every((k) => Math.abs(b[k] - lastFitBounds[k]) <= 3);

// Arayüz ölçeği: ekranın yüksekliğine göre (1080 = 1x, 1440 = 1.3x), 1–1.5 arası.
// Pencere boyutları ölçekle büyür; içerik CSS zoom ile büyütülür (diğer pencereler etkilenmez).
function uiZoom(bounds) {
  if (typeof settings.uiScale === 'number' && settings.uiScale > 0) return settings.uiScale;
  const d = bounds ? screen.getDisplayMatching(bounds) : screen.getPrimaryDisplay();
  const z = Math.round((d.workArea.height / 1080) * 20) / 20;
  return Math.min(1.5, Math.max(1, z));
}

let scaling = false;

function applyZoom(newZ) {
  if (!panelWin || panelWin.isDestroyed() || Math.abs(newZ - zoom) <= 0.005) return;
  scaling = true;
  const oldZ = zoom;
  const prevZoom = settings.panelZoom || oldZ;
  zoom = newZ;
  settings.panelZoom = newZ;

  const wa = screen.getDisplayMatching(panelWin.getBounds()).workArea;

  const b = panelWin.getBounds();
  const home = settings.panelBounds || b;
  const baseW = (settings.panelBounds && settings.panelBounds.width) ? (settings.panelBounds.width / prevZoom) : (b.width / oldZ);
  const baseH = (settings.panelBounds && settings.panelBounds.height) ? (settings.panelBounds.height / prevZoom) : (b.height / oldZ);

  const newW = Math.min(wa.width, Math.max(Math.round(270 * newZ), Math.round(baseW * newZ)));
  const newH = Math.min(wa.height, Math.max(Math.round(MIN_H * newZ), Math.round(baseH * newZ)));

  // Faz 5.0-P.1: üst bar ev konumunda kalır, panel aşağı uzar; sığmazsa sadece geçici olarak yukarı itilir
  const pos = PanelPos.place({ x: home.x, y: home.y, width: newW }, newH, wa);

  panelWin.setMinimumSize(Math.round(270 * newZ), Math.round(MIN_H * newZ));
  panelWin.setBounds(pos);
  settings.panelBounds = { x: home.x, y: home.y, width: newW, height: newH };
  if (typeof syncDrawerPosition === 'function') syncDrawerPosition();
  saveSettings();
  broadcast(true);
  setTimeout(() => { scaling = false; }, 80);
}

function checkDisplayChange() {
  if (scaling || settings.uiScale !== 'auto' || !panelWin || panelWin.isDestroyed()) return;
  const b = panelWin.getBounds();
  const newZ = uiZoom(b);
  if (Math.abs(newZ - zoom) > 0.005) {
    applyZoom(newZ);
  }
}

function createPanel() {
  const wa = screen.getPrimaryDisplay().workArea;
  let b = settings.panelBounds || { width: 340, height: 420, x: wa.x + wa.width - 360, y: wa.y + 120 };
  // 1.1.0'daki büyüme hatasından kalan dev boyutu düzelt
  if (b.width > 640) b = { ...b, width: 340, height: Math.min(b.height, 480) };
  // ölçek değiştiyse (ilk açılış ya da ekran değişimi) kayıtlı boyutu ona göre büyüt
  const z = uiZoom(b);
  const pz = settings.panelZoom || 1;
  if (Math.abs(z - pz) > 0.01) {
    b = { ...b, width: Math.round(b.width * z / pz), height: Math.round(b.height * z / pz) };
    settings.panelZoom = z;
    settings.panelBounds = b;
    saveSettings();
  }
  zoom = z;
  // Faz 5.0-P.1: kayıtlı yer = üst barın ev konumu. Eski kayıt (alt yarıda alt kenara bağlı) bir kez çevrilir:
  // üst barın boştaki yeri ilk boy ölçümünde alt kenardan hesaplanır (fitPanel). Kullanıcının ayarı kaybolmaz.
  if (!settings.panelHomeTop) {
    legacyBottom = settings.panelBounds ? PanelPos.legacyBottom(settings.panelBounds, screen.getDisplayMatching(settings.panelBounds).workArea) : null;
    if (legacyBottom === null) { settings.panelHomeTop = true; saveSettings(); }
  }
  const openAt = PanelPos.place(b, b.height, screen.getDisplayMatching(PanelPos.barRect(b)).workArea);
  panelWin = new BrowserWindow({
    ...openAt,
    minWidth: Math.round(270 * zoom), minHeight: Math.round(MIN_H * zoom),
    frame: false, transparent: true, resizable: true, skipTaskbar: false,
    alwaysOnTop: true, hasShadow: false, show: false,
    title: 'Daeva Lens',
    icon: path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'),
    webPreferences: { preload: path.join(__dirname, 'ui', 'preload.js'), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  panelWin.setAlwaysOnTop(true, 'screen-saver');
  applyScreenProtect();
  // sürükleme dinleyicisi (win-drag) attach ile kurulur; çekmece açıkken panel ona çarpmaz
  Collide.attach(panelWin, () => (drawerWin && !drawerWin.isDestroyed() && drawerWin.isVisible() ? drawerWin.getBounds() : null));
  panelWin.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) log('[panel]', e.message, e.lineNumber); });
  panelWin.loadFile(path.join(__dirname, 'ui', 'panel.html'));
  panelWin.once('ready-to-show', () => { if (!startHidden) panelWin.showInactive(); applyClickThrough(); });
  const saveB = (resized) => {
    if (panelWin.isDestroyed() || scaling || isFitting) return;
    const b = panelWin.getBounds();
    // otomatik boyutun kendi taşıması/boyutlandırması ev konumu sayılmaz (itilmiş yer kaydedilmez)
    if (!isOwnFit(b)) rememberBounds(b, resized === true);
    if (typeof syncDrawerPosition === 'function') syncDrawerPosition();
  };
  panelWin.on('moved', () => { saveB(false); checkDisplayChange(); });
  panelWin.on('resized', () => saveB(true));
  panelWin.on('restore', () => broadcast(true));
  panelWin.on('show', () => broadcast(true));
  panelWin.on('closed', () => { panelWin = null; });
}

// ---------------------------------------------------------------------------
// ---------------------------------------------------------------------------
// Ayarlar ve Boss penceresi: bağımsız, şeffaf, animasyonlu pencere
// ---------------------------------------------------------------------------

let drawerWin = null;

function createDrawerWindow() {
  if (drawerWin && !drawerWin.isDestroyed()) return drawerWin;
  const dsz = DrawerPos.drawerSize(screen.getPrimaryDisplay().workArea, zoom); // dar ekranda ekranı aşmaz
  drawerWin = new BrowserWindow({
    width: dsz.width,
    height: dsz.height,
    frame: false,
    transparent: true,
    resizable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    show: false,
    hasShadow: false,
    title: 'Daeva Lens · Settings',
    webPreferences: {
      preload: path.join(__dirname, 'ui', 'preload.js'),
      backgroundThrottling: false,
      contextIsolation: true,
    },
  });
  drawerWin.setAlwaysOnTop(true, 'screen-saver');
  Collide.attach(drawerWin, () => (panelWin && !panelWin.isDestroyed() ? panelWin.getBounds() : null));
  applyScreenProtect();
  drawerWin.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) log('[drawer]', e.message, e.lineNumber); });
  drawerWin.loadFile(path.join(__dirname, 'ui', 'drawer.html'));
  drawerWin.on('closed', () => { drawerWin = null; });
  return drawerWin;
}

function syncDrawerPosition() {
  if (!drawerWin || drawerWin.isDestroyed() || !drawerWin.isVisible() || !panelWin || panelWin.isDestroyed()) return;
  const b = panelWin.getBounds();
  const wa = screen.getDisplayMatching(b).workArea;
  drawerWin.setBounds(DrawerPos.drawerRect(b, wa, zoom));
}

function drawerOpen(tab) {
  if (!panelWin) createPanel();
  const win = createDrawerWindow();
  syncDrawerPosition();
  if (!win.isVisible()) win.show();
  win.focus();
  send(win, 'tab', DrawerTabs.normTab(tab));
  send(panelWin, 'drawer-status', { open: true });
  broadcast(true);
}

function drawerClose() {
  if (!drawerWin || drawerWin.isDestroyed() || !drawerWin.isVisible()) return;
  send(drawerWin, 'drawer-closing');
  setTimeout(() => {
    if (drawerWin && !drawerWin.isDestroyed()) drawerWin.hide();
    if (panelWin && !panelWin.isDestroyed()) send(panelWin, 'drawer-status', { open: false });
  }, 160);
}

function drawerToggle(tab) {
  if (drawerWin && !drawerWin.isDestroyed() && drawerWin.isVisible()) {
    drawerClose();
  } else {
    drawerOpen(tab);
  }
}

function openSettings(tab) {
  drawerOpen(tab);
}

// ---------------------------------------------------------------------------
// Otomatik boyut: panel boşken sadece başlık + özet kadar, dövüşte satırlar geldikçe büyür.
// Kullanıcının elle verdiği yükseklik en büyük sınırdır (settings.panelBounds.height).
// Faz 5.0-P.1: üst bar kullanıcının bıraktığı yerde (ev konumu, settings.panelBounds.y) durur,
// panel hep aşağı uzar. Alta sığmazsa sadece gerektiği kadar yukarı itilir, kısalınca ev konumuna döner.
// ---------------------------------------------------------------------------

// panelin kaydedilen yeri (ev konumu): sadece kullanıcı sürükleyince / boyutlandırınca değişir.
// otomatik boyut açıkken yükseklik = kullanıcının en büyük yüksekliği
function rememberBounds(b, userResized) {
  const old = settings.panelBounds || b;
  if (userResized) settings.panelBounds = { ...b };
  else settings.panelBounds = { x: b.x, y: b.y, width: b.width, height: Math.max(old.height || b.height, b.height) };
  settings.panelHomeTop = true;
  legacyBottom = null;
  saveSettings();
}

function fitPanel(h) {
  if (!panelWin || panelWin.isDestroyed()) return;
  const c = panelWin.getBounds();
  const home = settings.panelBounds ? { ...settings.panelBounds } : { ...c };
  const wa = screen.getDisplayMatching(PanelPos.barRect(home)).workArea;
  // Otomatik boyutta içeriği tam sar
  const want = Math.max(Math.round(MIN_H * zoom), Math.min(wa.height, Math.ceil(h)));
  if (Collide.isDragging(panelWin)) {
    // sürüklenirken: olduğu yerde boyu değişir, ev konumuna zıplamaz (bırakınca yeni ev konumu olur)
    if (want !== c.height) { lastFitBounds = { ...c, height: want }; panelWin.setBounds(lastFitBounds); }
    return;
  }
  if (legacyBottom !== null && settings.panelBounds) {
    // eski kayıt: üst barın boştaki yeri = alt kenar - ilk ölçülen boy
    home.y = legacyBottom - want;
    settings.panelBounds = { ...settings.panelBounds, y: home.y };
    settings.panelHomeTop = true;
    log('panel ev konumu eski kayıttan çevrildi', { altKenar: legacyBottom, boy: want, y: home.y });
    legacyBottom = null;
    saveSettings();
  }
  const pos = PanelPos.place({ x: home.x, y: home.y, width: c.width }, want, wa);
  if (pos.height === c.height && pos.width === c.width && pos.x === c.x && pos.y === c.y) return;
  isFitting = true;
  lastFitBounds = pos;
  panelWin.setBounds(pos);
  setTimeout(() => { isFitting = false; }, 150);
}

function applyClickThrough() {
  if (panelWin) {
    // kilit değişimi pencere boyunu kaydırırsa geri al (aç/kapa birikip paneli uzatmasın); bu taşıma ev konumu sayılmaz
    const fixed = PanelPos.keepSize(panelWin, () => panelWin.setIgnoreMouseEvents(!!settings.clickThrough, { forward: true }));
    if (fixed) { isFitting = true; lastFitBounds = fixed; setTimeout(() => { isFitting = false; }, 150); }
    send(panelWin, 'click-through', !!settings.clickThrough);
  }
  updateTray();
  broadcast(true);
}

function togglePanel() {
  if (!panelWin) { autoShow.manualShow(); createPanel(); return; }
  if (panelWin.isVisible()) { autoShow.manualHide(); panelWin.hide(); } else { autoShow.manualShow(); panelWin.showInactive(); }
  updateTray();
}

// ---------------------------------------------------------------------------
// Faz 8.17: oyunla otomatik göster/gizle (saf durum makinesi: lib/autoshow). Oyun varlığı yalnız
// Npcap yakalama sinyalinden (son oyun paketi) anlaşılır; süreç/pencere taraması YOK.
const autoShow = AutoShow.create({ now: Date.now(), enabled: DEFAULTS.autoShowWithGame });
let autoShowLive = false; // yalnız canlı yakalamada (kayıt tekrarında değil) çalışır
function autoShowPacket() {
  if (!autoShowLive) return;
  autoShow.setEnabled(settings.autoShowWithGame !== false);
  autoShow.setHideSec(settings.autoHideSec);
  const vis = !!(panelWin && !panelWin.isDestroyed() && panelWin.isVisible());
  if (autoShow.gamePacket(Date.now(), vis) === 'show' && panelWin && !panelWin.isDestroyed()) { panelWin.showInactive(); updateTray(); }
}
function autoShowTick() {
  if (!autoShowLive) return;
  autoShow.setEnabled(settings.autoShowWithGame !== false);
  autoShow.setHideSec(settings.autoHideSec);
  const vis = !!(panelWin && !panelWin.isDestroyed() && panelWin.isVisible());
  const drawerOpen =!!(drawerWin && !drawerWin.isDestroyed() && drawerWin.isVisible());
  if (autoShow.tick(Date.now(), { visible: vis, drawerOpen }) === 'hide') { panelWin.hide(); updateTray(); }
}

// ---------------------------------------------------------------------------
// Durum yayını (4 Hz)
// ---------------------------------------------------------------------------

// B-13: Sayaçta hiçbir şey değişmediyse (meter.version aynı) ve seçenekler aynıysa önceki hesap
// tekrar kullanılır. Saate bağlı alanlar (hedef zaman aşımı) en geç 1 sn'de bir yenilenir.
const snapCache = new Map();
let snapForce = false;
function cachedSnapshot(which, opts) {
  const key = which + '|' + JSON.stringify(opts);
  const stamp = engine.meter.version + ':' + engine.ownId + ':' + Math.floor(Date.now() / 1000);
  const hit = snapCache.get(key);
  if (!snapForce && hit && hit.stamp === stamp) return hit.snap;
  const snap = engine.meter.snapshot(which, opts);
  if (snapCache.size > 8) snapCache.clear();
  snapCache.set(key, { stamp, snap });
  return snap;
}

// Sol sayaç satırlarına kara liste bayrağı (hasar vurmayan sanal parti satırları dahil): ad + sunucu ile defterde 'blacklist' etiketi var mı.
// Yalnız bellekteki indeksi okur; ağ yok. Bayrak ana süreçte işaretlenir, panel yayıncı modunda göstermez.
function flagBlacklisted(enc) {
  if (!enc || !Array.isArray(enc.actors)) return;
  const on = settings.playerRatingsOn !== false;
  let R = null;
  try { R = on ? getRatings() : null; } catch { R = null; }
  for (const a of enc.actors) {
    let bl = false;
    if (R && !a.own && typeof a.name === 'string' && a.name && !a.name.includes('#')) { try { bl = R.isBlacklisted(a.name, a.server || 0); } catch { bl = false; } }
    if (bl) a.bl = true; else if (a.bl) delete a.bl;
  }
}

function panelState(cdList) {
  const isBossFight = (engine.meter.cur && engine.meter.cur.isBoss) || (selectedBoss !== null && engine.meter.bossHistory.length > 0);
  let effView = settings.view;
  if (settings.view === 'auto') {
    // 'auto': partideysen YALNIZ PARTİ (kadro), değilsen YALNIZ BEN (açık dünyada boss dövüşünde bile yabancılar girmez)
    effView = engine.meter.inGroup ? 'party' : 'me';
  }
  const snapOpts = {
    onlyMine: settings.onlyMine,
    view: effView,
    bossView: settings.bossView !== false,
    showIdle: settings.showIdleParty === true, // hasar vurmayan parti üyeleri 0 hasarla listede kalsın
  };
  if (selectedBoss !== null) snapOpts.boss = selectedBoss;
  const snap = cachedSnapshot(selectedEnc, snapOpts);
  flagBlacklisted(snap.enc);
  const now = Date.now();
  const cds =(cdList || engine.cds.list()).filter((s) => settings.cd[s.base] && settings.cd[s.base].on);

  const bossHistory = engine.meter.bossHistory;
  let bossEnc = null;
  const drawerVisible = drawerWin && !drawerWin.isDestroyed() && drawerWin.isVisible();
  if (drawerVisible && bossHistory && bossHistory.length > 0) {
    const bossIdx = (selectedBoss !== null && selectedBoss < bossHistory.length) ? selectedBoss : 0;
    bossEnc = cachedSnapshot(0, { boss: bossIdx, bossView: true }).enc;
  }

  return {
    now,
    status: {
      running: status.running, backend: status.backend, error: status.error, waiting: status.waiting,
      conns: status.conns, live: now - status.lastPkt < 5000, recording: status.recording,
      ownId: engine.ownId,
      charName: settings.charName || null,
      ping: engine.ping && Date.now() - engine.pingAt < 30000 ? engine.ping : null,
      vpnHint: status.vpnHint || null,
      npcapMissing: !status.running && /Npcap is required/.test(status.error || ''), // Faz 8.16: kırmızı rozet + kurulum ipucu
    },
    selected: selectedEnc,
    selectedBoss,
    encounters: snap.encounters,
    bosses: snap.bosses || [],
    bossView: settings.bossView !== false,
    enc: snap.enc,
    bossEnc,
    deaths: snap.deaths || [], // Sürüm 2.0: son ölüm özetleri (Ölümler sekmesi)
    cds,
    view: { mode: settings.view, eff: effView, needOwn: snap.needOwn, party: engine.meter.party ? { size: engine.meter.party.size, dungeon: engine.meter.party.dungeon, members: [...engine.meter.party.members] } : null },
    ui: { lang: settings.lang, zoom, uiScale: settings.uiScale, accent: accentRgb(), opacity: settings.opacity, showCooldowns: settings.showCooldowns, cdViewMode: settings.cdViewMode || 'icons', cdOnlyOnCooldown: !!settings.cdOnlyOnCooldown, showTarget: settings.showTarget === true, showGS: settings.showGS === true, showCP: settings.showCP === true, bossTarget: settings.bossTarget === true, maxRows: settings.maxRows, onlyMine: settings.onlyMine, clickThrough: settings.clickThrough, posLock: !!settings.posLock, visualToasts: settings.visualToasts === true, deathRecap: settings.deathRecap !== false, personalBest: settings.personalBest === true, streamerMode: !!settings.streamerMode },
  };
}

// Faz 8.4: eşya uyarısının okunacak metni. 'name' tam ad (bilinmiyorsa tür adı), 'kind' kısa tür adı, 'off' boş.
const ITEM_KIND_LABEL = { scroll: 'Scroll', potion: 'Potion', food: 'Food', drink: 'Drink', rebirth: 'Resurrection', item: 'Item' };
function itemTtsText(e) {
  const mode = settings.itemTts;
  if (mode === 'off') return '';
  const kindName = t(ITEM_KIND_LABEL[e.itemKind] || 'Item');
  if (mode === 'kind') return kindName;
  const known = e.name && !/^Skill \d+$/.test(e.name);
  return known ? t(e.name) : kindName;
}

let lastVersion = -1;
let lastCdSig = '';
function broadcast(force) {
  engine.tick();
  const panelActive = panelWin && !panelWin.isDestroyed() && panelWin.isVisible() && !panelWin.isMinimized();
  const drawerActive = drawerWin && !drawerWin.isDestroyed() && drawerWin.isVisible() && !drawerWin.isMinimized();
  if (!panelActive && !drawerActive) return;
  const cdList = engine.cds.list(); // tek çağrı: imza + panelState aynı listeyi kullanır
  let cdSig = '';
  for (let i = 0; i < cdList.length; i++) cdSig += cdList[i].readyAt + ',';
  const live = engine.meter.cur !== null;
  if (!force && !live && engine.meter.version === lastVersion && cdSig === lastCdSig && Date.now() % 2000 > 260) return;
  lastVersion = engine.meter.version;
  lastCdSig = cdSig;
  snapForce = !!force; // ayar/seçim değişince önbellek kullanılmaz
  const st = panelState(cdList);
  snapForce = false;
  // Yayıncı modu: ad->etiket tablosu yalnız DEĞİŞTİĞİNDE (pencere başına) state'e eklenir; kapalıyken hiçbir iş yapılmaz
  let maskTbl = null;
  let maskSig = '';
  if (settings.streamerMode) {
    maskTbl = MASK.buildTable(getMasker(), st, settings.charName);
    maskSig = JSON.stringify(maskTbl);
  }
  const withMask = (win) => {
    if (!maskTbl) { maskSent.delete(win); return st; }
    if (!maskHooked.has(win)) { maskHooked.add(win); win.webContents.on('did-finish-load', () => maskSent.delete(win)); }
    if (maskSent.get(win) === maskSig) return st;
    maskSent.set(win, maskSig);
    return Object.assign({}, st, { mask: maskTbl });
  };
  if (panelActive) send(panelWin, 'state', withMask(panelWin));
  if (drawerActive) send(drawerWin, 'state', withMask(drawerWin));
}
const maskSent = new WeakMap(); // pencere -> en son gönderilen tablo imzası
const maskHooked = new WeakSet(); // yeniden yüklenen pencere tabloyu baştan alsın diye did-finish-load bağlanan pencereler

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------

function skillRows() {
  const seen = new Map(engine.cds.list().map((s) => [s.base, s]));
  // ayarlarda olan ya da daha önce görülmüş ama bu oturumda kullanılmamış beceriler de listelensin
  const { skillName } = require('./lib/skills');
  const { iconUrl } = require('./lib/icons');
  const { getDefaultCooldown } = require('./lib/cooldowns');
  const { classOf } = require('./lib/meter');
  // A-1: dövüşten önce de (canlı sınıf yokken) karakter adına göre hatırlanan sınıf kullanılır;
  // böylece öbür karakterin becerileri listeye karışmaz
  const ownCls = currentOwnClass();

  for (const base of new Set([...Object.keys(settings.cd), ...Object.keys(settings.seenSkills)])) {
    const b = Number(base);
    const cls = classOf(b);
    if (ownCls && cls && cls !== ownCls) continue;
    if (seen.has(b)) continue;
    const known = settings.seenSkills[base] || {};
    const raw = known.raw || b;
    const cfg = settings.cd[base] || {};
    const d = engine.cds.durationOf(b);
    const defMs = getDefaultCooldown(b);
    const learnedMs = settings.learned[b] || 0;
    const r = Math.floor(b / 10000) % 100;
    const isPassive = r >= 71 && r <= 80;
    seen.set(b, {
      base: b,
      icon: iconUrl(raw),
      name: cfg.name || known.name || skillName(raw),
      uses: 0,
      lastCast: 0,
      learnedMs,
      defaultMs: defMs,
      cdMs: d.ms,
      src: d.src,
      left: 0,
      passive: isPassive,
    });
  }
  return [...seen.values()].map((s) => ({ ...s, cfg: settings.cd[s.base] || null }));
}

// ---------------------------------------------------------------------------
// Deneysel özellikler (yalnız DAEVA_DEV)
// ---------------------------------------------------------------------------

function openLabs(tab) {
  if (!LABS) return;
  if (labsWin && !labsWin.isDestroyed()) { labsWin.show(); labsWin.focus(); if (tab) send(labsWin, 'labs-tab', tab); return; }
  const wa = screen.getPrimaryDisplay().workArea;
  labsWin = new BrowserWindow({
    width: 980, height: 720, minWidth: 560, minHeight: 420, x: wa.x + 80, y: wa.y + 60,
    title: 'Daeva Lens · Deneysel', backgroundColor: '#101216', autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'ui', 'dev', 'labs-preload.js'), contextIsolation: true },
  });
  labsWin.setAlwaysOnTop(!!settings.deneyselUstte, 'screen-saver');
  labsWin.loadFile(path.join(__dirname, 'ui', 'dev', 'labs.html'));
  labsWin.webContents.on('did-finish-load', () => { if (tab) send(labsWin, 'labs-tab', tab); });
  labsWin.on('closed', () => { labsWin = null; });
}

function labsState() {
  const L = labs.live(engine.now());
  L.playback = playback ? { file: path.basename(playback.file), speed: playback.speed, n: playback.n, done: !!playback.done, at: playback.clock } : null;
  L.ontop = !!settings.deneyselUstte;
  L.ownName = engine.charName || null;
  return L;
}

function labsArchive() {
  const idx = labs.readIndex();
  return idx.kayitlar || [];
}

// Kayıt oynatma: motor yeni kurulur, saati kaydın zaman damgalarıdır (x1/x4 gerçek zamanlı, max bekleme yok).
async function labsPlay(file, speed) {
  labsStopPlayback();
  const zlib = require('zlib');
  const readline = require('readline');
  const pb = { file, speed: speed === 'max' ? 'max' : Math.max(1, Number(speed) || 1), clock: 0, stop: false, done: false, n: 0 };
  playback = pb;
  makeEngine({ now: () => pb.clock || Date.now() });
  selectedEnc = 0; selectedBoss = null;
  status.backend = 'tekrar';
  log('deneysel: kayıt oynatma', path.basename(file), pb.speed);
  let t0 = null; const start = Date.now();
  try {
    const inp = /\.gz$/i.test(file) ? fs.createReadStream(file).pipe(zlib.createGunzip()) : fs.createReadStream(file);
    const rl = readline.createInterface({ input: inp, crlfDelay: Infinity });
    let batch = 0;
    for await (const line of rl) {
      if (pb.stop) { rl.close(); break; }
      if (!line.includes('"pkt"')) continue;
      let m; try { m = JSON.parse(line); } catch { continue; }
      if (m.type !== 'pkt') continue;
      if (t0 === null) t0 = m.t;
      if (pb.speed !== 'max') {
        const due = (m.t - t0) / pb.speed - (Date.now() - start);
        if (due > 15) await new Promise((r) => setTimeout(r, Math.min(due, 1000)));
        if (pb.stop) break;
      } else if (++batch % 3000 === 0) await new Promise((r) => setImmediate(r));
      pb.clock = m.t;
      status.lastPkt = Date.now();
      engine.packet(m);
      pb.n++;
    }
  } catch (err) { log('deneysel: oynatma hatası', err.message); }
  if (!pb.stop) { pb.clock += 120000; engine.tick(); pb.done = true; log('deneysel: oynatma bitti', pb.n); broadcast(true); }
}

function labsStopPlayback() {
  if (!playback) return false;
  playback.stop = true;
  playback = null;
  return true;
}

function labsGoLive() {
  if (!labsStopPlayback()) return;
  makeEngine();
  selectedEnc = 0; selectedBoss = null;
  status.backend = null;
  broadcast(true);
}

function registerLabsIpc() {
  ipcMain.handle('labs-state', () => labsState());
  ipcMain.handle('labs-set', (_e, patch) => {
    patch = patch || {};
    if (patch.flags) { labs.setFlags(patch.flags); settings.deneysel = { ...labs.flags }; }
    if (patch.region) { labs.setRegion(patch.region); settings.deneyselBolge = labs.region; }
    if (typeof patch.ontop === 'boolean') { settings.deneyselUstte = patch.ontop; if (labsWin && !labsWin.isDestroyed()) labsWin.setAlwaysOnTop(patch.ontop, 'screen-saver'); }
    saveSettings();
    return { flags: labs.flags, region: labs.region, ontop: !!settings.deneyselUstte };
  });
  ipcMain.on('labs-open', (_e, tab) => openLabs(tab));
  ipcMain.handle('labs-fights', () => ({ memory: labs.fights.map((f) => f.meta), archive: labsArchive() }));
  ipcMain.handle('labs-fight', (_e, id) => labs.fight(String(id || '')));
  ipcMain.handle('labs-pick', async () => {
    const r = await dialog.showOpenDialog(labsWin || undefined, {
      title: 'Kayıt seç', defaultPath: path.join(DATA(), 'kayitlar'),
      filters: [{ name: 'Daeva Lens kaydı', extensions: ['gz', 'jsonl'] }], properties: ['openFile'],
    });
    return r.canceled || !r.filePaths.length ? null : r.filePaths[0];
  });
  ipcMain.handle('labs-play', (_e, file, speed) => {
    if (!labs.flags.playback) return false;
    if (!file || !fs.existsSync(file) || !/\.(jsonl|gz)$/i.test(file)) return false;
    labsPlay(file, speed);
    return true;
  });
  ipcMain.handle('labs-speed', (_e, speed) => { if (playback) playback.speed = speed === 'max' ? 'max' : Math.max(1, Number(speed) || 1); return true; });
  ipcMain.handle('labs-live', () => { labsGoLive(); return true; });
  ipcMain.on('labs-open-archive', () => { const d = labs.archiveDir(); fs.mkdirSync(d, { recursive: true }); shell.openPath(d); });
  setInterval(() => { if (labsWin && !labsWin.isDestroyed() && labsWin.isVisible()) { try { send(labsWin, 'labs-live', labsState()); } catch (err) { log('deneysel: canlı durum', err.message); } } }, 500);
}

// ---------------------------------------------------------------------------
// Faz 9: zamanlayıcı uyarıları (ses + TTS panelde çalar; yazı kutusu ayrı, odak çalmayan pencerede)
// ---------------------------------------------------------------------------
function fightingNow() {
  const m = engine.meter;
  return ALERTS.inFight(Date.now(), m && m.cur ? m.cur.last : 0, engine.lastOwnAt || 0);
}

// name: timers.js'teki İngilizce ad; step: kalan dakika (0 = başlıyor)
function fireTimerAlert(name, step) {
  const d = ALERTS.decide(settings, fightingNow());
  const trLang = (settings.lang === 'tr' || (typeof I18N !== 'undefined' && I18N.getLang && I18N.getLang() === 'tr'));
  if (d.sound || d.tts) send(panelWin, 'timer-sound', { sound: d.sound ? settings.timerSound : 'sessiz', volume: settings.timerVolume / 100, tts: d.tts ? (trLang ? ALERTS.ttsText(t(name), step, 'tr') : ALERTS.ttsText(name, step)) : '', lang: trLang ? 'tr' : 'en', });
  if (d.toast) {
    const shown = t(name);
    const text = step === 0 ? `${shown}: ${t('starting now')}` : `${shown}: ${step} ${t('min left')}`;
    toastAdd(text, d.toast === 'quiet');
  }
}

const TOAST_W = 340;
const TOAST_MAX = 5;
const TOAST_QUIET_MS = 6000;
let toastWin = null;
let toastReady = false;
let toasts = [];       // { id, text, quiet, until (0 = Gizle'ye basana kadar) }
let toastSeq = 0;
let toastH = 0;

function createToastWindow() {
  if (toastWin && !toastWin.isDestroyed()) return toastWin;
  toastReady = false;
  toastWin = new BrowserWindow({
    width: Math.round(TOAST_W * zoom), height: Math.round(60 * zoom), x: 0, y: 0,
    frame: false, transparent: true, resizable: false, skipTaskbar: true, alwaysOnTop: true,
    focusable: false, show: false, hasShadow: false, title: 'Daeva Lens · Alerts',
    webPreferences: { preload: path.join(__dirname, 'ui', 'toast-preload.js'), backgroundThrottling: false, contextIsolation: true, nodeIntegration: false },
  });
  toastWin.setAlwaysOnTop(true, 'screen-saver');
  applyScreenProtect();
  toastWin.webContents.on('console-message', (e) => { if (e.level === 'error' || e.level === 3) log('[toast]', e.message, e.lineNumber); });
  toastWin.loadFile(path.join(__dirname, 'ui', 'toast.html'));
  toastWin.webContents.once('did-finish-load', () => { toastReady = true; try { toastWin.webContents.setZoomFactor(zoom); } catch {} toastPush(); });
  toastWin.on('closed', () => { toastWin = null; toastReady = false; });
  return toastWin;
}

function toastAdd(text, quiet) {
  const hold = !quiet && settings.timerToastMode === 'hold';
  const ms = quiet ? TOAST_QUIET_MS : settings.timerToastSec * 1000;
  toasts.push({ id: ++toastSeq, text, quiet, until: hold ? 0 : Date.now() + ms });
  while (toasts.length > TOAST_MAX) toasts.shift();
  createToastWindow();
  toastPush();
}

function toastClearAll() { if (toasts.length) { toasts = []; toastPush(); } }

function toastTick() {
  if (!toasts.length) return;
  const now = Date.now();
  const left = toasts.filter((x) => !x.until || x.until > now);
  if (left.length !== toasts.length) { toasts = left; toastPush(); }
}

// Konum: ekranın üst-ortası (panelin bulunduğu ekran; yoksa ana ekran). Odak çalınmaz: showInactive.
function toastPlace() {
  if (!toastWin || toastWin.isDestroyed()) return;
  const wa = (panelWin && !panelWin.isDestroyed() ? screen.getDisplayMatching(panelWin.getBounds()) : screen.getPrimaryDisplay()).workArea;
  const w = Math.round(TOAST_W * zoom);
  const h = Math.max(1, Math.min(Math.round(toastH * zoom) + 2, wa.height));
  try { toastWin.webContents.setZoomFactor(zoom); } catch { /* yok say */ } // içerik panelle aynı ölçekte
  toastWin.setBounds({ x: Math.round(wa.x + (wa.width - w) / 2), y: wa.y + Math.round(8 * zoom), width: w, height: h });
}

function toastPush() {
  if (!toastWin || toastWin.isDestroyed()) return;
  if (!toasts.length) { if (toastWin.isVisible()) toastWin.hide(); return; }
  if (!toastReady) return; // yükleme bitince did-finish-load yeniden çağırır
  const items = toasts.map((x) => ({ id: x.id, text: x.text, quiet: x.quiet, hold: !x.until && !x.quiet })); // Gizle düğmesi yalnız 'Gizle'ye basana kadar' kutularında
  send(toastWin, 'toasts', { items, hide: t('Hide'), accent: accentRgb(), opacity: settings.opacity });
  // yalnız sessiz yazı varsa pencere tıklanamaz (oyuna geçirgen); Gizle düğmesi olan varsa tıklanabilir
  toastWin.setIgnoreMouseEvents(!toasts.some((x) => !x.until && !x.quiet)); // düğme yoksa tıklamalar oyuna geçer
}

// Yazı kutusu içeriği ölçüsünü bildirince (toast-fit) yer ayarlanır ve pencere odak çalmadan gösterilir
function toastShown() {
  if (!toastWin || toastWin.isDestroyed() || !toasts.length) return;
  toastPlace();
  if (!toastWin.isVisible()) { toastWin.showInactive(); toastWin.setAlwaysOnTop(true, 'screen-saver'); }
}

function applyScreenProtect() {
  const on = settings.screenProtect === true;
  for (const w of [panelWin, drawerWin, toastWin]) {
    if (w && !w.isDestroyed()) w.setContentProtection(on);
  }
}

// Faz 8.2: oyuncu değerlendirme deposu (userData; ASAR salt-okunur). 500 ms debounce, çıkışta flush.
let ratings = null;
let ratingsPrefill = null;
let partyNow = null; // şimdiki partinin üyeleri (0x0297 memberDetails): boss kesilmeden de puanlanabilsin
let ratingsPick = null; // son sağ tıklanan oyuncu: hiçbir karşılaşmada yoksa puanlama ekranında tek kişilik sanal karşılaşma olur
let serversTbl = null;
function loadServers() {
  if (!serversTbl) { try { serversTbl = JSON.parse(fs.readFileSync(path.join(__dirname, 'data', 'servers.json'), 'utf8')); } catch { serversTbl = {}; } }
  return serversTbl;
}
function getRatings() {
  if (!ratings) {
    ratings = new Ratings(path.join(DATA(), 'player_ratings.json'), path.join(__dirname, 'data', 'player_ratings.json'));
    ratings.load();
    ratings.onChange = notifyRatings;
  }
  return ratings;
}
// Yayıncı modu: puanlama ekranındaki adlar da tek ana-süreç maskesinden (getMasker) takma ad alır
function ratingsMask(entries) {
  const me = settings.charName ? String(settings.charName).toLowerCase() : '';
  const tbl = {};
  for (const e of entries) {
    const k = MASK.keyOf(e.targetNickname);
    if (!(k in tbl)) tbl[k] = getMasker().alias(e.targetNickname, null, !!me && String(e.targetNickname).toLowerCase() === me, 'Me');
  }
  return tbl;
}
function ratingsPayload() { // panel rozetleri için: yalnız açık/kapalı + ad|sunucu indeksi
  const on = settings.playerRatingsOn !== false;
  return { on, index: on ? getRatings().indexObject() : {} };
}
// Puanlama ekranı: defterdeki karşılaşmalar (yeniden eskiye) + oyuncu özetleri; yayıncı modunda adlar tek maskeden takma ad alır
function ratePayload() {
  const on = settings.playerRatingsOn !== false;
  let live = null; // şimdiki parti + sürmekte olan savaş (deftere yalnız boss bitince yazılır; puanlama buna bağlı değil)
  if (on) {
    try {
      const byName = new Map();
      for (const m of partyNow || []) if (m && m.name) byName.set(String(m.name).toLowerCase(), { name: m.name, server: m.server || 0, cls: m.cls || 0, total: 0 });
      const e = engine.meter.snapshot(0, { view: 'all' }).enc;
      const fight = e && e.live && e.actors && e.actors.length;
      if (fight) {
        for (const a of e.actors) {
          if (!a.name) continue;
          const k = String(a.name).toLowerCase(); const o = byName.get(k);
          byName.set(k, { name: a.name, server: a.server || (o ? o.server : 0), cls: a.cls || (o ? o.cls : 0), total: a.total || 0 });
        }
      }
      if (byName.size) live = { at: fight ? e.start : Date.now(), boss: fight && e.boss ? e.boss.name : '', actors: [...byName.values()] };
    } catch { /* canlı veri okunamazsa yalnız defter gösterilir */ }
  }
  const d = on ? RATE.collect(getLedger(), getRatings(), { me: settings.charName, live, pick: ratingsPick, rated: true }) : { encs: [], total: 0, rated: 0, black: 0 };
  let mask = null;
  if (settings.streamerMode) {
    const seen = new Map();
    for (const e of d.encs) for (const p of e.players) seen.set(p.n.toLowerCase(), { targetNickname: p.n });
    mask = ratingsMask([...seen.values()]);
  }
  return { on, ...d, servers: loadServers(), alert: settings.blacklistAlert === true, mask };
}
function notifyRatings() {
  const on = settings.playerRatingsOn !== false;
  send(panelWin, 'ratings-changed', { on, index: on ? getRatings().indexObject() : {} });
  send(drawerWin, 'ratings-changed', null);
}

function registerIpc() {
  ipcMain.handle('get-settings', () => ({ settings, skills: skillRows(), ownId: engine.ownId, dataDir: DATA(), version: app.getVersion(), zoom,
    ...(labs ? { labs: { flags: labs.flags, region: labs.region, features: LABS.FEATURES, regions: Object.fromEntries(Object.entries(LABS.REGIONS).map(([k, v]) => [k, v.label])) } } : {}) }));
  ipcMain.handle('set-settings', (_e, patch) => {
    patch = patch || {};
    for (const [k, v] of Object.entries(patch || {})) {
      if (k in DEFAULTS) settings[k] = v;
    }
    if ('itemTts' in (patch || {}) && !['kind', 'name', 'off'].includes(settings.itemTts)) settings.itemTts = 'off';
    for (const bk of ['bossTarget', 'showIdleParty', 'bossView', 'deathRecap', 'personalBest', 'blacklistAlert', 'streamerMode', 'posLock']) {
      if (bk in (patch || {})) settings[bk] = !!settings[bk]; // Faz 8.6: yalnız mantıksal değer
    }
    if ('autoShowWithGame' in (patch || {})) settings.autoShowWithGame = !!settings.autoShowWithGame; // Faz 8.17: yalnız mantıksal değer
    if ('autoShowWithGame' in (patch || {})) {
      autoShow.setEnabled(settings.autoShowWithGame);
      // Ayar kapatılınca otomatik gizlenmiş panel geri gelir (mevcut davranış: panel hep görünür)
      if (!settings.autoShowWithGame && autoShow.autoHidden && panelWin && !panelWin.isDestroyed() && !panelWin.isVisible()) { panelWin.showInactive(); updateTray(); }
    }
    if ('autoHideSec' in patch) { settings.autoHideSec = AutoShow.normHideSec(settings.autoHideSec); autoShow.setHideSec(settings.autoHideSec); } // tamsayı 10-300 sn
    if ('timerRegion' in (patch || {})) settings.timerRegion = TIMERS.normRegion(settings.timerRegion);
    if ('playerRatingsOn' in (patch || {})) { settings.playerRatingsOn = !!settings.playerRatingsOn; notifyRatings(); }
    if ('timersOn' in (patch || {})) settings.timersOn = !!settings.timersOn;
    if ('timerAlarms' in (patch || {})) settings.timerAlarms = cleanTimerAlarms(settings.timerAlarms);
    if (Object.keys(patch).some((k) => k.startsWith('timerAlert') || ['timerSound', 'timerVolume', 'timerBeep', 'timerTts', 'timerToastMode', 'timerToastSec', 'timerCombat'].includes(k))) {
      ALERTS.normalize(settings);
      if (settings.timerAlertMode === 'sound' || settings.timerAlertMode === 'off') toastClearAll(); // yazı kapatıldıysa açık kutular da kapanır
    }
    if ('uiScale' in patch) {
      const b = panelWin ? panelWin.getBounds() : null;
      const newZ = uiZoom(b);
      applyZoom(newZ);
    }
    if ('cd' in patch) engine.cds.setConfig(settings.cd);
    if ('learned' in patch) engine.cds.learned = settings.learned;
    if ('idleSec' in patch) engine.meter.idleMs = settings.idleSec * 1000;
    if ('clickThrough' in patch) applyClickThrough();
    if ('screenProtect' in patch) applyScreenProtect();
    if ('lang' in patch) { I18N.setLang(settings.lang); updateTray(); }
    if ('charName' in patch) {
      settings.charName = patch.charName ? patch.charName.trim() : null;
      if (engine) engine.setCharName(settings.charName);
    }
    if ('shortcuts' in patch) {
      settings.shortcuts = mergeShortcuts(settings.shortcuts, patch.shortcuts);
      registerShortcuts();
    }
    if ('customAccent' in patch && !patch.customAccentRgb) {
      settings.customAccentRgb = hexToRgb(patch.customAccent) || '242, 179, 61';
    }
    if ('autoStart' in patch && !DEV) { try { app.setLoginItemSettings({ openAtLogin: !!settings.autoStart, args: ['--gizli'] }); } catch (err) { log('otomatik başlatma', err.message); } }
    saveSettings();
    broadcast(true);
    return true;
  });
  ipcMain.handle('get-timers', () => {
    const now = Date.now();
    return { now, region: settings.timerRegion, tz: TIMERS.REGIONS[settings.timerRegion].tz, events: TIMERS.allInfo(settings.timerRegion, now), reset: TIMERS.resetInfo(settings.timerRegion, now) };
  });
  ipcMain.handle('set-skill', (_e, base, cfg) => {
    if (cfg) {
      const known = engine.cds.skills.get(Number(base));
      settings.cd[base] = { ...(settings.cd[base] || {}), ...cfg };
      if (known) settings.cd[base].name = known.name;
    }
    else delete settings.cd[base];
    engine.cds.setConfig(settings.cd);
    saveSettings();
    broadcast(true);
    return settings.cd[base] || null;
  });
  ipcMain.handle('forget-learned', (_e, base) => { delete settings.learned[base]; delete engine.cds.learned[base]; saveSettings(); return true; });
  ipcMain.handle('reset-skill', (_e, base) => {
    const b = Number(base);
    if (settings.cd[b]) delete settings.cd[b].cdMs;
    delete settings.learned[b];
    delete engine.cds.learned[b];
    engine.cds.setConfig(settings.cd);
    saveSettings();
    broadcast(true);
    return true;
  });
  ipcMain.handle('skills', () => skillRows());
  ipcMain.handle('pick-sound', async () => {
    const r = await dialog.showOpenDialog(panelWin, { title: t('Choose a sound file'), filters: [{ name: t('Audio'), extensions: ['wav', 'mp3', 'ogg', 'm4a'] }], properties: ['openFile'] });
    if (r.canceled || !r.filePaths[0]) return null;
    const src = r.filePaths[0];
    const dir = path.join(DATA(), 'sesler');
    fs.mkdirSync(dir, { recursive: true });
    const id = 'dosya-' + Date.now().toString(36);
    const dst = path.join(dir, id + path.extname(src).toLowerCase());
    fs.copyFileSync(src, dst);
    const entry = { id, name: path.basename(src, path.extname(src)), file: dst };
    settings.customSounds = [...settings.customSounds, entry];
    saveSettings();
    send(panelWin, 'custom-sounds', settings.customSounds);
    return entry;
  });
  function loadMockBoss() {
    if (!engine) return;
    const durMs = 154000;
    const tEnd = Date.now();
    const t0 = tEnd - durMs;
    const bossId = 999901;
    const ownId = engine.ownId || 2987;
    const ownName = settings.charName || 'You';
    engine.ownId = ownId;
    engine.ownSource = 'mock';
    engine.meter.setOwn(ownId);
    engine.meter.setName(ownId, ownName);

    engine.meter.party = {
      size: 4,
      dungeon: 1,
      members: new Set([ownName, 'Aethelgard', 'Sylphira', 'Demyx']),
    };
    engine.meter.names.set(ownId, ownName);
    engine.meter.classes.set(ownId, 14);
    engine.meter.names.set(88001, 'Aethelgard');
    engine.meter.classes.set(88001, 15);
    engine.meter.names.set(88003, 'Demyx');
    engine.meter.classes.set(88003, 11);
    engine.meter.names.set(88002, 'Sylphira');
    engine.meter.classes.set(88002, 16);

    function makeActor(id, total, hits, skillsDef) {
      const skills = new Map();
      for (const sk of skillsDef) {
        skills.set(sk.code, {
          skill: sk.code,
          raw: sk.code,
          total: sk.dmg,
          hits: sk.hits,
          crits: Math.round(sk.hits * 0.45),
          critDmg: Math.round(sk.dmg * 0.65),
          backs: Math.round(sk.hits * 0.3),
          perfect: Math.round(sk.hits * 0.1),
          double: Math.round(sk.hits * 0.15),
          parry: 0,
          min: Math.round((sk.dmg / sk.hits) * 0.6),
          max: Math.round((sk.dmg / sk.hits) * 1.6),
          targets: new Set([bossId]),
          dot: !!sk.dot,
        });
      }
      return {
        id,
        total,
        hits,
        crits: Math.round(hits * 0.42),
        backs: Math.round(hits * 0.28),
        first: t0,
        last: tEnd,
        max: 950000,
        skills,
        targets: new Set([bossId]),
      };
    }

    const bActors = new Map();
    bActors.set(ownId, makeActor(ownId, 62450800, 284, [
      { code: 14010000, dmg: 22400000, hits: 32 },
      { code: 14020000, dmg: 17500000, hits: 14 },
      { code: 14030000, dmg: 10200000, hits: 88 },
      { code: 14110000, dmg: 5800000, hits: 36 },
      { code: 14040000, dmg: 3600000, hits: 28 },
      { code: 14080000, dmg: 2100000, hits: 18 },
      { code: 14050000, dmg: 850800, hits: 68 },
    ]));
    bActors.set(88001, makeActor(88001, 48920000, 196, [
      { code: 15020000, dmg: 20500000, hits: 18 },
      { code: 15010000, dmg: 14200000, hits: 24 },
      { code: 15030000, dmg: 8600000, hits: 12 },
      { code: 15040000, dmg: 3200000, hits: 22 },
      { code: 15050000, dmg: 1800000, hits: 16 },
      { code: 15060000, dmg: 620000, hits: 104 },
    ]));
    bActors.set(88003, makeActor(88003, 33810000, 210, [
      { code: 11010000, dmg: 13500000, hits: 45 },
      { code: 11020000, dmg: 10400000, hits: 22 },
      { code: 11030000, dmg: 5800000, hits: 38 },
      { code: 11040000, dmg: 2600000, hits: 40 },
      { code: 11050000, dmg: 1100000, hits: 45 },
      { code: 11060000, dmg: 410000, hits: 20 },
    ]));
    bActors.set(88002, makeActor(88002, 14120000, 98, [
      { code: 16020000, dmg: 6800000, hits: 30 },
      { code: 16030000, dmg: 4200000, hits: 28 },
      { code: 16010000, dmg: 1900000, hits: 40 },
      { code: 16040000, dmg: 820000, hits: 24 },
      { code: 16050000, dmg: 400000, hits: 15 },
    ]));

    const mockEnc = {
      start: t0,
      last: tEnd,
      isBoss: true,
      bossId,
      bossName: 'Stormwing Rudra',
      bossCode: 215432,
      bossMaxHp: 160000000,
      bossTotalDamage: 159300800,
      bossFirst: t0,
      bossLast: tEnd,
      bossKilled: true,
      bossKilledAt: tEnd,
      actors: bActors,
      bossActors: bActors,
      targets: new Set([bossId]),
      ownTargetDmg: new Map([[bossId, 62450800]]),
      taken: 48500,
      deaths: 0,
    };

    engine.meter.cur = null;
    engine.meter.history.unshift(mockEnc);
    if (engine.meter.history.length > 20) engine.meter.history.pop();
    engine.meter.bossHistory.unshift(mockEnc);
    if (engine.meter.bossHistory.length > 20) engine.meter.bossHistory.pop();
    engine.meter.version++;
  }

  if (LABS) {
    registerLabsIpc();
  } else {
    ipcMain.handle('labs-state', () => null);
    ipcMain.handle('labs-set', () => ({ ok: false }));
    ipcMain.on('labs-open', () => {});
    ipcMain.handle('labs-fights', () => ({ memory: [], archive: [] }));
    ipcMain.handle('labs-fight', () => null);
    ipcMain.handle('labs-pick', async () => null);
    ipcMain.handle('labs-play', () => false);
    ipcMain.handle('labs-speed', () => false);
    ipcMain.handle('labs-live', () => false);
    ipcMain.on('labs-open-archive', () => {});
  }

  // Sürüm 2.0 (Faz 7.5): sahte boss verisi sadece geliştirme sürümünde (DAEVA_DEV=1) kayıtlı
  if (DEV) {
    ipcMain.on('dev-load-mock-boss', () => {
      loadMockBoss();
      selectedEnc = 0;
      selectedBoss = 0;
      broadcast(true);
      if (!drawerWin || !drawerWin.isVisible()) openSettings('boss');
    });
  }

  ipcMain.on('reset', () => { engine.meter.reset(); selectedEnc = 0; selectedBoss = null; broadcast(true); });
  ipcMain.on('select-boss', (_e, i) => { selectedBoss = i !== null && i !== undefined ? Math.max(0, i | 0) : null; broadcast(true); });
  // Kalıcı boss geçmişi: liste (yalnız özetler), tek rapor (yayıncı modunda ad tablosuyla), tek karşılaşmayı silme
  ipcMain.handle('boss-log-list', () => getBossLog().list());
  ipcMain.handle('boss-log-get', (_e, fk) => {
    const enc = getBossLog().get(typeof fk === 'string' ? fk : '');
    if (!enc) return null;
    return { enc, mask: settings.streamerMode ? MASK.buildTable(getMasker(), { bossEnc: enc }, settings.charName) : null };
  });
  ipcMain.on('set-own', (_e, id) => {
    if (id && typeof id !== 'number') return; // hasar vurmayan parti üyesinin sanal satırı ('p:' + ad) kimlik olarak seçilemez
    settings.ownManual = id || null;
    if (id) {
      const n = engine.meter.names.get(id);
      if (n) {
        settings.charName = n;
        engine.setCharName(n);
      }
    }
    saveSettings();
    if (id) engine.setOwnManual(id);
    else engine.clearOwnManual();
    broadcast(true);
  });
  ipcMain.on('open-settings', (_e, tab) => openSettings(tab));
  ipcMain.on('drawer-toggle', (_e, tab) => drawerToggle(tab));
  ipcMain.on('drawer-close', () => drawerClose());
  ipcMain.handle('drawer', (_e, open) => (open ? drawerOpen() : drawerClose()));
  ipcMain.on('toggle-click-through', () => { settings.clickThrough = !settings.clickThrough; saveSettings(); applyClickThrough(); });
  Collide.setDragGuard(() => !!settings.posLock);
  ipcMain.on('toggle-pos-lock', () => togglePosLock());
  ipcMain.on('toast-hide', (_e, id) => { toasts = toasts.filter((x) => x.id !== id || x.quiet || x.until); toastPush(); });
  ipcMain.on('toast-fit', (_e, h) => { toastH = Math.max(0, Math.min(600, Number(h) || 0)); toastShown(); });
  ipcMain.handle('timer-test', () => { fireTimerAlert('Siege Bosses (Tamasa / Argo / Kaira)', 5); return true; });
  ipcMain.on('hide-panel', () => { autoShow.manualHide(); if (panelWin) panelWin.hide(); updateTray(); });
  ipcMain.on('start-recording', () => startRecording(90));
  ipcMain.on('open-data-dir', () => shell.openPath(DATA()));
  ipcMain.on('quit', () => app.quit());
  ipcMain.handle('custom-sounds', () => settings.customSounds || []);
  // Faz 8.2: oyuncu değerlendirme (doğrulama lib/ratings.validate: ad ≤ 32, puan 1-5 tamsayı, not ≤ 300, izinli etiketler)
  ipcMain.handle('get-ratings', () => ratingsPayload());
  ipcMain.handle('rate-data', () => ratePayload());
  // Puanlama ekranı: yıldız, hızlı etiketler ve kara liste (puan 0 = temizle). Aynı ad farklı sunucu = ayrı oyuncu.
  ipcMain.handle('quick-rate', (_e, inp) => {
    if (!inp || typeof inp !== 'object' || typeof inp.name !== 'string') return { ok: false, error: 'invalid' };
    const server = Number.isInteger(inp.server) && inp.server > 0 && inp.server < 65536 ? inp.server : 0;
    const patch = {};
    if (inp.rating !== undefined) patch.rating = inp.rating;
    if (inp.blacklist !== undefined) patch.blacklist = !!inp.blacklist;
    if (inp.note !== undefined) patch.note = inp.note;
    if (inp.tags && typeof inp.tags === 'object') patch.tags = inp.tags;
    return getRatings().quick(inp.name, server, patch, settings.charName || '');
  });
  ipcMain.on('ratings-open', (_e, name, server) => {
    ratingsPrefill = (typeof name === 'string' && name.trim() && name.length <= 32) ? { name: name.trim(), server: Number.isInteger(server) && server > 0 && server < 65536 ? server : 0 } : null;
    if (ratingsPrefill) ratingsPick = ratingsPrefill;
    openSettings('boss'); // oyuncu değerlendirme artık "Boss ve Oyuncular" ekranının içinde
  });
  ipcMain.handle('ratings-take-prefill', () => { const n = ratingsPrefill; ratingsPrefill = null; return n; });
  ipcMain.on('panel-fit', (_e, h) => fitPanel(h));
}

// ---------------------------------------------------------------------------
// Tepsi ve kısayollar
// ---------------------------------------------------------------------------

function updateTray() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: panelWin && panelWin.isVisible() ? t('Hide panel') : t('Show panel'), accelerator: 'Ctrl+Shift+D', click: togglePanel },
    { label: t('Click-through'), type: 'checkbox', checked: !!settings.clickThrough, accelerator: 'Ctrl+Shift+L', click: () => { settings.clickThrough = !settings.clickThrough; saveSettings(); applyClickThrough(); } },
    { label: t('Position lock'), type: 'checkbox', checked: !!settings.posLock, accelerator: 'Ctrl+Shift+K', click: togglePosLock },
    { type: 'separator' },
    { type: 'separator' },
    { label: t('Reset meter'), accelerator: 'Ctrl+Shift+R', click: () => { engine.meter.reset(); selectedEnc = 0; selectedBoss = null; broadcast(true); } },
    { type: 'separator' },
    { label: t('Skills and sounds…'), click: () => openSettings('skills') },
    { label: t('Settings…'), click: () => openSettings('general') },
    { type: 'separator' },
    rec ? { label: t('Stop traffic recording'), click: stopRecording } : { label: t('Record traffic (90 s)'), click: () => startRecording(90) },
    { label: t('Open data folder'), click: () => shell.openPath(DATA()) },
    { type: 'separator' },
    ...(dev ? dev.trayItems() : []),
    { label: t('Quit'), click: () => app.quit() },
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip('Daeva Lens' + (DEV ? ' (dev)' : '') + (status.running ? t(' · listening') : ''));
}

function createTray() {
  const img = nativeImage.createFromPath(path.join(__dirname, 'assets', process.platform === 'win32' ? 'icon.ico' : 'icon.png'));
  tray = new Tray(img);
  tray.on('click', togglePanel);
  updateTray();
}

let activeRegisteredShortcuts = [];

function togglePosLock() {
  settings.posLock = !settings.posLock;
  saveSettings();
  broadcast(true);
  updateTray();
}

function registerShortcuts() {
  for (const acc of activeRegisteredShortcuts) {
    try { globalShortcut.unregister(acc); } catch { /* ignore */ }
  }
  activeRegisteredShortcuts = [];

  const sc = (settings && settings.shortcuts) ? settings.shortcuts : DEFAULTS.shortcuts;
  const reg = (acc, fn) => {
    if (!acc || typeof acc !== 'string') return;
    try {
      if (globalShortcut.register(acc, () => { if (dev) dev.action('kisayol', acc); fn(); })) {
        activeRegisteredShortcuts.push(acc);
      } else {
        log('kısayol alınamadı', acc);
      }
    } catch (err) {
      log('kısayol hatası', acc, err.message);
    }
  };

  reg(sc.toggle || DEFAULTS.shortcuts.toggle, togglePanel);
  reg(sc.clickThrough || DEFAULTS.shortcuts.clickThrough, () => {
    settings.clickThrough = !settings.clickThrough;
    saveSettings();
    applyClickThrough();
  });
  reg(sc.posLock || DEFAULTS.shortcuts.posLock, togglePosLock);
  reg(sc.reset || DEFAULTS.shortcuts.reset, () => {
    engine.meter.reset();
    selectedEnc = 0; selectedBoss = null;
    broadcast(true);
  });
}

// ---------------------------------------------------------------------------
// Başlangıç
// ---------------------------------------------------------------------------

app.on('second-instance', () => { autoShow.manualShow(); if (panelWin) panelWin.showInactive(); else createPanel(); });

app.whenReady().then(() => {
  loadSettings();
  log('başladı', app.getVersion());
  removeOldPlayersFile();
  loadMobsCache();
  if (!settings.lang) settings.lang = /^tr/i.test(app.getLocale()) ? 'tr' : 'en';
  I18N.setLang(settings.lang);
  makeEngine();
  registerIpc();
  createTray();
  createPanel();
  screen.on('display-metrics-changed', checkDisplayChange);
  screen.on('display-added', checkDisplayChange);
  screen.on('display-removed', checkDisplayChange);
  updateTray();
  registerShortcuts();
  if (DEV) {
    let devMod = null;
    try { devMod = require('./lib/dev'); } catch (err) { devMod = null; } // dosya yoksa sessizce atla
    if (devMod) dev = devMod.start({
      app, log, dataDir: DATA, engine: () => engine, settings: () => settings, panel: () => panelWin, send,
      updateTray: () => updateTray(), status,
      // Faz 5.0-K.6: sürükleme ölçümünde pencerenin adı
      windowName: (w) => (w === panelWin ? 'panel' : w === drawerWin ? 'cekmece' : 'diger'),
    });
    if (dev) { logHook = (l) => dev.logLine(l); updateTray(); }
  }
  capture = new Capture({
    app,
    log,
    onLine: onHelperLine,
    onState: (s) => {
      status.running = !!s.running;
      status.waiting = !!s.waiting;
      if (s.backend) status.backend = s.backend;
      if (s.error !== undefined) status.error = s.error || null;
      if (s.vpnHint !== undefined) status.vpnHint = s.vpnHint;
      if (s.running) status.error = null;
      updateTray();
      broadcast(true);
    },
  });
  const replay = process.env.A2_TEKRAR || (process.argv.find((a) => a.startsWith('--tekrar=')) || '').slice(9);
  if (replay) replayFile(replay);
  else { autoShow.start(Date.now()); autoShowLive = true; capture.start(); }
  setInterval(() => { broadcast(false); autoShowTick(); }, 250);
  // Faz 8.3 / 9: etkinlik alarmları; pencere kapalıyken de burada (ana süreç) çalışır.
  // Eşik mantığı lib/alerts.js'te: her eşik bir olay için bir kez, yeniden açılınca/saat değişince eski eşik tekrarlanmaz.
  const alertSched = ALERTS.createScheduler(TIMERS);
  setInterval(() => {
    try {
      toastTick();
      if (settings.timersOn !== true) return;
      const nowMs = Date.now();
      for (const a of alertSched.tick(nowMs, settings.timerRegion, settings.timerAlarms, settings.timerAlertSteps)) {
        fireTimerAlert(a.name, a.step);
      }
    } catch (err) { log('zamanlayıcı alarmı', err.message); }
  }, 1000);
  // geliştirme: A2_DENEYSEL=<sekme> Deneysel penceresini açar; A2_DENEYSEL_GORUNTU=<klasör> ise
  // A2_DENEYSEL_SN saniye sonra her sekmenin görüntüsünü kaydedip çıkar (sadece DAEVA_DEV)
  if (LABS && process.env.A2_DENEYSEL) {
    setTimeout(() => openLabs(process.env.A2_DENEYSEL), 1500);
    if (process.env.A2_DENEYSEL_OYNAT) setTimeout(() => labsPlay(process.env.A2_DENEYSEL_OYNAT, process.env.A2_DENEYSEL_HIZ || 'max'), 2500);
    const out = process.env.A2_DENEYSEL_GORUNTU;
    if (out) {
      setTimeout(async () => {
        const w = labsWin;
        const shot = async (name) => { try { fs.writeFileSync(path.join(out, name), (await w.webContents.capturePage()).toPNG()); } catch (err) { log('deneysel görüntü', err.message); } };
        const run = (js) => w.webContents.executeJavaScript(js).catch(() => {});
        const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        for (const tab of ['live', 'map', 'timers', 'play', 'settings']) { await run(`document.querySelector('#tabs [data-tab=${tab}]').click()`); await wait(900); await shot('deneysel-' + tab + '.png'); }
        await run("document.querySelector('#tabs [data-tab=fights]').click()"); await wait(900);
        await run("(document.querySelector('.fi')||{click(){}}).click()"); await wait(900);
        for (const f of ['summary', 'timeline', 'positions', 'buffs', 'threat', 'items', 'build']) { await run(`document.querySelector('#fTabs [data-f=${f}]').click()`); await wait(700); await shot('deneysel-dovus-' + f + '.png'); }
        if (panelWin) { try { fs.writeFileSync(path.join(out, 'panel.png'), (await panelWin.webContents.capturePage()).toPNG()); } catch { /* yok */ } }
        openSettings('general'); await wait(1200);
        if (drawerWin) { try { await drawerWin.webContents.executeJavaScript("document.querySelector('.seg [data-tab=general]').click(); document.getElementById('labsCard').scrollIntoView()"); await wait(400); fs.writeFileSync(path.join(out, 'cekmece-genel.png'), (await drawerWin.webContents.capturePage()).toPNG()); } catch (err) { log('çekmece görüntü', err.message); } }
        log('deneysel: görüntüler kaydedildi', out);
        app.quit();
      }, Number(process.env.A2_DENEYSEL_SN || 20) * 1000);
    }
  }
  // geliştirme: çekmeceyi art arda aç/kapa, boyutları günlüğe yaz (sadece DAEVA_DEV)
  if (DEV && process.env.A2_CEKMECE_TEST) {
    let k = 0;
    const loop = setInterval(async () => {
      if (!panelWin) return;
      log('boyut', panelWin.getBounds());
      drawerToggle();
      if (++k > 6) { clearInterval(loop); setTimeout(() => { log('son boyut', panelWin.getBounds()); app.quit(); }, 1500); }
    }, 1200);
  }
  // geliştirme: A2_GORUNTU=<klasör> ise birkaç saniye sonra pencere görüntülerini kaydet (sadece DAEVA_DEV)
  if (DEV && process.env.A2_GORUNTU) {
    const out = process.env.A2_GORUNTU;
    const after = Number(process.env.A2_GORUNTU_SN || 30) * 1000;
    setTimeout(async () => {
      try { fs.writeFileSync(path.join(out, 'panel.png'), (await panelWin.webContents.capturePage()).toPNG()); } catch { /* yok */ }
      openSettings('skills');
    }, after - 4000);
    setTimeout(async () => {
      try {
        if (panelWin) fs.writeFileSync(path.join(out, 'acik.png'), (await panelWin.webContents.capturePage()).toPNG());
      } catch (err) { log('görüntü alınamadı', err.message); }
      app.quit();
    }, after);
  }
});

app.on('window-all-closed', (e) => { e.preventDefault(); });
// Faz 5.0-K.2: geliştirme sürümünde oturum kaydı düzgün kapansın diye çıkış bir kez bekletilir
// (gzip'in sonu yazılır, dosya etiketli adını alır). En fazla 4 sn; olmazsa bir sonraki açılışta "_yarim" olur.
let devClosing = false;
app.on('before-quit', (e) => {
  if (dev && !devClosing) {
    devClosing = true;
    e.preventDefault();
    const go = () => app.quit();
    Promise.race([dev.close(), new Promise((r) => setTimeout(r, 4000))]).then(go, go);
    return;
  }
  app.isQuitting = true;
  try { if (ratings) ratings.flush(); } catch { /* yok say */ }
  try { if (personalBests) personalBests.flush(); } catch { /* yok say */ }
  try { globalShortcut.unregisterAll(); } catch { /* yok say */ }
  try {
    screen.removeListener('display-metrics-changed', checkDisplayChange);
    screen.removeListener('display-added', checkDisplayChange);
    screen.removeListener('display-removed', checkDisplayChange);
  } catch { /* yok say */ }
  if (rec) stopRecording();
  if (dev) dev.stop();
  if (capture) capture.stop();
  if (mobsCache) mobsCache.saveSync();
  clearTimeout(saveTimer);
  try { fs.writeFileSync(SETTINGS_FILE(), JSON.stringify(settings, null, 1)); } catch { /* yok say */ }
  flushLogSync();
});
