import { expect, it } from 'vitest'
import { allowsSameOriginApiProxy } from '../src/proxySecurity'

it('allows same-origin browser requests before the proxy rewrites trusted Origin', () => {
  expect(allowsSameOriginApiProxy({
    host: '127.0.0.1:5173', origin: 'http://127.0.0.1:5173', 'sec-fetch-site': 'same-origin',
  })).toBe(true)
  expect(allowsSameOriginApiProxy({
    host: '127.0.0.1:5173', 'sec-fetch-site': 'same-origin',
  })).toBe(true)
})

it('rejects cross-site, image-navigation, mismatched-Origin and metadata-free requests', () => {
  for (const headers of [
    { host: '127.0.0.1:5173' },
    { host: '127.0.0.1:5173', 'sec-fetch-site': 'cross-site' },
    { host: '127.0.0.1:5173', 'sec-fetch-site': 'none' },
    { host: '127.0.0.1:5173', origin: 'https://attacker.invalid', 'sec-fetch-site': 'cross-site' },
  ]) {
    expect(allowsSameOriginApiProxy(headers)).toBe(false)
  }
})
