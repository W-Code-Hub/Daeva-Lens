// Copyright (C) 2026 W-Code (W-Code-Hub). GPL-3.0-or-later; no warranty.
// a2co-capture: Aion 2 Cube Overlay için pasif ağ dinleyici.
//
// Ne yapar:
//   - AION2.exe sürecinin açık TCP bağlantılarını Windows'tan sorar (GetExtendedTcpTable),
//   - Npcap (wpcap.dll) ile SADECE bu bağlantıların trafiğini pasif olarak dinler,
//   - TCP yüklerini JSON satırları halinde standart çıkışa yazar.
//
// Ne yapmaz:
//   - Oyun sürecine bağlanmaz, belleğini okumaz, hiçbir şey enjekte etmez,
//   - Paket göndermez, değiştirmez, engellemez (sadece kopyasını okur).
//
// Çıktı (her satır bir JSON):
//   {"type":"status","msg":"..."}
//   {"type":"conns","pid":123,"conns":[{"local":"1.2.3.4:5","remote":"6.7.8.9:10"}]}
//   {"type":"pkt","t":1696350000123,"dir":"in|out","conn":"6.7.8.9:10","seq":123,"data":"base64"}
//   {"type":"error","msg":"..."}

package main

import (
	"bufio"
	"encoding/base64"
	"encoding/binary"
	"encoding/json"
	"flag"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"sync"
	"syscall"
	"time"
	"unsafe"
)

var (
	out   = bufio.NewWriterSize(os.Stdout, 1<<16)
	outMu sync.Mutex
)

var logOut *os.File

func emit(v interface{}) {
	b, err := json.Marshal(v)
	if err != nil {
		return
	}
	outMu.Lock()
	out.Write(b)
	out.WriteByte('\n')
	if logOut != nil {
		if m, ok := v.(map[string]interface{}); ok && m["type"] != "pkt" {
			logOut.WriteString(time.Now().Format("2006-01-02T15:04:05.000") + " " + string(b) + "\n")
		}
	}
	outMu.Unlock()
}

func status(format string, a ...interface{}) {
	emit(map[string]interface{}{"type": "status", "msg": fmt.Sprintf(format, a...)})
}

func fail(format string, a ...interface{}) {
	emit(map[string]interface{}{"type": "error", "msg": fmt.Sprintf(format, a...)})
	outMu.Lock()
	out.Flush()
	outMu.Unlock()
}

// ---------------------------------------------------------------------------
// Süreç ve TCP tablosu

// Tanı için: adında "aion" geçen süreçler
func similarProcs() []string {
	var res []string
	snap, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return res
	}
	defer syscall.CloseHandle(snap)
	var pe syscall.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := syscall.Process32First(snap, &pe); err != nil {
		return res
	}
	for {
		exe := syscall.UTF16ToString(pe.ExeFile[:])
		l := strings.ToLower(exe)
		if strings.Contains(l, "aion") || strings.Contains(l, "ncsoft") || strings.Contains(l, "purple") {
			res = append(res, fmt.Sprintf("%s(%d)", exe, pe.ProcessID))
		}
		if err := syscall.Process32Next(snap, &pe); err != nil {
			break
		}
	}
	return res
}

func findPids(name string) map[uint32]bool {
	pids := map[uint32]bool{}
	snap, err := syscall.CreateToolhelp32Snapshot(syscall.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return pids
	}
	defer syscall.CloseHandle(snap)
	var pe syscall.ProcessEntry32
	pe.Size = uint32(unsafe.Sizeof(pe))
	if err := syscall.Process32First(snap, &pe); err != nil {
		return pids
	}
	for {
		exe := syscall.UTF16ToString(pe.ExeFile[:])
		if strings.EqualFold(exe, name) {
			pids[pe.ProcessID] = true
		}
		if err := syscall.Process32Next(snap, &pe); err != nil {
			break
		}
	}
	return pids
}

