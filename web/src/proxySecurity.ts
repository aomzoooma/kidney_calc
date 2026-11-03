type HeadersLike = Record<string, string | undefined>

export function allowsSameOriginApiProxy(headers: HeadersLike): boolean {
  const host = headers.host
  if (!host) return false
  const origin = headers.origin
  const fetchSite = headers['sec-fetch-site']?.toLowerCase()
  if (fetchSite && fetchSite !== 'same-origin') return false
  if (origin && origin !== `http://${host}`) return false
  if (!origin && fetchSite !== 'same-origin') return false
  return true
}
