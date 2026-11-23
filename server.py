#!/usr/bin/env python3
"""Serve the installed OHIF viewer on loopback, with SPA and WASM support."""
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from threading import BoundedSemaphore
from urllib.parse import parse_qs, urlsplit

from local_metadata import read_metadata

# OHIF_SITE: каталог с собранным вьюером. Нужен, когда код запускается из
# неизменяемой установки (/nix/store), а сборка www лежит в рабочем каталоге.
SITE = Path(os.environ.get('OHIF_SITE') or
            (Path(__file__).resolve().parent / 'www'))
METADATA_WORKERS = BoundedSemaphore(4)


class Handler(SimpleHTTPRequestHandler):
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map,
                      '.wasm': 'application/wasm', '.js': 'text/javascript',
                      '.mjs': 'text/javascript'}

    def do_POST(self):
        if urlsplit(self.path).path != '/api/local-dicom-metadata':
            self.send_error(404)
            return
        # Only the locally served viewer can invoke this endpoint from a browser.
        if self.headers.get('Origin') != 'http://127.0.0.1:3000':
            self.send_error(403)
            return
        try:
            length = int(self.headers.get('Content-Length', '0'))
        except ValueError:
            length = 0
        if not 0 < length <= 512 * 1024 * 1024:
            self.send_error(413)
            return
        with METADATA_WORKERS:
            try:
                payload = self.rfile.read(length)
                if len(payload) != length:
                    raise ValueError('Incomplete request')
                result = read_metadata(payload)
                body = json.dumps(result, ensure_ascii=False, allow_nan=False).encode('utf-8')
            except Exception:
                # Avoid patient text and filenames in HTTP errors and server logs.
                self.send_error(422, 'Unable to read DICOM metadata')
                return
        self.send_response(200)
        self.send_header('Content-Type', 'application/json; charset=utf-8')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def end_headers(self):
        self.send_header('Cross-Origin-Opener-Policy', 'same-origin')
        self.send_header('Cross-Origin-Embedder-Policy', 'require-corp')
        self.send_header('Cross-Origin-Resource-Policy', 'same-origin')
        self.send_header('X-Content-Type-Options', 'nosniff')
        self.send_header('Cache-Control', 'no-cache')
        self.send_header('Content-Security-Policy',
                         "default-src 'self' data: blob:; "
                         "script-src 'self' 'unsafe-inline' 'unsafe-eval' 'wasm-unsafe-eval'; "
                         "style-src 'self' 'unsafe-inline'; connect-src 'self' blob:; "
                         "worker-src 'self' blob:; object-src 'none'; base-uri 'self'; "
                         "frame-ancestors 'none'; form-action 'self'")
        super().end_headers()

    def send_head(self):
        url = urlsplit(self.path)
        path = url.path
        # Client-side navigation after import keeps the in-memory local files.
        # A document request (reload, restored tab, pasted URL) cannot restore them.
        local_viewer = (path == '/viewer/dicomlocal' or
                        'dicomlocal' in parse_qs(url.query).get('datasources', []))
        if path == '/' or local_viewer:
            self.send_response(302)
            self.send_header('Location', '/localbasic')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return None
        local = Path(self.translate_path(self.path))
        if not local.is_file() and '.' not in path.rsplit('/', 1)[-1]:
            self.path = '/index.html'
        return super().send_head()

    def list_directory(self, path):
        self.send_error(404)
        return None


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', 3000), partial(Handler, directory=str(SITE)))
    print('OHIF: http://127.0.0.1:3000/localbasic', flush=True)
    server.serve_forever()
