"""E9 dead drop for the Phase 0 spike (docs/spikes/phase-0-testnet.md).

Not a product service. Serves each GRIDS request file in a directory and saves what
the wallet posts back beside it as <name>.signed.json. GajuDesk opens
grid://localhost:<port>/1/d/<name>.json, fetches http://localhost:<port>/<name>.json,
and posts its response to the same URL.

Request names are capability URLs, as ADR 0012 specifies for the real relay: only a
name carrying a 128-bit random token (``<label>-<32 hex>.json``) is served or
accepted, so knowing the host isn't enough to read a request or answer one first.

    python3 contracts/spike/grids_dead_drop.py <dir> [port]
"""

import json
import pathlib
import re
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(sys.argv[1]).resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
MAX_RESPONSE = 64 * 1024
REQUEST_NAME = re.compile(r"[a-z0-9]+-[0-9a-f]{32}\.json")


def is_answer_to(body: bytes, request: pathlib.Path) -> bool:
    """Check a posted response names the same signer and type as its request.

    This only filters junk early; the signature itself is checked by grids-submit.
    """
    try:
        response = json.loads(body)
        asked = json.loads(request.read_bytes())
    except ValueError:
        return False
    if not isinstance(response, dict):
        return False
    keys = ("grids", "network_id", "type", "public_id")
    return all(response.get(key) == asked.get(key) for key in keys)


class DeadDrop(BaseHTTPRequestHandler):
    """GET returns a request; POST stores the wallet's response, once."""

    def _request(self) -> pathlib.Path | None:
        name = self.path.lstrip("/")
        if not REQUEST_NAME.fullmatch(name):
            return None
        path = ROOT / name
        return path if path.is_file() else None

    def _reply(self, code: int, body: bytes) -> None:
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self) -> None:
        """Serve a request file to the wallet."""
        path = self._request()
        if path is None:
            self.send_error(404)
            return
        self._reply(200, path.read_bytes())

    def do_POST(self) -> None:
        """Store the wallet's signed response beside its request, once."""
        path = self._request()
        if path is None:
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_RESPONSE:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        if not is_answer_to(body, path):
            self.send_error(400)
            return
        try:
            # Exclusive create: the first valid response claims the slot atomically.
            with path.with_suffix(".signed.json").open("xb") as signed:
                signed.write(body)
        except FileExistsError:
            self.send_error(409)
            return
        print(f"received {path.name}: {len(body)} bytes", flush=True)
        self._reply(200, b'{"ok":true}')


if __name__ == "__main__":
    print(f"dead drop serving {ROOT} on http://localhost:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), DeadDrop).serve_forever()
