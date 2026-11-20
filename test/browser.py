#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-only
"""End-to-end test of the installer in Chromium, with synthetic fixtures only.

  python test/browser.py [--headed] [--keep]

Needs Playwright for Python (pip install playwright; python -m playwright
install chromium) and Info-ZIP unzip on PATH. No real game data is used.
"""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import random
import shutil
import struct
import subprocess
import sys
import tempfile
import threading
import zipfile
from pathlib import Path

from playwright.sync_api import sync_playwright, expect

REPO = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(REPO))
from serve import make_server  # noqa: E402

VERSION = "9.9.9"
ROOT = "switch/manhunt1_nx/"
SECTOR = 2048
REDUMP_OFFSET = 0x18300000
rng = random.Random(1234)


def rand(n: int) -> bytes:
    return rng.randbytes(n)


# Manifest spelling -> contents. sfx.RAW spans several 512 KiB slices.
GAME = {
    "DEFAULT.xbe": rand(70001),
    "audio/xbox/SFX/sfx.RAW": rand(1_300_000),
    "levels/Scrap2/Scene1.bsp": rand(5000),
    "levels/Scrap2/empty.dat": b"",
    "levels/asylum/pak/ASYLUM.TXD": rand(600_000),
}
# How the user's copy spells them (different case).
SOURCE_SPELLING = {
    "DEFAULT.xbe": "default.XBE",
    "audio/xbox/SFX/sfx.RAW": "AUDIO/xbox/sfx/SFX.raw",
    "levels/Scrap2/Scene1.bsp": "levels/scrap2/scene1.BSP",
    "levels/Scrap2/empty.dat": "levels/scrap2/EMPTY.DAT",
    "levels/asylum/pak/ASYLUM.TXD": "Levels/Asylum/PAK/asylum.txd",
}
EXTRA = {"extra/notes.txt": b"not in the manifest"}


def sha(b: bytes) -> str:
    return hashlib.sha256(b).hexdigest()


# ---------- fixtures ----------

def release_zip(path: Path, bad_nro: bool = False) -> None:
    nro = rand(300_000)
    asset_lines = ["# sha256  size  path   (synthetic test fixture)"]
    asset_lines += [f"{sha(d)}  {len(d)}  {p}" for p, d in GAME.items()]
    manifest = {
        "name": "manhunt1_nx",
        "version": VERSION,
        "nro": {"path": "manhunt.nro", "sha256": sha(b"other" if bad_nro else nro), "bytes": len(nro)},
        "game": {
            "install_dir": "game",
            "default_xbe_sha256": sha(GAME["DEFAULT.xbe"]),
            "asset_manifest": "asset-manifest.sha256",
        },
        "env_default": "manhunt.env",
    }
    files = {
        "manhunt.nro": nro,
        "manhunt.env": b"MANHUNT_WIDESCREEN=1\nMANHUNT_LANGUAGE=english\n",
        "manifest.json": json.dumps(manifest, indent=2).encode() + b"\n",
        "asset-manifest.sha256": ("\n".join(asset_lines) + "\n").encode(),
        "INSTALL.txt": b"synthetic test fixture\n",
        "LICENSES/LGPL-2.1.txt": b"LGPL text placeholder\n",
        "LICENSES/MIT-xboxrecomp.txt": b"MIT text placeholder\n",
        "LICENSES/SOURCE-OFFER.txt": b"source offer placeholder\n",
        "LICENSES/EXTRA-notice.txt": b"an extra licence file\n",
    }
    with zipfile.ZipFile(path, "w", zipfile.ZIP_DEFLATED) as zf:
        for name, data in files.items():
            info = zipfile.ZipInfo(ROOT + name, date_time=(2026, 1, 1, 0, 0, 0))
            info.compress_type = zipfile.ZIP_STORED if name == "INSTALL.txt" else zipfile.ZIP_DEFLATED
            zf.writestr(info, data)


