# Daeva Lens - Build It Yourself (step by step)

English · Türkçe: [docs/tr/BUILD.md](docs/tr/BUILD.md)

This guide is for people who do not program. If you just want to use the ready-made release, you do not need to build anything: extract the zip from the [Releases](https://github.com/W-Code-Hub/daeva-lens/releases/latest) page and run `Daeva Lens.exe`. This guide is for producing your own build from the source code.

## What you need
- Windows 10/11 (64-bit)
- Internet (the first setup downloads the required packages, about 300 MB)
- Free disk space: about 2 GB

## 1. Install Node.js (once)
1. Go to https://nodejs.org, download the **LTS** version and install it (just keep clicking "Next").
2. After installing, open a **PowerShell** window (type "PowerShell" in the Start menu).
3. Type `node -v` and press Enter. If you see a version number, you are good.

## 2. Go into the folder
In PowerShell, go into the `daeva-lens` folder you downloaded (the one that contains `package.json`). For example, if it is in your Downloads folder:
```
cd "$HOME\Downloads\daeva-lens"
```
(Change the path to wherever the folder really is. You can also open the folder in Explorer and type `powershell` in the address bar.)

## 3. Download the required packages
```
npm install
```
It takes a few minutes. Yellow warnings are normal; if you see a red "ERR", check your internet connection and try again.

## 4. Run the tests (optional but recommended)
```
npm test
```
If there are failures, do not continue with the build.

## 5. Open the program to try it (optional)
```
npm start
```
Note: **Npcap** must be installed to receive game data (https://npcap.com/#download).

## 6. Build
```
npm run dist
```
This command packages the program with `electron-builder` (an `app.asar` is created inside) and then `tools\postbuild.js` writes the icon and version info into the exe. When it finishes, the ready folder is:
```
dist\win-unpacked\
```
`Daeva Lens.exe` inside it can be run. Copy the whole folder somewhere (the exe alone is not enough).

## 7. Verify (optional)
```
certutil -hashfile "dist\win-unpacked\Daeva Lens.exe" SHA256
```
Your build may **not** produce exactly the same hash as the official release; this is normal (build time and package versions cause differences).

## Troubleshooting
- `npm` is not recognized: close PowerShell and open it again; if that does not help, reinstall Node.
- Download error: your antivirus or a corporate network may be blocking it; try another network.
- "File is locked" during the build: close any running Daeva Lens, delete the `dist` folder and try again.
- The exe is unsigned; if Windows SmartScreen warns, click **More info > Run anyway**.

## About the test recordings
Full tests need local game recordings; for privacy reasons the recordings are not published, so those tests are skipped. Tests that need recordings show up in the output as "SKIPPED (local recording needed)" (the program prints this in Turkish as "ATLANDI (yerel kayıt gerekli)"). No recordings are published; the `test/kayitlar/` folder is empty.

## Building the helper (a2co-capture.exe) from source
`bin\a2co-capture.exe` is the small helper that passively listens to the game's network traffic (written in Go, GPL-3.0). Its source is in the `capture` folder (`main.go`, `raw.go`, `go.mod`).

1. Install Go from the official site: https://go.dev/dl/ (Windows, 1.21 or newer; keep clicking "Next").
2. Open a new PowerShell in the `daeva-lens` folder you downloaded (see step 2 above) and go into the `capture` folder:
```
cd capture
$env:GOOS="windows"; $env:GOARCH="amd64"; $env:CGO_ENABLED="0"
go build -trimpath -o a2co-capture.exe .
```
3. If you like, you can copy your own build into the `bin` folder and run the program with it.
