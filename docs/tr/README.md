# Daeva Lens

![Surum](https://img.shields.io/badge/s%C3%BCr%C3%BCm-2.2.0-6366f1?style=for-the-badge) ![Platform](https://img.shields.io/badge/platform-Windows%2010%2F11%20x64-0ea5e9?style=for-the-badge) ![Lisans](https://img.shields.io/badge/lisans-GPL--3.0-64748b?style=for-the-badge)

**Türkçe** · English: [README.md](../../README.md)

**Daeva Lens**, **AION 2** için DPS / şifa sayacı ve boss yardımcısı bir ekran paneli (overlay). Ağ kartına gelen oyun trafiğinin salt-okunur, pasif bir kopyasını (Npcap ile) dinler; hasar, şifa, alınan hasar, boss ve zindan geçmişi, boss zamanlayıcıları, oyuncu değerlendirme ve beceri rotasyonu gösterir. Arayüz Türkçe / İngilizce.

![Oynatma demosu](../img/oynatma-demo.gif)

| Sayaç paneli | Konum kilidi |
|---|---|
| ![Sayaç paneli](../img/sayac-ana.png) | ![Konum kilidi](../img/sayac-konum-kilitli.png) |

| Beceriler | Ayarlar: panel ve sayaç |
|---|---|
| ![Beceriler](../img/ayar-beceriler.png) | ![Panel ve sayaç](../img/ayar-panel-ve-sayac.png) |

| Ayarlar: sesler | Ayarlar: gizlilik | Ayarlar: pencere ve veri |
|---|---|---|
| ![Sesler](../img/ayar-sesler.png) | ![Gizlilik](../img/ayar-gizlilik.png) | ![Pencere ve veri](../img/ayar-pencere-ve-veri.png) |

_Tüm görüntüler programın gerçek arayüzüdür; Yayıncı modu açıkken yerel, yayınlanmayan kayıtlı bir test oturumu oynatılarak alındı, bu yüzden adlar takma ad görünür. Canlı oyun kullanılmadı. Kayıt gerçek oynanıştan alınmış bir paket kaydıdır (program içinde oynatıldı) ve oyuncu adı maskelenmiştir._

## Özellikler

- **DPS, şifa (HPS) ve alınan hasar:** grup ve kişisel görünüm, pay, kritik oranı, beceri dökümü, ölüm özeti.
- **Boss ve zindan geçmişi:** her boss dövüşü kaydedilir; zindanda ana boss (son boss) kesilince koşu kartı kapanır.
- **Dört sekme:** Boss ve Oyuncular, Beceriler, Zamanlayıcılar, Ayarlar.
- **Sesler merkezi:** tüm ses ve sesli okuma ayarları tek yerde (Ayarlar > Sesler).
- **Boss zamanlayıcıları:** shugo.gg ile aynı çizelge verisi, bölge seçimi, bip veya Türkçe/İngilizce sesli uyarı.
- **Oyuncu değerlendirme ve kara liste:** puan ver, not tut, kara listedeki oyuncu partideyse isteğe bağlı kırmızı uyarı. Veriler yalnız bilgisayarında durur.
- **Skill rotation:** oyuncu başına beceri şeridi; yakınlaştırma (tekerlek / +/- / Sığdır) ve kaydırma.
- **Parti gösterimi:** hasar vurmayan parti üyelerini gizleme ayarı.
- **Yayıncı modu:** oyuncu adları ekranda takma adla değişir.

## Kurulum

1. **Npcap**'i <https://npcap.com/#download> adresinden varsayılan seçeneklerle kurun. Npcap olmadan Daeva Lens çalışmaz.
2. [Sürümler](https://github.com/W-Code-Hub/daeva-lens/releases/latest) sayfasından zip'i indirin ve **klasörün tamamını** kalıcı bir yere çıkarın.
3. `Daeva Lens.exe` dosyasını çalıştırın. Kurulum gerekmez. Ayarlar ve günlük `%APPDATA%\Daeva Lens` klasörüne yazılır. Otomatik başlatma açılırsa (varsayılan kapalıdır) Windows açılışına eklenir.
4. AION 2'yi açın. Panel dövüş başlayınca dolar.

**SmartScreen notu:** exe imzasız olduğu için Windows "Windows bilgisayarınızı korudu" diyebilir. **Daha fazla bilgi > Yine de çalıştır** deyin. Exe imzasızdır çünkü imza sertifikası ücretlidir ve bu proje ücretsiz bir hobi projesidir. Antivirüs de imzasız programlarda yanlış alarm verebilir. Güveni artırmanın ücretsiz yolları: dosyaları VirusTotal'da taratabilirsiniz; yanlış alarmı Microsoft'a <https://www.microsoft.com/wdsi/filesubmission> adresinden bildirebilirsiniz. İndirmenizi doğrulamak için önce zip dosyasının özetini sürüm sayfasındaki `SHA256SUMS.txt` ile karşılaştırın:

```
certutil -hashfile "Daeva-Lens-v2.2.0-win-x64.zip" SHA256
```

Zip'i açtıktan sonra `Daeva Lens.exe` dosyasının özetini, açılan klasörün içindeki `SHA256SUMS.txt` dosyasındaki ilgili satırla karşılaştırın:

```
certutil -hashfile "Daeva Lens.exe" SHA256
```

## Kullanım ve kısayollar

| Kısayol | İş |
|---|---|
| `Ctrl+Shift+K` | Konum kilidi (paneli yanlışlıkla taşımayı engeller) |
| `Ctrl+Shift+L` | Tıklama geçirme (fare tıklamaları oyuna geçer) |
| `Ctrl+Shift+D` | Paneli göster / gizle |
| `Ctrl+Shift+R` | Sayacı sıfırla |

Kısayollar Ayarlar'dan değiştirilebilir. Bir oyuncuya tıklayınca beceri dökümü açılır; dişli simgesi dört sekmeli çekmeceyi açar. Ayrıntılı rehber: [GUIDE.md](GUIDE.md) (Türkçe ve İngilizce).

## Sık sorulan sorular

- **Panel boş:** Npcap kurulu mu? Kurduktan sonra uygulamayı yeniden başlatın.
- **Panele tıklayamıyorum:** tıklama geçirme açık; `Ctrl+Shift+L`.
- **Paneli taşıyamıyorum:** konum kilidi açık; `Ctrl+Shift+K`.
- **Sesli uyarı yok:** seçilen dil için Windows'ta ses (voice) kurulu olmalı; Ayarlar > Sesler.
- **Panel oyunun üstünde görünmüyor:** oyunu kenarlıksız/pencereli modda çalıştırın.
- **Her şeyi sıfırlamak:** kapatın ve `%APPDATA%\Daeva Lens\` klasörünü silin.

## Güvenlik ve dürüstlük

Kaynak kodun yaptığı (ve yapmadığı) işler:

- Oyunun **belleğini okumaz**, koda **enjekte etmez**, **tuşlarınızı dinlemez** (tek genel tuşlar yukarıdaki Electron kısayollarıdır).
- **Ağa hiçbir şey göndermez:** HTTP, güncelleme veya telemetri kodu yoktur; zamanlayıcılar yerel saati kullanır.
- Yardımcı program, oyunu bulmak için çalışan süreçlerin listesine ve TCP ile UDP bağlantı tablolarına bakar (Windows sistem çağrıları). Adında aion, ncsoft veya purple geçen süreçleri günlüğe yazar. Npcap ile trafiğin pasif bir kopyasını okur ve oyun sunucusuna hiçbir şey göndermez.
- Trafiği yerel dosyaya kaydetme isteğe bağlıdır ve varsayılan olarak kapalıdır. Ayarlar ve veriler `%APPDATA%\Daeva Lens\` içindedir.

**NCSOFT'un resmi onayı yoktur.** NCSOFT'un yayımlanmış kuralları (plaync.com/policy/operation/aion2) paket okumayı veya ekran panellerini açıkça ne yasaklıyor ne de izin veriyor. Bilinen bir ban vakası bulunamadı, ama bu bir onay değildir. **Ceza veya yasaklanma konusunda hiçbir güvence verilmez; risk kullanıcıya aittir.**

Yardımcı program `a2co-capture.exe` de GPL-3.0 lisanslı özgür yazılımdır; kaynağı `capture/` klasöründedir (bkz. [BUILD.md](BUILD.md)).

## Kendin derle

Adım adım rehber (Node.js, `npm install`, `npm test`, `npm run dist`) için [BUILD.md](BUILD.md) dosyasına bakın (Türkçe ve İngilizce). Yakalama yardımcısının kaynağı `capture/` klasöründedir.

Tam testler yerel oyun kayıtları ister; gizlilik nedeniyle kayıtlar yayınlanmıyor, bu testler atlanır.

## Lisans

GPL-3.0-or-later ([LICENSE](../../LICENSE)). Telif (C) 2026 W-Code (W-Code-Hub). Bir kısım veri RATmeter ve A2Tools (GPL-3.0) kaynaklıdır. Npcap ayrı bir üründür, kendi lisansı vardır ve pakete dahil değildir. Garanti yoktur.
