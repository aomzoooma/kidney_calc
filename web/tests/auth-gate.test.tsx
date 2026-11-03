import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { AuthGate } from '../src/AuthGate'
import { apiFetch, setAuthEnabled } from '../src/authClient'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  setAuthEnabled(false)
})

const reply = (status: number, body: unknown = {}) => ({
  status,
  ok: status >= 200 && status < 300,
  json: async () => body,
})

it('keeps unauthenticated demo available, marked synthetic-only', async () => {
  const fetchMock = vi.fn(async () => reply(200, {
    auth_enabled: false, synthetic_only: true, clinical_use: false,
  }))
  vi.stubGlobal('fetch', fetchMock)
  render(<AuthGate><p>เครื่องมือทดลอง</p></AuthGate>)

  expect(await screen.findByText('เครื่องมือทดลอง')).toBeTruthy()
  expect(screen.getByText(/โหมดทดลองไม่มีล็อกอิน/)).toBeTruthy()
  expect(screen.getByText(/ใช้ข้อมูลสมมติเท่านั้น/)).toBeTruthy()
})

it('signs in with CSRF, confirms cookie, acknowledges it, then shows app', async () => {
  const calls: Array<[string, RequestInit | undefined]> = []
  const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
    calls.push([path, options])
    if (path === '/auth/status') return reply(200, {
      auth_enabled: true, synthetic_only: true, clinical_use: false,
    })
    if (path === '/auth/me') return reply(401)
    if (path === '/auth/csrf?purpose=login') return reply(200, { csrf_token: 'login-token' })
    if (path === '/auth/login') return reply(200, { login_ticket: 'login-ticket-value' })
    if (path === '/auth/confirm') return reply(200, { csrf_token: 'ack-token' })
    if (path === '/auth/ack') return reply(204)
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<AuthGate><p>หน้าวางแผน</p></AuthGate>)

  fireEvent.change(await screen.findByLabelText('ชื่อผู้ใช้'), { target: { value: 'admin' } })
  fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: 'secret-only-in-memory' } })
  fireEvent.submit(screen.getByRole('form', { name: 'เข้าสู่ระบบผู้ดูแล' }))

  expect(await screen.findByText('หน้าวางแผน')).toBeTruthy()
  expect(calls.map(([path]) => path)).toEqual([
    '/auth/status', '/auth/me', '/auth/csrf?purpose=login', '/auth/login', '/auth/confirm', '/auth/ack',
  ])
  const login = calls.find(([path]) => path === '/auth/login')
  expect(JSON.parse(String(login?.[1]?.body))).toEqual({ username: 'admin', password: 'secret-only-in-memory' })
  expect(login?.[1]?.credentials).toBe('same-origin')
  expect(login?.[1]?.headers).toEqual(expect.objectContaining({ 'X-CSRF-Token': 'login-token' }))
  expect(screen.queryByDisplayValue('secret-only-in-memory')).toBeNull()
  expect(localStorage.length).toBe(0)
  expect(sessionStorage.length).toBe(0)
})

it('explains restart recovery if confirm response is lost', async () => {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/status') return reply(200, {
      auth_enabled: true, synthetic_only: true, clinical_use: false,
    })
    if (path === '/auth/me') return reply(401)
    if (path === '/auth/csrf?purpose=login') return reply(200, { csrf_token: 'login-token' })
    if (path === '/auth/login') return reply(200, { login_ticket: 'login-ticket-value' })
    if (path === '/auth/confirm') throw new TypeError('Failed to fetch')
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<AuthGate><p>หน้าวางแผน</p></AuthGate>)
  fireEvent.change(await screen.findByLabelText('ชื่อผู้ใช้'), { target: { value: 'admin' } })
  fireEvent.change(screen.getByLabelText('รหัสผ่าน'), { target: { value: 'secret' } })
  fireEvent.submit(screen.getByRole('form', { name: 'เข้าสู่ระบบผู้ดูแล' }))

  expect((await screen.findByRole('alert')).textContent).toMatch(/ยืนยัน/)
  expect(screen.getByRole('button', { name: /ตรวจอีกครั้งหลังรีสตาร์ต backend/ })).toBeTruthy()
  expect(screen.queryByText('หน้าวางแผน')).toBeNull()
})

it('logs out with one-time write token and returns to login', async () => {
  const calls: Array<[string, RequestInit | undefined]> = []
  const fetchMock = vi.fn(async (path: string, options?: RequestInit) => {
    calls.push([path, options])
    if (path === '/auth/status') return reply(200, {
      auth_enabled: true, synthetic_only: true, clinical_use: false,
    })
    if (path === '/auth/me') return reply(calls.filter(([p]) => p === '/auth/me').length === 1 ? 200 : 401,
      { authenticated: true, username: 'admin' })
    if (path === '/auth/csrf?purpose=write') return reply(200, { csrf_token: 'write-token' })
    if (path === '/auth/logout') return reply(204)
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<AuthGate><p>หน้าวางแผน</p></AuthGate>)

  fireEvent.click(await screen.findByRole('button', { name: 'ออกจากระบบ' }))
  expect(await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeTruthy()
  expect(calls.map(([path]) => path)).toEqual([
    '/auth/status', '/auth/me', '/auth/csrf?purpose=write', '/auth/logout',
  ])
  expect(calls[3][1]?.credentials).toBe('same-origin')
  expect(calls[3][1]?.headers).toEqual(expect.objectContaining({ 'X-CSRF-Token': 'write-token' }))
})

it('does not expose planner when auth status cannot be checked', async () => {
  const fetchMock = vi.fn(async () => reply(503))
  vi.stubGlobal('fetch', fetchMock)
  render(<AuthGate><p>หน้าวางแผน</p></AuthGate>)

  expect((await screen.findByRole('alert')).textContent).toMatch(/backend/)
  expect(screen.queryByText('หน้าวางแผน')).toBeNull()
  await waitFor(() => expect(screen.getByRole('button', { name: 'ลองตรวจอีกครั้ง' })).toBeTruthy())
})

it('does not treat a missing auth status endpoint as anonymous demo mode', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => reply(404, { detail: 'Not found' })))
  render(<AuthGate><p>หน้าวางแผน</p></AuthGate>)

  expect(await screen.findByRole('heading', { name: 'เชื่อมต่อระบบไม่ได้' })).toBeTruthy()
  expect(screen.queryByText('หน้าวางแผน')).toBeNull()
  expect(screen.queryByText(/โหมดทดลองไม่มีล็อกอิน/)).toBeNull()
})

it('returns to login when an authenticated API reports an expired session', async () => {
  const fetchMock = vi.fn(async (path: string) => {
    if (path === '/auth/status') return reply(200, {
      auth_enabled: true, synthetic_only: true, clinical_use: false,
    })
    if (path === '/auth/me') return reply(200, { authenticated: true })
    if (path === '/experimental/profiles') return reply(401)
    throw new Error(`Unexpected request: ${path}`)
  })
  vi.stubGlobal('fetch', fetchMock)
  render(<AuthGate><p>ข้อมูลสมมติที่โหลดไว้</p></AuthGate>)

  expect(await screen.findByText('ข้อมูลสมมติที่โหลดไว้')).toBeTruthy()
  expect((await apiFetch('/experimental/profiles')).status).toBe(401)
  expect(await screen.findByRole('heading', { name: 'เข้าสู่ระบบ' })).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toMatch(/หมดอายุ/)
  expect(screen.queryByText('ข้อมูลสมมติที่โหลดไว้')).toBeNull()
})
