import { afterEach, expect, it, vi } from 'vitest'
import { apiFetch, AUTH_REQUIRED_EVENT, setAuthEnabled } from '../src/authClient'

afterEach(() => {
  setAuthEnabled(false)
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

const reply = (status: number, body: unknown = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
})

it('keeps anonymous synthetic demo writes free of auth bootstrap calls', async () => {
  const fetchMock = vi.fn(async () => reply(200, { saved: true }))
  vi.stubGlobal('fetch', fetchMock)
  setAuthEnabled(false)
  await apiFetch('/experimental/profiles', { method: 'POST', body: '{}' })
  expect(fetchMock).toHaveBeenCalledTimes(1)
  expect(fetchMock.mock.calls[0][0]).toBe('/experimental/profiles')
})

it('attaches one-time CSRF token to every authenticated unsafe request', async () => {
  const calls: Array<[RequestInfo | URL, RequestInit | undefined]> = []
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push([input, init])
    if (input === '/auth/csrf?purpose=write') return reply(200, { csrf_token: 'one-time-token' })
    return reply(200, { saved: true })
  })
  vi.stubGlobal('fetch', fetchMock)
  setAuthEnabled(true)
  await apiFetch('/experimental/profiles/2/goals', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}',
  })

  expect(calls.map(([input]) => input)).toEqual([
    '/auth/csrf?purpose=write', '/experimental/profiles/2/goals',
  ])
  expect(calls[0][1]?.credentials).toBe('same-origin')
  expect(calls[1][1]?.credentials).toBe('same-origin')
  expect(new Headers(calls[1][1]?.headers).get('X-CSRF-Token')).toBe('one-time-token')
  expect(new Headers(calls[0][1]?.headers).has('X-CSRF-Token')).toBe(false)
})

it('aborts write when token unavailable and signals expired session', async () => {
  const dispatch = vi.spyOn(window, 'dispatchEvent')
  const fetchMock = vi.fn(async (input: RequestInfo | URL) =>
    input === '/auth/csrf?purpose=write' ? reply(429) : reply(401))
  vi.stubGlobal('fetch', fetchMock)
  setAuthEnabled(true)
  await expect(apiFetch('/experimental/recipes', { method: 'POST', body: '{}' })).rejects.toThrow(/เซสชัน/)

  expect(fetchMock.mock.calls.map(([input]) => input)).toEqual([
    '/auth/csrf?purpose=write', '/auth/me',
  ])
  expect(dispatch).toHaveBeenCalledWith(expect.objectContaining({ type: AUTH_REQUIRED_EVENT }))
  expect(fetchMock.mock.calls.some(([input]) => input === '/experimental/recipes')).toBe(false)
})

it('ignores a delayed old-session 401 after logout and a new login', async () => {
  let release: ((response: ReturnType<typeof reply>) => void) | undefined
  const delayed = new Promise<ReturnType<typeof reply>>(resolve => { release = resolve })
  const dispatch = vi.spyOn(window, 'dispatchEvent')
  vi.stubGlobal('fetch', vi.fn(() => delayed))
  setAuthEnabled(true)
  const pending = apiFetch('/experimental/profiles')

  setAuthEnabled(false)
  setAuthEnabled(true)
  release?.(reply(401))
  expect((await pending).status).toBe(401)
  expect(dispatch).not.toHaveBeenCalledWith(expect.objectContaining({ type: AUTH_REQUIRED_EVENT }))
})

it('does not send a write token fetched for a session that changed in flight', async () => {
  let release: ((response: ReturnType<typeof reply>) => void) | undefined
  const delayed = new Promise<ReturnType<typeof reply>>(resolve => { release = resolve })
  const fetchMock = vi.fn((input: RequestInfo | URL) =>
    input === '/auth/csrf?purpose=write' ? delayed : Promise.resolve(reply(200)))
  vi.stubGlobal('fetch', fetchMock)
  setAuthEnabled(true)
  const pending = apiFetch('/experimental/profiles', { method: 'POST', body: '{}' })
  setAuthEnabled(false)
  setAuthEnabled(true)
  release?.(reply(200, { csrf_token: 'old-session-token' }))

  await expect(pending).rejects.toThrow(/สถานะการเข้าสู่ระบบเปลี่ยนแล้ว/)
  expect(fetchMock.mock.calls.some(([input]) => input === '/experimental/profiles')).toBe(false)
})
