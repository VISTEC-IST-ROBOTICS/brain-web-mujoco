#!/usr/bin/env python3
"""Serve the URDF viewer plus /api/models, a list of every <scene>/urdf/*.urdf found under assets_src/.
Usage: tools/coppeliasim/urdf_viewer/server.py [port]   then open http://localhost:<port>/viewer/"""
import json
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parents[2] / "assets_src"


class Handler(SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def do_GET(self):
        path = self.path.split("?")[0]
        if path == "/api/models":
            self.send_bytes(json.dumps(self.models()).encode(), "application/json")
        elif path in ("/", "/viewer", "/viewer/"):
            self.send_bytes((HERE / "index.html").read_bytes(), "text/html")
        else:
            super().do_GET()

    def models(self):
        return sorted(p.relative_to(ROOT).as_posix() for p in ROOT.glob("*/urdf/*.urdf"))

    def send_bytes(self, body, content_type):
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8000
    print(f"Serving {ROOT} on http://localhost:{port}/viewer/")
    ThreadingHTTPServer(("127.0.0.1", port), Handler).serve_forever()
