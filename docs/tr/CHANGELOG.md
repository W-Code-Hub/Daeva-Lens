# Daeva Lens 2.2.1 · Sürüm Notları

Türkçe · English: [CHANGELOG.md](../../CHANGELOG.md)

## 2.2.1

Düzeltmeler
- Panel taşıma ve konum kilidi: sürükleme ve kilit artık güvenilir çalışır.
- Bölge değişiminden sonra sayaç boş kalmaz.
- Sessizce yutulan hatalar artık günlüğe yazılır.
- Kaybolan bir ağ paketi okumayı takıp bırakmaz; yaklaşık yarım saniye sonra atlanır.
- Ctrl+R ile boss sıfırlama her yerde aynı davranır.

Değişenler
- Sesler, ekran bildirimleri, etkinlik zamanlayıcıları ve ek paneller (bekleme süreleri, hedef çubuğu, Gear Score, Combat Power, vurmayan parti üyeleri, boss hedefi) varsayılan olarak kapalıdır; Ayarlar'dan açılır. Mevcut ayarlarınız olduğu gibi korunur.
- README, imzasız exe uyarısını ve SHA256 doğrulamasını açıklar.
- Altı yeni otomatik test.

Daeva Lens oyuna dokunmaz; yalnızca ağ trafiğinin pasif bir kopyasını okur. Ekran yakalama koruması varsayılan olarak kapalıdır.

---

# Daeva Lens 2.2.0 · Sürüm Notları

2.1.0 sonrası değişiklikler.

## Yeni
- **Dört sekmeli çekmece:** Boss ve Oyuncular, Beceriler, Zamanlayıcılar, Ayarlar. 2.1.0'ın altı sekmesinin (Boss, Ölümler, Beceriler, Tuşlar, Genel, Hakkında) yerini alır; bir dövüşün ölümleri artık Boss ve Oyuncular sekmesinde görünür.
- **Boss ve zindan geçmişi diske kaydedilir.** 2.1.0 yalnız son 20 boss dövüşünü bellekte tutuyordu. Zindanlarda son boss "ana boss" olarak gruplanır ve koşu kartını kapatır.
- **Beceri rotasyonu zaman çizelgesi:** yakınlaştırma (tekerlek, +/-, Sığdır) ve kaydırma (sürükleme).
- **Sesler merkezi:** tüm ses ve sesli okuma ayarları tek yerde (Ayarlar > Sesler), eşyanın adını sesli okuma seçeneği dahil.
- **Boss zamanlayıcıları (Zamanlayıcılar sekmesi):** shugo.gg çizelge verisi, bölge seçimi, Türkçe/İngilizce bip veya sesli uyarı. Ağ isteği yok, yerel saat.
- **Oyuncu değerlendirme ve kara liste:** puan, not ve kara listedeki oyuncu partinizdeyken isteğe bağlı kırmızı uyarı; yalnız bilgisayarınızda saklanır.
- **Hasar vurmayan parti üyelerini gizleme** seçeneği.
- **Yayıncı modu** (adlar yerel takma adlarla gösterilir) ve **ekran yakalama koruması** (varsayılan kapalı).
- **Konum kilidi:** Ctrl+Shift+K ile açılıp kapanır.
- **Oyunla göster/gizle:** oyundan bir süre trafik gelmezse panel gizlenir, trafik gelince geri döner.
- **Yalnız boss hasarı görünümü** ve **kişisel rekor** bildirimi (yalnız bu bilgisayarda saklanır).
- **Kaynak kod ve yakalama yardımcısının kaynağı (`capture/`, a2co-capture.exe)** depoda; yardımcı kaynaktan derlenip denetlenebilir (bkz. [BUILD.md](BUILD.md)).

## Değişen / kaldırılan
- **Npcap şart.** 2.1.0'da hâlâ bulunan gizli PowerShell / yönetici izinli ham soket yedeği kaldırıldı.
- **Tuş göstergesi kaldırıldı** (Tuşlar sekmesi ve a2-keys.exe yardımcısı).
- **Boss tehdit (agro) uyarısı kaldırıldı.** Tehdit sesi artık yalnız kara liste uyarısında kullanılır.
- **Panel otomatik boyut tiki kaldırıldı;** panel her zaman içeriğine göre boyutlanır.
- Açıklama ve güvenlik/gizlilik metinleri yeniden yazıldı (pasif Npcap dinleme, ağ çağrısı yok; ceza güvencesi verilmez).

Kurulum ve sağlama adımları: [README](README.md#kurulum). Bilinen sınırlar: zamanlayıcı saatleri topluluk verisidir (resmi API yok); exe imzasızdır, SmartScreen uyarabilir.

---

# Daeva Lens 2.1.0 (önceki sürüm, 15 Ekim 2026)

Yayınlanan 2.1.0 sürüm notlarından alındı ve 2.1.0 paketiyle karşılaştırıldı.

## Yeni / değişen
- **Akıllı ses ve bildirim motoru:** Boss kırılma gongu, %25 altı düşük can nabzı, Boss tehdit (agro) ve iksir tonları; ayarlarda her ses için bağımsız ses seviyesi, açma/kapatma ve test düğmeleri.
- **Tuş göstergesi ve bekleme süreleri:** tuşlar üzerinde dairesel dolum (`conic-gradient`) ve milisaniye sayacıyla pürüzsüz geri sayım.
- **Panel otomatik boyutlandırma:** Hasar / Şifa / Alınan sekmeleri üst satıra (DPS yanına) taşındı; dikey sonsuz uzama hatası giderildi; panel içeriğini sarar; kilitli (tıklama geçirgen) modda boşluk kalmaz.
- **Kararlılık:** 56 kayıt (9,82 milyon çerçeve) üzerinde %0,00 hasar kaybı ve 36/36 birim testi.
- **Çekmece:** altı sekme (Boss, Ölümler, Beceriler, Tuşlar, Genel, Hakkında); Ctrl+Shift+L ile tıklama geçirme; son 20 dövüşün boss geçmişi, yalnız bellekte.