type conn struct {
	LocalIP    net.IP
	LocalPort  uint16
	RemoteIP   net.IP
	RemotePort uint16
	Pid        uint32
}

func (c conn) key() string {
	return fmt.Sprintf("%s:%d>%s:%d", c.LocalIP, c.LocalPort, c.RemoteIP, c.RemotePort)
}

var (
	iphlpapi           = syscall.NewLazyDLL("iphlpapi.dll")
	procGetExtTcpTable = iphlpapi.NewProc("GetExtendedTcpTable")
	procGetExtUdpTable = iphlpapi.NewProc("GetExtendedUdpTable")
)

func ipFromU32(v uint32) net.IP {
	b := make([]byte, 4)
	binary.LittleEndian.PutUint32(b, v)
	return net.IPv4(b[0], b[1], b[2], b[3]).To4()
}

func portFromU32(v uint32) uint16 {
	// alt 16 bit, ağ bayt sırası
	return uint16((v&0xff)<<8 | (v>>8)&0xff)
}

func tcpConnsFor(pids map[uint32]bool) []conn {
	var size uint32
	const afInet = 2
	const tcpTableOwnerPidAll = 5
	procGetExtTcpTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, afInet, tcpTableOwnerPidAll, 0)
	if size == 0 {
		return nil
	}
	buf := make([]byte, size+1024)
	size = uint32(len(buf))
	r, _, _ := procGetExtTcpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, afInet, tcpTableOwnerPidAll, 0)
	if r != 0 {
		return nil
	}
	n := binary.LittleEndian.Uint32(buf[0:4])
	var res []conn
	for i := uint32(0); i < n; i++ {
		off := 4 + i*24
		if int(off+24) > len(buf) {
			break
		}
		row := buf[off : off+24]
		state := binary.LittleEndian.Uint32(row[0:4])
		pid := binary.LittleEndian.Uint32(row[20:24])
		if !pids[pid] || state != 5 { // 5 = ESTABLISHED
			continue
		}
		c := conn{
			LocalIP:    ipFromU32(binary.LittleEndian.Uint32(row[4:8])),
			LocalPort:  portFromU32(binary.LittleEndian.Uint32(row[8:12])),
			RemoteIP:   ipFromU32(binary.LittleEndian.Uint32(row[12:16])),
			RemotePort: portFromU32(binary.LittleEndian.Uint32(row[16:20])),
			Pid:        pid,
		}
		if c.RemoteIP.IsLoopback() {
			continue
		}
		res = append(res, c)
	}
	sort.Slice(res, func(a, b int) bool { return res[a].key() < res[b].key() })
	return res
}

// Oyunun UDP yerel portları (GetExtendedUdpTable, UDP_TABLE_OWNER_PID)
func udpPortsFor(pids map[uint32]bool) []uint16 {
	var size uint32
	const afInet = 2
	const udpTableOwnerPid = 1
	procGetExtUdpTable.Call(0, uintptr(unsafe.Pointer(&size)), 0, afInet, udpTableOwnerPid, 0)
	if size == 0 {
		return nil
	}
	buf := make([]byte, size+1024)
	size = uint32(len(buf))
	r, _, _ := procGetExtUdpTable.Call(uintptr(unsafe.Pointer(&buf[0])), uintptr(unsafe.Pointer(&size)), 0, afInet, udpTableOwnerPid, 0)
	if r != 0 {
		return nil
	}
	n := binary.LittleEndian.Uint32(buf[0:4])
	var res []uint16
	for i := uint32(0); i < n; i++ {
		off := 4 + i*12
		if int(off+12) > len(buf) {
			break
		}
		row := buf[off : off+12]
		pid := binary.LittleEndian.Uint32(row[8:12])
		if !pids[pid] {
			continue
		}
		ip := ipFromU32(binary.LittleEndian.Uint32(row[0:4]))
		if ip.IsLoopback() {
			continue
		}
		res = append(res, portFromU32(binary.LittleEndian.Uint32(row[4:8])))
	}
	sort.Slice(res, func(a, b int) bool { return res[a] < res[b] })
	return res
}

