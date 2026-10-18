# Daeva Lens - Kendin Derle (adım adım)

Türkçe · English: [BUILD.md](../../BUILD.md)

Bu rehber programlama bilmeyenler içindir. Hazır sürümü kullanmak istiyorsanız derlemeye gerek yok: [Sürümler](https://github.com/W-Code-Hub/daeva-lens/releases/latest) sayfasındaki zip'i çıkarıp `Daeva Lens.exe` çalıştırın. Bu rehber, kaynak koddan kendi sürümünüzü üretmek içindir.

## Neye ihtiyaç var
- Windows 10/11 (64 bit)
- İnternet (ilk kurulumda gerekli paketler indirilir, yaklaşık 300 MB)
- Boş disk alanı: yaklaşık 2 GB

## 1. Node.js'i kurun (bir kez)
1. https://nodejs.org adresine gidin, **LTS** sürümünü indirip kurun (hep "İleri").
2. Kurulumdan sonra bir **PowerShell** penceresi açın (Başlat'a "PowerShell" yazın).
3. `node -v` yazıp Enter'a basın. Bir sürüm numarası görürseniz tamam.

## 2. Klasöre girin
PowerShell'de, indirdiğiniz `daeva-lens` klasörüne (içinde `package.json` olan) girin. Örneğin Downloads (İndirilenler) klasöründeyse:
```
cd "$HOME\Downloads\daeva-lens"
```
(Yolu klasörün gerçek yerine göre değiştirin. Klasörü Gezgin'de açıp adres çubuğuna `powershell` yazarak da açabilirsiniz.)

## 3. Gerekli paketleri indirin
```
npm install
```
Birkaç dakika sürer. Sarı uyarılar normaldir; kırmızı "ERR" varsa internetinizi kontrol edip tekrar deneyin.

## 4. Testleri çalıştırın (isteğe bağlı ama önerilir)
```
npm test
```
Hata varsa derlemeyi sürdürmeyin.

## 5. Programı denemek için açın (isteğe bağlı)
```
npm start
```
Not: oyun verisi için **Npcap** kurulu olmalıdır (https://npcap.com/#download).

## 6. Derleyin
```
npm run dist
```
Bu komut `electron-builder` ile programı paketler (içinde `app.asar` oluşur) ve ardından `tools\postbuild.js` ile exe'ye simge ve sürüm bilgisi yazar. Bitince hazır klasör:
```
dist\win-unpacked\
```
İçindeki `Daeva Lens.exe` çalıştırılabilir. Klasörün tamamını bir yere kopyalayın (tek başına exe yetmez).

## 7. Doğrulama (isteğe bağlı)
```
certutil -hashfile "dist\win-unpacked\Daeva Lens.exe" SHA256
```
Derlemeniz resmî sürümle bire bir aynı hash'i **vermeyebilir**; bu normaldir (derleme zamanı ve paket sürümleri farklılık yaratır).

## Sorun giderme
- `npm` tanınmıyor: PowerShell'i kapatıp yeniden açın; olmazsa Node'u yeniden kurun.
- İndirme hatası: antivirüs veya kurumsal ağ engelliyor olabilir; başka ağda deneyin.
- Derleme sırasında "dosya kilitli": çalışan Daeva Lens'i kapatın, `dist` klasörünü silip tekrar deneyin.
- Exe imzasızdır; Windows SmartScreen uyarırsa **Ek bilgi > Yine de çalıştır**.

## Test kayıtları hakkında
Tam testler yerel oyun kayıtları ister; gizlilik nedeniyle kayıtlar yayınlanmıyor, bu testler atlanır. Kayıt gerektiren testler çıktıda "ATLANDI (yerel kayıt gerekli)" olarak görünür. `test/kayitlar/` içinde yalnız adsız bir örnek kayıt kalır; yerel ağ adresleri anonimleştirilmiştir (10.0.0.x), sunucu adresleri oyunun herkese açık sunucularıdır.

## Yardımcı programı (a2co-capture.exe) kaynaktan derleme
`bin\a2co-capture.exe`, oyunun ağ trafiğini pasif dinleyen küçük yardımcı programdır (Go ile yazılmış, GPL-3.0). Kaynağı `capture` klasöründedir (`main.go`, `raw.go`, `go.mod`).

1. Go'yu resmî siteden kurun: https://go.dev/dl/ (Windows, 1.21 veya yenisi; hep "İleri").
2. İndirdiğiniz `daeva-lens` klasöründe yeni bir PowerShell açın (yukarıdaki 2. adıma bakın) ve `capture` klasörüne girin:
```
cd capture
$env:GOOS="windows"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
go build -trimpath -o a2co-capture.exe .
```
3. İsterseniz kendi derlemenizi `bin` klasörüne kopyalayıp programı onunla çalıştırabilirsiniz.
