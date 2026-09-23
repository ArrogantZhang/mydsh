/** Tab-owned original-file downloads through the authenticated complete-byte reader. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { pathPartsOf } from '@deepseek-ai/dsh-util-workspace-path'
import type { ReadDocumentBytes, SessionFile } from './rpc.ts'

/** Browser handoff status; a started download does not confirm that the user saved it. */
export type DocumentDownload =
  | { readonly phase: 'reading' | 'started' }
  | { readonly phase: 'failed'; readonly failure?: RemoteFailure }

type TabDownloads = Readonly<Partial<Record<TabId, DocumentDownload>>>

/** Tab ids are Session-local; the owning Session separates concurrent preview surfaces. */
export type DocumentDownloads = Readonly<Partial<Record<SessionId, TabDownloads>>>

type Save = (bytes: Uint8Array<ArrayBuffer>, filename: string) => () => void

/**
 * Hand unchanged bytes to the browser as a file, never as executable page content.
 * @param bytes - complete original file bytes.
 * @param filename - basename suggested to the browser download manager.
 * @returns the disposer for the retained object URL.
 */
export function saveDocument(bytes: Uint8Array<ArrayBuffer>, filename: string): () => void {
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }))
  const release = (): void => { URL.revokeObjectURL(url) }
  const anchor = document.createElement('a')
  anchor.href = url
  anchor.download = filename
  try { anchor.click() } catch (error) { release(); throw error }
  return release
}

/** One pending read and at most one retained download URL per live preview tab. */
export class DocumentDownloadController {
  private readonly state = createSnapshotStore<DocumentDownloads>({})
  private readonly jobs = new Map<string, { done: Promise<void>; cancel: () => void }>()
  private readonly pending = new Set<Promise<void>>()
  private disposed = false

  /** @param read - bounded, authenticated original-byte reader. @param save - browser handoff and URL disposer. */
  constructor(private readonly read: ReadDocumentBytes, private readonly save: Save = saveDocument) {}

  /** Read download feedback. @returns a stable snapshot until a download changes. */
  getSnapshot = (): DocumentDownloads => this.state.getSnapshot()
  /** Observe download feedback. @param listener - invalidation callback. @returns subscription disposer. */
  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  /**
   * Read current original bytes without changing the preview or its renderer.
   * @param owner - Session whose layout owns the tab; independent of the addressed file's Session.
   * @param id - owning preview tab.
   * @param file - Session and path carried by the tab's resource address.
   * @param signal - tab lifetime; closing the tab cancels reads and releases its URL.
   * @returns after handoff, refusal, or cancellation; repeated pending gestures share the operation.
   */
  download(owner: SessionId, id: TabId, file: SessionFile, signal: AbortSignal): Promise<void> {
    if (this.disposed || signal.aborted) return Promise.resolve()
    const key = JSON.stringify([owner, id])
    const previous = this.jobs.get(key)
    if (previous !== undefined && this.getSnapshot()[owner]?.[id]?.phase === 'reading') return previous.done
    previous?.cancel()
    const abort = new AbortController()
    let release: (() => void) | undefined
    const cancel = (): void => {
      abort.abort()
      release?.(); release = undefined
      signal.removeEventListener('abort', cancel)
      this.jobs.delete(key)
      this.publish(owner, id)
    }
    signal.addEventListener('abort', cancel, { once: true })
    const done = Promise.resolve().then(async () => {
      abort.signal.throwIfAborted()
      const result = await this.read(file, abort.signal)
      abort.signal.throwIfAborted()
      if (!result.ok) { this.publish(owner, id, { phase: 'failed', failure: result.error }); return }
      release = this.save(result.value.data, pathPartsOf(result.value.absolutePath).name)
      if (abort.signal.aborted) { release(); release = undefined; return }
      this.publish(owner, id, { phase: 'started' })
    }).catch(() => {
      // Transport and browser handoff exceptions have no stable file error code.
      if (!abort.signal.aborted) this.publish(owner, id, { phase: 'failed' })
    })
    this.jobs.set(key, { done, cancel })
    this.pending.add(done)
    void done.then(() => { this.pending.delete(done) })
    this.publish(owner, id, { phase: 'reading' })
    return done
  }

  /** Cancel and join reads, then release all browser-held file URLs. */
  async dispose(): Promise<void> {
    this.disposed = true
    const jobs = [...this.jobs.values()]
    for (const job of jobs) job.cancel()
    await Promise.allSettled([...this.pending])
  }

  private publish(owner: SessionId, id: TabId, value?: DocumentDownload): void {
    const { [owner]: current = {}, ...others } = this.getSnapshot()
    const { [id]: _removed, ...tabs } = current
    const next = value === undefined ? tabs : { ...tabs, [id]: value }
    this.state.set(Object.keys(next).length === 0 ? others : { ...others, [owner]: next })
  }
}
