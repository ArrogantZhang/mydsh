import { isIP } from 'node:net'

const NEXT_PATH_BASE = 'https://dsh.invalid'
const LOOPBACK_PEERS = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

/**
 * Return a local redirect target safe to include in an invite-authentication response.
 * The input is untrusted request data; only a slash-prefixed path without literal ASCII control or whitespace characters is
 * resolved under the internal base origin.
 * @param raw Requested redirect path, or an absent value when no redirect was supplied.
 * @returns The path, query, and fragment for a target beginning with one literal slash, or `/` for rejected input.
 */
export function safeNextPath(raw?: string | null): string {
  if (!raw || raw[0] !== '/' || raw.startsWith('//') || raw.includes('\\') || /[\u0000-\u0020\u007f]/.test(raw)) return '/'
  const target = new URL(raw, NEXT_PATH_BASE)
  if (target.origin !== NEXT_PATH_BASE) return '/'
  return `${target.pathname}${target.search}${target.hash}`
}

/**
 * Read one exact-named cookie from an HTTP Cookie header.
 * The header is untrusted request data; duplicate target names are rejected to prevent ambiguous authentication state.
 * @param header Raw Cookie header, or undefined when the request did not send one.
 * @param name Exact cookie name to retrieve.
 * @returns The sole cookie value, including an intentional empty value, or undefined when it is absent or duplicated.
 */
export function cookieValue(header: string | undefined, name: string): string | undefined {
  if (!header) return undefined
  let value: string | undefined
  for (const pair of header.split(';')) {
    const trimmed = pair.trim()
    const separator = trimmed.indexOf('=')
    if (separator < 0 || trimmed.slice(0, separator) !== name) continue
    if (value !== undefined) return undefined
    value = trimmed.slice(separator + 1)
  }
  return value
}

/**
 * Select the request address permitted to identify a rate-limit bucket.
 * Forwarded data is untrusted unless the direct peer is one of the exact local reverse-proxy addresses.
 * @param peer Direct socket peer address, or undefined when the server did not expose one.
 * @param forwarded Forwarded client address supplied by the local proxy.
 * @returns A trusted literal forwarded address, otherwise the direct peer or `unknown` when it is absent.
 */
export function trustedClientAddress(peer: string | undefined, forwarded: string | undefined): string {
  if (peer !== undefined && LOOPBACK_PEERS.has(peer) && forwarded !== undefined && isIP(forwarded) !== 0) return forwarded
  return peer ?? 'unknown'
}

/**
 * Check whether reverse-proxy origin headers describe one HTTPS origin.
 * All values are untrusted request headers; this accepts only the exact HTTPS forwarding mode and an origin containing only
 * scheme and authority. Its raw authority, including an explicit default port, must equal the forwarded host.
 * @param origin Forwarded Origin header.
 * @param proto Forwarded protocol header.
 * @param host Forwarded host header.
 * @returns Whether the headers identify the same HTTPS origin.
 */
export function validForwardedOrigin(
  origin: string | undefined,
  proto: string | undefined,
  host: string | undefined,
): boolean {
  if (origin === undefined || proto !== 'https' || host === undefined) return false
  const authority = /^https:\/\/([^/?#@\\\s]+)$/i.exec(origin)?.[1]
  if (authority === undefined) return false
  try {
    new URL(origin)
    return authority.toLowerCase() === host.toLowerCase()
  } catch {
    return false
  }
}

/** Configuration controlling fixed-window authentication-failure retention. */
export interface FailureLimiterConfig {
  /** Window duration in milliseconds. */
  windowMs: number
  /** Failures allowed during one window before an address is blocked. */
  maxFailures: number
  /**
   * Maximum retained addresses; zero discards all failures, otherwise a new address evicts the oldest insertion after expired
   * entries are pruned.
   */
  maxEntries: number
}

interface FailureBucket {
  startedAt: number
  failures: number
}

/**
 * Bound fixed-window authentication-failure state by client address.
 * Instances mutate only their own in-memory buckets; expiry uses caller-provided Unix milliseconds and capacity evicts the
 * oldest Map insertion.
 */
export class FailureLimiter {
  private readonly buckets = new Map<string, FailureBucket>()

  /**
   * Create a bounded fixed-window failure limiter.
   * @param config Fixed-window timing, failure threshold, and retained-address limit.
   */
  constructor(private readonly config: FailureLimiterConfig) {}

  /**
   * Return the number of currently retained buckets, including expired buckets awaiting a capacity prune.
   * @returns Retained address-bucket count.
   */
  get size(): number {
    return this.buckets.size
  }

  /**
   * Return the remaining fixed-window delay once an address reaches its failure limit.
   * Expired buckets do not block; time values are Unix milliseconds.
   * @param address Client address used as the bucket key.
   * @param nowMs Current Unix time in milliseconds.
   * @returns Whole retry seconds rounded up with a minimum of one, or undefined when the address is not blocked.
   */
  retryAfterSeconds(address: string, nowMs: number): number | undefined {
    const bucket = this.buckets.get(address)
    if (bucket === undefined || this.expired(bucket, nowMs) || bucket.failures < this.config.maxFailures) return undefined
    return Math.max(1, Math.ceil((this.config.windowMs - (nowMs - bucket.startedAt)) / 1000))
  }

  /**
   * Record one failed authentication attempt in the address's current fixed window.
   * Expired buckets are replaced; adding a new address at capacity first removes every expired bucket, then evicts the oldest
   * insertion if required. A zero entry capacity discards the failure.
   * @param address Client address used as the bucket key.
   * @param nowMs Current Unix time in milliseconds.
   */
  recordFailure(address: string, nowMs: number): void {
    if (this.config.maxEntries <= 0) return
    const bucket = this.buckets.get(address)
    if (bucket !== undefined && !this.expired(bucket, nowMs)) {
      bucket.failures++
      return
    }
    if (bucket !== undefined) this.buckets.delete(address)
    this.makeRoom(nowMs)
    this.buckets.set(address, { startedAt: nowMs, failures: 1 })
  }

  /**
   * Delete one address's retained failure state.
   * @param address Client address used as the bucket key.
   */
  clear(address: string): void {
    this.buckets.delete(address)
  }

  private expired(bucket: FailureBucket, nowMs: number): boolean {
    return nowMs - bucket.startedAt >= this.config.windowMs
  }

  private makeRoom(nowMs: number): void {
    if (this.buckets.size < this.config.maxEntries) return
    for (const [address, bucket] of this.buckets) {
      if (this.expired(bucket, nowMs)) this.buckets.delete(address)
    }
    if (this.buckets.size >= this.config.maxEntries) {
      const oldest = this.buckets.keys().next().value as string
      this.buckets.delete(oldest)
    }
  }
}
