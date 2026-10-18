'use strict';
// Zamanlayıcı uyarı kutusu: ana süreç listeyi gönderir, burada yalnız çizilir. Odak almaz.
const stack = document.getElementById('stack');
let lastH = -1;
function fit() {
  const h = Math.ceil(stack.getBoundingClientRect().height);
  if (h !== lastH) { lastH = h; toastApi.fit(h); }
}
toastApi.onToasts((d) => {
  if (!d || !Array.isArray(d.items)) return;
  if (d.accent) document.documentElement.style.setProperty('--acc-rgb', d.accent);
  if (d.opacity) document.documentElement.style.setProperty('--alpha', d.opacity);
  stack.textContent = '';
  for (const it of d.items) {
    const el = document.createElement('div');
    el.className = 'tt' + (it.quiet ? ' quiet' : '');
    const msg = document.createElement('span');
    msg.className = 'msg';
    msg.textContent = it.text;
    el.appendChild(msg);
    if (it.hold) {
      const b = document.createElement('button');
      b.textContent = d.hide || 'Hide';
      b.onclick = () => toastApi.hide(it.id);
      el.appendChild(b);
    }
    stack.appendChild(el);
  }
  lastH = -1;
  requestAnimationFrame(fit);
});