// Bu bilgisayarın döngü dışı IPv4 adresleri
func localIPv4s() []net.IP {
	var res []net.IP
	ifs, err := net.Interfaces()
	if err != nil {
		return res
	}
	for _, it := range ifs {
		if it.Flags&net.FlagUp == 0 || it.Flags&net.FlagLoopback != 0 {
			continue
		}
		addrs, _ := it.Addrs()
		for _, a := range addrs {
			var ip net.IP
			switch v := a.(type) {
			case *net.IPNet:
				ip = v.IP
			case *net.IPAddr:
				ip = v.IP
			}
			if ip4 := ip.To4(); ip4 != nil && !ip4.IsLoopback() && !ip4.IsLinkLocalUnicast() {
				res = append(res, ip4)
			}
		}
	}
	return res
}

// ---------------------------------------------------------------------------
// Npcap (wpcap.dll) - dinamik yükleme, cgo yok

var (
	wpcap        *syscall.LazyDLL
	pFindAllDevs *syscall.LazyProc
	pFreeAllDevs *syscall.LazyProc
	pOpenLive    *syscall.LazyProc
	pCompile     *syscall.LazyProc
	pSetFilter   *syscall.LazyProc
	pFreeCode    *syscall.LazyProc
	pNextEx      *syscall.LazyProc
	pDatalink    *syscall.LazyProc
	pClose       *syscall.LazyProc
	pGetErr      *syscall.LazyProc
	pBreakLoop   *syscall.LazyProc
)

func loadNpcap() error {
	// Npcap, DLL'lerini System32\Npcap altına koyar
	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	npcapDir := filepath.Join(sysRoot, "System32", "Npcap")
	k32 := syscall.NewLazyDLL("kernel32.dll")
	setDllDir := k32.NewProc("SetDllDirectoryW")
	if p, err := syscall.UTF16PtrFromString(npcapDir); err == nil {
		setDllDir.Call(uintptr(unsafe.Pointer(p)))
	}
	wpcap = syscall.NewLazyDLL("wpcap.dll")
	if err := wpcap.Load(); err != nil {
		return fmt.Errorf("Npcap bulunamadı (wpcap.dll yüklenemedi): %v", err)
	}
	pFindAllDevs = wpcap.NewProc("pcap_findalldevs")
	pFreeAllDevs = wpcap.NewProc("pcap_freealldevs")
	pOpenLive = wpcap.NewProc("pcap_open_live")
	pCompile = wpcap.NewProc("pcap_compile")
	pSetFilter = wpcap.NewProc("pcap_setfilter")
	pFreeCode = wpcap.NewProc("pcap_freecode")
	pNextEx = wpcap.NewProc("pcap_next_ex")
	pDatalink = wpcap.NewProc("pcap_datalink")
	pClose = wpcap.NewProc("pcap_close")
	pGetErr = wpcap.NewProc("pcap_geterr")
	pBreakLoop = wpcap.NewProc("pcap_breakloop")
	return nil
}

type pcapIf struct {
	Next        *pcapIf
	Name        *byte
	Description *byte
	Addresses   *pcapAddr
	Flags       uint32
}

type pcapAddr struct {
	Next      *pcapAddr
	Addr      *sockaddr
	Netmask   *sockaddr
	Broadaddr *sockaddr
	Dstaddr   *sockaddr
}

type sockaddr struct {
	Family uint16
	Data   [14]byte
}

type bpfProgram struct {
	Len   uint32
	Insns uintptr
}

type pcapPkthdr struct {
	TsSec  int32
	TsUsec int32
	Caplen uint32
	Len    uint32
}

