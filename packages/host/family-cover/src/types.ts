/** Browser-safe shared-cover values and resolved processing limits. */
import type { Branded } from '@deepseek-ai/dsh-brand'
import type {} from '@deepseek-ai/dsh-typert-protocol'
import type { CoverErrorCode } from './errors.ts'

declare module '@deepseek-ai/dsh-typert-protocol' {
  interface RemoteErrorDetailsMap {
    /** Classified shared-cover refusal; private paths and original bytes stay on the Host. */
    'family-cover/failed': { readonly reason: CoverErrorCode }
  }
}

/** Opaque compare-and-swap token for a committed cover record. */
export type CoverRevision = Branded<'FamilyCoverRevision'>

/** Shared image metadata, excluding its storage path and original filename. */
export interface CoverImage {
  readonly width: number
  readonly height: number
  readonly bytes: number
  readonly mediaType: 'image/webp'
}

/** The shared cover, or a revisioned empty state after removal. */
export interface CoverSnapshot {
  readonly revision: CoverRevision
  readonly cover: CoverImage | null
}

/** Deployment-resolved admission, normalization, and writer-lock budgets. */
export interface CoverLimits {
  /** Maximum streamed source bytes before normalization. */
  readonly maxInputBytes: number
  /** Maximum decoded width multiplied by height. */
  readonly maxInputPixels: number
  /** Maximum normalized image long edge; smaller sources are not enlarged. */
  readonly maxOutputDimension: number
  /** Maximum complete normalized image bytes stored or read. */
  readonly maxOutputBytes: number
  /** Maximum admitted mutations per provider lifetime. */
  readonly maxConcurrentUploads: number
  /** Native image-processing deadline in seconds. */
  readonly timeoutSeconds: number
  /** Maximum milliseconds waiting for the shared writer lock. */
  readonly lockWaitMs: number
}
