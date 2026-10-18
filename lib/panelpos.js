'use strict';
// Faz 5.0-P.1: DPS panelinin "ev konumu" (kullanıcının paneli bıraktığı yer) hesabı.
// Saf fonksiyonlar: Electron'a bağlı değil, testte doğrudan denenir.
//
// Kural: üst bar ev konumunda (home.y) durur, panel aşağı doğru uzar/kısalır.
// Çalışma alanının (wa) altına sığmazsa sadece sığmayan kadar yukarı itilir.
// Kısalınca yine home.y'ye döner. İtilmiş yer asla ev konumu olarak kaydedilmez.

// home: { x, y, width }   h: istenen pencere yüksekliği   wa: o monitörün çalışma alanı { x, y, width, height }
function place(home, h, wa) {
  const height = Math.max(1, Math.min(Math.round(h), wa.height));
  const width = Math.min(home.width, wa.width);
  let y = home.y;
  if (y + height > wa.y + wa.height) y = wa.y + wa.height - height; // alta çarptı: gerektiği kadar yukarı
  if (y < wa.y) y = wa.y;                                            // ekranın üstünden taşmasın
  let x = home.x;
  if (x + width > wa.x + wa.width) x = wa.x + wa.width - width;      // ekran dışında kalmasın (monitör çıkarıldıysa)
  if (x < wa.x) x = wa.x;
  return { x, y, width, height };
}

// Hangi monitör: üst barın (ev konumunun üst şeridinin) bulunduğu monitör.
const barRect = (home) => ({ x: home.x, y: home.y, width: home.width, height: 30 });

// Eski kayıt (Faz 5.0-P öncesi): ekranın alt yarısındaki panelde ALT kenar sabit tutuluyordu,
// kayıtlı y = alt kenar - en büyük yükseklik. Bu panel için üst barın boştaki yeri bilinmiyor;
// ilk boy ölçümünde (boştaki boy) alt kenardan hesaplanır: y = alt kenar - boştaki boy.
const isLowerHalf = (b, wa) => b.y + b.height / 2 > wa.y + wa.height / 2;
function legacyBottom(saved, wa) {
  return isLowerHalf(saved, wa) ? saved.y + saved.height : null;
}

// Kilit (tıklama geçirme) değişimi pencerenin boyunu asla değiştirmemeli. Windows'ta şeffaf çerçevesiz pencerede
// setIgnoreMouseEvents bazen boyu birkaç piksel kaydırır; her aç/kapada birikip panel aşağı uzuyordu.
// fn() çalışır; pencerenin genişlik/yüksekliği değiştiyse eski boya geri alınır. Geri alındıysa yeni sınırlar döner, yoksa null.
function keepSize(win, fn) {
  const before = win.getBounds();
  fn();
  const after = win.getBounds();
  if (after.width === before.width && after.height === before.height) return null;
  win.setBounds(before);
  return before;
}

module.exports = { place, barRect, isLowerHalf, legacyBottom, keepSize };
