import { describe, expect, it } from 'vitest'
import { cookieValue, FailureLimiter, safeNextPath, trustedClientAddress, validForwardedOrigin } from '../src/policy.ts'

describe('safeNextPath', () => {
  it('preserves a local path, query, and fragment', () => {
    expect(safeNextPath('/sessions?id=1')).toBe('/sessions?id=1')
    expect(safeNextPath('/sessions?id=1#latest')).toBe('/sessions?id=1#latest')
  })

  it('returns the root path for absent, empty, or cross-origin input', () => {
    expect(safeNextPath()).toBe('/')
    expect(safeNextPath(null)).toBe('/')
    expect(safeNextPath('')).toBe('/')
    expect(safeNextPath('https://evil.example/sessions')).toBe('/')
    expect(safeNextPath('//evil.example/sessions')).toBe('/')
    expect(safeNextPath('https://[')).toBe('/')
  })

  it('rejects literal backslashes without decoding encoded-looking path text', () => {
    expect(safeNextPath('/\\evil.example/sessions')).toBe('/')
    expect(safeNextPath('/%2F%2Fevil.example/sessions?next=%5C')).toBe('/%2F%2Fevil.example/sessions?next=%5C')
  })
})

describe('cookieValue', () => {
  it('returns the one exact cookie value', () => {
    expect(cookieValue('a=1; __Host-dsh_invite=token; b=2', '__Host-dsh_invite')).toBe('token')
    expect(cookieValue('__Host-dsh_invite=a=b', '__Host-dsh_invite')).toBe('a=b')
  })

  it('rejects duplicate target cookies', () => {
    expect(cookieValue('__Host-dsh_invite=first; __Host-dsh_invite=second', '__Host-dsh_invite')).toBeUndefined()
  })

  it('does not match cookie-name prefixes or suffixes and handles absent or empty values', () => {
    expect(cookieValue('x__Host-dsh_invite=token; __Host-dsh_invite_x=token', '__Host-dsh_invite')).toBeUndefined()
    expect(cookieValue(undefined, '__Host-dsh_invite')).toBeUndefined()
    expect(cookieValue('', '__Host-dsh_invite')).toBeUndefined()
    expect(cookieValue('__Host-dsh_invite=', '__Host-dsh_invite')).toBe('')
  })
})

describe('trustedClientAddress', () => {
  it('uses a literal forwarded client address only from an exact loopback peer', () => {
    for (const peer of ['127.0.0.1', '::1', '::ffff:127.0.0.1']) {
      expect(trustedClientAddress(peer, '203.0.113.5')).toBe('203.0.113.5')
      expect(trustedClientAddress(peer, '2001:db8::5')).toBe('2001:db8::5')
    }
  })

  it('does not trust forwarded data from other peers and falls back for missing peers', () => {
    expect(trustedClientAddress('10.0.0.1', '203.0.113.5')).toBe('10.0.0.1')
    expect(trustedClientAddress(undefined, '203.0.113.5')).toBe('unknown')
  })

  it('rejects non-literal forwarded forms', () => {
    for (const forwarded of ['203.0.113.5, 198.51.100.1', '203.0.113.5:443', '[2001:db8::5]:443', 'client.example', '']) {
      expect(trustedClientAddress('127.0.0.1', forwarded)).toBe('127.0.0.1')
    }
  })
})

