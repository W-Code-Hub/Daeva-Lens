'use strict';
// Zamanlayıcı uyarı kutusu için en küçük köprü: yalnız liste alma, Gizle ve boyut bildirme
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('toastApi', {
  onToasts: (fn) => { if (typeof fn === 'function') ipcRenderer.on('toasts', (_e, d) => fn(d)); },
  hide: (id) => ipcRenderer.send('toast-hide', id),
  fit: (h) => ipcRenderer.send('toast-fit', h),
});
