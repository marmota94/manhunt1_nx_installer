#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-only
"""Validate a manhunt1_nx port release ZIP and stage it under release/.

  python tools/update-release.py manhunt1-nx-vX.Y.Z.zip [--expect-sha256 HEX]
      Validate the ZIP, copy it to release/, write release/manifest.json from
      the manifest inside it and remove other staged archives.

  python tools/update-release.py --check
      Validate what is staged: release/manifest.json and the archive it selects.

Requires Python 3.11 or later.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import shutil
import stat
import sys
import zipfile
from pathlib import Path

if sys.version_info < (3, 11):
    sys.exit("update-release.py needs Python 3.11 or later")

ROOT = "switch/manhunt1_nx/"
REQUIRED = [
    "manhunt.nro",
    "manhunt.env",
    "manifest.json",
    "asset-manifest.sha256",
    "INSTALL.txt",
    "LICENSES/LGPL-2.1.txt",
    "LICENSES/MIT-xboxrecomp.txt",
]
NAME_RE = re.compile(r"^manhunt1-nx-v(\d+\.\d+\.\d+)\.zip$")
VERSION_RE = re.compile(r"^\d+\.\d+\.\d+$")
HEX64 = re.compile(r"^[0-9a-f]{64}$")
SEGMENT_RE = re.compile(r"^[A-Za-z0-9_.\- ]+$")
ASSET_LINE = re.compile(r"^([0-9a-f]{64}) {2}(\d+) {2}(.+)$")
CHUNK = 1 << 20


class ReleaseError(Exception):
    pass


def safe_path(p: str) -> bool:
    return bool(p) and all(SEGMENT_RE.match(s) and s not in (".", "..") for s in p.split("/"))


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with path.open("rb") as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
    return h.hexdigest()


def read_member(zf: zipfile.ZipFile, info: zipfile.ZipInfo) -> tuple[bytes, str]:
    """Reads a member fully. zipfile checks its CRC at the end of the read."""
    h = hashlib.sha256()
    parts = []
    with zf.open(info) as f:
        while chunk := f.read(CHUNK):
            h.update(chunk)
            parts.append(chunk)
    return b"".join(parts), h.hexdigest()


def check_manifest(m: object) -> dict:
    if not isinstance(m, dict):
        raise ReleaseError("manifest.json is not an object")
    if not isinstance(m.get("version"), str) or not VERSION_RE.match(m["version"]):
        raise ReleaseError("manifest.json: bad version")
    nro = m.get("nro")
    if not isinstance(nro, dict) or not isinstance(nro.get("path"), str) or not safe_path(nro["path"]):
        raise ReleaseError("manifest.json: bad nro.path")
    if not isinstance(nro.get("sha256"), str) or not HEX64.match(nro["sha256"]):
        raise ReleaseError("manifest.json: bad nro.sha256")
    if not isinstance(nro.get("bytes"), int) or nro["bytes"] <= 0:
        raise ReleaseError("manifest.json: bad nro.bytes")
    game = m.get("game")
    if not isinstance(game, dict):
        raise ReleaseError("manifest.json: missing game")
    d = game.get("install_dir")
    if not isinstance(d, str) or not SEGMENT_RE.match(d) or d in (".", ".."):
        raise ReleaseError("manifest.json: bad game.install_dir")
    if not isinstance(game.get("asset_manifest"), str) or not safe_path(game["asset_manifest"]):
        raise ReleaseError("manifest.json: bad game.asset_manifest")
    if not isinstance(game.get("default_xbe_sha256"), str) or not HEX64.match(game["default_xbe_sha256"]):
        raise ReleaseError("manifest.json: bad game.default_xbe_sha256")
    return m


def parse_asset_manifest(text: str) -> list[tuple[str, int, str]]:
    assets = []
    seen = set()
    for n, line in enumerate(text.split("\n"), 1):
        line = line.rstrip("\r")
        if not line.strip() or line.startswith("#"):
            continue
        m = ASSET_LINE.match(line)
        if not m:
            raise ReleaseError(f"asset manifest line {n}: bad format")
        path = m.group(3)
        if not safe_path(path):
            raise ReleaseError(f"asset manifest line {n}: unsafe path {path!r}")
        if path.lower() in seen:
            raise ReleaseError(f"asset manifest: duplicate path {path}")
        seen.add(path.lower())
        assets.append((m.group(1), int(m.group(2)), path))
    if not assets:
        raise ReleaseError("asset manifest is empty")
    return assets


def validate(zip_path: Path, expect_sha256: str | None = None) -> tuple[dict, bytes]:
    """Validates the release ZIP. Returns its manifest and the manifest's bytes."""
    m = NAME_RE.match(zip_path.name)
    if not m:
        raise ReleaseError(f"{zip_path.name}: name must be manhunt1-nx-vX.Y.Z.zip")
    file_version = m.group(1)
    digest = sha256_file(zip_path)
    if expect_sha256 and digest != expect_sha256.lower():
        raise ReleaseError(f"{zip_path.name}: SHA-256 is {digest}, expected {expect_sha256}")

    try:
        zf = zipfile.ZipFile(zip_path)
    except zipfile.BadZipFile as e:
        raise ReleaseError(f"{zip_path.name}: not a ZIP ({e})") from e
    with zf:
        infos = zf.infolist()
        lower = {}
        for info in infos:
            name = info.filename
            if not name.startswith(ROOT) or name == ROOT:
                raise ReleaseError(f"entry outside {ROOT}: {name}")
            rel = name[len(ROOT):].rstrip("/")
            if "\\" in name or not safe_path(rel):
                raise ReleaseError(f"unsafe entry name: {name}")
            if name.lower() in lower:
                raise ReleaseError(f"names differ only in case: {lower[name.lower()]} and {name}")
            lower[name.lower()] = name
            mode = info.external_attr >> 16
            if info.create_system == 3 and stat.S_ISLNK(mode):
                raise ReleaseError(f"symlink not allowed: {name}")
            if info.compress_type not in (zipfile.ZIP_STORED, zipfile.ZIP_DEFLATED):
                raise ReleaseError(f"{name}: compression method {info.compress_type} (only store and deflate)")
            if info.flag_bits & 0x1:
                raise ReleaseError(f"{name}: encrypted")

        names = {i.filename for i in infos}
        missing = [r for r in REQUIRED if ROOT + r not in names]
        if missing:
            raise ReleaseError("missing required files: " + ", ".join(missing))

        # Read every member: zipfile raises BadZipFile on a CRC mismatch and
        # on a local header whose name differs from the central directory.
        contents: dict[str, bytes] = {}
        hashes: dict[str, str] = {}
        for info in infos:
            if info.is_dir():
                continue
            try:
                data, h = read_member(zf, info)
            except zipfile.BadZipFile as e:
                raise ReleaseError(f"{info.filename}: {e}") from e
            if len(data) != info.file_size:
                raise ReleaseError(f"{info.filename}: size mismatch")
            hashes[info.filename] = h
            if not info.filename.endswith(".nro"):
                contents[info.filename] = data

    manifest_bytes = contents[ROOT + "manifest.json"]
    try:
        manifest = check_manifest(json.loads(manifest_bytes))
    except json.JSONDecodeError as e:
        raise ReleaseError(f"manifest.json: {e}") from e
    if manifest["version"] != file_version:
        raise ReleaseError(f"file name says v{file_version}, manifest.json says v{manifest['version']}")

    nro_name = ROOT + manifest["nro"]["path"]
    if nro_name not in hashes:
        raise ReleaseError(f"NRO {nro_name} not in the ZIP")
    nro_info = next(i for i in infos if i.filename == nro_name)
    if nro_info.file_size != manifest["nro"]["bytes"]:
        raise ReleaseError(f"NRO is {nro_info.file_size} bytes, manifest says {manifest['nro']['bytes']}")
    if hashes[nro_name] != manifest["nro"]["sha256"]:
        raise ReleaseError(f"NRO SHA-256 is {hashes[nro_name]}, manifest says {manifest['nro']['sha256']}")

    am_name = ROOT + manifest["game"]["asset_manifest"]
    if am_name not in contents:
        raise ReleaseError(f"asset manifest {am_name} not in the ZIP")
    assets = parse_asset_manifest(contents[am_name].decode("utf-8"))
    xbe = [a for a in assets if a[2].lower() == "default.xbe"]
    if not xbe:
        raise ReleaseError("asset manifest has no DEFAULT.xbe")
    if xbe[0][0] != manifest["game"]["default_xbe_sha256"]:
        raise ReleaseError(
            f"DEFAULT.xbe SHA-256 in the asset manifest ({xbe[0][0]}) differs from manifest.json "
            f"({manifest['game']['default_xbe_sha256']})")

    print(f"OK {zip_path.name}: v{manifest['version']}, {len(infos)} entries, "
          f"{len(assets)} game files listed, SHA-256 {digest}")
    return manifest, manifest_bytes


