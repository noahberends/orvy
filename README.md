# Orvy

A step sequencer driven by Conway's Game of Life. Lit cells play their row's note as the playhead passes; at the end of each bar the grid advances one generation.

## Layout

| Path | What it is |
|---|---|
| `src/index.html` | Page markup (template with `{{NAME}}`, `{{HEAD}}`, `{{STYLES}}`, `{{SCRIPT}}`) |
| `src/core.js` | Pure logic: Life rule, link codes, grid resizing, settings validation. No DOM or audio |
| `src/app.js` | Everything else: audio, drawing, history, input, tapes |
| `src/styles/` | Stylesheets, one per component, concatenated in file-name order |
| `src/fonts/` | Self-hosted fonts (Chakra Petch, Tilt Neon) and their SIL Open Font Licenses |
| `src/site/` | Files copied as-is into the self-hosted build: icon, PNG icons, link-preview image |
| `src/sw.js` | Offline worker template for the self-hosted build |
| `tests/` | Tests for `core.js` |
| `tools/` | Dev server and the page that renders the PNG icons |
| `archive/` | The last single-file version, kept for reference |

## Build

```bash
pip install -r requirements-dev.txt
```

```bash
python3 build.py
```

The build runs the tests first and stops if any fail. It then writes:

- `dist/orvy.html`: a single-file page for hosts that wrap it in their own document. Fonts are embedded, and share links point at `EMBED_URL` in `build.py`.
- `dist/preview.html`: the same page in a full HTML document, for local testing.
- `dist/site/`: a static site for your own hosting, with offline support, an app manifest, icons, link previews, and audio recording.

Without `rjsmin`/`rcssmin` installed, the build ships unminified code. It also falls back to unminified script if the minifier would change any template string or produce code that fails to parse.

## Test

```bash
python3 tests/run.py
```

Uses macOS's built-in JavaScriptCore. Elsewhere, the tests are skipped with a notice.

## Run locally

```bash
python3 tools/dev_server.py
```

Serves `dist/` at http://localhost:8792. Open `/preview.html` for the single-file build or `/site/` for the self-hosted one.

To regenerate the PNG icons and link-preview image after changing `src/site/icon.svg`, build, run the dev server, open `/_tools/render_images.html` (copy `tools/render_images.html` into `dist/_tools/` first), and run `saveAll()` in the console.

## Deploy

Every push to `main` runs `.github/workflows/pages.yml`, which runs the tests, builds the site and publishes `dist/site/` to GitHub Pages. To deploy somewhere else, build with the public address so link previews get an absolute image URL:

```bash
SITE_URL=https://example.com/ python3 build.py
```

Then upload the contents of `dist/site/` to any static host over HTTPS. The offline worker only runs on HTTPS or localhost.

Share links are built from the page's own address, so they work on whatever domain hosts the site.
