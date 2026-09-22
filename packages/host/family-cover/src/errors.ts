/** Stable cover failures shared by storage and authenticated transport. */

/** Caller-visible failure categories; filesystem details stay on the Host. */
export type CoverErrorCode = 'invalid-image' | 'too-large' | 'conflict' | 'not-found' | 'busy' | 'unavailable' | 'corrupt'

/** An expected cover-operation refusal. */
export class CoverError extends Error {
  /** @param code - stable refusal category. @param message - safe diagnostic without private paths. */
  constructor(readonly code: CoverErrorCode, message: string) {
    super(message)
    this.name = 'CoverError'
  }
}
