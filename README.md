# Thai Renal Nutrition Planner

Personal-use Thai renal nutrition planner for a caregiver. See [master plan](docs/MASTER_PLAN.md). This project is under development and is not ready for patient care.

For development, create a Python virtual environment and install `requirements.txt`. Run tests with `python -m unittest discover -s tests -v`. Start the local-only API with `uvicorn api.main:app --host 127.0.0.1 --port 8000`; `/health` reports only that the process responds, not that the application is ready for use. Optional local food-name translation setup and model terms are in [docs/LOCAL_FOOD_TRANSLATION.md](docs/LOCAL_FOOD_TRANSLATION.md). Clinical validation, mobile UI, OCR, security, backup, and Windows setup are not complete. Do not enter real patient data.

## Administrator auth foundation

Auth is opt-in so existing local synthetic demos keep working: `ADMIN_AUTH_ENABLED` defaults to `false`. That mode has no login protection and must contain synthetic test data only. Never use real patient data in either mode. With `ADMIN_AUTH_ENABLED=true`, startup fails unless `ADMIN_USERNAME`, an Argon2id `ADMIN_PASSWORD_HASH`, a random `SESSION_SECRET` of at least 32 bytes, loopback `AUTH_ORIGIN`, and explicit `AUTH_COOKIE_SECURE` are configured. Keep all values outside Git. Example local HTTP setup (the password is entered at a hidden prompt):

```sh
export ADMIN_AUTH_ENABLED=true
export ADMIN_USERNAME=admin
export ADMIN_PASSWORD_HASH="$(python -c 'from getpass import getpass; from pwdlib import PasswordHash; print(PasswordHash.recommended().hash(getpass()))')"
export SESSION_SECRET="$(python -c 'import secrets; print(secrets.token_urlsafe(48))')"
export AUTH_ORIGIN=http://127.0.0.1:8000
export AUTH_COOKIE_SECURE=false
```

The first-run client flow is `GET /auth/csrf?purpose=login` → `POST /auth/login` → `POST /auth/confirm` → `POST /auth/ack`. The confirm response sets the signed `HttpOnly`, `SameSite=Strict` session cookie; the client acknowledges receipt before accessing data or starting another session transition. Authenticated unsafe requests require a one-time token from `GET /auth/csrf?purpose=write`; logout uses its own one-time token from `GET /auth/csrf?purpose=logout`. Both require exact configured `Origin` and `Host`. The paired web flow is local-development only and remains unverified in a real browser.

PowerShell first-run setup and recovery steps are in [docs/ADMIN_AUTH.md](docs/ADMIN_AUTH.md). The web UI now detects auth mode and performs the login, cookie acknowledgment, and logout flow; browser, phone, Windows-service, and HTTPS deployment checks remain incomplete.

Only one browser session is active. To switch devices, log out on the active device first. Sessions expire absolutely after eight hours, are revoked on logout or re-login, and live only in process memory. Run one worker. A process restart revokes sessions. Login throttling is five attempts per 15 minutes with at most two concurrent password verifications; limiter/session state is per process and is not shared across workers or proxy instances. Do not put this app behind a proxy or expose it to a network. A confirm response is the only auth-cookie writer; client must acknowledge received cookie before another login/logout transition. If confirm response is lost, server keeps an unacknowledged transition barrier until process restart, even after cookie expiry. Ordering guarantee does not span process restart: a response already in flight during restart may overwrite a newer valid cookie and force the user to restart and log in again. The stale cookie cannot authenticate because restarted server has no matching session state. This prototype does not establish phone, remote-access, HTTPS deployment, or patient-data readiness.
