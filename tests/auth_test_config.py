"""Synthetic-only auth settings and test client bootstrap."""

import os

from pwdlib import PasswordHash
from fastapi.testclient import TestClient
from api.auth import AuthCsrfLimiter, AuthLimiter, AuthSessions

AUTH_ORIGIN = "http://127.0.0.1:8000"
TEST_PASSWORD = "test-only-password"
os.environ["ADMIN_AUTH_ENABLED"] = "true"
os.environ["ADMIN_USERNAME"] = "test-admin"
os.environ["SESSION_SECRET"] = "test-only-session-secret-32-bytes-minimum"
os.environ["AUTH_ORIGIN"] = AUTH_ORIGIN
os.environ["AUTH_COOKIE_SECURE"] = "false"
os.environ["ADMIN_PASSWORD_HASH"] = PasswordHash.recommended().hash(TEST_PASSWORD)


class AuthTestClient(TestClient):
    def __init__(self, app, *, authenticated=True, reset_state=True,
                 client=("127.0.0.1", 12345)):
        super().__init__(app, client=client, base_url=AUTH_ORIGIN)
        self.headers["origin"] = AUTH_ORIGIN
        self.auto_csrf = True
        self._authenticated = False
        if reset_state:
            import api.main as main
            main._auth_sessions = AuthSessions()
            main._auth_limiter = AuthLimiter()
            main._auth_csrf_limiter = AuthCsrfLimiter()
        if authenticated:
            self.login()

    def login(self):
        csrf = self.get("/auth/csrf", params={"purpose": "login"}).json()["csrf_token"]
        headers = {"x-csrf-token": csrf}
        response = self.post("/auth/login", json={"username": "test-admin", "password": TEST_PASSWORD},
                             headers=headers)
        if response.status_code != 200:
            raise AssertionError(f"test login failed: {response.status_code}")
        confirmed = self.post("/auth/confirm", json={"login_ticket": response.json()["login_ticket"]},
                              headers=headers)
        if confirmed.status_code != 200:
            raise AssertionError(f"test confirm failed: {confirmed.status_code}")
        ack_token = confirmed.json()["csrf_token"]
        ack = self.post("/auth/ack", headers={"x-csrf-token": ack_token})
        if ack.status_code != 204:
            raise AssertionError(f"test session ack failed: {ack.status_code}")
        self._authenticated = True

    def request(self, method, url, **kwargs):
        path = url.split("?", 1)[0]
        unsafe = method.upper() not in ("GET", "HEAD", "OPTIONS")
        guarded = path.startswith("/experimental/") or path == "/auth/logout"
        headers = dict(kwargs.pop("headers", {}) or {})
        if self._authenticated and self.auto_csrf and unsafe and guarded:
            headers.setdefault("x-csrf-token", self.get("/auth/csrf", params={"purpose": "write"}).json()["csrf_token"])
        kwargs["headers"] = headers
        return super().request(method, url, **kwargs)
