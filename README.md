# manhunt1_nx SD installer

A static web page that builds a complete SD-card package for
[manhunt1_nx](https://github.com/marmota94/manhunt1_nx), the Nintendo Switch
homebrew port of the original Xbox Manhunt, from your own copy of the game.

**https://marmota94.github.io/manhunt1_nx_installer/**

Everything runs in your browser tab. Nothing is uploaded.

## For players

You need a current Chromium-based browser (Chrome, Edge, Brave, Opera), about
2.5 GB of free disk space and your own original Xbox copy of Manhunt as either:

- a disc image (`.iso`): an xiso or a full Redump image, or
- a folder extracted from it that contains `DEFAULT.xbe`, `audio` and `levels`.

1. Open the page and wait for "Port release vX.Y.Z".
2. Choose your disc image or folder. The page checks that every file the port
   needs is there with the right size and that your `DEFAULT.xbe` is the
   supported one. It then shows "Manhunt (Xbox), supported".
3. Click **Build SD package**. Each file is checked against the port's SHA-256
   list as it is written. Then click **Save** to download
   `manhunt1-nx-vX.Y.Z-sd.zip`.

Install it on the Switch:

1. Delete any old `switch/manhunt1_nx/game` folder on the SD card.
2. Extract the ZIP at the root of the SD card.
3. Hold **R** while opening a game to enter the homebrew menu or Sphaira in
   title-takeover mode, then start `manhunt.nro`.
4. To quit, hold **ZL + ZR + Plus + Minus** for 1.5 seconds.

Settings are in `switch/manhunt1_nx/manhunt.env`, one `KEY=VALUE` per line:

- `MANHUNT_WIDESCREEN=1` gives 16:9, with the HUD, menus and movies kept at 4:3
  in the centre. It is on in the release; remove the line for 4:3.
- `MANHUNT_LANGUAGE` sets the console language the game reads: `english`,
  `japanese`, `german`, `french`, `spanish` or `italian`. The release sets
  `spanish`; without the line the game uses `english`.

The NRO includes an LGPL-2.1 library. Its source is listed in
switch/manhunt1_nx/LICENSES/SOURCE-OFFER.txt.

## For maintainers

### Layout

| Path | Contents |
|---|---|
| `index.html`, `css/` | The page. Strict CSP: `default-src 'self'`, no inline scripts or styles |
| `js/app.js` | Release loading, input selection and preflight |
| `js/worker.js` | Packaging Web Worker: hashes and writes the ZIP into OPFS |
| `sw.js` | Service worker that streams the staged ZIP to the browser's downloads |
| `js/xdvdfs.js` | XDVDFS reader (xiso and full XGD1 layouts) |
| `js/zip.js`, `js/sha256.js`, `js/crc32.js` | ZIP/ZIP64, streaming SHA-256, CRC-32 |
| `js/release.js`, `js/staging.js` | Manifest parsing, preflight, OPFS staging and reclaim |
| `release/` | `manifest.json` and the one port release ZIP the site serves |
| `tools/update-release.py` | Validates and stages a port release |
| `serve.py` | Local server |
| `test/` | Unit and browser tests |

### How packaging works

- On load the page fetches `release/manifest.json` and
  `release/manhunt1-nx-vX.Y.Z.zip`, checks every entry's CRC and the NRO's
  SHA-256 and size.
- After a selection, the preflight matches paths against the asset manifest
  ignoring case, and writes the manifest's spelling to the output. Files the
  manifest does not list are ignored. `DEFAULT.xbe` is hashed and its bytes are
  kept, so packaging writes the verified copy.
- The worker copies the port ZIP's entries with their original compressed
  bytes, then stores each game file under `switch/manhunt1_nx/game/`. It reads
  512 KiB slices and computes SHA-256 and CRC-32 in one pass, and fails on any
  mismatch. ZIP64 records are written only when sizes or offsets need them.
- The output is staged in OPFS, read back and checked, then served by the
  service worker at `download/<session>/<name>`.
- Each tab holds a Web Lock for its staging directory. A reopened tab, or any
  later visit, removes staging directories whose owner is gone.

### Updating the port release

Use Python 3.11 or later.

```sh
gh release download vX.Y.Z -R marmota94/manhunt1_nx -p 'manhunt1-nx-vX.Y.Z.zip' -D /tmp/rel
python tools/update-release.py /tmp/rel/manhunt1-nx-vX.Y.Z.zip --expect-sha256 <published sha256>
git add release/manifest.json
git add -f release/manhunt1-nx-vX.Y.Z.zip
git rm --cached release/manhunt1-nx-v<old>.zip
```

The validator checks that all entries are under `switch/manhunt1_nx/`, that the
required files are present (`manhunt.nro`, `manhunt.env`, `manifest.json`,
`asset-manifest.sha256`, `INSTALL.txt`, `LICENSES/LGPL-2.1.txt`,
`LICENSES/MIT-xboxrecomp.txt`), that no names differ only in case, that there
are no symlinks, that only store or deflate is used, that the file name's
version matches the manifest, and that the NRO hash, the XBE hash in the asset
manifest and every CRC are correct. It then copies the ZIP to `release/`,
writes `release/manifest.json` and removes older staged archives.
`python tools/update-release.py --check` validates what is staged.

### Rules for commits

- Commit only `release/manifest.json` and the one reviewed port ZIP
  (`git add -f`).
- Never commit disc images, game files, generated SD packages or test output
  from real data.

### Running locally

```sh
python serve.py            # http://localhost:8000/
```

### Tests

```sh
node --test test/unit.mjs  # SHA-256 vectors, XDVDFS layouts, ZIP64 (virtual 5 GiB entry)
python test/browser.py     # Playwright + Chromium, synthetic fixtures, checked with unzip -t
```

The browser test needs `pip install playwright`,
`python -m playwright install chromium` and Info-ZIP `unzip` on `PATH`. It
covers the ISO path (xiso and full XGD1), the folder path, missing files, wrong
sizes, a wrong XBE, a changed asset, a bad NRO and reclaiming staging
directories.

### Deployment

`.github/workflows/pages.yml` re-runs the validator and the tests, then deploys
the static files plus the archive that `release/manifest.json` selects. In the
repository settings, set Pages to deploy from GitHub Actions.

## Licence

LGPL-2.1-only. See `LICENSE` and `NOTICES.md`. Not affiliated with or endorsed
by Rockstar Games, Take-Two Interactive, Microsoft or Nintendo.
