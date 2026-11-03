const AUTH_REQUIRED_EVENT = 'kidney-calc-auth-required'
let authEnabled = false
let authGeneration = 0

export function setAuthEnabled(enabled: boolean) {
  if (authEnabled !== enabled) authGeneration++
  authEnabled = enabled
}

function isUnsafe(method: string) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase())
}

function isExperimental(input: RequestInfo | URL) {
  const value = typeof input === 'string' ? input : input instanceof URL ? input.pathname : input.url
  const path = new URL(value, 'http://localhost').pathname
  return path === '/experimental' || path.startsWith('/experimental/')
}

function isRequest(input: RequestInfo | URL): input is Request {
  return typeof Request !== 'undefined' && input instanceof Request
}

function notifyIfSessionExpired(generation: number) {
  if (!authEnabled || authGeneration !== generation) return
  window.dispatchEvent(new Event(AUTH_REQUIRED_EVENT))
}

async function verifySessionAfterCsrfFailure(generation: number) {
  if (!authEnabled || authGeneration !== generation) return
  try {
    const response = await fetch('/auth/me', {
      credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
    })
    if (response.status === 401) notifyIfSessionExpired(generation)
  } catch {
    // Network failure is reported by the original request; do not change auth state.
  }
}

export async function apiFetch(input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> {
  const method = init.method ?? (isRequest(input) ? input.method : 'GET')
  const requestInit = { ...init, method, credentials: init.credentials ?? 'same-origin' as const }
  const protectedRoute = authEnabled && isExperimental(input)
  const generation = authGeneration
  if (!protectedRoute || !isUnsafe(method)) {
    const response = await fetch(input, requestInit)
    if (protectedRoute && response.status === 401) notifyIfSessionExpired(generation)
    return response
  }

  const csrfResponse = await fetch('/auth/csrf?purpose=write', {
    credentials: 'same-origin', cache: 'no-store', headers: { Accept: 'application/json' },
  })
  if (!csrfResponse.ok) {
    await verifySessionAfterCsrfFailure(generation)
    throw new Error('ส่งคำขอไม่ได้ · เซสชันอาจหมดอายุหรือระบบกำลังจำกัดคำขอ')
  }
  let csrf: { csrf_token?: unknown }
  try {
    csrf = await csrfResponse.json() as { csrf_token?: unknown }
  } catch {
    throw new Error('ส่งคำขอไม่ได้ · เซิร์ฟเวอร์ส่งรหัสยืนยันไม่ครบ')
  }
  if (typeof csrf.csrf_token !== 'string') {
    throw new Error('ส่งคำขอไม่ได้ · เซิร์ฟเวอร์ส่งรหัสยืนยันไม่ครบ')
  }
  if (!authEnabled || authGeneration !== generation) {
    throw new Error('ส่งคำขอไม่ได้ · สถานะการเข้าสู่ระบบเปลี่ยนแล้ว')
  }
  const headers = new Headers(isRequest(input) ? input.headers : undefined)
  new Headers(init.headers).forEach((value, key) => headers.set(key, value))
  headers.set('X-CSRF-Token', csrf.csrf_token)
  const response = await fetch(input, { ...requestInit, headers })
  if (response.status === 401) notifyIfSessionExpired(generation)
  return response
}

export { AUTH_REQUIRED_EVENT }
