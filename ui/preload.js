'use strict';
const { contextBridge, ipcRenderer } = require('electron');

const listen = new Set(['state', 'alert', 'click-through', 'skills-changed', 'tab', 'drawer-closing', 'drawer-status', 'notice', 'custom-sounds', 'ratings-changed', 'timer-sound', 'boss-log-changed']);
const activeListeners = new Map();

if (typeof window !== 'undefined') {
  window.addEventListener('beforeunload', () => {
    for (const ch of listen) {
      try { ipcRenderer.removeAllListeners(ch); } catch {}
    }
    activeListeners.clear();
  });
}

contextBridge.exposeInMainWorld('api', {
  on: (ch, fn) => {
    if (!listen.has(ch) || typeof fn !== 'function') return () => {};
    let m = activeListeners.get(ch);
    if (!m) {
      m = new Map();
      activeListeners.set(ch, m);
    }
    if (m.has(fn)) {
      try { ipcRenderer.removeListener(ch, m.get(fn)); } catch {}
      m.delete(fn);
    }
    const listener = (_e, d) => fn(d);
    m.set(fn, listener);
    ipcRenderer.on(ch, listener);
    return () => {
      try { ipcRenderer.removeListener(ch, listener); } catch {}
      if (m.get(fn) === listener) m.delete(fn);
    };
  },
  off: (ch, fn) => {
    if (!listen.has(ch)) return;
    const m = activeListeners.get(ch);
    if (m && fn && m.has(fn)) {
      try { ipcRenderer.removeListener(ch, m.get(fn)); } catch {}
      m.delete(fn);
    } else if (!fn) {
      try { ipcRenderer.removeAllListeners(ch); } catch {}
      if (m) m.clear();
    }
  },
  removeAllListeners: (ch) => {
    if (listen.has(ch)) {
      try { ipcRenderer.removeAllListeners(ch); } catch {}
      const m = activeListeners.get(ch);
      if (m) m.clear();
    }
  },
  fit: (h) => ipcRenderer.send('panel-fit', h),
  drag: (phase, x, y, at, n) => ipcRenderer.send('win-drag', phase, x, y, at, n),
  drawer: (open) => ipcRenderer.invoke('drawer', open),
  drawerToggle: () => ipcRenderer.send('drawer-toggle'),
  drawerClose: () => ipcRenderer.send('drawer-close'),
  getRatings: () => ipcRenderer.invoke('get-ratings'),
  rateData: () => ipcRenderer.invoke('rate-data'),
  quickRate: (r) => ipcRenderer.invoke('quick-rate', r),
  ratingsOpen: (name, server) => ipcRenderer.send('ratings-open', name, server),
  ratingsTakePrefill: () => ipcRenderer.invoke('ratings-take-prefill'),
  getTimers: () => ipcRenderer.invoke('get-timers'),
  timerTest: () => ipcRenderer.invoke('timer-test'),
  getSettings: () => ipcRenderer.invoke('get-settings'),
  setSettings: (patch) => ipcRenderer.invoke('set-settings', patch),
  setSkill: (base, cfg) => ipcRenderer.invoke('set-skill', base, cfg),
  forgetLearned: (base) => ipcRenderer.invoke('forget-learned', base),
  resetSkill: (base) => ipcRenderer.invoke('reset-skill', base),
  skills: () => ipcRenderer.invoke('skills'),
  pickSound: () => ipcRenderer.invoke('pick-sound'),
  customSounds: () => ipcRenderer.invoke('custom-sounds'),
  reset: () => ipcRenderer.send('reset'),
  selectBoss: (i) => ipcRenderer.send('select-boss', i),
  bossLogList: () => ipcRenderer.invoke('boss-log-list'),
  bossLogGet: (fk) => ipcRenderer.invoke('boss-log-get', fk),
  setOwn: (id) => ipcRenderer.send('set-own', id),
  openSettings: (tab) => ipcRenderer.send('open-settings', tab),
  toggleClickThrough: () => ipcRenderer.send('toggle-click-through'),
  togglePosLock: () => ipcRenderer.send('toggle-pos-lock'),
  hidePanel: () => ipcRenderer.send('hide-panel'),
  startRecording: () => ipcRenderer.send('start-recording'),
  openDataDir: () => ipcRenderer.send('open-data-dir'),
  quit: () => ipcRenderer.send('quit'),
  // Deneysel özellikler: ana süreç bu kanalları yalnız geliştirme sürümünde dinler
  labsSet: (patch) => ipcRenderer.invoke('labs-set', patch),
  labsOpen: (tab) => ipcRenderer.send('labs-open', tab),
});
