'use strict';
// Ayarlar sekmesinin kenar menüsü: bölüm listesi ve ses ayarlarının tek merkezi.
// Hem pencerede (<script>, window.SETSECTIONS) hem testlerde (require) kullanılır.
(function (root) {
const SECTIONS = [
  { id: 'appearance', label: 'Appearance', desc: 'How the panel looks.' },
  { id: 'panel', label: 'Panel and meter', desc: 'What the left meter shows and how fights are counted.' },
  { id: 'boss', label: 'Boss and fights', desc: 'What appears when you fight a boss.' },
  { id: 'sounds', label: 'Sounds', desc: 'Every sound and voice setting in one place.' },
  { id: 'players', label: 'Players', desc: 'Ratings, notes and the blacklist.' },
  { id: 'privacy', label: 'Privacy and streaming', desc: 'Hide names and the panel from viewers.' },
  { id: 'window', label: 'Window and data', desc: 'Shortcuts, startup, auto-hide and local data.' },
  { id: 'about', label: 'About', desc: 'What this tool does.', last: true }, // en altta, ayrı
];
// Her ses/okuma/bip ayarının (ayar anahtarı) kendi kutusunun id'si aynı addır; hepsi "sounds" bölümünde olmalıdır.
const SOUND_KEYS = ['volume', 'combatOnlySound', 'visualToasts', 'soundStagger', 'soundLowHp', 'soundPotion',
  'soundChoiceStagger', 'soundChoiceLowHp', 'soundChoicePotion', 'itemTts', 'timerBeep', 'timerSound', 'timerVolume', 'timerTts'];
const DEFAULT_SECTION = 'appearance';
const isSection = (id) => typeof id === 'string' && SECTIONS.some((s) => s.id === id);
// Kayıtlı son bölüm geçerliyse o, değilse (boş/bozuk/silinmiş) varsayılan
const pickSection = (id) => (isSection(id) ? id : DEFAULT_SECTION);
const api = { SECTIONS, SOUND_KEYS, DEFAULT_SECTION, isSection, pickSection };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else root.SETSECTIONS = api;
})(typeof window !== 'undefined' ? window : globalThis);
