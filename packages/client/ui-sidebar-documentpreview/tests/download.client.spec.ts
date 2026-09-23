// @vitest-environment jsdom
/** Original-byte downloads preserve filenames and remain owned by their preview tabs. */
import { Blob as NodeBlob } from 'node:buffer'
import { afterEach, expect, it, onTestFinished, vi } from 'vitest'
import type { TabId } from '@deepseek-ai/dsh-client-ui-dockkit'
import { RemoteError } from '@deepseek-ai/dsh-client-test-runtime'
import { DocumentDownloadController, saveDocument } from '../src/client/download.ts'
import type { ReadDocumentBytes } from '../src/client/rpc.ts'
import { FILE, TAB_ID, SESSION } from './fixtures.client.ts'

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals() })

const original = { ok: true as const, value: {
  absolutePath: '/workspace/报表.xlsx', version: 'current', offset: 0,
  data: new Uint8Array([80, 75, 0, 255]), bytes: 4, eof: true,
} }

function fixture() {
  const read = vi.fn<ReadDocumentBytes>().mockResolvedValue(original)
  const release = vi.fn()
  const save = vi.fn(() => release)
  const controller = new DocumentDownloadController(read, save)
  const lifetime = new AbortController()
  onTestFinished(() => controller.dispose())
  return { read, save, release, controller, lifetime }
}

it('reads complete original bytes only on a gesture, preserving the Chinese basename', async () => {
  const f = fixture()
  const changed = vi.fn()
  const unsubscribe = f.controller.subscribe(changed)
  onTestFinished(unsubscribe)
  expect(f.read).not.toHaveBeenCalled()
  const done = f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  expect(f.controller.getSnapshot()[SESSION]?.[TAB_ID]).toEqual({ phase: 'reading' })
  expect(f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)).toBe(done)
  await done
  expect(f.read).toHaveBeenCalledExactlyOnceWith(FILE, expect.any(AbortSignal))
  expect(f.save).toHaveBeenCalledExactlyOnceWith(original.value.data, '报表.xlsx')
  expect(f.controller.getSnapshot()[SESSION]?.[TAB_ID]).toEqual({ phase: 'started' })
  expect(changed).toHaveBeenCalledTimes(2)
  expect(f.release).not.toHaveBeenCalled()
  f.lifetime.abort()
  expect(f.release).toHaveBeenCalledTimes(1)
  expect(f.controller.getSnapshot()).toEqual({})
})

it('keeps equal tab ids in different Session occurrences independent', async () => {
  const f = fixture()
  const second = new AbortController()
  const otherSession = 's-2' as typeof SESSION
  await Promise.all([
    f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal),
    f.controller.download(otherSession, TAB_ID, FILE, second.signal),
  ])
  expect(f.read).toHaveBeenCalledTimes(2)
  f.lifetime.abort()
  expect(f.release).toHaveBeenCalledTimes(1)
  expect(f.controller.getSnapshot()[otherSession]?.[TAB_ID]?.phase).toBe('started')
})

it('preserves Host failures and allows a fresh attempt without starting a partial download', async () => {
  const f = fixture()
  const error = new RemoteError('workspace-file/too-large', 'File exceeds limit', { path: FILE.path, limit: 3 })
  f.read.mockResolvedValueOnce({ ok: false, error })
  await f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  expect(f.save).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot()[SESSION]?.[TAB_ID]).toEqual({ phase: 'failed', failure: error })
  await f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  expect(f.save).toHaveBeenCalledTimes(1)
  expect(f.controller.getSnapshot()[SESSION]?.[TAB_ID]?.phase).toBe('started')
})

it.each(['read', 'save'] as const)('reports an unexpected %s refusal without an unhandled rejection', async (operation) => {
  const f = fixture()
  if (operation === 'read') f.read.mockRejectedValueOnce(new Error('disconnected'))
  else f.save.mockImplementationOnce(() => { throw new Error('save refused') })
  await f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  expect(f.controller.getSnapshot()[SESSION]?.[TAB_ID]).toEqual({ phase: 'failed' })
})