func cstr(p *byte) string {
	if p == nil {
		return ""
	}
	var b []byte
	for ptr := unsafe.Pointer(p); ; ptr = unsafe.Pointer(uintptr(ptr) + 1) {
		c := *(*byte)(ptr)
		if c == 0 {
			break
		}
		b = append(b, c)
	}
	return string(b)
}

type device struct {
	Name string
	Desc string
	IPs  []net.IP
}

func listDevices() ([]device, error) {
	var all *pcapIf
	errbuf := make([]byte, 512)
	r, _, _ := pFindAllDevs.Call(uintptr(unsafe.Pointer(&all)), uintptr(unsafe.Pointer(&errbuf[0])))
	if int32(r) != 0 {
		return nil, fmt.Errorf("pcap_findalldevs: %s", cstr(&errbuf[0]))
	}
	defer pFreeAllDevs.Call(uintptr(unsafe.Pointer(all)))
	var res []device
	for d := all; d != nil; d = d.Next {
		dev := device{Name: cstr(d.Name), Desc: cstr(d.Description)}
		for a := d.Addresses; a != nil; a = a.Next {
			if a.Addr != nil && a.Addr.Family == 2 { // AF_INET
				ip := net.IPv4(a.Addr.Data[2], a.Addr.Data[3], a.Addr.Data[4], a.Addr.Data[5]).To4()
				dev.IPs = append(dev.IPs, ip)
			}
		}
		res = append(res, dev)
	}
	return res, nil
}

type handle struct {
	ptr      uintptr
	dev      device
	linkType int
	filter   string
	mu       sync.Mutex
	closed   bool
}

func openDevice(d device) (*handle, error) {
	errbuf := make([]byte, 512)
	name, _ := syscall.BytePtrFromString(d.Name)
	h, _, _ := pOpenLive.Call(uintptr(unsafe.Pointer(name)), 65535, 0, 100, uintptr(unsafe.Pointer(&errbuf[0])))
	if h == 0 {
		return nil, fmt.Errorf("pcap_open_live(%s): %s", d.Desc, cstr(&errbuf[0]))
	}
	lt, _, _ := pDatalink.Call(h)
	return &handle{ptr: h, dev: d, linkType: int(lt)}, nil
}

func (h *handle) setFilter(expr string) error {
	h.mu.Lock()
	defer h.mu.Unlock()
	var prog bpfProgram
	cexpr, _ := syscall.BytePtrFromString(expr)
	r, _, _ := pCompile.Call(h.ptr, uintptr(unsafe.Pointer(&prog)), uintptr(unsafe.Pointer(cexpr)), 1, 0xffffffff)
	if int32(r) != 0 {
		e, _, _ := pGetErr.Call(h.ptr)
		return fmt.Errorf("pcap_compile: %s", cstr((*byte)(unsafe.Pointer(e))))
	}
	defer pFreeCode.Call(uintptr(unsafe.Pointer(&prog)))
	r, _, _ = pSetFilter.Call(h.ptr, uintptr(unsafe.Pointer(&prog)))
	if int32(r) != 0 {
		e, _, _ := pGetErr.Call(h.ptr)
		return fmt.Errorf("pcap_setfilter: %s", cstr((*byte)(unsafe.Pointer(e))))
	}
	return nil
}

// ---------------------------------------------------------------------------
// Paket çözme (Ethernet / Null / Raw -> IPv4 -> TCP)

type tcpSeg struct {
	proto            byte // 6 = TCP, 17 = UDP
	srcIP, dstIP     net.IP
	srcPort, dstPort uint16
	seq              uint32
	flags            byte
	payload          []byte
}

