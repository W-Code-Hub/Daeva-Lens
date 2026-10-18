# Daeva Lens 2.2.1 · Release Notes

English · Türkçe: [docs/tr/CHANGELOG.md](docs/tr/CHANGELOG.md)

## 2.2.1

Fixes
- Panel moving and position lock: dragging and the lock now work reliably.
- The meter no longer stays empty after a zone change.
- Errors that were swallowed silently are now written to the log.
- A lost network packet no longer stalls reading; it is skipped after about half a second.
- Ctrl+R boss reset behaves the same way everywhere.

Changed
- Sounds, on-screen notices, event timers and the extra panels (cooldowns, target bar, Gear Score, Combat Power, idle party members, boss target) are off by default. Turn them on in Settings. Existing settings are kept as they are.
- The README explains the unsigned-exe warning and how to check the SHA256.
- Six new automated tests.

Daeva Lens does not touch the game; it only reads a passive copy of network traffic. Screen-capture protection is off by default.

---

# Daeva Lens 2.2.0 · Release Notes

Changes since 2.1.0.

## New
- **Four-tab drawer:** Boss and Players, Skills, Timers, Settings. It replaces the six tabs of 2.1.0 (Boss, Deaths, Skills, Keys, General, About); the deaths of a fight now appear under Boss and Players.
- **Boss and dungeon history is saved on disk.** 2.1.0 kept only the last 20 boss fights in memory. In dungeons the last boss is grouped as the "main boss" and closes the run card.
- **Skill rotation timeline:** zoom (wheel, +/-, Fit) and pan (drag).
- **Sounds hub:** all sound and voice settings in one place (Settings > Sounds), including the spoken item name option.
- **Boss timers (Timers tab):** schedule data from shugo.gg, region selection, beep or spoken alert in English or Turkish. No network requests, local clock.
- **Player ratings and blacklist:** rating, notes and an optional red alert when a blacklisted player is in your party; stored only on your PC.
- **Option to hide party members** who are not dealing damage.
- **Streamer mode** (names shown as local aliases) and **screen-capture protection** (off by default).
- **Position lock:** toggles with Ctrl+Shift+K.
- **Show/hide with the game:** the panel hides after a while without game traffic and returns when the game sends data again.
- **Boss-damage-only view** and a **personal best** notice (saved only on this computer).
- **Source code and the capture helper source (`capture/`, a2co-capture.exe)** are in the repository; the helper can be built from source and audited (see [BUILD.md](BUILD.md)).

## Changed / removed
- **Npcap is required.** The hidden PowerShell / administrator raw-socket fallback that 2.1.0 still contained was removed.
- **Key overlay removed** (Keys tab and the a2-keys.exe helper).
- **Boss threat (aggro) alert removed.** The threat tone is now used only for the blacklist alert.
- **Panel auto-size checkbox removed;** the panel always fits its content.
- Description and security/privacy wording rewritten (passive Npcap capture, no network calls; no guarantee against sanctions).

Install and checksum steps: see the [README](README.md#install). Known limits: timer times are community data (there is no official API); the exe is unsigned, so SmartScreen may warn.

---

# Daeva Lens 2.1.0 (previous release, 15 October 2026)

Taken from the published 2.1.0 release notes and checked against the 2.1.0 package.

## New / changed
- **Smart audio notification engine:** Boss Stagger gong, Low HP (<25%) heartbeat pulse, Boss Threat (aggro) and potion chimes; independent volume, toggle and test buttons in settings.
- **Key overlay and cooldown timers:** smooth countdown animation (`conic-gradient`) with millisecond precision on the key buttons.
- **Panel auto-fit:** Damage / Healing / Taken mode tabs moved to the top row beside DPS; fixed the endless downward growth; the panel wraps its content; no empty gap in click-through (locked) mode.
- **Reliability:** verified on 56 session recordings (9.82M frames) with 0.00% damage loss and 36/36 unit tests.
- **Drawer:** six tabs (Boss, Deaths, Skills, Keys, General, About); click-through with Ctrl+Shift+L; boss history of the last 20 fights, kept in memory only.
