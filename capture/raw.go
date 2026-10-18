// Copyright (C) 2026 W-Code (W-Code-Hub). GPL-3.0-or-later; no warranty.
package main

// Npcap gerektirmeyen yöntem: Windows ham soket (SIO_RCVALL).
// Ek sürücü kurmaz, ama yönetici izni gerektirir. Sadece okuma yapar,
// hiçbir paket göndermez ya da değiştirmez.

import (
	"fmt"
	"net"
	"syscall"
	"time"
	"unsafe"
)

const sioRcvall = 0x98000001

type rawCap struct {
	ip     net.IP
	fd     syscall.Handle
	closed bool
}

func wsaInit() {
	var d syscall.WSAData
	syscall.WSAStartup(uint32(0x202), &d)
}

func openRaw(ip net.IP) (*rawCap, error) {
	fd, err := syscall.Socket(syscall.AF_INET, syscall.SOCK_RAW, syscall.IPPROTO_IP)
	if err != nil {
		if errno, ok := err.(syscall.Errno); ok && (errno == 10013 || errno == syscall.ERROR_ACCESS_DENIED) {
			return nil, fmt.Errorf("yönetici izni gerekli (ham soket açılamadı)")
		}
		return nil, fmt.Errorf("ham soket açılamadı: %v", err)
	}
	sa := &syscall.SockaddrInet4{}
	copy(sa.Addr[:], ip.To4())
	if err := syscall.Bind(fd, sa); err != nil {
		syscall.Closesocket(fd)
		return nil, fmt.Errorf("ham soket bağlanamadı (%s): %v", ip, err)
	}
	syscall.SetsockoptInt(fd, syscall.SOL_SOCKET, syscall.SO_RCVBUF, 16<<20)
	in := uint32(1) // RCVALL_ON
	var ret uint32
	if err := syscall.WSAIoctl(fd, sioRcvall, (*byte)(unsafe.Pointer(&in)), 4, nil, 0, &ret, nil, 0); err != nil {
		syscall.Closesocket(fd)
		if errno, ok := err.(syscall.Errno); ok && errno == 10013 {
			return nil, fmt.Errorf("yönetici izni gerekli (SIO_RCVALL)")
		}
		return nil, fmt.Errorf("SIO_RCVALL başarısız (%s): %v", ip, err)
	}
	return &rawCap{ip: ip, fd: fd}, nil
}

func (r *rawCap) close() {
	if !r.closed {
		r.closed = true
		syscall.Closesocket(r.fd)
	}
}

func rawLoop(r *rawCap, st *state) {
	buf := make([]byte, 65536)
	errs := 0
	for !r.closed {
		var n, flags uint32
		wb := syscall.WSABuf{Len: uint32(len(buf)), Buf: &buf[0]}
		err := syscall.WSARecv(r.fd, &wb, 1, &n, &flags, nil, nil)
		if err != nil {
			if r.closed {
				return
			}
			errs++
			if errs <= 3 || errs%100 == 0 {
				status("ham soket okuma hatası (%s): %v", r.ip, err)
			}
			time.Sleep(200 * time.Millisecond)
			continue
		}
		if n == 0 {
			continue
		}
		st.countRaw(buf[:n], r.ip)
		seg, ok := parseFrame(12, buf[:n]) // ham IPv4
		if !ok || len(seg.payload) == 0 {
			continue
		}
		dir, key, ok := st.lookup(seg)
		if !ok {
			continue
		}
		p := make([]byte, len(seg.payload))
		copy(p, seg.payload)
		seg.payload = p
		emitPkt(time.Now().UnixMilli(), dir, key, seg)
	}
}
