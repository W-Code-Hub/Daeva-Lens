Turkce | English: README-test.en.txt

DAEVA LENS - TESTLER (paketin disinda)

Calistirma (Node yeterli, Electron gerekmez):
  cd (proje klasoru)
  node tools/test.js

Sonunda "N geçti, M hatalı, K atlandı" yazar. Hata varsa cikis kodu 1'dir.

Icerik:
  tools/test.js       Ana test: motor/sayac/ayristirici birim testleri, kayit tekrar oynatma
                      (test/beklenen.json), fuzz tekrar oynatma. Kod yolu: proje koku
  tools/test-yeni.js  Yeni modul testleri: timers, ratings, recap, pb, autoshow,
                      ui/mask, itemKind, sharecard (saf kisimlar), classifyBossCast
  tools/replay.js, satirlar.js  Yardimci araclar (kayit okuma/denetim)
  test/beklenen.json  Her kayit icin dogru cevaplar
  test/kayitlar/      Yalnizca adsiz ornek kayit; digerleri gizlilik nedeniyle yayinlanmaz, ilgili testler ATLANDI olur

Notlar:
  - Fuzz testi kayitlari su klasorlerde arar: test/kayitlar, %APPDATA%\Daeva Lens\kayitlar,
    %APPDATA%\Aion2 Cube Overlay\kayitlar. Bu klasorlerdeki kayit sayisi sonucu (kayit/cerceve) degistirir.
  - Baska klasor vermek icin: node tools/test.js <klasor>
  - Testler gecici dosyalari sistem temp klasorune yazar ve siler; AppData'ya yazmaz.
  - Kaldirilanlar: eski klavye sistemi (KeyOverlay, a2-keys.exe, keymap), devlog ve
    deneysel (Labs) testleri; kodlari artik yok. ui/keyskills.js uygulamada hala kullanilir.
