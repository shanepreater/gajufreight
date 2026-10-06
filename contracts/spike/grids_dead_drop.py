"""E9 dead drop for the Phase 0 spike (docs/spikes/phase-0-testnet.md).

Not a product service. Serves each GRIDS request file in a directory and saves what
the wallet posts back beside it as <name>.signed.json. GajuDesk opens
grid://localhost:<port>/1/d/<name>.json, fetches http://localhost:<port>/<name>.json,
and posts its response to the same URL.

    python3 contracts/spike/grids_dead_drop.py <dir> [port]
"""

import json
import pathlib
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

ROOT = pathlib.Path(sys.argv[1]).resolve()
PORT = int(sys.argv[2]) if len(sys.argv) > 2 else 8765
MAX_RESPONSE = 64 * 1024


class DeadDrop(BaseHTTPRequestHandler):
    """GET returns a request; POST stores the wallet's response."""

    def _file(self) -> pathlib.Path | None:
        path = (ROOT / self.path.lstrip("/")).resolve()
        return path if path.parent == ROOT and path.suffix == ".json" else None

    def do_GET(self) -> None:
        """Serve a request file to the wallet."""
        path = self._file()
        if path is None or not path.is_file():
            self.send_error(404)
            return
        body = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_POST(self) -> None:
        """Store the wallet's signed response beside its request, once."""
        path = self._file()
        signed = path.with_suffix(".signed.json") if path else None
        # Only for a request we issued, once, and small: the drop may be reachable
        # through a public tunnel while a phone test runs.
        if path is None or not path.is_file() or signed is None or signed.exists():
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length", 0))
        if length > MAX_RESPONSE:
            self.send_error(413)
            return
        body = self.rfile.read(length)
        json.loads(body)  # reject anything that isn't JSON
        signed.write_bytes(body)
        print(f"received {path.name}: {len(body)} bytes", flush=True)
        reply = b'{"ok":true}'
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(reply)))
        self.end_headers()
        self.wfile.write(reply)


if __name__ == "__main__":
    print(f"dead drop serving {ROOT} on http://localhost:{PORT}", flush=True)
    ThreadingHTTPServer(("127.0.0.1", PORT), DeadDrop).serve_forever()
