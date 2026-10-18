'use strict';
// Yardımcı programların yolu. Paketli sürümde bin/ app.asar dışına açılır (app.asar.unpacked);
// geliştirme sürümünde kod doğrudan kaynak klasöründen yüklendiği için bin/ yanındadır.
const path = require('path');

function binPath(name) {
  const p = path.join(__dirname, '..', 'bin', name);
  return p.replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
}

module.exports = { binPath };
