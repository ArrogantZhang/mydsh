/** Shared cover transport and browser-owned object URL lifecycle. */
import type { CoverRevision, CoverSnapshot } from '@deepseek-ai/dsh-family-cover/types'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'

/** Authorized transport and browser URL allocator, owned by the plugin runtime. */
export interface CoverIO {
  /** @param signal - request cancellation. @returns current shared metadata. */
  current(signal: AbortSignal): Promise<CoverSnapshot>
  /** @param revision - last observed version. @param signal - cancellation. @returns committed empty metadata. */
  remove(revision: CoverRevision, signal: AbortSignal): Promise<CoverSnapshot>
  /** @param url - same-origin cover route. @param init - authenticated request. @returns HTTP response. */
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** @param blob - normalized cover bytes. @returns owned object URL. */
  createUrl(blob: Blob): string
  /** @param url - previously allocated URL. */
  revokeUrl(url: string): void
}

/** Stable localized failure category, without arbitrary Host diagnostics. */
export type CoverFailureReason = 'auth' | 'conflict' | 'too-large' | 'invalid-image' | 'busy' | 'unavailable'

/** Transport refusal whose reason can be localized in the family settings. */
export class CoverFailure extends Error {
  /** @param reason - safe refusal category. */
  constructor(readonly reason: CoverFailureReason) { super(reason); this.name = 'CoverFailure' }
}

/** Display facts derived from the latest shared-cover read. */
export interface CoverClientSnapshot {
  readonly cover?: CoverSnapshot
  readonly url?: string
  readonly busy: boolean
  readonly error?: CoverFailureReason
}

function checkResponse(response: Response): void {
  if (response.ok) return
  const reasons: Record<number, CoverFailureReason> = { 401: 'auth', 403: 'auth', 409: 'conflict', 413: 'too-large', 415: 'invalid-image', 429: 'busy' }
  throw new CoverFailure(reasons[response.status] ?? 'unavailable')
}

/** Cancelable shared-cover reads and writes; no bytes enter Session or attachment APIs. */
export class CoverClient {
  private readonly state = createSnapshotStore<CoverClientSnapshot>({ busy: false })
  private controller: AbortController | undefined
  private readonly pending = new Set<Promise<void>>()
  private disposed = false
  private mutating = false

  /** @param io - authorized transport and URL allocation. */
  constructor(private readonly io: CoverIO) {}
  /** Read observed cover facts. @returns stable metadata and the current browser URL. */
  getSnapshot = (): CoverClientSnapshot => this.state.getSnapshot()
  /**
   * Observe cover changes.
   * @param listener - invalidation callback.
   * @returns subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  /** Refresh the shared cover. @returns after adoption; failures are published for the UI. */
  refresh(): Promise<void> {
    if (this.mutating) return Promise.resolve()
    return this.run(false, async (signal) => { await this.load(signal) })
  }

  /** Cancel pending work and immediately release any displayed private bytes. */
  clear(): void {
    this.controller?.abort()
    this.mutating = false
    this.replace({ busy: false })
  }

  /**
   * Replace the shared cover using the last observed revision.
   * @param file - user-selected static raster; name and EXIF never enter preferences.
   * @returns after refreshing shared state, including after an uncertain write outcome.
   */
  upload(file: File): Promise<void> {
    return this.mutate(async (revision, signal) => {
      const response = await this.io.fetch('/api/family-cover/upload', { method: 'POST', body: file, signal,
        credentials: 'same-origin', cache: 'no-store', headers: { 'content-type': file.type, 'if-match': revision } })
      checkResponse(response)
      await response.body?.cancel()
    })
  }

  /** Remove the shared cover. @returns after revision-checked deletion and a fresh read. */
  remove(): Promise<void> {
    return this.mutate(async (revision, signal) => { await this.io.remove(revision, signal) })
  }

  /** Withdraw private bytes and join all owned transport work. */
  async dispose(): Promise<void> {
    this.disposed = true
    this.clear()
    await Promise.allSettled([...this.pending])
  }

  private mutate(operation: (revision: CoverRevision, signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.mutating) return Promise.resolve()
    return this.run(true, async (signal) => {
      let failure: CoverFailure | undefined
      try {
        const snapshot = this.state.getSnapshot().cover
        if (snapshot === undefined) throw new CoverFailure('unavailable')
        signal.throwIfAborted()
        await operation(snapshot.revision, signal)
      } catch (error) { failure = error instanceof CoverFailure ? error : new CoverFailure('unavailable') }
      signal.throwIfAborted()
      // A failed response can follow a committed write; always reconcile before reporting it.
      await this.load(signal)
      if (failure !== undefined) throw failure
    })
  }

  private run(mutation: boolean, operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.disposed) return Promise.resolve()
    this.controller?.abort()
    const controller = new AbortController()
    this.controller = controller
    this.mutating = mutation
    const { error: _error, ...previous } = this.state.getSnapshot()
    this.state.set({ ...previous, busy: true })
    const promise = operation(controller.signal).catch((error: unknown) => {
      if (controller.signal.aborted) return
      const reason = error instanceof CoverFailure ? error.reason : 'unavailable'
      this.replace({ ...(reason === 'auth' ? {} : this.state.getSnapshot()), busy: false, error: reason })
    }).finally(() => {
      if (controller !== this.controller || controller.signal.aborted) return
      this.mutating = false
      this.state.set({ ...this.state.getSnapshot(), busy: false })
    })
    this.pending.add(promise)
    void promise.then(() => { this.pending.delete(promise) })
    return promise
  }

  private async load(signal: AbortSignal): Promise<void> {
    let cover: CoverSnapshot
    try { cover = await this.io.current(signal) } catch (error) {
      // Remote carrier failures may hide HTTP status, so an unconfirmed read cannot retain private bytes.
      if (!signal.aborted) this.replace({ busy: true })
      throw error
    }
    signal.throwIfAborted()
    if (cover.cover === null) { this.replace({ cover, busy: true }); return }
    const response = await this.io.fetch(`/api/family-cover/image?revision=${encodeURIComponent(cover.revision)}`,
      { signal, credentials: 'same-origin', cache: 'no-store' })
    checkResponse(response)
    if (response.headers.get('content-type') !== 'image/webp') throw new CoverFailure('unavailable')
    const bytes = await response.blob()
    signal.throwIfAborted()
    const url = this.io.createUrl(bytes)
    this.replace({ cover, url, busy: true })
  }

  private replace(next: CoverClientSnapshot): void {
    const previous = this.state.getSnapshot().url
    this.state.set(next)
    if (previous !== undefined && previous !== next.url) this.io.revokeUrl(previous)
  }
}
