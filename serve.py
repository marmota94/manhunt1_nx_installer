#!/usr/bin/env python3
# SPDX-License-Identifier: LGPL-2.1-only
"""Serve the installer locally at http://localhost:8000/ (service workers and
OPFS need a secure context, and localhost counts as one).

  python serve.py [--port 8000] [--dir .]
"""

import argparse
import functools
import http.server
from pathlib import Path

CSP = ("default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self'; connect-src 'self'; "
       "worker-src 'self'; font-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'")


class Handler(http.server.SimpleHTTPRequestHandler):
    extensions_map = {
        **http.server.SimpleHTTPRequestHandler.extensions_map,
        ".js": "text/javascript",
        ".mjs": "text/javascript",
        ".css": "text/css",
        ".json": "application/json",
        ".md": "text/plain; charset=utf-8",
        "": "text/plain; charset=utf-8",
    }

    def end_headers(self):
        self.send_header("Content-Security-Policy", CSP)
        self.send_header("Cache-Control", "no-cache")
        self.send_header("X-Content-Type-Options", "nosniff")
        super().end_headers()


class QuietHandler(Handler):
    def log_message(self, *args):
        pass


def make_server(directory: Path, port: int, host: str = "127.0.0.1", quiet: bool = False) -> http.server.ThreadingHTTPServer:
    handler = functools.partial(QuietHandler if quiet else Handler, directory=str(directory))
    return http.server.ThreadingHTTPServer((host, port), handler)


def main():
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--dir", type=Path, default=Path(__file__).resolve().parent)
    args = ap.parse_args()
    httpd = make_server(args.dir, args.port)
    print(f"Serving {args.dir} at http://localhost:{args.port}/ (Ctrl+C to stop)")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
