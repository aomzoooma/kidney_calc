"""Local-only, single-process administrator authentication primitives."""

from __future__ import annotations

from dataclasses import dataclass, replace
import hashlib
import os
import secrets
import threading
import time
from typing import Callable
from urllib.parse import urlsplit

from fastapi import Request
from starlette.middleware.sessions import SessionMiddleware
from starlette.types import ASGIApp, Message, Receive, Scope, Send


@dataclass(frozen=True)
class AuthConfig:
    enabled: bool
    admin_username: str = ""
    admin_password_hash: str = ""
    session_secret: str = ""
    auth_origin: str = ""
    cookie_secure: bool = False


def load_auth_config(environ=os.environ) -> AuthConfig:
    enabled = environ.get("ADMIN_AUTH_ENABLED", "false")
    if enabled not in {"true", "false"}:
        raise RuntimeError("ADMIN_AUTH_ENABLED must be true or false")
    if enabled == "false":
        return AuthConfig(False)
    names = ("ADMIN_USERNAME", "ADMIN_PASSWORD_HASH", "SESSION_SECRET", "AUTH_ORIGIN",
             "AUTH_COOKIE_SECURE")
    values = {name: environ.get(name, "") for name in names}
    missing = [name for name, value in values.items() if not value]
    if missing:
        raise RuntimeError(f"Required auth configuration missing: {', '.join(missing)}")
    if len(values["SESSION_SECRET"].encode()) < 32:
        raise RuntimeError("SESSION_SECRET must contain at least 32 bytes")
    origin = values["AUTH_ORIGIN"]
    parsed = urlsplit(origin)
    try:
        parsed.port
    except ValueError as exc:
        raise RuntimeError("AUTH_ORIGIN has an invalid port") from exc
    if (parsed.scheme not in {"http", "https"} or parsed.hostname not in {"localhost", "127.0.0.1", "::1"}
            or not parsed.netloc or parsed.path or parsed.query or parsed.fragment
            or parsed.username or parsed.password):
        raise RuntimeError("AUTH_ORIGIN must be a loopback http(s) origin without a path")
    if values["AUTH_COOKIE_SECURE"] not in {"true", "false"}:
        raise RuntimeError("AUTH_COOKIE_SECURE must be true or false")
    cookie_secure = values["AUTH_COOKIE_SECURE"] == "true"
    if parsed.scheme == "https" and not cookie_secure:
        raise RuntimeError("AUTH_COOKIE_SECURE must be true for an https origin")
    if not values["ADMIN_USERNAME"].strip():
        raise RuntimeError("ADMIN_USERNAME must be non-empty text")
    if len(values["ADMIN_USERNAME"]) > 128:
        raise RuntimeError("ADMIN_USERNAME is too long")
    return AuthConfig(True, values["ADMIN_USERNAME"], values["ADMIN_PASSWORD_HASH"],
                      values["SESSION_SECRET"], origin, cookie_secure)


def csrf_origin_valid(request: Request, trusted_origin: str) -> bool:
    trusted_host = urlsplit(trusted_origin).netloc
    return (request.headers.get("origin", "") == trusted_origin
            and request.headers.get("host", "").lower() == trusted_host.lower())


def csrf_bootstrap_valid(request: Request, trusted_origin: str) -> bool:
    """Allow a browser bootstrap only from the configured same-origin context."""
    if not csrf_origin_valid_host(request, trusted_origin):
        return False
    origin = request.headers.get("origin")
    if origin is not None:
        return origin == trusted_origin
    # Browsers attach Fetch Metadata to same-origin fetches, including GETs.
    # A top-level cross-site image/navigation has no same-origin marker.
    return request.headers.get("sec-fetch-site", "").lower() == "same-origin"


def csrf_origin_valid_host(request: Request, trusted_origin: str) -> bool:
    trusted_host = urlsplit(trusted_origin).netloc
    return request.headers.get("host", "").lower() == trusted_host.lower()


class AuthCsrfLimiter:
    """Bound CSRF bootstrap issuance per loopback client address."""

    def __init__(self, max_requests: int = 30, window_seconds: int = 60,
                 clock: Callable[[], float] = time.monotonic):
        self.max_requests = max_requests
        self.window_seconds = window_seconds
        self._clock = clock
        self._requests: dict[str, list[float]] = {}
        self._lock = threading.Lock()

    def allow(self, client_key: str) -> bool:
        now = self._clock()
        with self._lock:
            # Caller is constrained to loopback; still cap retained keys.
            for key, entries in list(self._requests.items()):
                recent = [stamp for stamp in entries if now - stamp < self.window_seconds]
                if recent:
                    self._requests[key] = recent
                else:
                    del self._requests[key]
            if client_key not in self._requests and len(self._requests) >= 4:
                return False
            entries = self._requests.setdefault(client_key, [])
            if len(entries) >= self.max_requests:
                return False
            entries.append(now)
            return True


def csrf_token(request: Request) -> str:
    token = request.headers.get("x-csrf-token", "")
    return token if len(token) <= 128 else ""