def stage(zip_path: Path, dest: Path, expect_sha256: str | None) -> None:
    manifest, manifest_bytes = validate(zip_path, expect_sha256)
    dest.mkdir(parents=True, exist_ok=True)
    target = dest / zip_path.name
    if zip_path.resolve() != target.resolve():
        shutil.copyfile(zip_path, target)
    for old in dest.glob("manhunt1-nx-v*.zip"):
        if old.name != target.name:
            old.unlink()
            print(f"removed {old}")
    (dest / "manifest.json").write_bytes(manifest_bytes)
    print(f"staged {target} and {dest / 'manifest.json'} (v{manifest['version']})")


def check(dest: Path) -> None:
    mpath = dest / "manifest.json"
    try:
        staged = check_manifest(json.loads(mpath.read_bytes()))
    except (OSError, json.JSONDecodeError) as e:
        raise ReleaseError(f"{mpath}: {e}") from e
    zip_path = dest / f"manhunt1-nx-v{staged['version']}.zip"
    if not zip_path.is_file():
        raise ReleaseError(f"{zip_path} not found")
    inner, inner_bytes = validate(zip_path)
    if inner_bytes != mpath.read_bytes():
        raise ReleaseError(f"{mpath} differs from the manifest inside {zip_path.name}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("zip", nargs="?", type=Path, help="release ZIP to validate and stage")
    ap.add_argument("--expect-sha256", help="fail unless the ZIP has this SHA-256")
    ap.add_argument("--check", action="store_true", help="validate the staged release instead")
    ap.add_argument("--dest", type=Path, default=Path(__file__).resolve().parent.parent / "release",
                    help="staging directory (default: release/)")
    args = ap.parse_args()
    try:
        if args.check:
            if args.zip:
                ap.error("--check takes no ZIP")
            check(args.dest)
        elif args.zip:
            stage(args.zip, args.dest, args.expect_sha256)
        else:
            ap.error("give a release ZIP or --check")
    except ReleaseError as e:
        print(f"error: {e}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
