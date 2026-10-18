'use strict';
// Çekmecenin sekme kimlikleri (ui/drawer.html .seg button[data-tab]) ve eski/yanlış adların çevirisi.
// Dört sekme: Boss ve Oyuncular · Beceriler · Zamanlayıcılar · Ayarlar. Eski adlar (Ölümler, Puanla/Rate, Hakkında...)
// ve tepsi menüsü gibi yerlerden gelen Türkçe adlar çekmeceyi boş açmasın diye yeni sekmelere çevrilir.

const TABS = ['boss', 'skills', 'timers', 'general'];

const ALIASES = {
  beceriler: 'skills', beceri: 'skills', sesler: 'skills', sounds: 'skills', skill: 'skills',
  genel: 'general', ayarlar: 'general', settings: 'general', about: 'general', hakkinda: 'general', 'hakkında': 'general',
  // Oyuncu değerlendirme ve ölümler artık "Boss ve Oyuncular" ekranının içinde
  players: 'boss', rate: 'boss', puanlama: 'boss', oyuncular: 'boss', ratings: 'boss', player: 'boss',
  deaths: 'boss', olumler: 'boss', 'ölümler': 'boss', death: 'boss',
  zamanlayicilar: 'timers', 'zamanlayıcılar': 'timers', timer: 'timers',
  bosslar: 'boss', bosses: 'boss',
};

const DEFAULT_TAB = 'skills';

// Gerçek sekme kimliğini döndürür; bilinmeyen ad varsayılan sekmeye (Beceriler) düşer
function normTab(tab) {
  if (typeof tab !== 'string' || !tab.trim()) return DEFAULT_TAB;
  const k = tab.trim().toLowerCase();
  if (TABS.includes(k)) return k;
  if (Object.prototype.hasOwnProperty.call(ALIASES, k)) return ALIASES[k];
  return DEFAULT_TAB;
}

module.exports = { TABS, ALIASES, DEFAULT_TAB, normTab };
