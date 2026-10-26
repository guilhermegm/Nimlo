#!/usr/bin/env python3
"""Fetch the pinned upstream release, verify its digest, and unpack locally."""
import hashlib,json,pathlib,subprocess,tarfile
root=pathlib.Path(__file__).resolve().parent.parent
release=json.loads((root/'neovim-release.json').read_text())
cache=root/'target/vendor';cache.mkdir(parents=True,exist_ok=True)
archive=cache/'nvim-macos-arm64.tar.gz'
if not archive.exists() or hashlib.sha256(archive.read_bytes()).hexdigest()!=release['sha256']:
    subprocess.run(['curl','--fail','--location','--silent','--show-error','--output',str(archive),release['url']],check=True)
if hashlib.sha256(archive.read_bytes()).hexdigest()!=release['sha256']:
    raise SystemExit('Neovim archive checksum mismatch')
if not (cache/'nvim-macos-arm64/bin/nvim').is_file():
    with tarfile.open(archive) as source:source.extractall(cache,filter='data')
