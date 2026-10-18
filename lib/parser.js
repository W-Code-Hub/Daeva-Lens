'use strict';
// Aion 2 oyun trafiği çözücü (pasif). Yardımcı programın verdiği TCP yüklerini
// sıraya koyar, çerçevelere böler, LZ4 demetlerini açar. Hiçbir şey göndermez.
//
// Çerçeve: varint uzunluk L + (isteğe bağlı 0xF0..0xFE bayrak) + 2 bayt opcode + gövde.
// Çerçevenin toplam boyu L - 3. opcode FF FF = demet: u32 LE açılmış boy + LZ4 blok.
// Sunucu -> istemci yönü şifresiz. İstemci -> sunucu yönü şifreli; orada sadece
// çerçeve boyları okunur (uzunluk baytı açık).

function readVarint(b, i) {
  let r = 0, s = 0;
  for (let n = 0; n < 4; n++) {
    if (i >= b.length) return null;
    const x = b[i++];
    r += (x & 0x7f) * (1 << s);
    s += 7;
    if (x < 0x80) return [r, i];
  }
  let val = BigInt(r);
  let shift = 28n;
  for (let n = 4; n < 10; n++) {
    if (i >= b.length) return null;
    const x = b[i++];
    val |= BigInt(x & 0x7f) << shift;
    shift += 7n;
    if (x < 0x80) {
      const num = Number(BigInt.asIntN(64, val));
      return [num, i];
    }
  }
  return null;
}

// Saf JS LZ4 blok açıcı
function lz4Block(src, outSize) {
  const dst = Buffer.allocUnsafe(outSize);
  let si = 0, di = 0;
  while (si < src.length) {
    const token = src[si++];
    let lit = token >> 4;
    if (lit === 15) {
      let b;
      do {
        if (si >= src.length) throw new Error('lz4 taşma');
        b = src[si++];
        lit += b;
      } while (b === 255);
    }
    if (di + lit > outSize || si + lit > src.length) throw new Error('lz4 taşma');
    src.copy(dst, di, si, si + lit); si += lit; di += lit;
    if (si >= src.length) break;
    if (si + 2 > src.length) throw new Error('lz4 taşma');
    const off = src[si] | (src[si + 1] << 8); si += 2;
    if (off === 0 || off > di) throw new Error('lz4 ofset');
    let ml = token & 15;
    if (ml === 15) {
      let b;
      do {
        if (si >= src.length) throw new Error('lz4 taşma');
        b = src[si++];
        ml += b;
      } while (b === 255);
    }
    ml += 4;
    if (di + ml > outSize) throw new Error('lz4 taşma');
    if (off === 1) {
      dst.fill(dst[di - 1], di, di + ml);
      di += ml;
    } else if (off >= ml) {
      dst.copyWithin(di, di - off, di - off + ml);
      di += ml;
    } else {
      for (let k = 0; k < ml; k++) { dst[di] = dst[di - off]; di++; }
    }
  }
  return di === outSize ? dst : dst.subarray(0, di);
}

// Bir bayt dizisini çerçevelere ayırır. Kalan (yarım) baytların başlangıcını döndürür.
function splitFrames(b, onFrame, depth = 0) {
  let i = 0;
  while (i < b.length) {
    if (b[i] === 0) { i++; continue; }
    const v = readVarint(b, i);
    if (!v) break;
    const tot = v[0] + (v[1] - i) - 4;
    if (tot <= 0 || tot > 1 << 20) return { rest: i, bad: true };
    if (i + tot > b.length) break;
    let k = v[1];
    const end = i + tot;
    if (k < end && b[k] >= 0xf0 && b[k] <= 0xfe) k++;
    if (k + 2 > end) { i = end; continue; }
    const op = (b[k] << 8) | b[k + 1];
    const body = b.subarray(k + 2, end);
    if (op === 0xffff && body.length >= 4 && depth < 4) {
      const n = body.readUInt32LE(0);
      if (n > 0 && n < 8 << 20) {
        try { splitFrames(lz4Block(body.subarray(4), n), onFrame, depth + 1); } catch { /* bozuk demet */ }
      }
    } else {
      onFrame(op, body, tot);
    }
    i = end;
  }
  return { rest: i, bad: false };
}

// Şifreli yön: sadece çerçeve boyları
function splitSizes(b, onFrame) {
  let i = 0;
  while (i < b.length) {
    if (b[i] === 0) { i++; continue; }
    const v = readVarint(b, i);
    if (!v) break;
    const tot = v[0] + (v[1] - i) - 4;
    if (tot <= 0 || tot > 1 << 20) return { rest: i, bad: true };
    if (i + tot > b.length) break;
    onFrame(-1, null, tot);
    i += tot;
  }
  return { rest: i, bad: false };
}