func parseFrame(linkType int, data []byte) (*tcpSeg, bool) {
	var ip []byte
	switch linkType {
	case 1: // Ethernet
		if len(data) < 14 {
			return nil, false
		}
		et := binary.BigEndian.Uint16(data[12:14])
		off := 14
		if et == 0x8100 && len(data) >= 18 { // VLAN
			et = binary.BigEndian.Uint16(data[16:18])
			off = 18
		}
		if et != 0x0800 {
			return nil, false
		}
		ip = data[off:]
	case 0, 108: // Null / Loop
		if len(data) < 4 {
			return nil, false
		}
		ip = data[4:]
	case 12, 101: // Raw IP
		ip = data
	default:
		return nil, false
	}
	if len(ip) < 20 || ip[0]>>4 != 4 {
		return nil, false
	}
	proto := ip[9]
	if proto != 6 && proto != 17 {
		return nil, false
	}
	// parçalanmış IP paketlerinin devam parçaları atlanır (başlık yok)
	if binary.BigEndian.Uint16(ip[6:8])&0x1fff != 0 {
		return nil, false
	}
	ihl := int(ip[0]&0x0f) * 4
	total := int(binary.BigEndian.Uint16(ip[2:4]))
	if total > len(ip) || total < ihl+8 {
		total = len(ip)
	}
	if ihl < 20 || ihl > total {
		return nil, false
	}
	l4 := ip[ihl:total]
	seg := &tcpSeg{
		proto: proto,
		srcIP: net.IPv4(ip[12], ip[13], ip[14], ip[15]).To4(),
		dstIP: net.IPv4(ip[16], ip[17], ip[18], ip[19]).To4(),
	}
	if proto == 17 {
		if len(l4) < 8 {
			return nil, false
		}
		seg.srcPort = binary.BigEndian.Uint16(l4[0:2])
		seg.dstPort = binary.BigEndian.Uint16(l4[2:4])
		seg.payload = l4[8:]
		return seg, true
	}
	if len(l4) < 20 {
		return nil, false
	}
	doff := int(l4[12]>>4) * 4
	if doff > len(l4) || doff < 20 {
		return nil, false
	}
	seg.srcPort = binary.BigEndian.Uint16(l4[0:2])
	seg.dstPort = binary.BigEndian.Uint16(l4[2:4])
	seg.seq = binary.BigEndian.Uint32(l4[4:8])
	seg.flags = l4[13]
	seg.payload = l4[doff:]
	return seg, true
}

// ---------------------------------------------------------------------------

type state struct {
	mu       sync.RWMutex
	conns    map[string]conn // TCP: "remoteIP:port" -> conn
	udpPorts map[uint16]bool // oyunun UDP yerel portları
	localIPs map[string]bool // bu bilgisayarın IPv4 adresleri

	// istatistik (ham soket)
	stMu                  sync.Mutex
	rawAll, rawIn, rawOut int64
	tcpIn, tcpOut         int64
	udpIn, udpOut         int64
	udpOther              map[string]int64 // eşleşmeyen UDP uç noktaları (tanı için)
}

func (s *state) lookup(seg *tcpSeg) (string, string, bool) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if seg.proto == 17 {
		if s.udpPorts[seg.dstPort] && s.localIPs[seg.dstIP.String()] {
			s.count(false, "in")
			return "in", fmt.Sprintf("udp:%s:%d", seg.srcIP, seg.srcPort), true
		}
		if s.udpPorts[seg.srcPort] && s.localIPs[seg.srcIP.String()] {
			s.count(false, "out")
			return "out", fmt.Sprintf("udp:%s:%d", seg.dstIP, seg.dstPort), true
		}
		return "", "", false
	}
	k1 := fmt.Sprintf("%s:%d", seg.srcIP, seg.srcPort)
	if c, ok := s.conns[k1]; ok && c.LocalPort == seg.dstPort {
		s.count(true, "in")
		return "in", k1, true
	}
	k2 := fmt.Sprintf("%s:%d", seg.dstIP, seg.dstPort)
	if c, ok := s.conns[k2]; ok && c.LocalPort == seg.srcPort {
		s.count(true, "out")
		return "out", k2, true
	}
	return "", "", false
}

