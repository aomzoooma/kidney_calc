"""Auth lifecycle, middleware, concurrency, and process-local boundary tests."""

import os
from concurrent.futures import ThreadPoolExecutor
from http.cookies import SimpleCookie
from pathlib import Path
import tempfile
import threading
import unittest
from unittest.mock import patch

from fastapi.testclient import TestClient

import auth_test_config
from api.auth import AuthConfig, AuthCsrfLimiter, AuthLimiter, AuthSessions, load_auth_config
import api.main as main
from api.main import app


class AuthPrimitiveTest(unittest.TestCase):
    def test_csrf_bootstrap_limiter_and_outstanding_scope_are_bounded(self):
        now = [0.0]
        limiter = AuthCsrfLimiter(max_requests=2, window_seconds=10, clock=lambda: now[0])
        self.assertTrue(limiter.allow("127.0.0.1"))
        self.assertTrue(limiter.allow("127.0.0.1"))
        self.assertFalse(limiter.allow("127.0.0.1"))
        now[0] += 10
        self.assertTrue(limiter.allow("127.0.0.1"))

        sessions = AuthSessions(clock=lambda: now[0])
        issued = [sessions.issue_csrf(None, "login", "127.0.0.1") for _ in range(8)]
        self.assertTrue(all(issued))
        self.assertIsNone(sessions.issue_csrf(None, "login", "127.0.0.1"))
        self.assertIsNotNone(sessions.issue_csrf(None, "login", "::1"))

    def test_limiter_reserves_before_verify_caps_concurrency_and_expires(self):
        now = [100.0]
        limiter = AuthLimiter(max_attempts=5, window_seconds=10, max_in_flight=2,
                              clock=lambda: now[0])
        first = limiter.reserve("admin")
        second = limiter.reserve("admin")
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)
        self.assertIsNone(limiter.reserve("admin"))
        limiter.failed("admin", first)
        third = limiter.reserve("admin")
        self.assertIsNotNone(third)
        limiter.release("admin", third)
        limiter.failed("admin", second)
        for _ in range(3):
            token = limiter.reserve("admin")
            self.assertIsNotNone(token)
            limiter.failed("admin", token)
        self.assertIsNone(limiter.reserve("admin"))
        now[0] += 10
        self.assertIsNotNone(limiter.reserve("admin"))

    def test_login_needs_ack_and_session_expires_absolutely(self):
        now = [1_000.0]
        sessions = AuthSessions(clock=lambda: now[0])
        nonce = sessions.issue_csrf(None, "login")
        epoch = sessions.begin_login()
        ticket = sessions.prepare_login(nonce, None, epoch)
        self.assertIsNotNone(ticket)
        issued, ack_token = sessions.confirm_login(ticket, nonce, 10)
        self.assertFalse(sessions.valid(issued.session_id, issued.expires_at))
        self.assertTrue(sessions.acknowledge(issued.session_id, issued.expires_at, ack_token))
        self.assertTrue(sessions.valid(issued.session_id, issued.expires_at))
        now[0] += 9
        self.assertTrue(sessions.valid(issued.session_id, issued.expires_at))
        now[0] += 1
        self.assertFalse(sessions.valid(issued.session_id, issued.expires_at))

    def test_confirm_is_single_use_and_relogin_waits_for_ack(self):
        sessions = AuthSessions()
        nonce = sessions.issue_csrf(None, "login")
        ticket = sessions.prepare_login(nonce, None, sessions.begin_login())
        issued, ack = sessions.confirm_login(ticket, nonce, 100)
        self.assertIsNone(sessions.confirm_login(ticket, nonce, 100))
        self.assertIsNone(sessions.issue_csrf(None, "login"))
        self.assertTrue(sessions.acknowledge(issued.session_id, issued.expires_at, ack))
        relogin_nonce = sessions.issue_csrf(issued.session_id, "login")
        relogin_ticket = sessions.prepare_login(relogin_nonce, issued.session_id,
                                                 sessions.begin_login())
        self.assertIsNotNone(relogin_ticket)
        replacement, replacement_ack = sessions.confirm_login(relogin_ticket, relogin_nonce, 100)
        self.assertFalse(sessions.valid(issued.session_id, issued.expires_at))
        self.assertFalse(sessions.valid(replacement.session_id, replacement.expires_at))
        self.assertTrue(sessions.acknowledge(replacement.session_id,
                                             replacement.expires_at, replacement_ack))

    def test_unacknowledged_cookie_transition_never_unlocks_automatically(self):
        now = [1_000.0]
        sessions = AuthSessions(clock=lambda: now[0])
        nonce = sessions.issue_csrf(None, "login")
        ticket = sessions.prepare_login(nonce, None, sessions.begin_login())
        issued, _ = sessions.confirm_login(ticket, nonce, 10)
        now[0] += 100
        self.assertFalse(sessions.valid(issued.session_id, issued.expires_at))
        self.assertIsNone(sessions.issue_csrf(None, "login"))

    def test_limiter_and_sessions_are_process_local(self):
        first = AuthLimiter(max_attempts=1)
        second = AuthLimiter(max_attempts=1)
        token = first.reserve("admin")
        first.failed("admin", token)
        self.assertIsNone(first.reserve("admin"))
        self.assertIsNotNone(second.reserve("admin"))

        sessions_a = AuthSessions()
        nonce = sessions_a.issue_csrf(None, "login")
        ticket = sessions_a.prepare_login(nonce, None, sessions_a.begin_login())
        issued, _ = sessions_a.confirm_login(ticket, nonce, 100)
        sessions_b = AuthSessions()
        self.assertFalse(sessions_b.valid(issued.session_id, issued.expires_at))

    def test_expired_window_does_not_release_hung_password_verification_slot(self):
        now = [0.0]
        limiter = AuthLimiter(max_attempts=5, window_seconds=10, max_in_flight=1,
                              clock=lambda: now[0])
        active = limiter.reserve("admin")
        now[0] += 100
        self.assertIsNone(limiter.reserve("admin"))
        limiter.release("admin", active)
        self.assertIsNotNone(limiter.reserve("admin"))

    def test_config_preserves_demo_default_and_fails_closed_when_enabled(self):
        self.assertFalse(load_auth_config({}).enabled)
        with self.assertRaises(RuntimeError):
            load_auth_config({"ADMIN_AUTH_ENABLED": "sometimes"})
        with self.assertRaises(RuntimeError):
            load_auth_config({"ADMIN_AUTH_ENABLED": "true"})


