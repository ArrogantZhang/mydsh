import { createHmac } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { inviteCodeMatches, issueSessionToken, SESSION_COOKIE_NAME, verifySessionToken } from '../src/token.ts'

const SECRET = '0123456789abcdef0123456789abcdef'

describe('invite auth token primitives', () => {
  it('hashes and compares fixed-length SHA-256 digests across equal and unequal inputs', () => {
    expect(inviteCodeMatches('shared-code-123', 'shared-code-123')).toBe(true)
    expect(inviteCodeMatches('shared-code-124', 'shared-code-123')).toBe(false)
    expect(inviteCodeMatches('', 'shared-code-123')).toBe(false)
  })

  it('issues and verifies expiring signed session tokens', () => {
    const token = issueSessionToken(SECRET, 60, 1_000, Buffer.alloc(16, 7))
    expect(token).toBe('v1.61.BwcHBwcHBwcHBwcHBwcHBw.oPlELwFLIeeTWkgjgj_mEfRa76XHDoEQYbOQkaXVZCs')
    expect(verifySessionToken(token, SECRET, 60_999)).toBe(true)
    expect(verifySessionToken(token, SECRET, 61_000)).toBe(false)
    expect(verifySessionToken(token, 'wrong-secret', 1_000)).toBe(false)
    expect(verifySessionToken(`${token}x`, SECRET, 1_000)).toBe(false)

    const parts = token.split('.')
    expect(verifySessionToken(['v2', ...parts.slice(1)].join('.'), SECRET, 1_000)).toBe(false)
    for (const malformed of [undefined, '', 'v1', 'v1.a.b.c', 'v1.1.%%%%.AA', 'v1.1.AA.AA']) {
      expect(verifySessionToken(malformed, SECRET, 1_000)).toBe(false)
    }
    expect(verifySessionToken('v1.061.BwcHBwcHBwcHBwcHBwcHBw.oPlELwFLIeeTWkgjgj_mEfRa76XHDoEQYbOQkaXVZCs', SECRET, 1_000)).toBe(false)
    expect(verifySessionToken('v1.61.BwcHBwcHBwcHBwcHBwcHBw=.oPlELwFLIeeTWkgjgj_mEfRa76XHDoEQYbOQkaXVZCs', SECRET, 1_000)).toBe(false)
    expect(verifySessionToken('v1.61.BwcHBwcHBwcHBwcHBwcHBw.oPlELwFLIeeTWkgjgj_mEfRa76XHDoEQYbOQkaXVZCs=', SECRET, 1_000)).toBe(false)
    expect(verifySessionToken('v1.61.BwcHBwcHBwcHBwcHBwcHBw.oPlELwFLIeeTWkgjgj_mEfRa76XHDoEQYbOQkaXVZCt', SECRET, 1_000)).toBe(false)

    const noncanonicalNonce = 'BwcHBwcHBwcHBwcHBwcHBx'
    const noncanonicalPayload = `v1.61.${noncanonicalNonce}`
    const noncanonicalSignature = createHmac('sha256', SECRET).update(noncanonicalPayload).digest('base64url')
    expect(verifySessionToken(`${noncanonicalPayload}.${noncanonicalSignature}`, SECRET, 1_000)).toBe(false)
    expect(() => issueSessionToken(SECRET, 60, 1_000, Buffer.alloc(15))).toThrow(
      new RangeError('session token nonce must be exactly 16 bytes'),
    )
  })

  it('uses the host-only invite session cookie name', () => {
    expect(SESSION_COOKIE_NAME).toBe('__Host-dsh_invite')
  })
})