def make_site(dest: Path, bad_nro: bool = False) -> None:
    dest.mkdir(parents=True)
    for name in ["index.html", "sw.js", "LICENSE", "NOTICES.md"]:
        if (REPO / name).exists():
            shutil.copy(REPO / name, dest / name)
    for d in ["css", "js"]:
        shutil.copytree(REPO / d, dest / d)
    src = dest.parent / f"in-{dest.name}" / f"manhunt1-nx-v{VERSION}.zip"
    src.parent.mkdir()
    release_zip(src, bad_nro)
    if bad_nro:
        # The validator must refuse it; stage it by hand for the page test.
        r = subprocess.run([sys.executable, str(REPO / "tools/update-release.py"), str(src), "--dest", str(dest / "release")],
                           capture_output=True, text=True)
        assert r.returncode != 0 and "NRO SHA-256" in r.stderr, r.stderr
        (dest / "release").mkdir()
        shutil.copy(src, dest / "release" / src.name)
        with zipfile.ZipFile(src) as zf:
            (dest / "release/manifest.json").write_bytes(zf.read(ROOT + "manifest.json"))
    else:
        subprocess.run([sys.executable, str(REPO / "tools/update-release.py"), str(src), "--dest", str(dest / "release")],
                       check=True, capture_output=True)


def game_folder(dest: Path, files: dict[str, bytes]) -> Path:
    for rel, data in files.items():
        p = dest / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_bytes(data)
    return dest


def source_files(**changes) -> dict[str, bytes]:
    """The user's files in their own spelling, with optional changes:
    drop=[manifest paths], replace={manifest path: bytes}."""
    out = {}
    for p, d in GAME.items():
        if p in changes.get("drop", []):
            continue
        out[SOURCE_SPELLING[p]] = changes.get("replace", {}).get(p, d)
    out.update(EXTRA)
    return out


