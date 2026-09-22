/** Async browser cover adoption owns URLs and ignores obsolete completions. */
import { expect, it, vi } from 'vitest'
import type { CoverRevision, CoverSnapshot } from '@deepseek-ai/dsh-family-cover/types'
import { CoverClient, type CoverIO } from '../src/client/cover-client.ts'

const empty: CoverSnapshot = { revision: '0' as CoverRevision, cover: null }
const photo: CoverSnapshot = { revision: 'b657754d-76b3-4a73-91e5-9c310c6c5fa5' as CoverRevision,
  cover: { width: 12, height: 8, bytes: 12, mediaType: 'image/webp' } }
function bench(override: Partial<CoverIO> = {}) {
  const revoked: string[] = []
  let id = 0
  const io: CoverIO = { current: async () => photo, remove: async () => empty,
    fetch: async () => new Response(new Uint8Array(12), { headers: { 'content-type': 'image/webp' } }),
    createUrl: () => `blob:cover-${++id}`, revokeUrl: (url) => { revoked.push(url) }, ...override }
  return { client: new CoverClient(io), revoked, io }
}

it('loads shared bytes, replaces owned object URLs, and clears them when disabled', async () => {
  const { client, revoked } = bench()
  await client.refresh()
  expect(client.getSnapshot().url).toBe('blob:cover-1')
  await client.refresh()
  expect(revoked).toEqual(['blob:cover-1'])
  client.clear()
  expect(client.getSnapshot().url).toBeUndefined()
  expect(revoked).toEqual(['blob:cover-1', 'blob:cover-2'])
  await client.dispose()
})

it('ignores a stale response after clearing and joins it on disposal', async () => {
  let release!: (snapshot: CoverSnapshot) => void
  const pending = new Promise<CoverSnapshot>((resolve) => { release = resolve })
  const fetch = vi.fn<CoverIO['fetch']>()
  const { client } = bench({ current: () => pending, fetch })
  const refresh = client.refresh()
  client.clear()
  release(photo)
  await refresh
  expect(client.getSnapshot().url).toBeUndefined()
  expect(fetch).not.toHaveBeenCalled()
  await client.dispose()
})

it('refreshes a conflicted mutation and reports the conflict without losing the shared photo', async () => {
  const { client } = bench({ fetch: async (_url, init) => init?.method === 'POST'
    ? Response.json({ reason: 'conflict' }, { status: 409 })
    : new Response(new Uint8Array(12), { headers: { 'content-type': 'image/webp' } }) })
  await client.refresh()
  await client.upload(new File(['photo'], 'private-name.png', { type: 'image/png' }))
  expect(client.getSnapshot().error).toBe('conflict')
  expect(client.getSnapshot().url).toBeDefined()
  expect(client.getSnapshot().busy).toBe(false)
  await client.dispose()
})

it('removes stale displayed bytes on authentication loss', async () => {
  let authorized = true
  const { client, revoked } = bench({ fetch: async () => authorized
    ? new Response(new Uint8Array(12), { headers: { 'content-type': 'image/webp' } }) : new Response('', { status: 401 }) })
  await client.refresh()
  authorized = false
  await client.refresh()
  expect(client.getSnapshot().url).toBeUndefined()
  expect(client.getSnapshot().error).toBe('auth')
  expect(revoked).toEqual(['blob:cover-1'])
  await client.dispose()
})

it('clears private bytes when an opaque metadata failure cannot confirm authorization', async () => {
  let available = true
  const { client, revoked } = bench({ current: async () => {
    if (!available) throw new Error('opaque carrier failure')
    return photo
  } })
  await client.refresh()
  available = false
  await client.refresh()
  expect(client.getSnapshot().url).toBeUndefined()
  expect(client.getSnapshot().error).toBe('unavailable')
  expect(revoked).toEqual(['blob:cover-1'])
  await client.dispose()
})

it('does not mutate a cover whose revision has not been displayed', async () => {
  const { client, io } = bench()
  const send = vi.spyOn(io, 'fetch')
  await client.upload(new File(['photo'], 'family.png', { type: 'image/png' }))
  expect(send.mock.calls.some(([, init]) => init?.method === 'POST')).toBe(false)
  expect(client.getSnapshot().cover).toEqual(photo)
  expect(client.getSnapshot().error).toBe('unavailable')
  await client.dispose()
})
