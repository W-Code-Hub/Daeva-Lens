'use strict';
// Pencereler sürüklenirken birbirinin içine girmesin: DPS paneli ile tuş göstergesi çarpışır,
// birbirine yaklaşınca kenarları mıknatıs gibi yapışır.

const SNAP = 12; // bu kadar piksel yakınsa kenara yapış

const overlapX = (a, b) => a.x < b.x + b.width && b.x < a.x + a.width;
const overlapY = (a, b) => a.y < b.y + b.height && b.y < a.y + a.height;

// prev: pencerenin şimdiki yeri, next: gitmek istediği yer, other: diğer pencere.
// Dönen: çarpışma yoksa next (yapışma uygulanmış), varsa diğerinin kenarında durdurulmuş hâli.
function resolve(prev, next, other) {
  if (!other) return next;
  const r = { ...next };
  const hitX = overlapX(r, other), hitY = overlapY(r, other);
  if (hitX && hitY) {
    // hangi taraftan geldiyse o kenarda dur, diğer eksende kaymaya devam etsin
    if (prev.x + prev.width <= other.x) r.x = other.x - r.width;
    else if (prev.x >= other.x + other.width) r.x = other.x + other.width;
    else if (prev.y + prev.height <= other.y) r.y = other.y - r.height;
    else if (prev.y >= other.y + other.height) r.y = other.y + other.height;
    else {
      // zaten iç içeydi (eski kayıtlı konum): en az kaydıran tarafa it
      const opts = [
        [other.x - (r.x + r.width), 0], [other.x + other.width - r.x, 0],
        [0, other.y - (r.y + r.height)], [0, other.y + other.height - r.y],
      ].sort((a, b) => Math.abs(a[0]) + Math.abs(a[1]) - Math.abs(b[0]) - Math.abs(b[1]));
      r.x += opts[0][0]; r.y += opts[0][1];
    }
    return r;
  }
  // mıknatıs: yan yana / üst üste gelince kenarları hizala
  if (hitY || overlapY({ ...r, y: r.y - SNAP, height: r.height + 2 * SNAP }, other)) {
    if (Math.abs(r.x + r.width - other.x) < SNAP) r.x = other.x - r.width;
    else if (Math.abs(r.x - (other.x + other.width)) < SNAP) r.x = other.x + other.width;
  }
  if (hitX || overlapX({ ...r, x: r.x - SNAP, width: r.width + 2 * SNAP }, other)) {
    if (Math.abs(r.y + r.height - other.y) < SNAP) r.y = other.y - r.height;
    else if (Math.abs(r.y - (other.y + other.height)) < SNAP) r.y = other.y + other.height;
  }
  // sol / sağ kenarları da hizala (üst üste dururken)
  if (Math.abs(r.y + r.height - other.y) === 0 || Math.abs(r.y - (other.y + other.height)) === 0) {
    if (Math.abs(r.x - other.x) < SNAP) r.x = other.x;
  }
  return r;
}

// Sürükleme: pencere içi (ui/drag.js) imleç konumunu gönderir; pencere "tuttuğun nokta + imleç"
// konumuna gitmek ister, diğer pencereye çarparsa kenarında durur. Fare hep tuttuğun noktaya göre.
const others = new Map(); // pencere id -> () => diğer pencerenin sınırları
const drags = new Map();  // pencere id -> { b, x, y }
let ipcReady = false;
// Faz 5.0-K.6 (B-35): sürükleme ölçümü. Sadece Daeva Lens Dev setProbe ile bağlar; yoksa hiçbir şey ölçülmez.
let probe = null;
function setProbe(fn) { probe = typeof fn === 'function' ? fn : null; }

let dragGuard = null; // true dönerse sürükleme başlamaz (konum kilidi)
function setDragGuard(fn) { dragGuard = typeof fn === 'function' ? fn : null; }

function setupIpc() {
  if (ipcReady) return;
  ipcReady = true;
  const { ipcMain, BrowserWindow } = require('electron');
  ipcMain.on('win-drag', (e, phase, sx, sy, sentAt, coalesced) => {
    const recvAt = probe ? Date.now() : 0;
    const win = BrowserWindow.fromWebContents(e.sender);
    if (!win || win.isDestroyed()) return;
    if (phase === 'start') {
      if (dragGuard && dragGuard(win)) return;
      drags.set(win.id, { b: win.getBounds(), x: sx, y: sy });
      if (probe) try { probe(win, 'start', { recvAt, sentAt }); } catch { /* ölçüm hatası sürüklemeyi bozmasın */ }
      return;
    }
    const d = drags.get(win.id);
    if (!d) return;
    const prev = win.getBounds();
    const want = { ...prev, x: Math.round(d.b.x + sx - d.x), y: Math.round(d.b.y + sy - d.y) };
    const getOther = others.get(win.id);
    const r = resolve(prev, want, getOther ? getOther() : null);
    const moved = r.x !== prev.x || r.y !== prev.y;
    const t0 = probe ? performance.now() : 0;
    if (moved) win.setBounds({ ...prev, x: r.x, y: r.y });
    if (probe) try { probe(win, phase, { recvAt, sentAt, coalesced, moved, setBoundsMs: moved ? performance.now() - t0 : 0 }); } catch { /* yok say */ }
    if (phase === 'end') { drags.delete(win.id); win.emit('moved'); }
  });
}

// win sürüklenirken getOther() penceresine çarpar.
function attach(win, getOther) {
  setupIpc();
  others.set(win.id, getOther);
  win.on('closed', () => { others.delete(win.id); drags.delete(win.id); });
  win.on('will-resize', (e, nb) => {
    const o = getOther();
    if (o && overlapX(nb, o) && overlapY(nb, o) && !(overlapX(win.getBounds(), o) && overlapY(win.getBounds(), o))) e.preventDefault();
  });
}

// Faz 5.0-P.1: pencere şu an elle sürükleniyor mu (sürüklerken panel boyu değişirse ev konumuna zıplamasın)
const isDragging = (win) => !!win && drags.has(win.id);

module.exports = { resolve, attach, isDragging, setProbe, setDragGuard };
