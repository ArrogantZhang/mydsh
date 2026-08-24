import { describe, expect, it } from 'vitest'
import { inviteCodeMatches, issueSessionToken, SESSION_COOKIE_NAME, verifySessionToken } from '../src/token.ts'

const SECRET = '0123456789abcdef0123456789abcdef'

describe('invite auth token primitives', () => {
  it('matches invite codes without exposing comparison timing', () => {
    expect(inviteCodeMatches('shared-code-123', 'shared-code-123')).toBe(true)
    expect(inviteCodeMatches('shared-code-123', 'shared-code-124')).toBe(false)
    expect(inviteCodeMatches('shared-code-123', '')).toBe(false)
  })

  it('issues and verifies expiring signed session tokens', () => {
    const token = issueSessionToken(SECRET, 60, 1_000, Buffer.alloc(16, 7))
    expect(verifySessionToken(token, SECRET, 60_999)).toBe(true)
    expect(verifySessionToken(token, SECRET, 61_000)).toBe(false)
    expect(verifySessionToken(`${token}x`, SECRET, 1_000)).toBe(false)

    const parts = token.split('.')
    expect(verifySessionToken(['v2', ...parts.slice(1)].join('.'), SECRET, 1_000)).toBe(false)
    for (const malformed of [undefined, '', 'v1', 'v1.a.b.c', 'v1.1.%%%%.AA', 'v1.1.AA.AA']) {
      expect(verifySessionToken(malformed, SECRET, 1_000)).toBe(false)
    }
  })

  it('uses the host-only invite session cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-dsh_invite')
  })
})
