import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

/** Cookie carrying an invite-authenticated session token. */
export const SESSION_COOKIE_NAME = '__Host-dsh_invite'

const TOKEN_VERSION = 'v1'
const SIGNATURE_BYTES = 32
const NONCE_BYTES = 16
const BASE64URL = /^[A-Za-z0-9_-]+$/

/** Compare invite codes without leaking their equality through timing. */
export function inviteCodeMatches(expected: string, candidate: string): boolean {
  const expectedDigest = createHash('sha256').update(expected, 'utf8').digest()
  const candidateDigest = createHash('sha256').update(candidate, 'utf8').digest()
  return timingSafeEqual(expectedDigest, candidateDigest)
}

/** Create a signed, expiring session token. */
export function issueSessionToken(secret: string, ttlSeconds: number, nowMs = Date.now(), nonce = randomBytes(NONCE_BYTES)): string {
  const expiresSeconds = Math.floor(nowMs / 1000) + ttlSeconds
  const nonceText = nonce.toString('base64url')
  const payload = `${TOKEN_VERSION}.${String(expiresSeconds)}.${nonceText}`
  const signature = createHmac('sha256', secret).update(payload, 'utf8').digest('base64url')
  return `${payload}.${signature}`
}

/** Verify a session token's format, expiry, and signature. */
export function verifySessionToken(token: string | undefined, secret: string, nowMs = Date.now()): boolean {
  if (token === undefined) return false
  const parts = token.split('.')
  const [version, expiryText, nonceText, signatureText] = parts
  if (
    parts.length !== 4 || version !== TOKEN_VERSION || expiryText === undefined || nonceText === undefined || signatureText === undefined
  ) return false
  if (!/^\d+$/.test(expiryText) || !BASE64URL.test(nonceText) || !BASE64URL.test(signatureText)) return false
  const expiresSeconds = Number(expiryText)
  if (!Number.isSafeInteger(expiresSeconds) || expiresSeconds <= Math.floor(nowMs / 1000)) return false
  const nonce = Buffer.from(nonceText, 'base64url')
  const providedSignature = Buffer.from(signatureText, 'base64url')
  if (nonce.length !== NONCE_BYTES || providedSignature.length !== SIGNATURE_BYTES) return false
  const payload = `${TOKEN_VERSION}.${expiryText}.${nonceText}`
  const expectedSignature = createHmac('sha256', secret).update(payload, 'utf8').digest()
  return timingSafeEqual(expectedSignature, providedSignature)
}
