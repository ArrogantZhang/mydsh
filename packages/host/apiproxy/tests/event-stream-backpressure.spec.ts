import { describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry from '@deepseek-ai/dsh-agent'
import type { Agent, AgentStatus } from '@deepseek-ai/dsh-agent'
import SessionStore, { SessionId } from '@deepseek-ai/dsh-session'
import { createApiProxy, default as ApiProxyService } from '@deepseek-ai/dsh-host-apiproxy'
import type { HostFrame, MuxFrame } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { RpcRequest } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import { RpcId } from '@deepseek-ai/dsh-host-apiproxy/api/rpc'
import Storage from '@deepseek-ai/dsh-storage'
import { DomainFacility } from '@deepseek-ai/dsh-storage-domain'
import UserQuestionService from '@deepseek-ai/dsh-user-questions'
import WorkspaceRegistry from '@deepseek-ai/dsh-workspace'
import { FrameQueueOverflowError } from '../src/frame-queue.ts'
import { MemoryStorageBackend } from '../../../storage/storage-domain/tests/helpers/memory-backend.ts'

/** Count live Cordis listeners for one event without replacing the real dispatcher. */
function listenerCount(ctx: Context, event: string): number {
  return ctx.events._hooks[event]?.length ?? 0
}

/** Drain a stream until abort or failure, retaining every delivered frame. */
async function drain<F>(
  stream: AsyncIterable<RpcRequest<F>>,
  frames: F[],
): Promise<unknown> {
  try {
    for await (const envelope of stream) frames.push(envelope.payload)
  } catch (error) {
    return error
  }
}

/** Compose the real Session and Agent event producers used by mux. */
async function muxHarness(): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionStore)
  await ctx.plugin(UserQuestionService)
  await ctx.plugin(AgentRegistry)
  return ctx
}

/** Compose the service path with real Host registries and inert unrelated dependencies. */
async function serviceHarness(): Promise<{ ctx: Context; api: ApiProxyService }> {
  const ctx = await muxHarness()
  await ctx.plugin(Storage)
  ctx.storage.backend.register('memory', new MemoryStorageBackend())
  const storageDomain = new DomainFacility(ctx, { backend: 'memory', routes: {} })
  ctx.storage.mount('domain', storageDomain)
  ctx.provide('storageDomain', storageDomain)
  ctx.provide('sessionPersistence', { list: () => Promise.resolve([]) } as never)
  await ctx.plugin(WorkspaceRegistry)

  ctx.provide('agentDefaultModel', {
    currentSelection: () => ({ provider: 'p', model: 'm' }),
    saveSelection: () => Promise.resolve(),
  } as never)
  for (const name of ['attachments', 'directoryPicker', 'llm', 'sessionQuery', 'subagents', 'tools']) {
    ctx.provide(name, {})
  }
  await ctx.plugin(ApiProxyService, { maxEventStreamQueueFrames: 1 })
  return { ctx, api: ctx.apiProxy as ApiProxyService }
}

describe('ApiProxy event stream backpressure', () => {
  it('contains mux overflow, disposes its listener, and leaves an independently consumed stream usable', async () => {
    const ctx = await muxHarness()
    const api = createApiProxy(ctx, {
      defaultModelSelection: () => ({ provider: 'p', model: 'm' }),
      cwd: '/tmp',
      maxEventStreamQueueFrames: 1,
    })
    const baselineListeners = listenerCount(ctx, 'session/event')
    const failed = api.events.mux({ rpcId: RpcId('failed-mux'), payload: {} }, new AbortController().signal)
      [Symbol.asyncIterator]()
    const firstFailedFrame = failed.next()
    const healthyAbort = new AbortController()
    const healthyFrames: MuxFrame[] = []
    const healthyDone = drain(
      api.events.mux({ rpcId: RpcId('healthy-mux'), payload: {} }, healthyAbort.signal),
      healthyFrames,
    )
    expect(listenerCount(ctx, 'session/event')).toBe(baselineListeners + 2)

    const session = ctx.sessions.create()
    await expect(firstFailedFrame).resolves.toMatchObject({
      done: false,
      value: { payload: { type: 'session/subscribed', sessionId: session.id } },
    })
    await vi.waitFor(() => {
      expect(healthyFrames.some(frame => frame.type === 'session/subscribed')).toBe(true)
    })

    session.append('turn/start', { turn: 1 })
    await vi.waitFor(() => {
      expect(healthyFrames.some(frame => frame.type === 'session/event' && frame.event.type === 'turn/start')).toBe(true)
    })
    expect(() => session.append('step/start', { turn: 1, step: 1 })).not.toThrow()

    await expect(failed.next()).rejects.toEqual(new FrameQueueOverflowError(1))
    expect(listenerCount(ctx, 'session/event')).toBe(baselineListeners + 1)

    expect(() => session.append('step/end', { turn: 1, step: 1 })).not.toThrow()
    await vi.waitFor(() => {
      expect(healthyFrames.some(frame => frame.type === 'session/event' && frame.event.type === 'step/end')).toBe(true)
    })
    healthyAbort.abort()
    await expect(healthyDone).resolves.toBeUndefined()
    expect(listenerCount(ctx, 'session/event')).toBe(baselineListeners)
  })

  it('forwards the service Config bound to host queues and contains producer overflow', async () => {
    const { ctx, api } = await serviceHarness()
    const baselineListeners = listenerCount(ctx, 'agent/status')
    const failed = api.events.host({ rpcId: RpcId('failed-host'), payload: {} }, new AbortController().signal)
      [Symbol.asyncIterator]()
    const firstFailedFrame = failed.next()
    const healthyAbort = new AbortController()
    const healthyFrames: HostFrame[] = []
    const healthyDone = drain(
      api.events.host({ rpcId: RpcId('healthy-host'), payload: {} }, healthyAbort.signal),
      healthyFrames,
    )
    expect(listenerCount(ctx, 'agent/status')).toBe(baselineListeners + 2)

    const agent = { id: SessionId('host-overflow') } as Agent
    const emitStatus = (status: AgentStatus): void => {
      ctx.emit('agent/status', { agent, status })
    }
    expect(() => { emitStatus('running') }).not.toThrow()
    await expect(firstFailedFrame).resolves.toMatchObject({
      done: false,
      value: { payload: { type: 'host/session-status', sessionId: agent.id, running: true } },
    })
    await vi.waitFor(() => { expect(healthyFrames).toHaveLength(1) })

    expect(() => { emitStatus('idle') }).not.toThrow()
    await vi.waitFor(() => { expect(healthyFrames).toHaveLength(2) })
    expect(() => { emitStatus('running') }).not.toThrow()

    await expect(failed.next()).rejects.toEqual(new FrameQueueOverflowError(1))
    expect(listenerCount(ctx, 'agent/status')).toBe(baselineListeners + 1)

    expect(() => { emitStatus('idle') }).not.toThrow()
    await vi.waitFor(() => { expect(healthyFrames).toHaveLength(4) })
    healthyAbort.abort()
    await expect(healthyDone).resolves.toBeUndefined()
    expect(listenerCount(ctx, 'agent/status')).toBe(baselineListeners)
  })
})
