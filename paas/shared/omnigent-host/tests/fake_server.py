"""Fake Omnigent server for the omnigent-host kit tests.

Serves GET /v1/me and POST /oauth/token. Behaviour is re-read from a JSON control
file on every request, so a test can flip it while the supervisor runs:

  {"me": 200|401|500|...,          status for /v1/me (200 -> {"user_id": "tester"})
   "me_fail_first": N,             answer the first N /v1/me calls (counted from the
                                   last rewrite of the control file) with 401
   "token": 200|400|401|502|...,   status for /oauth/token
   "token_error": "invalid_grant"} OAuth error code sent with a 400

Every request is appended to requests.log as "<method> <path> <status> auth=<yes|no>"
(never the token itself). Minted access tokens start with "SECRET-ACCESS-" so the
tests can grep logs for leaks.

usage: fake_server.py <ctl.json> <portfile> <requests.log>
"""

from __future__ import annotations

import json
import secrets
import sys
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

CTL, PORTFILE, REQLOG = (Path(a) for a in sys.argv[1:4])
_lock = threading.Lock()
_me_calls = {"n": 0, "mtime": None}


def ctl() -> dict:
    """Current control dict; a rewritten control file restarts me_fail_first counting."""
    try:
        mtime = CTL.stat().st_mtime_ns
        data = json.loads(CTL.read_text())
    except (OSError, ValueError):
        return {}
    with _lock:
        if mtime != _me_calls["mtime"]:
            _me_calls["mtime"] = mtime
            _me_calls["n"] = 0
    return data


class H(BaseHTTPRequestHandler):
    def log_message(self, *args):  # silence stderr
        return

    def _send(self, status: int, body: dict) -> None:
        data = json.dumps(body).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)
        with _lock, REQLOG.open("a") as f:
            auth = "yes" if self.headers.get("Authorization", "").startswith("Bearer ") else "no"
            f.write(f"{self.command} {self.path} {status} auth={auth}\n")

    def do_GET(self):  # noqa: N802
        c = ctl()
        if self.path == "/v1/me":
            with _lock:
                _me_calls["n"] += 1
                n = _me_calls["n"]
            if n <= int(c.get("me_fail_first", 0)):
                return self._send(401, {"user_id": None, "login_url": "/login"})
            st = int(c.get("me", 200))
            if st == 200:
                return self._send(200, {"user_id": "tester", "is_admin": False})
            return self._send(st, {"detail": "fake"})
        return self._send(404, {"detail": "not found"})

    def do_POST(self):  # noqa: N802
        c = ctl()
        length = int(self.headers.get("Content-Length") or 0)
        self.rfile.read(length)
        if self.path == "/oauth/token":
            st = int(c.get("token", 200))
            if st == 200:
                return self._send(
                    200,
                    {
                        "access_token": "SECRET-ACCESS-" + secrets.token_hex(8),
                        "token_type": "Bearer",
                        "expires_in": 3600,
                    },
                )
            if st == 400:
                return self._send(400, {"error": c.get("token_error", "invalid_grant")})
            return self._send(st, {"error": "server_error"})
        return self._send(404, {"detail": "not found"})


srv = ThreadingHTTPServer(("127.0.0.1", 0), H)
PORTFILE.write_text(str(srv.server_address[1]))
srv.serve_forever()
