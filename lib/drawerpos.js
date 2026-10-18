'use strict';
// Çekmece penceresinin boyutu ve yeri (saf mantık). Dar ekranda (örn. 1366x768) pencere çalışma alanını asla aşmaz.
// panel: { x, y, width, height } ; wa: çalışma alanı { x, y, width, height } ; zoom: arayüz ölçeği

const DRAWER_W = 820; // iki sütunlu "Boss ve Oyuncular" ekranı için
const DRAWER_H = 640;
const GAP = 6;

function drawerSize(wa, zoom) {
  const z = zoom > 0 ? zoom : 1;
  return {
    width: Math.max(1, Math.min(wa.width, Math.round(DRAWER_W * z))),
    height: Math.max(1, Math.min(wa.height, Math.round(DRAWER_H * z))),
  };
}

// Panelin yanına (ekranın hangi yarısındaysa karşı tarafına) yerleşir; her zaman çalışma alanının içinde kalır.
function drawerRect(panel, wa, zoom) {
  const { width, height } = drawerSize(wa, zoom);
  const left = panel.x + panel.width / 2 > wa.x + wa.width / 2;
  let x = left ? panel.x - width - GAP : panel.x + panel.width + GAP;
  x = Math.max(wa.x, Math.min(x, wa.x + wa.width - width));
  const y = Math.max(wa.y, Math.min(panel.y + panel.height - height, wa.y + wa.height - height));
  return { x, y, width, height };
}

module.exports = { DRAWER_W, DRAWER_H, drawerSize, drawerRect };