class AuthApiTest(unittest.TestCase):
    def setUp(self):
        main._auth_sessions = AuthSessions()
        main._auth_limiter = AuthLimiter()
        main._auth_csrf_limiter = AuthCsrfLimiter()
        main._auth_logout_csrf_limiter = AuthCsrfLimiter(max_requests=8)
        self.client = auth_test_config.AuthTestClient(app, authenticated=False, reset_state=False)
        self.addCleanup(self.client.close)

    def test_auth_status_explicitly_reports_mode_and_synthetic_boundary(self):
        self.assertEqual(self.client.get("/auth/status").json(), {
            "auth_enabled": True, "synthetic_only": True, "clinical_use": False,
        })
        with patch.object(main, "_auth_config", AuthConfig(False)):
            self.assertEqual(self.client.get("/auth/status").json(), {
                "auth_enabled": False, "synthetic_only": True, "clinical_use": False,
            })

    def token(self, client=None, purpose="login"):
        client = client or self.client
        response = client.get("/auth/csrf", params={"purpose": purpose})
        self.assertEqual(response.status_code, 200)
        return response.json()["csrf_token"]

    def test_all_experimental_routes_are_gated_and_writes_require_csrf(self):
        import re
        route_app = app
        while not hasattr(route_app, "routes"):
            route_app = route_app.app
        routes = [(route.path, method) for route in route_app.routes
                  if getattr(route, "path", "").startswith("/experimental/")
                  for method in getattr(route, "methods", set())
                  if method not in {"HEAD", "OPTIONS"}]
        self.assertTrue(routes)
        for route_path, method in routes:
            path = re.sub(r"\{[^}]+\}", "1", route_path)
            response = self.client.request(method, path, json={})
            self.assertEqual(response.status_code, 401, f"{method} {route_path}")
        self.client.login()
        self.client.auto_csrf = False
        response = self.client.post("/experimental/recipes/calculate", json={"synthetic_only": True})
        self.assertEqual(response.status_code, 403)
        read = self.client.get("/experimental/no-such-route")
        self.assertEqual(read.status_code, 404)

    def test_csrf_bootstrap_rejects_cross_site_and_metadata_free_requests(self):
        self.client.headers.pop("origin", None)
        self.assertEqual(self.client.get("/auth/csrf").status_code, 403)
        self.assertEqual(self.client.get("/auth/csrf", headers={
            "sec-fetch-site": "cross-site",
        }).status_code, 403)
        self.assertEqual(self.client.get("/auth/csrf", headers={
            "sec-fetch-site": "same-origin",
        }).status_code, 200)

    def test_csrf_bootstrap_has_per_client_rate_limit(self):
        main._auth_csrf_limiter = AuthCsrfLimiter(max_requests=2, window_seconds=60)
        self.assertEqual(self.client.get("/auth/csrf").status_code, 200)
        self.assertEqual(self.client.get("/auth/csrf").status_code, 200)
        self.assertEqual(self.client.get("/auth/csrf").status_code, 429)

    def test_logout_nonce_survives_write_bootstrap_burst(self):
        self.client.login()
        for _ in range(29):
            self.assertEqual(self.client.post("/experimental/profiles", json={}).status_code, 422)
        logout_token = self.token(purpose="logout")
        self.assertEqual(self.client.post("/auth/logout", headers={
            "x-csrf-token": logout_token,
        }).status_code, 204)

    def test_unauthenticated_logout_nonce_request_does_not_spend_logout_quota(self):
        main._auth_logout_csrf_limiter = AuthCsrfLimiter(max_requests=1)
        self.assertEqual(self.client.get("/auth/csrf", params={"purpose": "logout"}).status_code, 401)
        self.client.login()
        self.assertEqual(self.client.get("/auth/csrf", params={"purpose": "logout"}).status_code, 200)

    def test_logout_nonce_has_separate_outstanding_scope_from_write_tokens(self):
        self.client.login()
        for _ in range(8):
            self.token(purpose="write")
        logout_token = self.token(purpose="logout")
        self.assertEqual(self.client.post("/auth/logout", headers={
            "x-csrf-token": logout_token,
        }).status_code, 204)

    def test_logout_nonce_rejects_cross_origin_and_replay(self):
        self.client.login()
        logout_token = self.token(purpose="logout")
        self.assertEqual(self.client.post("/auth/logout", headers={
            "x-csrf-token": logout_token, "origin": "http://attacker.example",
        }).status_code, 403)
        headers = {"x-csrf-token": logout_token}
        self.assertEqual(self.client.post("/auth/logout", headers=headers).status_code, 204)
        self.client.auto_csrf = False
        self.assertEqual(self.client.post("/auth/logout", headers=headers).status_code, 401)

    def test_concurrent_logout_nonces_revoke_session_once(self):
        self.client.login()
        tokens = [self.token(purpose="logout") for _ in range(2)]
        other = auth_test_config.AuthTestClient(app, authenticated=False, reset_state=False)
        self.addCleanup(other.close)
        other.cookies.set("kidney_calc_session", self.client.cookies.get("kidney_calc_session"),
                         domain="127.0.0.1", path="/")
        self.client.auto_csrf = other.auto_csrf = False

        def logout(client, token):
            return client.post("/auth/logout", headers={"x-csrf-token": token})

        with ThreadPoolExecutor(max_workers=2) as pool:
            responses = list(pool.map(logout, (self.client, other), tokens))
        statuses = [response.status_code for response in responses]
        self.assertEqual(statuses.count(204), 1)
        self.assertIn(next(status for status in statuses if status != 204), {401, 403})

    def test_login_write_and_logout_workflow(self):
        self.client.login()
        with tempfile.TemporaryDirectory() as directory, patch.dict(os.environ, {
            "KIDNEY_EXPERIMENTAL_DB": str(Path(directory) / "synthetic.db"),
        }):
            created = self.client.post("/experimental/profiles", json={
                "synthetic_only": True, "name": "Test profile",
            })
            self.assertEqual(created.status_code, 200)
            logout_token = self.token(purpose="logout")
            logged_out = self.client.post("/auth/logout", headers={
                "x-csrf-token": logout_token,
            })
            self.assertEqual(logged_out.status_code, 204)
            self.assertEqual(self.client.get("/auth/me").status_code, 401)

    def test_login_confirm_ack_rotation_logout_replay_and_cookie_flags(self):
        nonce = self.token()
        headers = {"x-csrf-token": nonce}
        response = self.client.post("/auth/login", json={
            "username": "test-admin", "password": auth_test_config.TEST_PASSWORD,
        }, headers=headers)
        self.assertEqual(response.status_code, 200)
        self.assertNotIn("set-cookie", response.headers)
        confirmed = self.client.post("/auth/confirm", json={
            "login_ticket": response.json()["login_ticket"],
        }, headers=headers)
        self.assertEqual(confirmed.status_code, 200)
        first_cookie = self.client.cookies.get("kidney_calc_session")
        self.assertTrue(first_cookie)
        cookie_header = next(value for name, value in confirmed.headers.multi_items()
                             if name.lower() == "set-cookie" and value.startswith("kidney_calc_session="))
        self.assertIn("httponly", cookie_header.lower())
        self.assertIn("samesite=strict", cookie_header.lower())
        self.assertNotIn("secure", cookie_header.lower())  # HTTP is test-only.
        self.assertEqual(self.client.get("/auth/me").status_code, 401)

        ack_token = confirmed.json()["csrf_token"]
        self.assertEqual(self.client.post("/auth/ack", headers={"x-csrf-token": ack_token}).status_code, 204)
        self.assertEqual(self.client.get("/auth/me").status_code, 200)

        old_cookie = first_cookie
        relogin_nonce = self.token(purpose="login")
        relogin_headers = {"x-csrf-token": relogin_nonce}
        relogin = self.client.post("/auth/login", json={
            "username": "test-admin", "password": auth_test_config.TEST_PASSWORD,
        }, headers=relogin_headers)
        self.assertEqual(relogin.status_code, 200)
        replacement = self.client.post("/auth/confirm", json={
            "login_ticket": relogin.json()["login_ticket"],
        }, headers=relogin_headers)
        self.assertEqual(replacement.status_code, 200)
        new_cookie = self.client.cookies.get("kidney_calc_session")
        self.assertNotEqual(old_cookie, new_cookie)
        replay = auth_test_config.AuthTestClient(app, authenticated=False, reset_state=False)
        self.addCleanup(replay.close)
        replay.cookies.set("kidney_calc_session", old_cookie, domain="127.0.0.1", path="/")
        self.assertEqual(replay.get("/auth/me").status_code, 401)
        self.assertEqual(self.client.post("/auth/ack", headers={
            "x-csrf-token": replacement.json()["csrf_token"],
        }).status_code, 204)

        logout_token = self.token(purpose="logout")
        logged_out = self.client.post("/auth/logout", headers={"x-csrf-token": logout_token})
        self.assertEqual(logged_out.status_code, 204)
        self.assertNotIn("set-cookie", logged_out.headers)
        replay.cookies.set("kidney_calc_session", new_cookie, domain="127.0.0.1", path="/")
        self.assertEqual(replay.get("/auth/me").status_code, 401)

    def test_delayed_confirm_cannot_be_overtaken_by_logout_or_new_login(self):
        self.client.login()
        self.client.auto_csrf = False
        old_cookie = self.client.cookies.get("kidney_calc_session")
        old_write_token = self.token(purpose="write")
        nonce = self.token(purpose="login")
        headers = {"x-csrf-token": nonce}
        login = self.client.post("/auth/login", json={
            "username": "test-admin", "password": auth_test_config.TEST_PASSWORD,
        }, headers=headers)
        self.assertEqual(login.status_code, 200)

        delayed = auth_test_config.AuthTestClient(app, authenticated=False, reset_state=False)
        self.addCleanup(delayed.close)
        delayed.cookies.set("kidney_calc_session", old_cookie, domain="127.0.0.1", path="/")
        confirm = delayed.post("/auth/confirm", json={"login_ticket": login.json()["login_ticket"]},
                               headers=headers)
        self.assertEqual(confirm.status_code, 200)
        self.assertTrue(confirm.headers.get("set-cookie", "").startswith("kidney_calc_session="))

        stale_logout = self.client.post("/auth/logout", headers={"x-csrf-token": old_write_token})
        self.assertEqual(stale_logout.status_code, 401)
        self.assertEqual(self.client.get("/auth/csrf", params={"purpose": "login"}).status_code, 429)
        duplicate = delayed.post("/auth/confirm", json={"login_ticket": login.json()["login_ticket"]},
                                 headers=headers)
        self.assertEqual(duplicate.status_code, 409)
        self.assertNotIn("set-cookie", duplicate.headers)

        new_cookie = SimpleCookie(confirm.headers["set-cookie"])["kidney_calc_session"].value
        self.client.cookies.set("kidney_calc_session", new_cookie, domain="127.0.0.1", path="/")
        acked = self.client.post("/auth/ack", headers={"x-csrf-token": confirm.json()["csrf_token"]})
        self.assertEqual(acked.status_code, 204)
        self.assertEqual(self.client.get("/auth/me").status_code, 200)

    def test_logout_cancels_pending_relogin_before_cookie_confirmation(self):
        self.client.login()
        logout_token = self.token(purpose="logout")
        nonce = self.token(purpose="login")
        login = self.client.post("/auth/login", json={
            "username": "test-admin", "password": auth_test_config.TEST_PASSWORD,
        }, headers={"x-csrf-token": nonce})
        self.assertEqual(login.status_code, 200)
        logout = self.client.post("/auth/logout", headers={"x-csrf-token": logout_token})
        self.assertEqual(logout.status_code, 204)
        confirm = self.client.post("/auth/confirm", json={"login_ticket": login.json()["login_ticket"]},
                                   headers={"x-csrf-token": nonce})
        self.assertEqual(confirm.status_code, 409)
        self.assertNotIn("set-cookie", confirm.headers)


    def test_cookieless_or_stale_browser_cannot_replace_acknowledged_session(self):
        self.client.login()
        other = auth_test_config.AuthTestClient(app, authenticated=False, reset_state=False)
        self.addCleanup(other.close)
        self.assertEqual(other.get("/auth/csrf", params={"purpose": "login"}).status_code, 429)

        old_cookie = self.client.cookies.get("kidney_calc_session")
        nonce = self.token(purpose="login")
        login = self.client.post("/auth/login", json={
            "username": "test-admin", "password": auth_test_config.TEST_PASSWORD,
        }, headers={"x-csrf-token": nonce})
        confirmed = self.client.post("/auth/confirm", json={
            "login_ticket": login.json()["login_ticket"],
        }, headers={"x-csrf-token": nonce})
        self.assertEqual(self.client.post("/auth/ack", headers={
            "x-csrf-token": confirmed.json()["csrf_token"],
        }).status_code, 204)

        stale = auth_test_config.AuthTestClient(app, authenticated=False, reset_state=False)
        self.addCleanup(stale.close)
        stale.cookies.set("kidney_calc_session", old_cookie, domain="127.0.0.1", path="/")
        self.assertEqual(stale.get("/auth/csrf", params={"purpose": "login"}).status_code, 429)

    def test_concurrent_duplicate_login_has_one_ticket_and_one_cookie_writer(self):
        nonce = self.token()
        headers = {"x-csrf-token": nonce}
        clients = [auth_test_config.AuthTestClient(app, authenticated=False, reset_state=False)
                   for _ in range(2)]
        for client in clients:
            self.addCleanup(client.close)
        barrier = threading.Barrier(2)
        verify = main._auth_password.verify

        def synchronized_verify(password, encoded):
            barrier.wait(timeout=3)
            return verify(password, encoded)

        def submit(client):
            return client.post("/auth/login", json={
                "username": "test-admin", "password": auth_test_config.TEST_PASSWORD,
            }, headers=headers)

        with patch.object(main._auth_password, "verify", side_effect=synchronized_verify):
            with ThreadPoolExecutor(max_workers=2) as pool:
                responses = list(pool.map(submit, clients))
        self.assertEqual([response.status_code for response in responses], [200, 200])
        tickets = [response.json()["login_ticket"] for response in responses]
        self.assertEqual(tickets[0], tickets[1])
        self.assertTrue(all("set-cookie" not in response.headers for response in responses))
        confirmed = clients[0].post("/auth/confirm", json={"login_ticket": tickets[0]}, headers=headers)
        self.assertEqual(confirmed.status_code, 200)
        replay = clients[1].post("/auth/confirm", json={"login_ticket": tickets[1]}, headers=headers)
        self.assertEqual(replay.status_code, 409)
        self.assertNotIn("set-cookie", replay.headers)

    def test_distinct_pending_login_challenges_cannot_issue_competing_cookies(self):
        clients = [auth_test_config.AuthTestClient(app, authenticated=False, reset_state=False)
                   for _ in range(2)]
        for client in clients:
            self.addCleanup(client.close)
        nonces = [self.token(client) for client in clients]
        responses = [client.post("/auth/login", json={
            "username": "test-admin", "password": auth_test_config.TEST_PASSWORD,
        }, headers={"x-csrf-token": nonce}) for client, nonce in zip(clients, nonces)]
        self.assertEqual([response.status_code for response in responses], [200, 409])
        self.assertTrue(all("set-cookie" not in response.headers for response in responses))
        confirm = clients[0].post("/auth/confirm", json={
            "login_ticket": responses[0].json()["login_ticket"],
        }, headers={"x-csrf-token": nonces[0]})
        self.assertEqual(confirm.status_code, 200)

    def test_invalid_unicode_username_is_rejected_without_server_error(self):
        nonce = self.token()
        response = self.client.post("/auth/login", json={
            "username": "ผู้ดูแล", "password": auth_test_config.TEST_PASSWORD,
        }, headers={"x-csrf-token": nonce})
        self.assertEqual(response.status_code, 401)

    def test_login_rejects_non_text_credentials_and_wrong_origin(self):
        nonce = self.token()
        response = self.client.post("/auth/login", json={
            "username": 123, "password": auth_test_config.TEST_PASSWORD,
        }, headers={"x-csrf-token": nonce})
        self.assertEqual(response.status_code, 422)
        response = self.client.post("/auth/login", json={
            "username": "test-admin", "password": auth_test_config.TEST_PASSWORD,
        }, headers={"x-csrf-token": nonce, "origin": "http://attacker.example"})
        self.assertEqual(response.status_code, 403)


if __name__ == "__main__":
    unittest.main()
