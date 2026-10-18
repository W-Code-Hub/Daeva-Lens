English | Turkce: README-test.tr.txt

DAEVA LENS - TESTS (not part of the package)

How to run (Node is enough, Electron is not needed):
  cd (project folder)
  node tools/test.js

At the end it prints "N passed, M failed, K skipped". If there is a failure, the exit code is 1.

Contents:
  tools/test.js       Main test: engine/meter/parser unit tests, recording replay
                      (test/beklenen.json), fuzz replay. Code path: project root
  tools/test-yeni.js  New-module tests: timers, ratings, recap, pb, autoshow,
                      ui/mask, itemKind, sharecard (pure parts), classifyBossCast
  tools/replay.js, satirlar.js  Helper tools (recording reading/inspection)
  test/beklenen.json  The correct answers for each recording
  test/kayitlar/      No recordings are published for privacy reasons (folder is empty), so the tests that need them are SKIPPED. You can put your own recordings here

Notes:
  - The fuzz test looks for recordings in these folders: test/kayitlar, %APPDATA%\Daeva Lens\kayitlar,
    %APPDATA%\Aion2 Cube Overlay\kayitlar. The number of recordings in these folders changes the result (recordings/frames).
  - To give another folder: node tools/test.js <folder>
  - Tests write temporary files to the system temp folder and delete them; they do not write to AppData.
  - Removed: the old keyboard system (KeyOverlay, a2-keys.exe, keymap), devlog and
    experimental (Labs) tests; their code no longer exists. ui/keyskills.js is still used by the app.
