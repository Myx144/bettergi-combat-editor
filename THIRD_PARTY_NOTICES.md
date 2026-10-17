# Third-Party Notices

The MIT license at the repository root covers the original editor and desktop wrapper. It does not relicense third-party materials.

## genshin-db

- Project: https://github.com/theBowja/genshin-db
- Source revision: `49a6544a6c6ae36089cb42fa591fc46f01de8bcf`
- License: MIT; full notice in `licenses/genshin-db-MIT.txt`.
- Character and talent metadata in `catalog.js` is generated from this source. The builder and selected source filenames are included.
- No BetterGI source file, character-alias database, or fallback cooldown table is bundled.

## Lucide

- Project: https://github.com/lucide-icons/lucide
- Included version: 0.468.0
- License: ISC, including the upstream Feather attribution; full notice in `vendor/lucide.LICENSE`.
- The original vendored library is `vendor/lucide.min.js`.

## External game images

Character and talent images are referenced by public URLs at `https://enka.network/ui/`. The image files are not bundled in the repository or desktop release. Game artwork, names and trademarks retain their respective owners' rights, including HoYoverse / miHoYo. This project's MIT license grants no rights to that artwork. Images are optional; offline editing uses text fallbacks.

## Frame measurements

No KQM/TCL measurement dataset is redistributed in this repository or desktop release. `cast-timings.js` starts empty. User calibration is stored in user projects. The small tables under `tests/` are explicitly synthetic test inputs.

## Electron and packaging

- Electron: https://github.com/electron/electron (MIT).
- electron-builder: https://github.com/electron-userland/electron-builder (MIT).
- Versions and transitive dependencies are pinned by `package-lock.json`.
- Packaged Electron distributions include `LICENSE.electron.txt` and `LICENSES.chromium.html` for the runtime and its bundled components. Keep those notices with unpacked distributions.
