"""Build Orvy from src/.

    python3 build.py

Runs the tests, then writes two targets:
  dist/orvy.html          single-file page for hosts that wrap it in their own document (fonts embedded)
  dist/preview.html       the same page in a full HTML document, for testing in a local browser
  dist/site/              a static site for your own hosting (index.html, fonts, icons, manifest, offline worker)

Minifies with rjsmin and rcssmin when installed (pip install -r requirements-dev.txt); otherwise bundles unminified.
"""
import base64
import hashlib
import json
import pathlib
import re
import shutil
import subprocess
import sys
import tempfile

NAME = "Orvy"
DESCRIPTION = "A step sequencer driven by Conway's Game of Life. Light cells to write a melody and let the grid evolve it."
# Where the single-file page is hosted. Share links from that build point here.
EMBED_URL = "https://claude.ai/artifact/3Lya3jKtzZxn6G8JVytV1A"
# Set this to the public address once the site has a home, e.g. "https://orvy.app/". Used for link previews.
SITE_URL = ""
THEME = "#0a0614"
FONTS = [
    ("Chakra Petch", 400, "chakra-petch-400.woff2"),
    ("Chakra Petch", 600, "chakra-petch-600.woff2"),
    ("Tilt Neon", 400, "tilt-neon-400.woff2"),
]

root = pathlib.Path(__file__).parent
src = root / "src"
dist = root / "dist"
site = dist / "site"
JSC = "/System/Library/Frameworks/JavaScriptCore.framework/Versions/Current/Helpers/jsc"

try:
    import rcssmin
    import rjsmin
    minify_css, minify_js = rcssmin.cssmin, rjsmin.jsmin
except ImportError:
    print("rjsmin/rcssmin not found; bundling without minifying")
    minify_css = minify_js = lambda text: text


def check_syntax(code):
    """Returns an error message, or None. Skipped when jsc isn't available."""
    if not pathlib.Path(JSC).exists():
        return None
    with tempfile.NamedTemporaryFile("w", suffix=".js", delete=False, encoding="utf-8") as f:
        f.write(code)
    out = subprocess.run([JSC, "-e", f"checkSyntax({str(f.name)!r})"], capture_output=True, text=True)
    pathlib.Path(f.name).unlink()
    return ((out.stdout + out.stderr).strip() or "unknown error") if out.returncode else None


def safe_minify_js(js):
    # rjsmin mishandles a template string nested inside another; comments are the only thing it may drop.
    if re.findall(r"\$\{[^}]*`", js):
        print("nested template string in the script; shipping unminified")
        return js
    out = minify_js(js)
    broken = [t for t in re.findall(r"`[^`]*`", js) if t not in out]
    if broken:
        print(f"minifier altered {len(broken)} template string(s), e.g. {broken[0][:60]!r}; shipping unminified")
        return js
    err = check_syntax(out)
    if err:
        print(f"minified script fails to parse ({err}); shipping unminified")
        return js
    return out


def font_faces(inline):
    rules = []
    for family, weight, file in FONTS:
        if inline:
            data = base64.b64encode((src / "fonts" / file).read_bytes()).decode()
            url = f"data:font/woff2;base64,{data}"
        else:
            url = f"fonts/{file}"
        rules.append(f'@font-face{{font-family:"{family}";font-style:normal;font-weight:{weight};font-display:swap;src:url({url}) format("woff2")}}')
    return "".join(rules)


