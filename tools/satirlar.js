'use strict';
// Faz 5.0-K.3: kayıt dosyalarını AKIŞLA, satır satır okur; dosyanın tamamı belleğe alınmaz.
// Bir oturum dosyası 24 saatte 1 GB'ı geçebilir. .jsonl ve .jsonl.gz okur.
// Yarım kalmış (çökmeden kalan) gzip dosyası da okunur: son tam boşaltmaya (10 sn) kadarki satırlar gelir,
// sonda yarım kalan satır JSON olarak çözülemez ve atlanır; dönen bilgide yarim: true olur.
//
//   const { forEachLine } = require('./satirlar');
//   const info = await forEachLine(dosya, (satır) => { ... });   // info: { lines, bytes, yarim, hata }
const fs = require('fs');
const zlib = require('zlib');
const { StringDecoder } = require('string_decoder');

function forEachLine(file, fn) {
  return new Promise((resolve, reject) => {
    const info = { lines: 0, bytes: 0, yarim: false, hata: null };
    let src;
    try { src = fs.createReadStream(file, { highWaterMark: 1 << 20 }); } catch (err) { reject(err); return; }
    let stream = src;
    if (/\.gz$/i.test(file)) {
      // Z_SYNC_FLUSH: dosya sonu eksikse (çökme) hata vermeden o ana kadarkini çıkar
      const gz = zlib.createGunzip({ finishFlush: zlib.constants.Z_SYNC_FLUSH });
      src.on('error', (err) => gz.destroy(err));
      src.pipe(gz);
      stream = gz;
    }
    const dec = new StringDecoder('utf8');
    let rest = '';
    let stopped = false;
    const emit = (s) => {
      if (stopped) return;
      if (s.endsWith('\r')) s = s.slice(0, -1);
      info.lines++;
      if (fn(s) === false) { stopped = true; stream.destroy(); finish(); }
    };
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      if (!stopped) { rest += dec.end(); if (rest) { info.yarim = info.yarim || !rest.trim().endsWith('}'); emit(rest); } }
      resolve(info);
    };
    stream.on('data', (chunk) => {
      info.bytes += chunk.length;
      const s = rest + dec.write(chunk);
      let i0 = 0, i;
      while (!stopped && (i = s.indexOf('\n', i0)) >= 0) { emit(s.slice(i0, i)); i0 = i + 1; }
      rest = stopped ? '' : s.slice(i0);
    });
    stream.on('end', finish);
    stream.on('close', finish);
    stream.on('error', (err) => {
      // bozuk ya da kesik gzip: o ana kadar okunanlar geçerli
      info.yarim = true;
      info.hata = err.message;
      finish();
    });
  });
}

// Kolaylık: satırları JSON olarak verir (çözülemeyen satır atlanır)
async function forEachJson(file, fn) {
  return forEachLine(file, (line) => {
    if (!line) return undefined;
    let m;
    try { m = JSON.parse(line); } catch { return undefined; }
    return fn(m);
  });
}

module.exports = { forEachLine, forEachJson };
