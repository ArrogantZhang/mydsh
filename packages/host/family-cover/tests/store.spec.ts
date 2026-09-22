/** Shared covers retain the previous committed photo on every refused mutation. */
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import sharp from 'sharp'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as files from '../src/files.ts'
import { FamilyCoverStore } from '../src/store.ts'
import type { CoverLimits } from '../src/types.ts'

const LIMITS: CoverLimits = {
  maxInputBytes: 1_048_576, maxInputPixels: 100_000, maxOutputDimension: 32,
  maxOutputBytes: 100_000, maxConcurrentUploads: 2, timeoutSeconds: 5, lockWaitMs: 2_000,
}
const directories: string[] = []
const stores: FamilyCoverStore[] = []
const signal = (): AbortSignal => new AbortController().signal

async function fixture(limits: Partial<CoverLimits> = {}) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-family-cover-'))
  directories.push(root)
  const store = await FamilyCoverStore.open(root, { ...LIMITS, ...limits })
  stores.push(store)
  return { root, store }
}

function stream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream({ start(controller) { controller.enqueue(bytes); controller.close() } })
}

async function picture(width = 64, height = 40): Promise<Buffer> {
  return sharp({ create: { width, height, channels: 3, background: '#f0c8a0' } }).png().toBuffer()
}

afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(stores.splice(0).map(store => store.dispose()))
  await Promise.all(directories.splice(0).map(root => rm(root, { recursive: true, force: true })))
})

