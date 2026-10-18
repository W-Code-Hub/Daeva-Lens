# Daeva Lens 2.2.1 · User Guide

English · Türkçe: [docs/tr/GUIDE.md](docs/tr/GUIDE.md)

## 1. Before you start
You need Windows 10/11 (64-bit) and **Npcap**. Install Npcap from npcap.com with the default options (once). Extract Daeva Lens from the zip and open `Daeva Lens.exe`.

## 2. Main panel
The top left has the damage / healing / taken tabs. Click a player in the list to open the skill breakdown. The boss health and break bar appear at the top. The gear icon next to the panel opens the **drawer** (4 tabs).

## 3. The four tabs
- **Boss and Players:** boss and dungeon history (day/run cards, "main boss" badge), boss report, death recap, player ratings and blacklist. Right-click a player and choose *Blacklist*.
- **Skills:** skills to track, cooldown sounds.
- **Timers:** world boss / event times.
- **Settings:** Appearance, Panel and meter, Boss and fights, Sounds, Players, Privacy and streaming, Window and data, About.

## 4. Boss and dungeon history
Every boss fight is saved. In a dungeon the last boss counts as the **main boss**; when it is defeated the run card closes and later fights go into a new run. Open the boss report (duration, MVP, break, player contributions) from the card.

## 5. Skill rotation
The boss report shows a skill strip per player. Zoom with the mouse wheel or **+ / - / Fit**, and pan by dragging. You can pick a single player from the list at the top.

## 6. Boss timers
The schedule is based on the same community data as shugo.gg (there is no official API). Pick your **region** (Korea, Taiwan, Global Asia / North America East-West / Europe / South America); times are converted to your local time. For each event you can turn on a beep or a **spoken alert** (Turkish or English); a Windows voice for that language must be installed for speech.

## 7. Sounds hub
Settings > Sounds: master volume, sound only in combat, break / low health / potion sounds, spoken item names, timer beep and spoken alert. Each sound has a test button next to it.

## 8. Player ratings and blacklist
Give players a rating and a note. If the blacklist alert is on, a red alert appears when someone on the list shows up in your party (once per session). The same name on another server is a different player. Data is stored only on your computer.

## 9. Position lock, click-through, shortcuts
Ctrl+Shift+K locks the panel position, Ctrl+Shift+L turns click-through on or off. The full shortcut table is in the [README](README.md#usage-and-shortcuts); shortcuts can be changed in Settings > Window and data.

## 10. Party and privacy settings
If "Show non-damaging party members" is off, members who are not hitting stay hidden from the list until they hit. **Streamer mode** replaces names with aliases and hides rating badges. The panel can be hidden from streams and screenshots.

## 11. Privacy and risk
Short version: no network calls, passive Npcap listening only, no guarantee against sanctions. Details: [README, Security and honesty](README.md#security-and-honesty).

## 12. Troubleshooting
See the [README FAQ](README.md#faq). To reset everything, delete the `%APPDATA%\Daeva Lens\` folder. Bug reports: github.com/W-Code-Hub/daeva-lens/issues
