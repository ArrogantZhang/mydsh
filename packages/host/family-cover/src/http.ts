/** Binary cover routes dispatched only after Connection authentication. */
import { brandString } from '@deepseek-ai/dsh-brand'
import { CoverError, type CoverErrorCode } from './errors.ts'
import type { FamilyCoverStore } from './store.ts'
import type { CoverRevision } from './types.ts'

const HEADERS = { 'cache-control': 'private, no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' }
const STATUS: Record<CoverErrorCode, number> = { 'invalid-image': 415, 'too-large': 413, conflict: 409,
  'not-found': 404, busy: 429, unavailable: 503, corrupt: 500 }

function failure(status: number, reason: string): Response {
  return Response.json({ reason }, { status, headers: HEADERS })
}

function revision(value: string | null): CoverRevision | undefined {
  return value !== null && /^(?:0|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/.test(value)
    ? brandString<CoverRevision>(value) : undefined
}

function sameOrigin(request: Request): boolean {
  const origin = request.headers.get('origin')
  const protocol = request.headers.get('x-forwarded-proto') ?? 'http'
  if (origin === null || !['http', 'https'].includes(protocol)) return false
  try {
    return new URL(origin).origin === `${protocol}://${request.headers.get('host')}` && new URL(origin).origin === origin
  } catch { return false }
}

/**
 * Accept one authenticated binary upload or revision-addressed read.
 * @param store - private shared-cover storage owner.
 * @param request - Connection's already-authenticated request; POST requires explicit same-origin authority.
 * @returns private, non-cacheable bytes or safe classified JSON without filesystem details.
 */
export async function coverHttp(store: FamilyCoverStore, request: Request): Promise<Response> {
  try {
    if (request.method === 'POST') {
      if (!sameOrigin(request)) return failure(403, 'origin')
      const expected = revision(request.headers.get('if-match'))
      if (expected === undefined) return failure(400, 'revision')
      if (request.body === null) return failure(400, 'body')
      const saved = await store.replace(expected, request.headers.get('content-type') ?? '', request.body, request.signal)
      return Response.json(saved, { headers: HEADERS })
    }
    const expected = revision(new URL(request.url).searchParams.get('revision'))
    if (expected === undefined) return failure(400, 'revision')
    const bytes = await store.read(expected, request.signal)
    return new Response(new Uint8Array(bytes), { headers: { ...HEADERS, 'content-type': 'image/webp' } })
  } catch (error) {
    if (error instanceof CoverError) return failure(STATUS[error.code], error.code)
    return failure(503, 'unavailable')
  }
}