describe('family cover storage', () => {
  it('starts empty and shares the same normalized cover after reopening', async () => {
    const { root, store } = await fixture()
    const empty = await store.snapshot(signal())
    expect(empty.cover).toBeNull()
    const saved = await store.replace(empty.revision, 'image/png', stream(await picture()), signal())
    expect(saved.revision).not.toBe(empty.revision)
    expect(saved.cover).toMatchObject({ width: 32, height: 20, mediaType: 'image/webp' })
    const bytes = await store.read(saved.revision, signal())
    expect((await sharp(bytes).metadata()).format).toBe('webp')
    const reopened = await FamilyCoverStore.open(root, LIMITS)
    stores.push(reopened)
    expect(await reopened.snapshot(signal())).toEqual(saved)
    expect(await reopened.read(saved.revision, signal())).toEqual(bytes)
    expect(JSON.stringify(saved)).not.toContain(root)
  })

  it('rejects stale replacements across independent store instances', async () => {
    const { root, store } = await fixture()
    const another = await FamilyCoverStore.open(root, LIMITS)
    stores.push(another)
    const empty = await store.snapshot(signal())
    const input = await picture()
    const results = await Promise.allSettled([
      store.replace(empty.revision, 'image/png', stream(input), signal()),
      another.replace(empty.revision, 'image/png', stream(input), signal()),
    ])
    expect(results.filter(result => result.status === 'fulfilled')).toHaveLength(1)
    expect(results.find(result => result.status === 'rejected')).toMatchObject({ reason: { code: 'conflict' } })
    expect(await another.snapshot(signal())).toEqual(await store.snapshot(signal()))
  })

  it('removes the shared photo without resetting the revision or touching unrelated files', async () => {
    const { root, store } = await fixture()
    const before = await store.snapshot(signal())
    const saved = await store.replace(before.revision, 'image/png', stream(await picture()), signal())
    await writeFile(join(root, 'keep.txt'), 'not a cover')
    await expect(store.remove(before.revision, signal())).rejects.toMatchObject({ code: 'conflict' })
    const removed = await store.remove(saved.revision, signal())
    expect(removed.cover).toBeNull()
    expect(removed.revision).not.toBe(before.revision)
    expect(removed.revision).not.toBe(saved.revision)
    await expect(store.read(removed.revision, signal())).rejects.toMatchObject({ code: 'not-found' })
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('not a cover')
    expect((await readdir(root)).filter(name => name.endsWith('.webp'))).toEqual([])
  })

  it.each(['text/html', 'image/svg+xml', 'image/gif'])('rejects unsupported media %s without changing the cover', async (media) => {
    const { store } = await fixture()
    const before = await store.snapshot(signal())
    await expect(store.replace(before.revision, media, stream(await picture()), signal())).rejects.toMatchObject({ code: 'invalid-image' })
    expect(await store.snapshot(signal())).toEqual(before)
  })

  it('rejects corrupt bytes and MIME spoofing without publication', async () => {
    const { store } = await fixture()
    const before = await store.snapshot(signal())
    await expect(store.replace(before.revision, 'image/png', stream(Buffer.from('invalid')), signal())).rejects.toMatchObject({ code: 'invalid-image' })
    await expect(store.replace(before.revision, 'image/jpeg', stream(await picture()), signal())).rejects.toMatchObject({ code: 'invalid-image' })
    expect(await store.snapshot(signal())).toEqual(before)
  })

  it('bounds streamed bytes and decoded pixels', async () => {
    const { store } = await fixture({ maxInputBytes: 100 })
    const before = await store.snapshot(signal())
    await expect(store.replace(before.revision, 'image/png', stream(Buffer.alloc(101)), signal())).rejects.toMatchObject({ code: 'too-large' })
    const other = await fixture({ maxInputPixels: 100 })
    const empty = await other.store.snapshot(signal())
    await expect(other.store.replace(empty.revision, 'image/png', stream(await picture()), signal())).rejects.toMatchObject({ code: 'too-large' })
  })

  it('refuses excess work and cancels a pending stream to quiescence on disposal', async () => {
    const { store } = await fixture({ maxConcurrentUploads: 1 })
    const before = await store.snapshot(signal())
    let started!: () => void
    const reading = new Promise<void>((resolve) => { started = resolve })
    let cancelled = false
    const pending = new ReadableStream<Uint8Array>({ pull() { started() }, cancel() { cancelled = true } })
    const upload = store.replace(before.revision, 'image/png', pending, signal())
    const rejected = expect(upload).rejects.toMatchObject({ code: 'unavailable' })
    await reading
    await expect(store.replace(before.revision, 'image/png', stream(await picture()), signal())).rejects.toMatchObject({ code: 'busy' })
    await store.dispose()
    await rejected
    expect(cancelled).toBe(true)
    await expect(store.snapshot(signal())).rejects.toMatchObject({ code: 'unavailable' })
  })

  it('preserves the committed photo when a caller aborts', async () => {
    const { store } = await fixture()
    const before = await store.snapshot(signal())
    const saved = await store.replace(before.revision, 'image/png', stream(await picture()), signal())
    const controller = new AbortController()
    controller.abort(new Error('caller cancelled'))
    await expect(store.replace(saved.revision, 'image/png', stream(await picture()), controller.signal)).rejects.toThrow('caller cancelled')
    expect(await store.snapshot(signal())).toEqual(saved)
  })

  it('rejects corrupt durable metadata rather than treating it as an empty store', async () => {
    const { root, store } = await fixture()
    await writeFile(join(root, 'cover.json'), '{broken')
    await expect(store.snapshot(signal())).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('rejects persisted image sizes above the configured read budget before allocation', async () => {
    const { root, store } = await fixture()
    await writeFile(join(root, 'cover.json'), JSON.stringify({
      version: 1, revision: 'b657754d-76b3-4a73-91e5-9c310c6c5fa5',
      image: { digest: 'a'.repeat(64), width: 10, height: 10, bytes: LIMITS.maxOutputBytes + 1, mediaType: 'image/webp' },
    }))
    await expect(store.snapshot(signal())).rejects.toMatchObject({ code: 'corrupt' })
  })

  it('cleans an unpublished blob after metadata publication fails and retains the previous photo', async () => {
    const { root, store } = await fixture()
    const before = await store.snapshot(signal())
    const saved = await store.replace(before.revision, 'image/png', stream(await picture()), signal())
    const previousFiles = await readdir(root)
    const publish = files.publishCoverFile
    vi.spyOn(files, 'publishCoverFile').mockImplementation(async (path, bytes) => {
      if (path.endsWith('cover.json')) throw new Error('simulated disk refusal')
      await publish(path, bytes)
    })
    await expect(store.replace(saved.revision, 'image/png', stream(await picture(8, 8)), signal())).rejects.toThrow('simulated disk refusal')
    expect(await store.snapshot(signal())).toEqual(saved)
    expect(await readdir(root)).toEqual(previousFiles)
  })
})
