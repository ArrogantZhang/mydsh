/** Bounded upload consumption and metadata-stripping raster normalization. */
import sharp, { type Metadata, type OutputInfo } from 'sharp'
import { CoverError } from './errors.ts'
import type { CoverLimits } from './types.ts'

/** A normalized static WebP ready for immutable storage. */
export interface NormalizedCover {
  readonly data: Buffer
  readonly width: number
  readonly height: number
}

/**
 * Consume a body once, canceling its reader on refusal or caller cancellation.
 * @param body - owned request body.
 * @param maxBytes - complete upload byte budget.
 * @param signal - request/provider lifetime.
 * @returns bounded owned bytes.
 */
export async function readCoverBody(body: ReadableStream<Uint8Array>, maxBytes: number, signal: AbortSignal): Promise<Buffer> {
  signal.throwIfAborted()
  const reader = body.getReader()
  const chunks: Buffer[] = []
  let size = 0
  let finished = false
  let cancellation: Promise<void> | undefined
  const cancel = (): void => {
    // Cancellation preserves the original refusal even if the underlying HTTP body already failed.
    cancellation ??= reader.cancel(signal.reason).then(() => {}, () => {})
  }
  signal.addEventListener('abort', cancel, { once: true })
  try {
    while (true) {
      signal.throwIfAborted()
      const chunk = await reader.read()
      signal.throwIfAborted()
      if (chunk.done) { finished = true; break }
      size += chunk.value.byteLength
      if (size > maxBytes) throw new CoverError('too-large', 'Cover upload exceeds its byte limit.')
      chunks.push(Buffer.from(chunk.value))
    }
    return Buffer.concat(chunks, size)
  } finally {
    signal.removeEventListener('abort', cancel)
    if (!finished) cancel()
    await cancellation
    reader.releaseLock()
  }
}

/**
 * Validate a declared raster type and produce bounded, orientation-correct WebP bytes.
 * @param data - bounded source bytes.
 * @param mediaType - declared MIME type.
 * @param limits - normalization budgets.
 * @param signal - cancellation checked before and after bounded native processing.
 * @returns metadata-free normalized bytes and their exact dimensions.
 */
export async function normalizeCover(data: Buffer, mediaType: string, limits: CoverLimits, signal: AbortSignal): Promise<NormalizedCover> {
  signal.throwIfAborted()
  const formats: Readonly<Record<string, string>> = { 'image/png': 'png', 'image/jpeg': 'jpeg', 'image/webp': 'webp' }
  const expected = formats[mediaType]
  if (expected === undefined || data.length === 0) throw new CoverError('invalid-image', 'Only JPEG, PNG, and WebP covers are accepted.')
  let metadata: Metadata
  try {
    metadata = await sharp(data, { limitInputPixels: false, failOn: 'error' }).metadata()
  } catch {
    // Decoder diagnostics can contain binary data; the public error is intentionally format-neutral.
    throw new CoverError('invalid-image', 'The cover image could not be decoded.')
  }
  signal.throwIfAborted()
  if (metadata.format !== expected || metadata.width < 1 || metadata.height < 1 || (metadata.pages ?? 1) !== 1) {
    throw new CoverError('invalid-image', 'The cover must be a static image matching its declared type.')
  }
  if (metadata.width * metadata.height > limits.maxInputPixels) throw new CoverError('too-large', 'Cover image exceeds its pixel limit.')
  let output: { data: Buffer; info: OutputInfo }
  try {
    output = await sharp(data, { limitInputPixels: limits.maxInputPixels, failOn: 'error' })
      .rotate().resize({ width: limits.maxOutputDimension, height: limits.maxOutputDimension, fit: 'inside', withoutEnlargement: true })
      .webp().timeout({ seconds: limits.timeoutSeconds }).toBuffer({ resolveWithObject: true })
  } catch {
    // Invalid decoder input and native processing deadlines share one safe refusal.
    throw new CoverError('invalid-image', 'The cover image could not be normalized.')
  }
  signal.throwIfAborted()
  if (output.data.length > limits.maxOutputBytes) throw new CoverError('too-large', 'Normalized cover exceeds its byte limit.')
  return { data: output.data, width: output.info.width, height: output.info.height }
}
