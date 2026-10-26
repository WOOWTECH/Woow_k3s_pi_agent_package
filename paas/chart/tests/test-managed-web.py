#!/usr/bin/env python3
"""Managed Paseo keeps the existing authenticated tenant entrance.

Real nginx+njs and Helm output; no Docker, cluster or model requests. CI already
installs these dependencies. Missing tools fail instead of silently skipping.
Only local listen ports and filesystem paths are relocated for the harness.
"""
import base64
from contextlib import contextmanager
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import http.client
import os
from pathlib import Path
import re
import shutil
import signal
import socket
import subprocess
import tempfile
import threading
import time
import unittest

import yaml

CHART = Path(__file__).resolve().parents[1]
PATHS = ["/paseo/setup", "/api/plugin-paseo", "/paseo-web", "/paseo-web/",
         "/paseo-web/hosts/test/agents/test", "/paseo-web/pi-paseo-build.json",
         "/paseo-web/_expo/static/js/web/entry-0123456789abcdef.js"]


class ManagedWebProxy(unittest.TestCase):
    def render(self, port, *flags):
        return list(yaml.safe_load_all(subprocess.check_output([
            os.environ.get("HELM_BINARY", "helm"), "template", "managed", str(CHART),
            "--set", "auth.existingSecret=synthetic-test", "--set", f"piWeb.port={port}",
            *flags], text=True)))

    def test_single_authenticated_port_and_uid_for_host_setup_combinations(self):
        for host in ["true", "false"]:
            for setup in ["true", "false"]:
                with self.subTest(host=host, setup=setup):
                    docs = self.render(30141, "--set", f"omnigentHost.enabled={host}",
                                       "--set", f"piWeb.omnigentSetup={setup}")
                    dep = next(d for d in docs if d and d["kind"] == "Deployment")
                    pod = dep["spec"]["template"]["spec"]
                    app = next(c for c in pod["containers"] if c["name"] == "pi-web")
                    identity = {**pod.get("securityContext", {}), **app.get("securityContext", {})}
                    self.assertEqual(identity["runAsUser"], 1000)
                    self.assertEqual(identity["runAsGroup"], 1000)
                    self.assertFalse(app.get("ports"))
                    env = {v["name"]: v.get("value") for v in app["env"]}
                    self.assertEqual(env["PI_WEB_HOSTNAME"], "127.0.0.1")
                    services = [d for d in docs if d and d["kind"] == "Service"]
                    self.assertEqual(len(services), 1)
                    self.assertEqual(services[0]["spec"]["type"], "ClusterIP")
                    self.assertEqual([p["targetPort"] for p in services[0]["spec"]["ports"]], [8080])

    @contextmanager
    def proxy(self, port, *, bypass=False):
        binary = os.environ.get("NGINX_BINARY") or shutil.which("nginx")
        if not binary:
            self.fail("nginx+njs required (or NGINX_BINARY/NGINX_MODULE_DIR/NGINX_MIME_TYPES)")
        module = Path(os.environ.get("NGINX_MODULE_DIR", "/usr/lib/nginx/modules")) / "ngx_http_js_module.so"
        mime = Path(os.environ.get("NGINX_MIME_TYPES", "/etc/nginx/mime.types"))
        self.assertTrue(module.is_file(), "njs must be present; do not disable production auth guard")
        self.assertTrue(mime.is_file())
        docs = self.render(port)
        data = next(d["data"] for d in docs if d and d["kind"] == "ConfigMap" and "nginx.conf" in d["data"])
        with tempfile.TemporaryDirectory(prefix="pi-proxy-") as temp:
            folder = Path(temp)
            replacements = {
                "modules/ngx_http_js_module.so": str(module),
                "/etc/nginx/mime.types": str(mime),
                "/etc/nginx/conf.d/*.conf": str(folder / "default.conf"),
                "/etc/nginx/njs/authguard.js": str(folder / "authguard.js"),
                "/auth/.htpasswd": str(folder / "htpasswd"),
                "/var/log/nginx/": str(folder) + "/",
                "/tmp/": str(folder) + "/",
                "listen 8080;": f"listen unix:{folder}/proxy.sock;",
            }
            for name in ["nginx.conf", "default.conf", "authguard.js"]:
                content = re.sub("|".join(re.escape(k) for k in replacements),
                                 lambda match: replacements[match[0]], data[name])
                if name == "nginx.conf" and os.geteuid() == 0:
                    content = "user root;\n" + content
                if name == "default.conf" and bypass:
                    # Negative control: the exact regression this suite must catch.
                    content = content.replace("location / {", "location / {\n auth_basic off;")
                (folder / name).write_text(content)
            password_hash = subprocess.check_output(["openssl", "passwd", "-apr1", "-stdin"],
                                                     input="synthetic-only\n", text=True).strip()
            (folder / "htpasswd").write_text("fixture:" + password_hash + "\n")
            (folder / "logs").mkdir()
            command = [binary, "-p", temp + "/", "-c", str(folder / "nginx.conf"), "-e", str(folder / "bootstrap.log")]
            checked = subprocess.run(command + ["-t"], capture_output=True, text=True)
            self.assertEqual(checked.returncode, 0, checked.stderr)
            with (folder / "process.log").open("w+") as log:
                child = subprocess.Popen(command + ["-g", "daemon off;"], stdout=log,
                                         stderr=log, start_new_session=True)
                try:
                    def request(path, authorization=None, method="GET"):
                        conn = http.client.HTTPConnection("localhost", timeout=3)
                        conn.sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
                        conn.sock.settimeout(3)
                        try:
                            conn.sock.connect(str(folder / "proxy.sock"))
                            headers = {"Host": "tenant.example.invalid", "Origin": "https://tenant.example.invalid"}
                            if authorization:
                                headers["Authorization"] = "Basic " + base64.b64encode(authorization.encode()).decode()
                            conn.request(method, path, headers=headers)
                            response = conn.getresponse()
                            return response.status, dict(response.getheaders()), response.read()
                        finally:
                            conn.close()
                    for _ in range(100):
                        self.assertIsNone(child.poll(), "nginx exited before becoming ready")
                        try:
                            if request("/healthz")[0] == 200:
                                break
                        except (OSError, http.client.HTTPException):
                            pass
                        time.sleep(0.03)
                    else:
                        self.fail("nginx did not become ready")
                    yield request
                finally:
                    if child.poll() is None:
                        os.killpg(child.pid, signal.SIGQUIT)
                        try:
                            child.wait(timeout=3)
                        except subprocess.TimeoutExpired:
                            os.killpg(child.pid, signal.SIGKILL)
                            child.wait(timeout=3)

    def test_real_proxy_protects_html_assets_api_and_deep_links(self):
        seen = []

        class Upstream(BaseHTTPRequestHandler):
            def do_GET(self):
                seen.append((self.path, self.headers.get("Host"), self.headers.get("Origin")))
                self.send_response(200)
                self.send_header("Cache-Control", "private, no-store")
                self.end_headers()
                self.wfile.write(b"managed-fixture")

            do_HEAD = do_GET

            def log_message(self, *_args):
                pass

        server = ThreadingHTTPServer(("127.0.0.1", 0), Upstream)
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            with self.proxy(server.server_port) as request:
                for path in PATHS:
                    for method in ["GET", "HEAD"]:
                        with self.subTest(path=path, method=method):
                            before = len(seen)
                            self.assertEqual(request(path, method=method)[0], 401)
                            self.assertEqual(len(seen), before, "anonymous request reached upstream")
                    status, headers, body = request(path, "fixture:synthetic-only")
                    self.assertEqual((status, body), (200, b"managed-fixture"))
                    self.assertEqual(headers["Cache-Control"], "private, no-store")
                    self.assertEqual(seen[-1], (path, "localhost", None))
                before = len(seen)
                # njs records 401s in nginx's log phase, which can finish after
                # the response reaches this client. Keep guessing with the wrong
                # password until the proxy itself proves the lock is active.
                deadline = time.monotonic() + 2
                for attempt in range(1, 14):
                    status, _, _ = request("/paseo-web", "fixture:wrong")
                    self.assertLess(time.monotonic(), deadline,
                                    "njs lockout did not engage within 2 seconds")
                    if status == 429:
                        break
                    self.assertEqual(status, 401, f"wrong Basic attempt {attempt}")
                else:
                    self.fail("njs lockout did not engage within 13 wrong Basic attempts")
                status, headers, _ = request("/paseo-web", "fixture:synthetic-only")
                self.assertEqual(status, 429, "njs lockout remains active on the managed entry")
                self.assertEqual(headers["Retry-After"], "300")
                self.assertEqual(len(seen), before)
            with self.proxy(server.server_port, bypass=True) as request:
                with self.assertRaises(AssertionError):
                    self.assertEqual(request("/paseo-web")[0], 401)
        finally:
            server.shutdown()
            server.server_close()
            worker.join(timeout=3)


if __name__ == "__main__":
    unittest.main(verbosity=2)
