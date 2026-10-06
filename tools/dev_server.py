"""Local dev server: serves dist/ and lets tools/render_images.html save generated images.

    python3 tools/dev_server.py [port]

POST /_save/<name> writes the request body to src/site/<name>. Only the image names below are accepted.
"""
import http.server
import pathlib
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
ALLOWED = {"icon-180.png", "icon-192.png", "icon-512.png", "og.png"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT / "dist"), **kwargs)

    def do_POST(self):
        name = self.path.removeprefix("/_save/")
        if not self.path.startswith("/_save/") or name not in ALLOWED:
            self.send_error(403)
            return
        body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        (ROOT / "src" / "site" / name).write_bytes(body)
        self.send_response(204)
        self.end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8792
    http.server.ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