describe('validForwardedOrigin', () => {
  it('requires an exact HTTPS origin with a matching forwarded host', () => {
    expect(validForwardedOrigin('https://dsh.example', 'https', 'dsh.example')).toBe(true)
    expect(validForwardedOrigin('https://DSH.EXAMPLE:8443', 'https', 'dsh.example:8443')).toBe(true)
  })

  it('rejects absent, insecure, mismatched, and malformed values', () => {
    expect(validForwardedOrigin(undefined, 'https', 'dsh.example')).toBe(false)
    expect(validForwardedOrigin('https://dsh.example', undefined, 'dsh.example')).toBe(false)
    expect(validForwardedOrigin('https://dsh.example', 'https', undefined)).toBe(false)
    expect(validForwardedOrigin('http://dsh.example', 'https', 'dsh.example')).toBe(false)
    expect(validForwardedOrigin('https://evil.example', 'https', 'dsh.example')).toBe(false)
    expect(validForwardedOrigin('not a URL', 'https', 'dsh.example')).toBe(false)
    expect(validForwardedOrigin('https://[', 'https', 'dsh.example')).toBe(false)
  })

  it('rejects URLs that contain anything beyond a scheme and authority', () => {
    for (const origin of [
      'https://user@dsh.example',
      'https://dsh.example/path',
      'https://dsh.example/?query=1',
      'https://dsh.example/#fragment',
    ]) {
      expect(validForwardedOrigin(origin, 'https', 'dsh.example')).toBe(false)
    }
  })
})

describe('FailureLimiter', () => {
  it('blocks after the configured number of failures and reports a rounded retry interval', () => {
    const limiter = new FailureLimiter({ windowMs: 10_000, maxFailures: 10, maxEntries: 10 })
    for (let failure = 0; failure < 9; failure++) limiter.recordFailure('203.0.113.5', 100)
    expect(limiter.retryAfterSeconds('203.0.113.5', 100)).toBeUndefined()
    limiter.recordFailure('203.0.113.5', 100)
    expect(limiter.retryAfterSeconds('203.0.113.5', 100)).toBe(10)
    expect(limiter.retryAfterSeconds('203.0.113.5', 9_101)).toBe(1)
  })

  it('clears one address without affecting another', () => {
    const limiter = new FailureLimiter({ windowMs: 1_000, maxFailures: 1, maxEntries: 10 })
    limiter.recordFailure('first', 0)
    limiter.recordFailure('second', 0)
    limiter.clear('first')
    expect(limiter.retryAfterSeconds('first', 0)).toBeUndefined()
    expect(limiter.retryAfterSeconds('second', 0)).toBe(1)
    expect(limiter.size).toBe(1)
  })

  it('replaces expired windows at their exact boundary', () => {
    const limiter = new FailureLimiter({ windowMs: 1_000, maxFailures: 2, maxEntries: 10 })
    limiter.recordFailure('203.0.113.5', 0)
    limiter.recordFailure('203.0.113.5', 1)
    expect(limiter.retryAfterSeconds('203.0.113.5', 999)).toBe(1)
    expect(limiter.retryAfterSeconds('203.0.113.5', 1_000)).toBeUndefined()
    limiter.recordFailure('203.0.113.5', 1_000)
    expect(limiter.retryAfterSeconds('203.0.113.5', 1_000)).toBeUndefined()
  })

  it('prunes expired entries before evicting the oldest insertion at capacity', () => {
    const limiter = new FailureLimiter({ windowMs: 100, maxFailures: 1, maxEntries: 2 })
    limiter.recordFailure('expired', 0)
    limiter.recordFailure('kept', 50)
    limiter.recordFailure('new', 100)
    expect(limiter.retryAfterSeconds('expired', 100)).toBeUndefined()
    expect(limiter.retryAfterSeconds('kept', 100)).toBe(1)
    expect(limiter.retryAfterSeconds('new', 100)).toBe(1)
    expect(limiter.size).toBe(2)

    limiter.recordFailure('later', 100)
    expect(limiter.retryAfterSeconds('kept', 100)).toBeUndefined()
    expect(limiter.retryAfterSeconds('new', 100)).toBe(1)
    expect(limiter.retryAfterSeconds('later', 100)).toBe(1)
    expect(limiter.size).toBe(2)
  })

  it('does not retain failures when configured with no entry capacity', () => {
    const limiter = new FailureLimiter({ windowMs: 1_000, maxFailures: 1, maxEntries: 0 })
    limiter.recordFailure('203.0.113.5', 0)
    expect(limiter.size).toBe(0)
    expect(limiter.retryAfterSeconds('203.0.113.5', 0)).toBeUndefined()
  })
})
