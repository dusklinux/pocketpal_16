#!/usr/bin/env python3
"""Update a matching native IPA's JavaScript bundle; optionally install via SSH."""

import argparse
import copy
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys
import tempfile
import zipfile

ROOT = Path(__file__).resolve().parent.parent


def run(command, **kwargs):
    return subprocess.run(command, cwd=ROOT, check=True, **kwargs)


def repack(base: Path, output: Path, bytecode: Path) -> None:
    compiled = bytecode.read_bytes()
    with zipfile.ZipFile(base) as source:
        bundles = [
            name for name in source.namelist()
            if name.startswith("Payload/") and name.count("/") == 2
            and name.endswith(".app/main.jsbundle")
        ]
        if len(bundles) != 1:
            raise ValueError("Expected one app with a main.jsbundle in the base IPA.")
        bundle = bundles[0]
        with source.open(bundle) as stream:
            header = stream.read(12)
        # Hermes bytecode headers contain an eight-byte magic and four-byte version.
        if len(header) != 12 or compiled[:12] != header:
            raise ValueError("Hermes bytecode mismatch: rebuild the native IPA with Xcode.")
        output.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=output.parent, suffix=".ipa", delete=False) as f:
            temporary = Path(f.name)
        try:
            with zipfile.ZipFile(temporary, "w") as target:
                for entry in source.infolist():
                    metadata = copy.copy(entry)
                    if entry.filename == bundle:
                        target.writestr(metadata, compiled)
                    else:
                        with source.open(entry) as src, target.open(metadata, "w") as dst:
                            shutil.copyfileobj(src, dst, length=1024 * 1024)
            with zipfile.ZipFile(temporary) as check:
                if bad := check.testzip():
                    raise ValueError(f"Corrupt ZIP entry: {bad}")
            os.replace(temporary, output)
        finally:
            temporary.unlink(missing_ok=True)
    print(f"Updated {output}; only {bundle} was replaced.")


def install(ipa: Path, host: str, port: int) -> None:
    # Reuse one authenticated connection; SSH prompts for credentials if needed.
    with tempfile.TemporaryDirectory(prefix="pocketpal16-ssh-") as directory:
        socket = str(Path(directory) / "connection")
        ssh = ["ssh", "-o", "ControlMaster=auto", "-o", f"ControlPath={socket}",
               "-o", "ControlPersist=60", "-p", str(port), host]
        remote = None
        try:
            helper = run(ssh + [
                'for p in /var/jb/Applications/TrollStoreLite.app/trollstorehelper '
                '/Applications/TrollStoreLite.app/trollstorehelper; do '
                'if test -x "$p"; then printf "%s" "$p"; exit 0; fi; done; '
                'echo "TrollStore Lite helper not found" >&2; exit 1'
            ], stdout=subprocess.PIPE, text=True).stdout.strip()
            remote = run(ssh + ["mktemp /var/tmp/pocketpal16-update.XXXXXX"],
                         stdout=subprocess.PIPE, text=True).stdout.strip()
            run(["scp", "-O", "-o", f"ControlPath={socket}", "-P", str(port),
                 str(ipa), f"{host}:{remote}"])
            run(ssh + [f"{shlex.quote(helper)} install {shlex.quote(remote)}"])
            print("TrollStore Lite installation succeeded. Open PocketPal 16 on the phone.")
        finally:
            if remote:
                subprocess.run(ssh + [f"rm -f {shlex.quote(remote)}"], cwd=ROOT)
            subprocess.run(["ssh", "-o", f"ControlPath={socket}", "-p", str(port),
                            "-O", "exit", host], cwd=ROOT, capture_output=True)


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base-ipa", type=Path, required=True,
                        help="Working IPA built with the same native code and dependencies")
    parser.add_argument("--output", type=Path, default=ROOT / "build/PocketPal16-js.ipa")
    parser.add_argument("--install-host", help="SSH destination, e.g. root@127.0.0.1")
    parser.add_argument("--ssh-port", type=int, default=22)
    args = parser.parse_args()
    base, output = args.base_ipa.resolve(), args.output.resolve()
    if base == output:
        parser.error("Choose an output path different from the base IPA.")
    # Resolve the compiler supplied by this checkout's React Native dependency tree.
    compiler_package = Path(run(
        ["node", "-p", "require.resolve('hermes-compiler/package.json', {paths: ["
         "require('path').dirname(require.resolve('react-native/package.json'))]})"],
        stdout=subprocess.PIPE, text=True,
    ).stdout.strip()).parent
    compiler_platform = {"linux": "linux64-bin", "darwin": "osx-bin"}[sys.platform]
    compiler = compiler_package / "hermesc" / compiler_platform / "hermesc"
    for check in ("lint", "typecheck", "test"):
        run(["npm", "run", check])
    with tempfile.TemporaryDirectory(prefix="pocketpal16-bundle-") as directory:
        bundle, bytecode = Path(directory) / "main.jsbundle", Path(directory) / "main.hbc"
        # A separate asset set would require updating more than the JavaScript bundle.
        assets = Path(directory) / "assets"
        run(["npx", "--no-install", "react-native", "bundle", "--platform", "ios",
             "--dev", "false", "--entry-file", "index.js", "--bundle-output", str(bundle),
             "--assets-dest", str(assets)])
        if assets.exists() and any(p.is_file() for p in assets.rglob("*")):
            raise ValueError("Bundled assets were emitted: use the full Xcode build for this change.")
        run([str(compiler), "-O", "-emit-binary", "-max-diagnostic-width=80", "-out", str(bytecode), str(bundle)])
        repack(base, output, bytecode)
    if args.install_host:
        install(output, args.install_host, args.ssh_port)


if __name__ == "__main__":
    main()
