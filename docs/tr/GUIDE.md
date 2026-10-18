# Daeva Lens 2.2.0 · Kullanıcı Kılavuzu

Türkçe · English: [GUIDE.md](../../GUIDE.md)

## 1. Başlamadan önce
Windows 10/11 (64 bit) ve **Npcap** gerekir. Npcap'i npcap.com'dan varsayılan seçeneklerle kurun (bir kez). Daeva Lens'i zip'ten çıkarıp `Daeva Lens.exe` ile açın.

## 2. Ana panel
Sol üstte hasar / şifa / alınan sekmeleri vardır. Listeden bir oyuncuya tıklayınca beceri dökümü açılır. Üstte boss canı ve kırılma çubuğu görünür. Panelin yanındaki dişli simgesi **çekmeceyi** (4 sekme) açar.

## 3. Dört sekme
- **Boss ve Oyuncular:** boss ve zindan geçmişi (gün/koşu kartları, "ana boss" rozeti), boss raporu, ölüm özeti, oyuncu puanlama ve kara liste. Bir oyuncuya sağ tıklayıp *Kara liste* seçebilirsiniz.
- **Beceriler:** takip edilecek beceriler, bekleme sesleri.
- **Zamanlayıcılar:** dünya boss / etkinlik saatleri.
- **Ayarlar:** Görünüm, Panel ve sayaç, Boss ve dövüşler, Sesler, Oyuncular, Gizlilik ve yayın, Pencere ve veri, Hakkında.

## 4. Boss ve zindan geçmişi
Her boss dövüşü kaydedilir. Zindanda son boss **ana boss** sayılır; o kesilince koşu kartı kapanır, sonraki dövüşler yeni koşuya yazılır. Karttan boss raporuna (süre, MVP, kırılma, oyuncu katkıları) girilir.

## 5. Skill rotation
Boss raporunda oyuncu başına beceri şeridi görünür. Fare tekerleği veya **+ / - / Sığdır** ile yakınlaştırın, sürükleyerek kaydırın. Üstteki listeden tek oyuncuyu seçebilirsiniz.

## 6. Boss zamanlayıcıları
Çizelge shugo.gg ile aynı topluluk verisine dayanır (resmi API yok). **Bölgenizi** seçin (Kore, Tayvan, Global Asya/Kuzey Amerika Doğu-Batı/Avrupa/Güney Amerika); saatler yerel saatinize çevrilir. Her etkinlik için bip veya **sesli uyarı** (Türkçe ya da İngilizce) açılabilir; ses için Windows'ta o dilde bir ses kurulu olmalıdır.

## 7. Sesler merkezi
Ayarlar > Sesler: ana ses seviyesi, yalnız dövüşte ses, kırılma / düşük can / iksir sesleri, eşya sesli okuma, zamanlayıcı bip ve sesli uyarı. Her sesin yanında deneme düğmesi vardır.

## 8. Oyuncu değerlendirme ve kara liste
Oyuncuya puan ve not verin. Kara liste uyarısı açıksa, listedeki biri partinde görününce (oturum başına bir kez) kırmızı uyarı çıkar. Aynı isim başka sunucuda ayrı oyuncudur. Veriler yalnız bilgisayarınızda saklanır.

## 9. Konum kilidi, tıklama geçirme, kısayollar
Ctrl+Shift+K panel konumunu kilitler, Ctrl+Shift+L tıklama geçirmeyi açıp kapatır. Kısayolların tam tablosu [README](README.md#kullanım-ve-kısayollar) içindedir; kısayollar Ayarlar > Pencere ve veri bölümünden değiştirilebilir.

## 10. Parti ve gizlilik ayarları
"Hasar vurmayan parti üyelerini göster" kapalıysa, vurmayan üyeler vurana kadar listede görünmez. **Yayıncı modu** adları takma adla değiştirir ve puan rozetlerini gizler. Panel yayın/ekran görüntüsünden gizlenebilir.

## 11. Gizlilik ve risk
Kısaca: ağ çağrısı yok, yalnız pasif Npcap dinleme, ceza garantisi yok. Ayrıntı: [README, Güvenlik ve dürüstlük](README.md#güvenlik-ve-dürüstlük).

## 12. Sorun giderme
[README SSS](README.md#sık-sorulan-sorular) bölümüne bakın. Her şeyi sıfırlamak için `%APPDATA%\Daeva Lens\` klasörünü silin. Hata bildirimi: github.com/W-Code-Hub/daeva-lens/issues