def xdvdfs_image(path: Path, files: dict[str, bytes], base: int) -> None:
    """Writes an XDVDFS image. Directory entries are chained through their
    right pointers (a valid, if unbalanced, tree)."""
    tree: dict = {}
    for rel, data in files.items():
        node = tree
        parts = rel.split("/")
        for part in parts[:-1]:
            node = node.setdefault(part, {})
        node[parts[-1]] = data
    blobs: list[tuple[int, bytes]] = []
    next_sector = [33]

    def alloc(n: int) -> int:
        s = next_sector[0]
        next_sector[0] += max(1, -(-n // SECTOR))
        return s

    def write_dir(node: dict) -> tuple[int, int]:
        kids = []
        for name in sorted(node, key=str.upper):
            v = node[name]
            if isinstance(v, bytes):
                s = alloc(len(v)) if v else 0
                if v:
                    blobs.append((s, v))
                kids.append((name, s, len(v), 0x20))
            else:
                s, n = write_dir(v)
                kids.append((name, s, n, 0x10))
        offsets = []
        p = 0
        for name, *_ in kids:
            ln = (14 + len(name) + 3) & ~3
            if p % SECTOR + ln > SECTOR:
                p += SECTOR - p % SECTOR
            offsets.append(p)
            p += ln
        table = bytearray(b"\xff" * (-(-p // SECTOR) * SECTOR))
        for i, (name, s, n, attrs) in enumerate(kids):
            right = offsets[i + 1] // 4 if i + 1 < len(kids) else 0
            struct.pack_into("<HHIIBB", table, offsets[i], 0, right, s, n, attrs, len(name))
            table[offsets[i] + 14:offsets[i] + 14 + len(name)] = name.encode()
        s = alloc(len(table))
        blobs.append((s, bytes(table)))
        return s, p

    root_sector, root_size = write_dir(tree)
    vd = bytearray(SECTOR)
    vd[0:20] = b"MICROSOFT*XBOX*MEDIA"
    vd[0x7EC:0x7EC + 20] = b"MICROSOFT*XBOX*MEDIA"
    struct.pack_into("<II", vd, 0x14, root_sector, root_size)
    blobs.append((32, bytes(vd)))
    with path.open("wb") as f:
        for s, data in sorted(blobs):
            f.seek(base + s * SECTOR)
            f.write(data)
        f.truncate(base + next_sector[0] * SECTOR)


# ---------- checks on the output ----------

def raw_entries(path: Path) -> dict[str, tuple[int, int, bytes]]:
    """name -> (method, crc, compressed bytes) read straight from the file."""
    out = {}
    with zipfile.ZipFile(path) as zf, path.open("rb") as f:
        for info in zf.infolist():
            f.seek(info.header_offset)
            h = f.read(30)
            n, e = struct.unpack("<HH", h[26:30])
            f.seek(info.header_offset + 30 + n + e)
            out[info.filename] = (info.compress_type, info.CRC, f.read(info.compress_size))
    return out


def check_output(out: Path, release: Path) -> None:
    r = subprocess.run(["unzip", "-t", str(out)], capture_output=True, text=True)
    print(r.stdout.strip().splitlines()[-1])
    assert r.returncode == 0 and "No errors detected" in r.stdout, r.stdout + r.stderr
    want = {ROOT + "game/" + p for p in GAME}
    with zipfile.ZipFile(release) as rz:
        port_names = {i.filename for i in rz.infolist()}
    got = raw_entries(out)
    assert set(got) == want | port_names, sorted(set(got) ^ (want | port_names))
    assert any(n.startswith(ROOT + "LICENSES/") for n in got)
    for n, (method, crc, data) in raw_entries(release).items():
        assert got[n] == (method, crc, data), f"{n} not copied through unchanged"
    with zipfile.ZipFile(out) as zf:
        for p, data in GAME.items():
            info = zf.getinfo(ROOT + "game/" + p)
            assert info.compress_type == zipfile.ZIP_STORED, p
            assert zf.read(info) == data, p


# ---------- browser steps ----------

def open_page(ctx, url: str):
    page = ctx.new_page()
    page.on("pageerror", lambda e: print("  page error:", e))
    page.goto(url)
    return page


def wait_release(page) -> None:
    expect(page.locator("#release-status")).to_have_text(f"Port release v{VERSION}", timeout=30_000)


def choose(page, kind: str, path: Path) -> None:
    page.set_input_files("#iso-input" if kind == "iso" else "#folder-input", str(path))


def build_and_save(page, dest: Path) -> Path:
    page.click("#build")
    expect(page.locator("#save")).to_be_visible(timeout=120_000)
    expect(page.locator("#build-status")).to_contain_text("ready and verified")
    with page.expect_download(timeout=60_000) as d:
        page.click("#save")
    dl = d.value
    assert dl.suggested_filename == f"manhunt1-nx-v{VERSION}-sd.zip", dl.suggested_filename
    dl.save_as(dest)
    return dest


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--headed", action="store_true")
    ap.add_argument("--keep", action="store_true", help="keep the temporary directory")
    args = ap.parse_args()
    if not shutil.which("unzip"):
        sys.exit("Info-ZIP unzip not found on PATH")

    tmp = Path(tempfile.mkdtemp(prefix="manhunt1-nx-installer-test-"))
    print("fixtures in", tmp)
    servers = []
    try:
        make_site(tmp / "site")
        make_site(tmp / "site-bad-nro", bad_nro=True)
        release = tmp / "site/release" / f"manhunt1-nx-v{VERSION}.zip"

        def serve(d: Path) -> str:
            httpd = make_server(d, 0, quiet=True)
            threading.Thread(target=httpd.serve_forever, daemon=True).start()
            servers.append(httpd)
            return f"http://localhost:{httpd.server_address[1]}/"

        url = serve(tmp / "site")
        bad_url = serve(tmp / "site-bad-nro")

        good = game_folder(tmp / "good/Manhunt", source_files())
        xiso = tmp / "game.xiso.iso"
        xdvdfs_image(xiso, source_files(), 0)
        redump = tmp / "game.redump.iso"
        xdvdfs_image(redump, source_files(), REDUMP_OFFSET)
        missing = game_folder(tmp / "missing/Manhunt", source_files(drop=["levels/Scrap2/Scene1.bsp"]))
        wrong_size = game_folder(tmp / "size/Manhunt", source_files(replace={"levels/Scrap2/Scene1.bsp": rand(4999)}))
        bad_xbe = rand(len(GAME["DEFAULT.xbe"]))
        wrong_xbe = game_folder(tmp / "xbe/Manhunt", source_files(replace={"DEFAULT.xbe": bad_xbe}))
        changed = bytearray(GAME["audio/xbox/SFX/sfx.RAW"])
        changed[900_000] ^= 0xFF
        changed_asset = game_folder(tmp / "changed/Manhunt", source_files(replace={"audio/xbox/SFX/sfx.RAW": bytes(changed)}))

        results = []

        def case(name, fn):
            print(f"- {name}")
            fn()
            results.append(name)

        with sync_playwright() as pw:
            browser = pw.chromium.launch(headless=not args.headed)
            ctx = browser.new_context(accept_downloads=True)

            def ok_case(kind, src, out_name, label):
                def run():
                    page = open_page(ctx, url)
                    wait_release(page)
                    choose(page, kind, src)
                    expect(page.locator("#preflight")).to_contain_text("Manhunt (Xbox), supported", timeout=60_000)
                    expect(page.locator("#preflight")).to_contain_text(label)
                    check_output(build_and_save(page, tmp / out_name), release)
                    page.close()
                return run

            case("folder path", ok_case("folder", good, "out-folder.zip", "from folder"))
            case("ISO path (xiso)", ok_case("iso", xiso, "out-xiso.zip", "from xiso image"))
            case("ISO path (full XGD1 / Redump layout)", ok_case("iso", redump, "out-redump.zip", "XGD1 (Redump) image"))

            def preflight_fails(src, *texts):
                page = open_page(ctx, url)
                wait_release(page)
                choose(page, "folder", src)
                pf = page.locator("#preflight")
                for t in texts:
                    expect(pf).to_contain_text(t, timeout=30_000)
                expect(pf).not_to_contain_text("Manhunt (Xbox), supported")
                expect(page.locator("#build")).to_be_disabled()
                page.close()

            case("missing files", lambda: preflight_fails(missing, "1 missing file", "levels/Scrap2/Scene1.bsp"))
            case("wrong sizes", lambda: preflight_fails(wrong_size, "wrong size", "levels/Scrap2/Scene1.bsp: 4999 bytes, expected 5000"))
            case("wrong XBE", lambda: preflight_fails(wrong_xbe, "Unsupported DEFAULT.xbe", sha(bad_xbe)))

            def changed_case():
                page = open_page(ctx, url)
                wait_release(page)
                choose(page, "folder", changed_asset)
                expect(page.locator("#preflight")).to_contain_text("Manhunt (Xbox), supported", timeout=30_000)
                page.click("#build")
                st = page.locator("#build-status")
                expect(st).to_contain_text("Packaging failed", timeout=60_000)
                expect(st).to_contain_text("audio/xbox/SFX/sfx.RAW: SHA-256 mismatch")
                expect(page.locator("#save")).to_be_hidden()
                # The failed build's staging directory is removed.
                page.wait_for_function("""async () => {
                  const root = await navigator.storage.getDirectory();
                  for await (const [n] of root.entries()) if (n.startsWith('staging-')) return false;
                  return true; }""", timeout=10_000)
                page.close()
            case("changed asset", changed_case)

            def bad_nro_case():
                page = open_page(ctx, bad_url)
                st = page.locator("#release-status")
                expect(st).to_contain_text("Could not load the port release", timeout=30_000)
                expect(st).to_contain_text("NRO SHA-256 mismatch")
                expect(page.locator("#iso-input")).to_be_disabled()
                expect(page.locator("#folder-input")).to_be_disabled()
                page.close()
            case("bad NRO", bad_nro_case)

            def reclaim_case():
                orphan = "staging-" + "ab" * 16
                page = open_page(ctx, url)
                wait_release(page)
                page.evaluate("""async (name) => {
                  const root = await navigator.storage.getDirectory();
                  const d = await root.getDirectoryHandle(name, { create: true });
                  const f = await (await d.getFileHandle('x.part', { create: true })).createWritable();
                  await f.write('left over'); await f.close(); }""", orphan)
                page.close()
                page = open_page(ctx, url)
                page.wait_for_function("""async (name) => {
                  const root = await navigator.storage.getDirectory();
                  for await (const [n] of root.entries()) if (n === name) return false;
                  return true; }""", arg=orphan, timeout=10_000)
                page.close()
            case("reclaim staging from an earlier session", reclaim_case)

            ctx.close()
            browser.close()
        print(f"OK: {len(results)} browser cases passed")
        return 0
    finally:
        for s in servers:
            s.shutdown()
        if args.keep:
            print("kept", tmp)
        else:
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
