/** Revision-checked shared-cover persistence independent of Session attachments. */
import { createHash, randomUUID } from 'node:crypto'
import { lstat, mkdir, realpath, readdir } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'
import { brandString } from '@deepseek-ai/dsh-brand'
import { z } from 'zod'
import { CoverError } from './errors.ts'
import { publishCoverFile, readPrivateFile, removeCoverFile } from './files.ts'
import { normalizeCover, readCoverBody } from './image.ts'
import type { CoverLimits, CoverRevision, CoverSnapshot } from './types.ts'

const METADATA_BYTES = 4096
const DIGEST = /^[0-9a-f]{64}$/
const MetadataSchema = z.object({
  version: z.literal(1),
  revision: z.uuid(),
  image: z.object({
    digest: z.string().regex(DIGEST),
    width: z.number().int().positive(), height: z.number().int().positive(),
    bytes: z.number().int().positive(), mediaType: z.literal('image/webp'),
  }).strict().nullable(),
}).strict()
type Metadata = z.infer<typeof MetadataSchema>

/** Private image storage with bounded intake, cross-process CAS, and joined disposal. */
export class FamilyCoverStore {
  private readonly lifetime = new AbortController()
  private readonly pending = new Set<Promise<unknown>>()
  private mutations = 0
  private readonly metadataPath: string

  private constructor(private readonly root: string, private readonly limits: CoverLimits) {
    this.metadataPath = join(root, 'cover.json')
  }

  /**
   * Open or create a dedicated private store directory, rejecting a symlinked root.
   * @param root - absolute configured directory.
   * @param limits - resolved processing and coordination budgets.
   * @returns one independent service lifetime over the shared directory.
   */
  static async open(root: string, limits: CoverLimits): Promise<FamilyCoverStore> {
    if (!isAbsolute(root)) throw new Error('family-cover: root must be an absolute path.')
    await mkdir(root, { recursive: true, mode: 0o700 })
    const stat = await lstat(root)
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new CoverError('corrupt', 'Cover root must be a real directory.')
    const store = new FamilyCoverStore(await realpath(root), limits)
    await store.metadata()
    return store
  }

  /**
   * Read the current shared metadata.
   * @param signal - caller cancellation.
   * @returns current metadata, never image bytes or Host paths.
   */
  snapshot(signal: AbortSignal): Promise<CoverSnapshot> {
    return this.run(signal, false, async (current) => {
      const metadata = await this.metadata()
      current.throwIfAborted()
      return this.project(metadata)
    })
  }

  /**
   * Admit and normalize one body, then compare its revision inside the writer lock.
   * @param expected - last observed revision.
   * @param mediaType - declared raster MIME type.
   * @param body - body consumed only after admission; the caller cancels refused, unconsumed bodies.
   * @param signal - caller cancellation, honored before the atomic commit begins.
   * @returns committed metadata.
   */
  replace(expected: CoverRevision, mediaType: string, body: ReadableStream<Uint8Array>, signal: AbortSignal): Promise<CoverSnapshot> {
    return this.run(signal, true, async (current) => {
      if (!['image/jpeg', 'image/png', 'image/webp'].includes(mediaType)) throw new CoverError('invalid-image', 'Only JPEG, PNG, and WebP covers are accepted.')
      const input = await readCoverBody(body, this.limits.maxInputBytes, current)
      const normalized = await normalizeCover(input, mediaType, this.limits, current)
      return this.lock(async () => {
        const previous = await this.metadata()
        this.assertRevision(previous, expected)
        current.throwIfAborted()
        const digest = createHash('sha256').update(normalized.data).digest('hex')
        const next: Metadata = {
          version: 1, revision: randomUUID(),
          image: { digest, width: normalized.width, height: normalized.height, bytes: normalized.data.length, mediaType: 'image/webp' },
        }
        try {
          await publishCoverFile(join(this.root, `${digest}.webp`), normalized.data)
          current.throwIfAborted()
          await publishCoverFile(this.metadataPath, Buffer.from(JSON.stringify(next) + '\n'))
        } finally {
          // A flush can fail after rename; only the durable pointer determines which blob stays.
          const committed = await this.metadata()
          await this.cleanObsolete(committed?.image?.digest ?? null)
        }
        return this.project(next)
      })
    })
  }