def render(target):
    js = (src / "core.js").read_text(encoding="utf-8") + "\n" + (src / "app.js").read_text(encoding="utf-8")
    js = js.replace("{{TARGET}}", target).replace("{{SHARE_BASE}}", EMBED_URL if target == "embed" else "")
    if target == "embed":
        # The embedding host blocks downloads and service workers, so recording and offline support aren't shipped there.
        js, n = re.subn(r"\n[ \t]*// @site-only.*?// @end-site-only\n", "\n", js, flags=re.S)
        if n != 1:
            sys.exit("expected one @site-only block in app.js")
        js = js.replace('if (TARGET === "site") { setupRecording(); registerOffline(); }', "")
    css = font_faces(inline=target == "embed") + minify_css(
        "\n".join(p.read_text(encoding="utf-8") for p in sorted((src / "styles").glob("*.css"))))
    html = (src / "index.html").read_text(encoding="utf-8")
    # Collapse markup whitespace to single spaces (keeps spacing between inline elements).
    html = re.sub(r"\s+", " ", html).replace("> <", "><").strip()
    html = re.sub(r"(</(?:kbd|b|button)>)<", r"\1 <", html)
    head = ""
    if target == "site":
        image = (SITE_URL + "og.png") if SITE_URL else "og.png"
        head = (f'<meta name="description" content="{DESCRIPTION}">'
                f'<meta name="theme-color" content="{THEME}">'
                '<link rel="icon" href="icon.svg" type="image/svg+xml">'
                '<link rel="apple-touch-icon" href="icon-180.png">'
                '<link rel="manifest" href="manifest.webmanifest">'
                '<link rel="preload" href="fonts/chakra-petch-400.woff2" as="font" type="font/woff2" crossorigin>'
                f'<meta property="og:type" content="website"><meta property="og:title" content="{NAME}">'
                f'<meta property="og:description" content="{DESCRIPTION}"><meta property="og:image" content="{image}">'
                + (f'<meta property="og:url" content="{SITE_URL}">' if SITE_URL else "")
                + '<meta name="twitter:card" content="summary_large_image">')
    return (html.replace("{{NAME}}", NAME).replace("{{HEAD}}", head)
                .replace("{{STYLES}}", css).replace("{{SCRIPT}}", safe_minify_js(js)))


def full_document(page):
    # The embedding host wraps the page in its own document; elsewhere we supply one.
    cut = page.index("</style>") + len("</style>")
    return ('<!doctype html><html lang="en"><head><meta charset="utf-8">'
            '<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">'
            + page[:cut] + "</head><body>" + page[cut:] + "</body></html>")


def main():
    tests = subprocess.run([sys.executable, str(root / "tests" / "run.py")], capture_output=True, text=True)
    if tests.returncode:
        print(tests.stdout + tests.stderr)
        sys.exit("tests failed; nothing built")
    print(tests.stdout.strip().splitlines()[-1])

    source = (src / "core.js").read_text(encoding="utf-8") + "\n" + (src / "app.js").read_text(encoding="utf-8")
    err = check_syntax(source)
    if err:
        sys.exit(f"syntax error in source: {err}")

    dist.mkdir(exist_ok=True)
    embed = render("embed")
    (dist / "orvy.html").write_text(embed, encoding="utf-8")
    (dist / "preview.html").write_text(full_document(embed), encoding="utf-8")
    print(f"dist/orvy.html       {len(embed):,} bytes")

    if site.exists():
        shutil.rmtree(site)
    (site / "fonts").mkdir(parents=True)
    (site / "index.html").write_text(full_document(render("site")), encoding="utf-8")
    for _, _, file in FONTS:
        shutil.copy(src / "fonts" / file, site / "fonts" / file)
    for lic in (src / "fonts").glob("OFL-*.txt"):
        shutil.copy(lic, site / "fonts" / lic.name)
    assets = sorted(p.name for p in (src / "site").iterdir() if p.is_file())
    for name in assets:
        shutil.copy(src / "site" / name, site / name)

    icons = [{"src": "icon.svg", "sizes": "any", "type": "image/svg+xml"}]
    for size in (192, 512):
        if (site / f"icon-{size}.png").exists():
            icons.append({"src": f"icon-{size}.png", "sizes": f"{size}x{size}", "type": "image/png"})
    (site / "manifest.webmanifest").write_text(json.dumps({
        "name": NAME, "short_name": NAME, "description": DESCRIPTION, "start_url": "./", "scope": "./",
        "display": "standalone", "background_color": THEME, "theme_color": THEME, "icons": icons,
    }, indent=2), encoding="utf-8")

    # Offline: cache the app shell. The cache name changes with the content, so updates replace old copies.
    files = ["./", "index.html", "manifest.webmanifest"] + [f"fonts/{f}" for _, _, f in FONTS] + [a for a in assets if a != "og.png"]
    digest = hashlib.sha256(b"".join((site / f).read_bytes() for f in files[1:])).hexdigest()[:12]
    (site / "sw.js").write_text((src / "sw.js").read_text(encoding="utf-8")
                                .replace("{{CACHE}}", f"orvy-{digest}").replace("{{FILES}}", json.dumps(files)), encoding="utf-8")
    count = sum(1 for p in site.rglob("*") if p.is_file())
    total = sum(p.stat().st_size for p in site.rglob("*") if p.is_file())
    print(f"dist/site/           {total:,} bytes in {count} files")
    if not SITE_URL:
        print("note: SITE_URL is empty, so link previews use a relative image path. Set it once the site has an address.")


main()
