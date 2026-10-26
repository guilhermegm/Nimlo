#!/usr/bin/env python3
"""Validate, smoke-test and package GitHub release downloads using the stdlib."""

import argparse
import hashlib
import json
import os
from pathlib import Path
import plistlib
import queue
import re
import shutil
import subprocess
import tarfile
import tempfile
import threading
import tomllib
import urllib.error
import urllib.request
import zipfile

ROOT = Path(__file__).resolve().parent.parent
PLATFORMS = {f"{system}-{arch}" for system in ("macos", "linux", "windows") for arch in ("arm64", "x64")}


def version(tag):
    package = tomllib.loads((ROOT / "Cargo.toml").read_text())["package"]
    value = package["version"]
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+", tag) or tag != f"v{value}":
        raise ValueError("The release tag must match the Cargo package version")
    with (ROOT / "desktop/macos/Info.plist").open("rb") as stream:
        native = plistlib.load(stream)
    if native["CFBundleShortVersionString"] != value:
        raise ValueError("Mac app and host versions must match")
    if not (ROOT / f"releases/{value}.md").is_file():
        raise ValueError("Release notes are missing")
    return value


def smoke(binary):
    """Exercise a real host without logging its private launch credential."""
    binary = Path(binary).resolve()
    subprocess.run([str(binary), "--help"], check=True, stdout=subprocess.DEVNULL)
    with tempfile.TemporaryDirectory(prefix="nimlo-release-smoke-") as temporary:
        root = Path(temporary)
        project = root / "project"
        project.mkdir()
        (project / "fixture.txt").write_text("Nimlo release fixture\n")
        home = root / "home"
        home.mkdir()
        environment = dict(os.environ, HOME=str(home), USERPROFILE=str(home))
        with (root / "host-stderr.txt").open("w+b") as errors:
            process = subprocess.Popen(
                [str(binary), "--workspace", str(project), "--state-dir", str(root / "state"),
                 "--listen", "127.0.0.1:0", "--desktop"],
                stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=errors,
                text=True, encoding="utf-8", env=environment,
            )
            events = queue.Queue()

            def read_ready():
                events.put(process.stdout.readline())

            reader = threading.Thread(target=read_ready, daemon=True)
            reader.start()
            try:
                try:
                    ready = json.loads(events.get(timeout=30))
                except (queue.Empty, json.JSONDecodeError) as error:
                    raise RuntimeError("Host did not emit its ready event") from error
                match = re.fullmatch(r"(http://127\.0\.0\.1:[0-9]+)/#token=([a-f0-9]{64})", ready.get("url", ""))
                if not match:
                    raise RuntimeError("Host ready event is invalid")
                origin, token = match.groups()

                def request(path, authenticated=False):
                    headers = {"Origin": origin}
                    if authenticated:
                        headers["Authorization"] = f"Bearer {token}"
                    return urllib.request.urlopen(urllib.request.Request(origin + path, headers=headers), timeout=10)

                try:
                    request("/api/bootstrap")
                    raise AssertionError("Unauthenticated bootstrap was accepted")
                except urllib.error.HTTPError as error:
                    assert error.code == 401, "Unexpected authentication response"
                with request("/api/bootstrap", True) as response:
                    snapshot = response.read()
                    assert response.headers.get("Cache-Control") == "no-store"
                    assert "HttpOnly" in response.headers.get("Set-Cookie", "")
                    assert b"fixture.txt" in snapshot, "Workspace listing missing"
                    json.loads(snapshot)
                for path, expected in (("/", b"Nimlo"), ("/app.js", b"WebSocket"), ("/editor.js", b"function"), ("/style.css", b"{")):
                    with request(path) as response:
                        assert response.status == 200 and expected in response.read(), "Embedded client is missing"
                process.stdin.close()
                assert process.wait(timeout=15) == 0, "Host shutdown failed"
                reader.join(timeout=2)
                print("Host startup, authentication, workspace, embedded assets and shutdown passed")
            finally:
                if process.poll() is None:
                    process.kill()
                    process.wait(timeout=10)
                process.stdout.close()
                if process.stdin and not process.stdin.closed:
                    process.stdin.close()


