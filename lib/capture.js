'use strict';
// Trafik yardımcısını (bin/a2co-capture.exe) başlatır ve satırlarını iletir.
// Yardımcı sadece AION2.exe bağlantılarının kopyasını okur; hiçbir şey göndermez veya değiştirmez.
// Npcap kurulu olmalıdır; yardımcı yönetici (UAC) onayı istemez, Npcap yoksa başlatılmaz.

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { binPath } = require('./paths');

class Capture {
  constructor(opts) {
    this.app = opts.app;
    this.log = opts.log || (() => {});
    this.onLine = opts.onLine || (() => {});
    this.onState = opts.onState || (() => {});
    this.proc = null;
    this.wanted = false;
    this.restartTimer = null;
  }

  helperPath() { return binPath('a2co-capture.exe'); }

  static npcapInstalled() {
    const root = process.env.SystemRoot || 'C:\\Windows';
    return fs.existsSync(path.join(root, 'System32', 'Npcap', 'wpcap.dll'));
  }

  splitter() {
    let buf = '';
    let lineErrors = 0;
    return (chunk) => {
      buf += typeof chunk === 'string' ? chunk : chunk.toString('utf8');
      let start = 0;
      let i;
      try {
        while ((i = buf.indexOf('\n', start)) >= 0) {
          const line = buf.slice(start, i);
          start = i + 1;
          if (line) {
            try { this.onLine(line); } catch (err) {
              // tek satırın hatası akışı kesmesin; ilk 5 hata + sonra her 100.'sü loga yazılır
              lineErrors++;
              if (lineErrors <= 5 || lineErrors % 100 === 0) this.log('[satır hatası]', lineErrors, err && err.message);
            }
          }
        }
      } finally {
        if (start > 0) {
          buf = buf.slice(start);
        }
        if (buf.length > 8 << 20) buf = '';
      }
    };
  }

  start() {
    this.wanted = true;
    if (this.proc) return true;
    const exe = this.helperPath();
    if (process.platform !== 'win32' || !fs.existsSync(exe)) {
      this.log('trafik yardımcısı bulunamadı', exe);
      this.onState({ running: false, error: 'Capture helper not found' });
      return false;
    }
    if (Capture.npcapInstalled()) {
      const child = spawn(exe, ['-backend', 'npcap'], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
      this.proc = { kind: 'child', child };
      child.stdout.on('data', this.splitter());
      child.stderr.on('data', (d) => this.log('[yardımcı stderr]', d.toString().slice(0, 300)));
      child.on('exit', (code) => this.exited(code));
      child.on('error', (err) => { this.log('yardımcı başlatılamadı', err.message); this.proc = null; this.onState({ running: false, error: err.message }); });
      this.onState({ running: true, backend: 'npcap' });
      return true;
    }
    // Npcap yok: gizli PowerShell / yönetici izinli ham soket yedeği kaldırıldı; Npcap şart.
    this.wanted = false;
    this.log('Npcap kurulu değil');
    this.onState({ running: false, error: 'Npcap is required. Install it from npcap.com' });
    return false;
  }

  exited(code) {
    this.log('yardımcı kapandı', code);
    const was = this.proc;
    this.proc = null;
    this.onState({ running: false });
    if (this.wanted && was) {
      clearTimeout(this.restartTimer);
      this.restartTimer = setTimeout(() => this.start(), 5000);
    }
  }

  stop() {
    this.wanted = false;
    clearTimeout(this.restartTimer);
    const p = this.proc;
    this.proc = null;
    if (!p) return;
    try { p.child.stdin.end(); } catch { /* yok say */ }
    try { p.child.kill(); } catch { /* yok say */ }
  }
}

module.exports = { Capture };