  /**
   * Read the exact current revision while coordinating against replacement/removal.
   * @param expected - metadata revision whose bytes the caller requested.
   * @param signal - caller cancellation.
   * @returns owned, digest-verified normalized bytes.
   */
  read(expected: CoverRevision, signal: AbortSignal): Promise<Uint8Array> {
    return this.run(signal, false, current => this.lock(async () => {
      const metadata = await this.metadata()
      this.assertRevision(metadata, expected)
      if (metadata?.image === undefined || metadata.image === null) throw new CoverError('not-found', 'No shared cover is configured.')
      const { image } = metadata
      const bytes = await readPrivateFile(join(this.root, `${image.digest}.webp`), image.bytes)
      current.throwIfAborted()
      if (bytes === undefined || bytes.length !== image.bytes || createHash('sha256').update(bytes).digest('hex') !== image.digest) {
        throw new CoverError('corrupt', 'Stored cover bytes do not match their metadata.')
      }
      return new Uint8Array(bytes)
    }))
  }

  /**
   * Publish a revisioned empty state before cleaning only this store's image files.
   * @param expected - last observed revision.
   * @param signal - caller cancellation before publication.
   * @returns the shared empty state.
   */
  remove(expected: CoverRevision, signal: AbortSignal): Promise<CoverSnapshot> {
    return this.run(signal, true, current => this.lock(async () => {
      const previous = await this.metadata()
      this.assertRevision(previous, expected)
      current.throwIfAborted()
      const next: Metadata = { version: 1, revision: randomUUID(), image: null }
      await publishCoverFile(this.metadataPath, Buffer.from(JSON.stringify(next) + '\n'))
      await this.cleanObsolete(null)
      return this.project(next)
    }))
  }

  /** Cancel intake and join already-started reads, native processing, and commits. */
  async dispose(): Promise<void> {
    this.lifetime.abort(new CoverError('unavailable', 'The shared cover service is stopping.'))
    await Promise.allSettled([...this.pending])
  }

  private async run<T>(signal: AbortSignal, mutation: boolean, operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.lifetime.signal.throwIfAborted()
    signal.throwIfAborted()
    if (mutation && this.mutations >= this.limits.maxConcurrentUploads) throw new CoverError('busy', 'Shared cover processing is busy.')
    if (mutation) this.mutations++
    const result = operation(AbortSignal.any([signal, this.lifetime.signal]))
    this.pending.add(result)
    const settle = (): void => { this.pending.delete(result); if (mutation) this.mutations-- }
    void result.then(settle, settle)
    return result
  }

  private lock<T>(operation: () => Promise<T>): Promise<T> {
    return withFileLock(this.metadataPath, operation, { waitMs: this.limits.lockWaitMs })
  }

  private async metadata(): Promise<Metadata | null> {
    const bytes = await readPrivateFile(this.metadataPath, METADATA_BYTES)
    if (bytes === undefined) return null
    let value: unknown
    try { value = JSON.parse(bytes.toString('utf8')) } catch { throw new CoverError('corrupt', 'Cover metadata is not valid JSON.') }
    const parsed = MetadataSchema.safeParse(value)
    if (!parsed.success) throw new CoverError('corrupt', 'Cover metadata has an unsupported format.')
    if (parsed.data.image !== null && parsed.data.image.bytes > this.limits.maxOutputBytes) {
      throw new CoverError('corrupt', 'Stored cover exceeds the configured read budget.')
    }
    return parsed.data
  }

  private project(metadata: Metadata | null): CoverSnapshot {
    const image = metadata?.image
    return {
      revision: brandString<CoverRevision>(metadata?.revision ?? '0'),
      cover: image === undefined || image === null ? null : {
        width: image.width, height: image.height, bytes: image.bytes, mediaType: image.mediaType,
      },
    }
  }

  private assertRevision(metadata: Metadata | null, expected: CoverRevision): void {
    if ((metadata?.revision ?? '0') !== expected) throw new CoverError('conflict', 'Another member changed the shared cover; refresh before retrying.')
  }

  private async cleanObsolete(currentDigest: string | null): Promise<void> {
    for (const name of await readdir(this.root)) {
      if (/^[0-9a-f]{64}\.webp$/.test(name) && name !== `${currentDigest}.webp`) await removeCoverFile(join(this.root, name))
    }
  }
}
