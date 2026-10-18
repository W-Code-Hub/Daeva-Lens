'use strict';
// Derleme sonrası: exe'ye simge ve sürüm bilgisi yaz (Linux'ta wine/rcedit gerekmesin diye saf JS).
const fs = require('fs');
const path = require('path');

(async () => {
  const ResEdit = await import('resedit');
  const { NtExecutable, NtExecutableResource, Data, Resource } = ResEdit;
  const pkg = require('../package.json');
  const exe = path.join(__dirname, '..', 'dist', 'win-unpacked', pkg.build.productName + '.exe');
  const ico = path.join(__dirname, '..', 'assets', 'icon.ico');
  const exeData = fs.readFileSync(exe);
  const pe = NtExecutable.from(exeData, { ignoreCert: true });
  const res = NtExecutableResource.from(pe);
  const iconFile = Data.IconFile.from(fs.readFileSync(ico));
  Resource.IconGroupEntry.replaceIconsForResource(res.entries, 1, 1033, iconFile.icons.map((i) => i.data));
  const vi = Resource.VersionInfo.fromEntries(res.entries)[0] || Resource.VersionInfo.createEmpty();
  const [a, b, c] = pkg.version.split('.').map(Number);
  vi.setFileVersion(a, b, c, 0, 1033);
  vi.setProductVersion(a, b, c, 0, 1033);
  vi.setStringValues({ lang: 1033, codepage: 1200 }, {
    FileDescription: 'Daeva Lens',
    ProductName: 'Daeva Lens',
    CompanyName: 'W-Code',
    LegalCopyright: 'Copyright (c) 2026 W-Code (W-Code-Hub). GPL-3.0-or-later',
    OriginalFilename: pkg.build.productName + '.exe',
    InternalName: 'Daeva Lens',
    FileVersion: pkg.version,
    ProductVersion: pkg.version,
  });
  vi.outputToResourceEntries(res.entries);
  res.outputResource(pe);
  fs.writeFileSync(exe, Buffer.from(pe.generate()));
  console.log('simge ve sürüm yazıldı:', exe);
})().catch((e) => { console.error(e); process.exit(1); });