def package(tag, platform):
    release = version(tag)
    output = ROOT / "target/github-release"
    output.mkdir(parents=True, exist_ok=True)
    name = f"Nimlo-{release}-{platform}"
    if platform.startswith("macos-"):
        app = ROOT / "target/desktop/Nimlo.app"
        subprocess.run(["codesign", "--verify", "--deep", "--strict", str(app)], check=True)
        with (app / "Contents/Info.plist").open("rb") as stream:
            assert plistlib.load(stream)["CFBundleShortVersionString"] == release
        archive = output / f"{name}.zip"
        subprocess.run(["ditto", "-c", "-k", "--sequesterRsrc", "--keepParent", str(app), str(archive)], check=True)
        with tempfile.TemporaryDirectory(prefix="nimlo-extracted-") as extracted:
            subprocess.run(["ditto", "-x", "-k", str(archive), extracted], check=True)
            unpacked = Path(extracted) / "Nimlo.app"
            subprocess.run(["codesign", "--verify", "--deep", "--strict", str(unpacked)], check=True)
            smoke(unpacked / "Contents/Resources/nimlo-editor")
    else:
        with tempfile.TemporaryDirectory(prefix="nimlo-package-") as temporary:
            stage = Path(temporary) / name
            stage.mkdir()
            windows = platform.startswith("windows-")
            executable = "nimlo-editor.exe" if windows else "nimlo-editor"
            shutil.copy2(ROOT / "target/release" / executable, stage / executable)
            shutil.copy2(ROOT / "SECURITY.md", stage / "SECURITY.md")
            command = ".\\nimlo-editor.exe" if windows else "./nimlo-editor"
            (stage / "README.txt").write_text(
                f"Nimlo {release} — {platform}\n\n"
                "Extract this folder before running Nimlo.\n"
                f'From a terminal: {command} --workspace "/absolute/path/to/project" --open-browser\n'
                "The editor uses your existing web browser. Keep its private launch link private.\n"
                "Keep the terminal running. Ctrl+C stops the host.\n"
                "To connect a phone, use Session > Pair a device in the editor.\n"
                "AI provider CLIs and cloudflared are optional, separate installations.\n"
                "See SECURITY.md for the host trust boundary and platform limitations.\n",
                encoding="utf-8",
            )
            if windows:
                (stage / "Start Nimlo.cmd").write_text(
                    '@echo off\r\nset "HOME=%USERPROFILE%"\r\n"%~dp0nimlo-editor.exe" --resume-project --open-browser %*\r\n',
                    encoding="utf-8", newline="",
                )
                archive = output / f"{name}.zip"
                with zipfile.ZipFile(archive, "w", zipfile.ZIP_DEFLATED) as bundle:
                    for file in sorted(stage.iterdir()):
                        bundle.write(file, f"{name}/{file.name}")
            else:
                launcher = stage / "Start Nimlo.sh"
                launcher.write_text('#!/bin/sh\nset -eu\nnimlo_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)\nexec "$nimlo_dir/nimlo-editor" --resume-project --open-browser "$@"\n')
                launcher.chmod(0o755)
                archive = output / f"{name}.tar.gz"
                with tarfile.open(archive, "w:gz") as bundle:
                    bundle.add(stage, arcname=name)
            with tempfile.TemporaryDirectory(prefix="nimlo-extracted-") as extracted:
                if windows:
                    with zipfile.ZipFile(archive) as bundle:
                        bundle.extractall(extracted)
                else:
                    with tarfile.open(archive) as bundle:
                        bundle.extractall(extracted, filter="data")
                smoke(Path(extracted) / name / executable)
    print(f"Packaged {archive.name}")


def checksums(tag):
    release = version(tag)
    output = ROOT / "target/github-release"
    archives = sorted(path for path in output.iterdir() if path.suffix in (".gz", ".zip"))
    expected = {f"Nimlo-{release}-{platform}" + (".tar.gz" if platform.startswith("linux-") else ".zip") for platform in PLATFORMS}
    if {path.name for path in archives} != expected:
        raise ValueError("All six expected platform archives are required before publication")
    (output / "SHA256SUMS.txt").write_text("".join(f"{hashlib.sha256(path.read_bytes()).hexdigest()}  {path.name}\n" for path in archives))
    print("Verified the complete platform inventory and generated SHA256SUMS.txt")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=("validate", "smoke", "package", "checksums"))
    parser.add_argument("--tag", default="v0.2.2")
    parser.add_argument("--platform", choices=sorted(PLATFORMS))
    parser.add_argument("--binary")
    args = parser.parse_args()
    if args.action == "validate":
        print(version(args.tag))
    elif args.action == "smoke":
        if not args.binary:
            parser.error("smoke requires --binary")
        smoke(args.binary)
    elif args.action == "package":
        if not args.platform:
            parser.error("package requires --platform")
        package(args.tag, args.platform)
    else:
        checksums(args.tag)
