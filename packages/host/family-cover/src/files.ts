/** Private bounded file reads and flushed same-directory publication. */
import { randomUUID } from 'node:crypto'
import { constants } from 'node:fs'
import { lstat, open, rename, unlink } from 'node:fs/promises'
import { dirname } from 'node:path'
import { CoverError } from './errors.ts'

/**
 * Classify an absent filesystem target.
 * @param error - filesystem rejection.
 * @returns whether its target is absent.
 */
export function missing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT'
}

/**
 * Read a regular single-link file without following a final symbolic link.
 * @param filename - store-owned path.
 * @param limit - maximum complete file bytes.
 * @returns owned bytes, or undefined only when the path is absent.
 */
export async function readPrivateFile(filename: string, limit: number): Promise<Buffer | undefined> {
  let info
  try { info = await lstat(filename) } catch (error) { if (missing(error)) return undefined; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > limit) throw new CoverError('corrupt', 'Cover storage contains an unsafe or oversized file.')
  const handle = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const opened = await handle.stat()
    if (!opened.isFile() || opened.nlink !== 1 || opened.size > limit || opened.dev !== info.dev || opened.ino !== info.ino) {
      throw new CoverError('corrupt', 'Cover storage changed during its read.')
    }
    const buffer = Buffer.alloc(opened.size + 1)
    let offset = 0
    while (offset < buffer.length) {
      const { bytesRead } = await handle.read(buffer, offset, buffer.length - offset, offset)
      if (bytesRead === 0) break
      offset += bytesRead
    }
    if (offset !== opened.size) throw new CoverError('corrupt', 'Cover file length changed during its read.')
    return buffer.subarray(0, offset)
  } finally { await handle.close() }
}

/**
 * Flush and atomically publish a private file. POSIX also flushes its parent directory.
 * @param filename - destination below the already-created private store root.
 * @param bytes - complete next content.
 * @returns after publication and applicable filesystem flushes complete.
 */
export async function publishCoverFile(filename: string, bytes: Uint8Array): Promise<void> {
  const temporary = `${filename}.${randomUUID()}.tmp`
  let published = false
  const handle = await open(temporary, 'wx', 0o600)
  try {
    try { await handle.writeFile(bytes); await handle.sync() } finally { await handle.close() }
    await rename(temporary, filename)
    published = true
    // Windows cannot open a directory for fsync through node:fs; file bytes were flushed above.
    if (process.platform !== 'win32') {
      const directory = await open(dirname(filename), 'r')
      try { await directory.sync() } finally { await directory.close() }
    }
  } finally {
    if (!published) {
      try { await unlink(temporary) } catch (error) { if (!missing(error)) throw error }
    }
  }
}

/**
 * Unlink one store-owned obsolete blob without touching an aliased target.
 * @param filename - path derived only from a validated content digest.
 */
export async function removeCoverFile(filename: string): Promise<void> {
  let info
  try { info = await lstat(filename) } catch (error) { if (missing(error)) return; throw error }
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) throw new CoverError('corrupt', 'An obsolete cover file is not owned regular storage.')
  await unlink(filename)
}