func (s *state) count(tcp bool, dir string) {
	s.stMu.Lock()
	defer s.stMu.Unlock()
	switch {
	case tcp && dir == "in":
		s.tcpIn++
	case tcp:
		s.tcpOut++
	case dir == "in":
		s.udpIn++
	default:
		s.udpOut++
	}
}

// Ham sokete gelen her paketi say (güvenlik duvarı gelen yönü kesiyor mu anlamak için)
func (s *state) countRaw(ip []byte, local net.IP) {
	if len(ip) < 20 {
		return
	}
	s.stMu.Lock()
	defer s.stMu.Unlock()
	s.rawAll++
	dst := net.IPv4(ip[16], ip[17], ip[18], ip[19])
	if dst.Equal(local) {
		s.rawIn++
	} else {
		s.rawOut++
	}
}

func (s *state) emitStats() {
	s.stMu.Lock()
	m := map[string]interface{}{
		"type": "stats", "raw": s.rawAll, "rawIn": s.rawIn, "rawOut": s.rawOut,
		"tcpIn": s.tcpIn, "tcpOut": s.tcpOut, "udpIn": s.udpIn, "udpOut": s.udpOut,
	}
	s.stMu.Unlock()
	emit(m)
}

func buildFilter(cs []conn, udp []uint16) string {
	var parts []string
	for _, c := range cs {
		parts = append(parts, fmt.Sprintf("(tcp and host %s and port %d)", c.RemoteIP, c.RemotePort))
	}
	for _, p := range udp {
		parts = append(parts, fmt.Sprintf("(udp and port %d)", p))
	}
	if len(parts) == 0 {
		return "tcp and host 0.0.0.0" // hiçbir şey eşleşmez
	}
	return strings.Join(parts, " or ")
}

func emitPkt(ts int64, dir, key string, seg *tcpSeg) {
	m := map[string]interface{}{
		"type": "pkt",
		"t":    ts,
		"dir":  dir,
		"conn": key,
		"data": base64.StdEncoding.EncodeToString(seg.payload),
	}
	if seg.proto == 17 {
		m["proto"] = "udp"
	} else {
		m["seq"] = seg.seq
		m["fl"] = seg.flags
	}
	emit(m)
}

func npcapAvailable() bool {
	sysRoot := os.Getenv("SystemRoot")
	if sysRoot == "" {
		sysRoot = `C:\Windows`
	}
	_, err := os.Stat(filepath.Join(sysRoot, "System32", "Npcap", "wpcap.dll"))
	return err == nil
}