class AuthLimiter:
    """Per-process account throttle; reservations bound concurrent password verification."""

    def __init__(self, max_attempts: int = 5, window_seconds: int = 900,
                 max_in_flight: int = 2, clock: Callable[[], float] = time.monotonic):
        self.max_attempts = max_attempts
        self.window_seconds = window_seconds
        self.max_in_flight = max_in_flight
        self._clock = clock
        self._attempts: dict[str, list[tuple[float, str, bool]]] = {}
        self._lock = threading.Lock()

    def reserve(self, key: str) -> str | None:
        now = self._clock()
        with self._lock:
            entries = [entry for entry in self._attempts.get(key, [])
                       if entry[2] or now - entry[0] < self.window_seconds]
            self._attempts[key] = entries
            if (len(entries) >= self.max_attempts
                    or sum(pending for _, _, pending in entries) >= self.max_in_flight):
                return None
            token = secrets.token_hex(16)
            entries.append((now, token, True))
            return token

    def failed(self, key: str, token: str) -> None:
        with self._lock:
            self._attempts[key] = [(stamp, entry_token, False if entry_token == token else pending)
                                   for stamp, entry_token, pending in self._attempts.get(key, [])]

    def release(self, key: str, token: str) -> None:
        """Free in-flight capacity if password verification raises unexpectedly."""
        with self._lock:
            entries = [entry for entry in self._attempts.get(key, []) if entry[1] != token]
            if entries:
                self._attempts[key] = entries
            else:
                self._attempts.pop(key, None)

    def succeeded(self, key: str, token: str) -> None:
        # Reset failed attempts, retaining reservations held by concurrent verifications.
        with self._lock:
            entries = [entry for entry in self._attempts.get(key, [])
                       if entry[2] and entry[1] != token]
            if entries:
                self._attempts[key] = entries
            else:
                self._attempts.pop(key, None)


@dataclass(frozen=True)
class IssuedSession:
    session_id: str
    expires_at: int
    previous_session_id: str | None
    acknowledged: bool = False


@dataclass(frozen=True)
class PendingLogin:
    ticket: str
    nonce_hash: str
    client_session_id: str | None
    replaced_session_id: str | None
    epoch: int
    expires_at: int