it('does not read after the tab ended or after plugin disposal', async () => {
  const f = fixture()
  f.lifetime.abort()
  await f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  await f.controller.dispose()
  await f.controller.download(SESSION, TAB_ID, FILE, new AbortController().signal)
  expect(f.read).not.toHaveBeenCalled()
})

it.each(['tab', 'plugin'] as const)('joins a pending read after %s disposal and ignores its late result', async (owner) => {
  const f = fixture()
  const pending = Promise.withResolvers<Awaited<ReturnType<ReadDocumentBytes>>>()
  f.read.mockReturnValueOnce(pending.promise)
  onTestFinished(() => { pending.resolve(original) })
  const done = f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  await Promise.resolve()
  const signal = f.read.mock.lastCall![1]
  if (owner === 'tab') f.lifetime.abort()
  let settled = false
  const disposed = f.controller.dispose().then(() => { settled = true })
  await Promise.resolve()
  await Promise.resolve()
  try {
    expect(signal.aborted).toBe(true)
    expect(settled).toBe(false)
  } finally {
    pending.resolve(original)
    await Promise.all([done, disposed])
  }
  expect(f.save).not.toHaveBeenCalled()
  expect(f.controller.getSnapshot()).toEqual({})
})

it('cancels before the deferred read starts', async () => {
  const f = fixture()
  const done = f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  f.lifetime.abort()
  await done
  expect(f.read).not.toHaveBeenCalled()
})

it('releases the previous URL on a new gesture and the current one on disposal', async () => {
  const f = fixture()
  await f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  await f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal)
  expect(f.release).toHaveBeenCalledTimes(1)
  await f.controller.dispose()
  expect(f.release).toHaveBeenCalledTimes(2)
})

it('keeps simultaneous tabs independent and releases a handoff that closes its tab', async () => {
  const f = fixture()
  const other = 'tab-2' as TabId
  const second = new AbortController()
  f.save.mockImplementationOnce(() => { f.lifetime.abort(); return f.release })
  await Promise.all([
    f.controller.download(SESSION, TAB_ID, FILE, f.lifetime.signal),
    f.controller.download(SESSION, other, { ...FILE, path: '另一份.docx' }, second.signal),
  ])
  expect(f.read.mock.calls.map(call => call[0].path)).toEqual([FILE.path, '另一份.docx'])
  expect(f.controller.getSnapshot()[SESSION]?.[TAB_ID]).toBeUndefined()
  expect(f.controller.getSnapshot()[SESSION]?.[other]?.phase).toBe('started')
  expect(f.release).toHaveBeenCalledTimes(1)
})

it('hands unchanged binary bytes to a download anchor and releases its URL explicitly', async () => {
  vi.stubGlobal('Blob', NodeBlob)
  const create = vi.fn<(blob: Blob) => string>(() => 'blob:original')
  const revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = create; static override revokeObjectURL = revoke })
  const click = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    expect(this.download).toBe('报表.xlsx')
    expect(this.href).toBe('blob:original')
  })
  const release = saveDocument(original.value.data, '报表.xlsx')
  expect(click).toHaveBeenCalledOnce()
  const blob = create.mock.calls[0]![0] as NodeBlob
  expect(blob.type).toBe('application/octet-stream')
  expect(new Uint8Array(await blob.arrayBuffer())).toEqual(original.value.data)
  expect(revoke).not.toHaveBeenCalled()
  release()
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:original')
})

it('releases the object URL when the browser handoff throws', () => {
  const revoke = vi.fn()
  vi.stubGlobal('URL', class extends URL { static override createObjectURL = () => 'blob:failed'; static override revokeObjectURL = revoke })
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => { throw new Error('blocked') })
  expect(() => saveDocument(original.value.data, 'file.pdf')).toThrow('blocked')
  expect(revoke).toHaveBeenCalledExactlyOnceWith('blob:failed')
})