func main() {
	procName := flag.String("process", "AION2.exe", "dinlenecek oyun süreci")
	listOnly := flag.Bool("list", false, "sadece ağ aygıtlarını ve bağlantıları listele")
	backend := flag.String("backend", "auto", "auto | npcap | raw (raw: Npcap gerektirmez, yönetici izni ister)")
	connectAddr := flag.String("connect", "", "çıktıyı bu yerel TCP adresine gönder (yönetici olarak çalışırken)")
	token := flag.String("token", "", "bağlantı doğrulama anahtarı")
	logFile := flag.String("log", "", "durum satırlarını bu dosyaya da yaz")
	flag.Parse()

	if *logFile != "" {
		if f, err := os.OpenFile(*logFile, os.O_CREATE|os.O_WRONLY|os.O_APPEND, 0644); err == nil {
			logOut = f
		}
	}

	// Çıktı hedefi: stdout ya da ana uygulamanın yerel soketi
	var connOut net.Conn
	if *connectAddr != "" {
		host, _, err := net.SplitHostPort(*connectAddr)
		if err != nil || (host != "127.0.0.1" && host != "localhost") {
			os.Exit(2) // sadece yerel bağlantıya izin ver
		}
		c, err := net.DialTimeout("tcp", *connectAddr, 5*time.Second)
		if err != nil {
			os.Exit(3)
		}
		connOut = c
		outMu.Lock()
		out = bufio.NewWriterSize(c, 1<<16)
		out.WriteString(*token + "\n")
		outMu.Unlock()
	}

	defer func() {
		outMu.Lock()
		out.Flush()
		outMu.Unlock()
	}()

	go func() {
		for {
			time.Sleep(100 * time.Millisecond)
			outMu.Lock()
			err := out.Flush()
			outMu.Unlock()
			if err != nil && connOut != nil {
				os.Exit(0) // ana uygulama kapandı
			}
		}
	}()

	// Ana uygulama kapanırsa çık
	go func() {
		buf := make([]byte, 64)
		for {
			var err error
			if connOut != nil {
				_, err = connOut.Read(buf)
			} else {
				_, err = os.Stdin.Read(buf)
			}
			if err != nil {
				outMu.Lock()
				out.Flush()
				outMu.Unlock()
				os.Exit(0)
			}
		}
	}()

	mode := *backend
	if mode == "auto" {
		if npcapAvailable() {
			mode = "npcap"
		} else {
			mode = "raw"
		}
	}

	var usable []device
	if mode == "npcap" {
		if err := loadNpcap(); err != nil {
			fail("%v", err)
			return
		}
		devs, err := listDevices()
		if err != nil {
			fail("%v", err)
			return
		}
		for _, d := range devs {
			if len(d.IPs) > 0 {
				usable = append(usable, d)
			}
		}
		status("yöntem: Npcap, %d ağ aygıtı (%d IPv4 adresli)", len(devs), len(usable))
	} else {
		wsaInit()
		status("yöntem: Windows ham soket (Npcap yok)")
	}

	if *listOnly {
		for _, d := range usable {
			status("aygıt: %s %v", d.Desc, d.IPs)
		}
		pids := findPids(*procName)
		status("%s süreçleri: %d", *procName, len(pids))
		for _, c := range tcpConnsFor(pids) {
			status("bağlantı: %s", c.key())
		}
		status("udp portları: %v", udpPortsFor(pids))
		status("benzer süreçler: %v", similarProcs())
		status("yerel adresler: %v", localIPv4s())
		return
	}

	st := &state{conns: map[string]conn{}, udpPorts: map[uint16]bool{}, localIPs: map[string]bool{}}
	var handles []*handle
	raws := map[string]*rawCap{}
	rawFailed := map[string]bool{}
	var hmu sync.Mutex

	openRaws := func(ips []net.IP) {
		for _, ip := range ips {
			ipk := ip.String()
			if _, ok := raws[ipk]; ok || rawFailed[ipk] {
				continue
			}
			r, err := openRaw(ip)
			if err != nil {
				rawFailed[ipk] = true
				fail("%v", err)
				continue
			}
			raws[ipk] = r
			status("dinleniyor (ham soket): %s", ipk)
			go rawLoop(r, st)
		}
	}

	lastKey := ""
	lastProcNote := time.Time{}
	refresh := func() {
		pids := findPids(*procName)
		cs := tcpConnsFor(pids)
		ups := udpPortsFor(pids)
		lips := localIPv4s()
		var keys []string
		m := map[string]conn{}
		for _, c := range cs {
			keys = append(keys, c.key())
			m[fmt.Sprintf("%s:%d", c.RemoteIP, c.RemotePort)] = c
		}
		for _, p := range ups {
			keys = append(keys, fmt.Sprintf("udp:%d", p))
		}
		lm := map[string]bool{}
		for _, ip := range lips {
			lm[ip.String()] = true
		}
		for _, c := range cs {
			lm[c.LocalIP.String()] = true
		}
		if len(pids) == 0 && time.Since(lastProcNote) > 30*time.Second {
			lastProcNote = time.Now()
			status("%s çalışmıyor; benzer süreçler: %v", *procName, similarProcs())
		}
		k := strings.Join(keys, ",")
		st.mu.Lock()
		st.localIPs = lm
		if k != lastKey {
			st.conns = m
			um := map[uint16]bool{}
			for _, p := range ups {
				um[p] = true
			}
			st.udpPorts = um
		}
		st.mu.Unlock()
		if k != lastKey {
			lastKey = k
			var list []map[string]string
			var pid uint32
			for _, c := range cs {
				pid = c.Pid
				list = append(list, map[string]string{
					"local":  fmt.Sprintf("%s:%d", c.LocalIP, c.LocalPort),
					"remote": fmt.Sprintf("%s:%d", c.RemoteIP, c.RemotePort),
				})
			}
			var pidList []uint32
			for p := range pids {
				pidList = append(pidList, p)
			}
			emit(map[string]interface{}{"type": "conns", "pid": pid, "pids": pidList, "running": len(pids) > 0, "conns": list, "udp": ups})
		}

		hmu.Lock()
		defer hmu.Unlock()

		if mode == "raw" {
			var ips []net.IP
			ips = append(ips, lips...)
			for _, c := range cs {
				ips = append(ips, c.LocalIP)
			}
			openRaws(ips)
			return
		}

		need := map[string]bool{}
		for _, c := range cs {
			for _, d := range usable {
				for _, ip := range d.IPs {
					if ip.Equal(c.LocalIP) {
						need[d.Name] = true
					}
				}
			}
		}
		if (len(cs) > 0 && len(need) == 0) || len(ups) > 0 {
			for _, d := range usable {
				need[d.Name] = true
			}
		}
		filter := buildFilter(cs, ups)
		for name := range need {
			found := false
			for _, h := range handles {
				if h.dev.Name == name {
					found = true
				}
			}
			if found {
				continue
			}
			for _, d := range usable {
				if d.Name != name {
					continue
				}
				h, err := openDevice(d)
				if err != nil {
					status("aygıt açılamadı: %v", err)
					continue
				}
				handles = append(handles, h)
				status("dinleniyor: %s %v", d.Desc, d.IPs)
				go readLoop(h, st)
			}
		}
		for _, h := range handles {
			// filtre her değiştirildiğinde Npcap tamponu boşaltılır; değişmediyse dokunma
			if h.filter == filter {
				continue
			}
			h.filter = filter
			if err := h.setFilter(filter); err != nil {
				status("filtre hatası (%s): %v", h.dev.Desc, err)
			}
		}
	}

	refresh()
	if lastKey == "" {
		status("%s bağlantısı bekleniyor (oyun açık mı?)", *procName)
	}
	tick := 0
	for {
		time.Sleep(1 * time.Second)
		tick++
		if tick%2 == 0 {
			refresh()
		}
		if tick%5 == 0 {
			st.emitStats()
		}
	}
}

func readLoop(h *handle, st *state) {
	var hdr *pcapPkthdr
	var data *byte
	for {
		h.mu.Lock()
		r, _, _ := pNextEx.Call(h.ptr, uintptr(unsafe.Pointer(&hdr)), uintptr(unsafe.Pointer(&data)))
		rc := int32(r)
		if rc == 0 {
			h.mu.Unlock()
			continue // zaman aşımı
		}
		if rc < 0 {
			h.mu.Unlock()
			status("okuma bitti (%s): %d", h.dev.Desc, rc)
			return
		}
		n := int(hdr.Caplen)
		frame := make([]byte, n)
		copy(frame, unsafe.Slice(data, n))
		tsSec, tsUsec := hdr.TsSec, hdr.TsUsec
		h.mu.Unlock()
		seg, ok := parseFrame(h.linkType, frame)
		if !ok || len(seg.payload) == 0 {
			continue
		}
		dir, key, ok := st.lookup(seg)
		if !ok {
			continue
		}
		emitPkt(int64(tsSec)*1000+int64(tsUsec)/1000, dir, key, seg)
	}
}
