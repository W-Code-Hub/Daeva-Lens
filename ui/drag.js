(() => {
'use strict';
// Pencereyi kendimiz taşıyoruz (Windows'un sürükleme bölgesi yerine): fare tuttuğun noktada kalır,
// pencere başka bir pencereye çarpınca durur, fare geri gelince yine tuttuğun yerden devam eder.
// window.enableDrag(seçici, gönder, izinli?)  gönder(aşama, ekranX, ekranY, zaman, birleşen)
// Faz 5.0-K.6 (B-35): her harekette gönderilme zamanı (Date.now) ve tarayıcının bu olaya kattığı
// hareket sayısı (getCoalescedEvents) da gider; sadece Daeva Lens Dev bunları ölçer.
window.enableDrag = (selector, send, allowed = () => true) => {
  document.addEventListener('pointerdown', (e) => {
    if (e.button !== 0 || !allowed()) return;
    const h = e.target.closest(selector);
    if (!h || e.target.closest('button, input, select, textarea, a, label, .nodrag')) return;
    e.preventDefault();
    h.setPointerCapture(e.pointerId);
    send('start', e.screenX, e.screenY, Date.now(), 1);
    const move = (ev) => send('move', ev.screenX, ev.screenY, Date.now(), ev.getCoalescedEvents ? ev.getCoalescedEvents().length : 1);
    const end = (ev) => {
      h.removeEventListener('pointermove', move);
      h.removeEventListener('pointerup', end);
      h.removeEventListener('lostpointercapture', end);
      try { h.releasePointerCapture(e.pointerId); } catch { /* yok say */ }
      send('end', ev.screenX, ev.screenY, Date.now(), 1);
    };
    h.addEventListener('pointermove', move);
    h.addEventListener('pointerup', end);
    h.addEventListener('lostpointercapture', end);
  });
};
})();