// Tek yönlü TCP akışı: sıra numarasına göre birleştirir
const GAP_TIMEOUT_MS = 500; // kayıp paket boşluğu en çok bu kadar beklenir

class Stream {
  constructor(onFrame, encrypted) {
    this.onFrame = onFrame;
    this.encrypted = encrypted; // true: sadece çerçeve boyları
    this.next = null;           // beklenen sıra no
    this.pending = new Map();   // seq -> Buffer
    this.buf = Buffer.alloc(0);
    this.gaps = 0;
    this.gapAt = 0;             // en eski bekleyen parçanın geldiği an (0: bekleyen yok)
  }

  push(seq, data, now = Date.now()) {
    if (!data.length) return;
    if (this.next === null) { this.next = seq; this.resync = true; }
    const d = (seq - this.next) | 0; // 32 bit fark
    if (d < 0) {
      if (d + data.length <= 0) return; // tekrar
      data = data.subarray(-d); seq = this.next;
    }
    if (seq !== this.next) {
      this.pending.set(seq >>> 0, data);
      if (!this.gapAt) this.gapAt = now;
      if (this.pending.size > 64) this.skipGap();
      return;
    }
    this.append(data);
    this.drain();
  }

  drain() {
    let found = true;
    while (found && this.pending.size) {
      found = false;
      for (const [s, dta] of this.pending) {
        const d = (s - this.next) | 0;
        if (d <= 0) {
          this.pending.delete(s);
          if (d + dta.length > 0) this.append(dta.subarray(-d));
          found = true;
          break;
        }
      }
    }
    if (!this.pending.size) this.gapAt = 0;
  }

  // Kayıp paket zaman aşımı: eksik parça GAP_TIMEOUT_MS içinde gelmediyse atla (akış sonsuza dek beklemesin)
  checkGap(now) {
    if (this.pending.size && this.gapAt && now - this.gapAt > GAP_TIMEOUT_MS) { this.skipGap(); this.gapAt = this.pending.size ? now : 0; }
  }

  // Kayıp paket: en yakın bekleyen parçaya atla ve çerçeve sınırını yeniden bul
  skipGap() {
    let best = null;
    for (const s of this.pending.keys()) {
      const d = (s - this.next) | 0;
      if (d > 0 && (best === null || d < best)) best = d;
    }
    if (best === null) {
      this.pending.clear();
      this.gapAt = 0;
      return;
    }
    this.gaps++;
    this.next = (this.next + best) >>> 0;
    this.buf = Buffer.alloc(0);
    this.resync = true;
    this.drain();
  }

  append(data) {
    this.next = (this.next + data.length) >>> 0;
    this.buf = this.buf.length ? Buffer.concat([this.buf, data]) : data;
    if (this.resync) {
      // Parça başı çoğunlukla çerçeve başıdır; değilse geçerli zincir bulunana kadar kaydır
      const off = findChain(this.buf);
      if (off < 0) { if (this.buf.length > 4096) this.buf = Buffer.alloc(0); return; }
      if (off > 0) {
        const remLen = this.buf.length - off;
        const rem = Buffer.allocUnsafe(remLen);
        this.buf.copy(rem, 0, off);
        this.buf = rem;
      }
      this.resync = false;
    }
    const r = this.encrypted ? splitSizes(this.buf, this.onFrame) : splitFrames(this.buf, this.onFrame);
    if (r.bad) { this.buf = Buffer.alloc(0); this.resync = true; return; }
    if (r.rest >= this.buf.length) {
      this.buf = Buffer.alloc(0);
    } else if (r.rest > 0) {
      const remLen = this.buf.length - r.rest;
      const rem = Buffer.allocUnsafe(remLen);
      this.buf.copy(rem, 0, r.rest);
      this.buf = rem;
    }
    if (this.buf.length > 1 << 22) { this.buf = Buffer.alloc(0); this.resync = true; }
  }
}

// Ardışık 2 geçerli çerçeve başlığının başladığı ilk ofset (yoksa ve veri azsa -1)
function findChain(b) {
  for (let s = 0; s < Math.min(b.length, 2048); s++) {
    if (b[s] === 0) continue;
    let i = s, ok = 0;
    while (ok < 3) {
      while (i < b.length && b[i] === 0) i++; // dolgu
      if (i >= b.length) { if (ok >= 1) ok = 3; break; }
      const v = readVarint(b, i);
      if (!v) break;
      const tot = v[0] + (v[1] - i) - 4;
      if (tot < 3 || tot > 1 << 20) break;
      if (i + tot > b.length) { if (ok >= 1 || s === 0) ok = 3; break; }
      i += tot; ok++;
    }
    if (ok >= 3) return s;
  }
  return -1;
}

module.exports = { Stream, splitFrames, splitSizes, lz4Block, readVarint };