class AuthSessions:
    """In-memory one-admin session lifecycle with one-time CSRF and cookie ACK gate."""

    _CSRF_MAX = 128
    _CSRF_TTL = 600
    _PENDING_TTL = 120
    _CSRF_PER_SCOPE_MAX = 8

    def __init__(self, clock: Callable[[], float] = time.time):
        self._clock = clock
        self._current: IssuedSession | None = None
        self._pending: PendingLogin | None = None
        self._csrf: dict[str, tuple[str | None, int, str, str]] = {}
        self._epoch = 0
        self._lock = threading.Lock()

    def issue_csrf(self, session_id: str | None, purpose: str,
                   client_key: str = "local") -> str | None:
        now = int(self._clock())
        with self._lock:
            self._prune(now)
            if purpose == "login":
                if self._current is not None and not self._current.acknowledged:
                    return None
                if ((self._current is None and session_id is not None)
                        or (self._current is not None
                            and self._current.session_id != session_id)):
                    return None
                kind = "login"
            elif purpose in {"write", "logout"}:
                if (self._current is None or not self._current.acknowledged
                        or self._current.session_id != session_id):
                    return None
                kind = purpose
                if purpose == "logout":
                    replace_count = sum(1 for entry in self._csrf.values()
                                        if entry[0] == session_id and entry[2] == "logout"
                                        and entry[3] == client_key)
                    if len(self._csrf) - replace_count >= self._CSRF_MAX:
                        return None
                    self._csrf = {key: entry for key, entry in self._csrf.items()
                                  if not (entry[0] == session_id and entry[2] == "logout"
                                          and entry[3] == client_key)}
            else:
                return None
            if len(self._csrf) >= self._CSRF_MAX:
                return None
            scope_tokens = sum(1 for entry in self._csrf.values()
                               if entry[0] == session_id and entry[2] == purpose
                               and entry[3] == client_key)
            if scope_tokens >= self._CSRF_PER_SCOPE_MAX:
                return None
            token = secrets.token_urlsafe(32)
            self._csrf[self._digest(token)] = (session_id, now + self._CSRF_TTL, kind, client_key)
            return token

    def valid_login_nonce(self, token: str, client_session_id: str | None) -> bool:
        with self._lock:
            self._prune(int(self._clock()))
            entry = self._csrf.get(self._digest(token))
            return entry is not None and entry[0] == client_session_id and entry[2] == "login"

    def consume_write_nonce(self, token: str, session_id: str) -> bool:
        return self._consume_csrf_nonce(token, session_id, "write")

    def consume_logout_nonce(self, token: str, session_id: str) -> bool:
        return self._consume_csrf_nonce(token, session_id, "logout")

    def _consume_csrf_nonce(self, token: str, session_id: str, purpose: str) -> bool:
        with self._lock:
            self._prune(int(self._clock()))
            entry = self._csrf.get(self._digest(token))
            if (entry is None or entry[0] != session_id or entry[2] != purpose
                    or self._current is None or not self._current.acknowledged
                    or self._current.session_id != session_id):
                return False
            self._csrf.pop(self._digest(token), None)
            return True

    def begin_login(self) -> int:
        with self._lock:
            self._prune(int(self._clock()))
            return self._epoch

    def prepare_login(self, token: str, client_session_id: str | None,
                      expected_epoch: int) -> str | None:
        now = int(self._clock())
        nonce_hash = self._digest(token)
        with self._lock:
            self._prune(now)
            entry = self._csrf.get(nonce_hash)
            if entry is None or entry[0] != client_session_id or entry[2] != "login":
                return None
            if self._pending is not None:
                if (self._pending.nonce_hash == nonce_hash
                        and self._pending.client_session_id == client_session_id
                        and self._pending.epoch == expected_epoch):
                    return self._pending.ticket
                return None
            if expected_epoch != self._epoch:
                return None
            if self._current is not None and not self._current.acknowledged:
                return None
            if self._current is not None and client_session_id != self._current.session_id:
                return None
            if self._current is None and client_session_id is not None:
                return None
            ticket = secrets.token_urlsafe(32)
            self._pending = PendingLogin(ticket, nonce_hash, client_session_id,
                                         self._current.session_id if self._current else None,
                                         self._epoch, now + self._PENDING_TTL)
            return ticket

    def confirm_login(self, ticket: str, token: str, lifetime_seconds: int) -> tuple[IssuedSession, str] | None:
        now = int(self._clock())
        nonce_hash = self._digest(token)
        with self._lock:
            self._prune(now)
            pending = self._pending
            if (pending is None or not secrets.compare_digest(pending.ticket, ticket)
                    or pending.nonce_hash != nonce_hash or pending.epoch != self._epoch):
                return None
            entry = self._csrf.get(nonce_hash)
            if entry is None or entry[0] != pending.client_session_id or entry[2] != "login":
                return None
            current_id = self._current.session_id if self._current else None
            if current_id != pending.replaced_session_id:
                return None
            self._csrf.pop(nonce_hash, None)
            issued = IssuedSession(secrets.token_urlsafe(32), now + lifetime_seconds,
                                   pending.replaced_session_id, False)
            self._current = issued
            self._pending = None
            self._epoch += 1
            ack_token = secrets.token_urlsafe(32)
            self._csrf[self._digest(ack_token)] = (issued.session_id, issued.expires_at, "ack")
            return issued, ack_token

    def acknowledge(self, session_id: str, expires_at: int, token: str) -> bool:
        now = int(self._clock())
        with self._lock:
            self._prune(now)
            entry = self._csrf.get(self._digest(token))
            if (self._current is None or self._current.session_id != session_id
                    or self._current.expires_at != expires_at or entry is None
                    or entry[0] != session_id or entry[2] != "ack"):
                return False
            if not self._current.acknowledged:
                self._current = replace(self._current, acknowledged=True)
            return True

    def valid(self, session_id: str, expires_at: int) -> bool:
        with self._lock:
            self._prune(int(self._clock()))
            return (self._current is not None and self._current.acknowledged
                    and self._current.session_id == session_id
                    and self._current.expires_at == expires_at)

    def revoke(self, session_id: str) -> bool:
        with self._lock:
            self._prune(int(self._clock()))
            if (self._current is None or not self._current.acknowledged
                    or self._current.session_id != session_id):
                return False
            self._current = None
            self._pending = None
            self._csrf = {key: entry for key, entry in self._csrf.items() if entry[0] != session_id}
            self._epoch += 1
            return True

    @staticmethod
    def _digest(token: str) -> str:
        return hashlib.sha256(token.encode("utf-8")).hexdigest()

    def _prune(self, now: int) -> None:
        self._csrf = {key: entry for key, entry in self._csrf.items() if entry[1] > now}
        if (self._current is not None and self._current.acknowledged
                and self._current.expires_at <= now):
            expired_id = self._current.session_id
            self._current = None
            self._pending = None
            self._csrf = {key: entry for key, entry in self._csrf.items() if entry[0] != expired_id}
            self._epoch += 1
        if self._pending is not None and self._pending.expires_at <= now:
            self._pending = None


class AuthSessionMiddleware:
    """Sign auth cookies; only login confirmation may write them."""

    def __init__(self, app: ASGIApp, secret_key: str, max_age: int, cookie_secure: bool):
        self.app = SessionMiddleware(app, secret_key=secret_key,
                                     session_cookie="kidney_calc_session", max_age=max_age,
                                     same_site="strict", https_only=cookie_secure)
        self.cookie_name = b"kidney_calc_session"
        self.cookie_marker = "auth_cookie_confirm"

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return

        async def send_guarded(message: Message) -> None:
            if (message["type"] == "http.response.start"
                    and (not scope.get("state", {}).get(self.cookie_marker)
                         or message.get("status") != 200)):
                message = dict(message)
                message["headers"] = [
                    (name, value) for name, value in message.get("headers", [])
                    if not (name.lower() == b"set-cookie"
                            and value.startswith(self.cookie_name + b"="))
                ]
            await send(message)

        await self.app(scope, receive, send_guarded)
