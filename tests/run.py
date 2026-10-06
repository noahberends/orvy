"""Runs tests/core.test.js against src/core.js with macOS's JavaScriptCore (jsc).

    python3 tests/run.py

Exits non-zero if any test fails. Prints a notice and exits 0 when jsc isn't available.
"""
import pathlib
import subprocess
import sys

JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"
root = pathlib.Path(__file__).resolve().parent.parent


def main():
    if not pathlib.Path(JSC).exists():
        print("jsc not found; skipping tests")
        return 0
    out = subprocess.run([JSC, str(root / "src/core.js"), str(root / "tests/core.test.js")],
                         capture_output=True, text=True)
    print(out.stdout + out.stderr, end="")
    return 1 if out.returncode or "TESTS FAILED" in out.stdout or "Exception" in out.stderr else 0


if __name__ == "__main__":
    sys.exit(main())
