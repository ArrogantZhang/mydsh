import { spawn as spawnChild, spawnSync } from 'node:child_process'
import { EventEmitter, once } from 'node:events'
import { PassThrough } from 'node:stream'
import { describe, expect, it } from 'vitest'
import {
  captureWorkerProcess,
  createWorkerProcessController,
  evaluateBenchmarkReports,
  parseWorkerReport,
  runBenchmarkCli,
  settleWorkerTeardown,
  type WebSocketDownlinkBenchmarkReport,
} from './websocket-downlink-benchmark.ts'

function report(
  compression: boolean,
  overrides: Record<string, number | boolean> = {},
): WebSocketDownlinkBenchmarkReport {
  return {
    compression,
    browsers: 5,
    downlinks: 10,
    muxFramesPerBrowser: 24_000,
    hostFramesPerBrowser: 256,
    serializedBytes: 10_000_000,
    transportBytes: compression ? 3_000_000 : 10_000_000,
    wallMs: 1_000,
    peakQueueFrames: 64,
    rssDeltaBytes: compression ? 32 * 1024 * 1024 : 8 * 1024 * 1024,
    webSocketMessages: compression ? 6_064 : 12_128,
    maxBatchFrames: 64,
    maxBatchBytes: 200_000,
    producerBurstFrames: 24,
    producerIntervalMs: 16,
    ...overrides,
  }
}

interface ScheduledCallback {
  callback: () => void
  milliseconds: number
  cancelled: boolean
}

class FakeChildProcess extends EventEmitter {
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly signals: NodeJS.Signals[] = []
  unrefs = 0
  acceptSignals = true

  kill(signal: NodeJS.Signals): boolean {
    this.signals.push(signal)
    return this.acceptSignals
  }

  unref(): void {
    this.unrefs++
  }
}

function manualSchedule(target: ScheduledCallback[]) {
  return (callback: () => void, milliseconds: number): (() => void) => {
    const item = { callback, milliseconds, cancelled: false }
    target.push(item)
    return () => { item.cancelled = true }
  }
}

function lifecycleController(
  mode: 'on' | 'off',
  terminate: (signal: NodeJS.Signals) => boolean,
): { controller: ReturnType<typeof createWorkerProcessController>; scheduled: ScheduledCallback[] } {
  const scheduled: ScheduledCallback[] = []
  const controller = createWorkerProcessController(mode, terminate, (callback, milliseconds) => {
    const item = { callback, milliseconds, cancelled: false }
    scheduled.push(item)
    return () => { item.cancelled = true }
  })
  return { controller, scheduled }
}

describe('WebSocket downlink benchmark report evaluation', () => {
  it('accepts reports that meet every benchmark threshold', () => {
    const plain = report(false)
    const compressed = report(true)

    expect(evaluateBenchmarkReports(plain, compressed)).toEqual({
      plain,
      compressed,
      byteReduction: 0.7,
      plainMessageReduction: 0.9,
      compressedMessageReduction: 0.95,
      compressionRssOverheadBytes: 24 * 1024 * 1024,
    })
  })

  it('rejects different serialized application byte counts', () => {
    expect(() => evaluateBenchmarkReports(
      report(false),
      report(true, { serializedBytes: 9_999_999 }),
    )).toThrow('serializedBytes mismatch: plain=10000000 compressed=9999999')
  })

  it.each([
    ['plain compression', report(false, { compression: true }), report(true), 'plain.compression actual=true expected=false'],
    ['compressed mode', report(false), report(true, { compression: false }), 'compressed.compression actual=false expected=true'],
    ['browser count', report(false, { browsers: 4 }), report(true), 'plain.browsers actual=4 expected=5'],
    ['downlink count', report(false), report(true, { downlinks: 9 }), 'compressed.downlinks actual=9 expected=10'],
    ['mux count', report(false, { muxFramesPerBrowser: 23_999 }), report(true), 'plain.muxFramesPerBrowser actual=23999 expected=24000'],
    ['host count', report(false), report(true, { hostFramesPerBrowser: 255 }), 'compressed.hostFramesPerBrowser actual=255 expected=256'],
    ['producer burst', report(false, { producerBurstFrames: 23 }), report(true), 'plain.producerBurstFrames actual=23 expected=24'],
    ['producer interval', report(false), report(true, { producerIntervalMs: 15 }), 'compressed.producerIntervalMs actual=15 expected=16'],
  ])('rejects a wrong %s', (_name, plain, compressed, message) => {
    expect(() => evaluateBenchmarkReports(plain, compressed)).toThrow(message)
  })

  it.each([
    ['serialized bytes', { serializedBytes: 0 }, 'plain.serializedBytes actual=0 threshold=>0'],
    ['transport bytes', { transportBytes: 0 }, 'plain.transportBytes actual=0 threshold=>0'],
  ])('rejects zero %s', (_name, overrides, message) => {
    expect(() => evaluateBenchmarkReports(report(false, overrides), report(true))).toThrow(message)
  })

  it('rejects zero compressed serialized and transport byte counts', () => {
    expect(() => evaluateBenchmarkReports(
      report(false),
      report(true, { serializedBytes: 0, transportBytes: 0 }),
    )).toThrow('compressed.serializedBytes actual=0 threshold=>0')
  })

  it('rejects zero compressed transport bytes independently', () => {
    expect(() => evaluateBenchmarkReports(
      report(false),
      report(true, { transportBytes: 0 }),
    )).toThrow('compressed.transportBytes actual=0 threshold=>0')
  })

  it('rejects less than sixty percent transport-byte reduction', () => {
    expect(() => evaluateBenchmarkReports(
      report(false),
      report(true, { transportBytes: 4_000_001 }),
    )).toThrow('byteReduction actual=0.5999999 threshold=>=0.6')
  })

  it('accepts large per-run RSS deltas with low compression overhead', () => {
    expect(evaluateBenchmarkReports(
      report(false, { rssDeltaBytes: 197 * 1024 * 1024 }),
      report(true, { rssDeltaBytes: 205 * 1024 * 1024 }),
    ).compressionRssOverheadBytes).toBe(8 * 1024 * 1024)
  })

  it('rejects compression RSS overhead above sixty-four MiB', () => {
    expect(() => evaluateBenchmarkReports(
      report(false, { rssDeltaBytes: 197 * 1024 * 1024 }),
      report(true, { rssDeltaBytes: 261 * 1024 * 1024 + 1 }),
    )).toThrow('compressionRssOverheadBytes actual=67108865 threshold=<=67108864')
  })

  it('clamps compression RSS overhead to zero', () => {
    expect(evaluateBenchmarkReports(
      report(false, { rssDeltaBytes: 205 * 1024 * 1024 }),
      report(true, { rssDeltaBytes: 197 * 1024 * 1024 }),
    ).compressionRssOverheadBytes).toBe(0)
  })

  it.each([
    ['plain', report(false, { peakQueueFrames: 4_097 }), report(true), 'plain.peakQueueFrames actual=4097 threshold=<=4096'],
    ['compressed', report(false), report(true, { peakQueueFrames: 4_097 }), 'compressed.peakQueueFrames actual=4097 threshold=<=4096'],
  ])('rejects a %s queue peak above capacity', (_name, plain, compressed, message) => {
    expect(() => evaluateBenchmarkReports(plain, compressed)).toThrow(message)
  })

  it.each([
    ['plain frame count', report(false, { maxBatchFrames: 65 }), report(true), 'plain.maxBatchFrames actual=65 threshold=<=64'],
    ['compressed frame count', report(false), report(true, { maxBatchFrames: 65 }), 'compressed.maxBatchFrames actual=65 threshold=<=64'],
    ['plain byte count', report(false, { maxBatchBytes: 262_145 }), report(true), 'plain.maxBatchBytes actual=262145 threshold=<=262144'],
    ['compressed byte count', report(false), report(true, { maxBatchBytes: 262_145 }), 'compressed.maxBatchBytes actual=262145 threshold=<=262144'],
  ])('rejects an above-limit %s', (_name, plain, compressed, message) => {
    expect(() => evaluateBenchmarkReports(plain, compressed)).toThrow(message)
  })

  it.each([
    ['plain frame maximum', report(false, { maxBatchFrames: 0 }), report(true), 'plain.maxBatchFrames actual=0 threshold=>0'],
    ['compressed frame maximum', report(false), report(true, { maxBatchFrames: 0 }), 'compressed.maxBatchFrames actual=0 threshold=>0'],
    ['plain byte maximum', report(false, { maxBatchBytes: 0 }), report(true), 'plain.maxBatchBytes actual=0 threshold=>0'],
    ['compressed byte maximum', report(false), report(true, { maxBatchBytes: 0 }), 'compressed.maxBatchBytes actual=0 threshold=>0'],
  ])('rejects a zero %s', (_name, plain, compressed, message) => {
    expect(() => evaluateBenchmarkReports(plain, compressed)).toThrow(message)
  })

  it.each([
    ['plain', report(false, { webSocketMessages: 12_129 }), report(true), 'plainMessageReduction actual=0.8999917546174142 threshold=>=0.9'],
    ['compressed', report(false), report(true, { webSocketMessages: 12_129 }), 'compressedMessageReduction actual=0.8999917546174142 threshold=>=0.9'],
  ])('rejects insufficient %s physical-message reduction', (_name, plain, compressed, message) => {
    expect(() => evaluateBenchmarkReports(plain, compressed)).toThrow(message)
  })

  it.each([
    ['plain', report(false, { webSocketMessages: 0 }), report(true), 'plain.webSocketMessages actual=0 threshold=>0'],
    ['compressed', report(false), report(true, { webSocketMessages: 0 }), 'compressed.webSocketMessages actual=0 threshold=>0'],
  ])('rejects a zero %s physical-message count', (_name, plain, compressed, message) => {
    expect(() => evaluateBenchmarkReports(plain, compressed)).toThrow(message)
  })
})

describe('WebSocket downlink benchmark CLI orchestration', () => {
  it('rejects every top-level argument before starting a worker', async () => {
    const modes: boolean[] = []

    await expect(runBenchmarkCli(['unexpected'], async (compression) => {
      modes.push(compression)
      return report(compression)
    })).rejects.toThrow('usage: websocket-downlink-benchmark.ts')
    expect(modes).toEqual([])
  })

  it('runs plain then compressed and returns the validated summary', async () => {
    const modes: boolean[] = []

    const summary = await runBenchmarkCli([], async (compression) => {
      modes.push(compression)
      return report(compression)
    })

    expect(modes).toEqual([false, true])
    expect(summary.compressionRssOverheadBytes).toBe(24 * 1024 * 1024)
  })

  it('retains validated plain metrics without copying a compressed failure payload', async () => {
    const plain = report(false)

    const failure = await runBenchmarkCli([], async (compression) => {
      if (!compression) return plain
      throw new Error('forbidden-payload-text')
    }).catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(`validated plain metrics=${JSON.stringify(plain)}`)
    expect((failure as Error).message).toContain('failure="Error"')
    expect((failure as Error).message).not.toContain('forbidden-payload-text')
  })

  it('includes both validated reports and RSS overhead in evaluator failures', async () => {
    const plain = report(false, { rssDeltaBytes: 197 * 1024 * 1024 })
    const compressed = report(true, { rssDeltaBytes: 261 * 1024 * 1024 + 1 })

    const failure = await runBenchmarkCli([], async compression => compression ? compressed : plain)
      .catch((error: unknown) => error)

    expect(failure).toBeInstanceOf(Error)
    expect((failure as Error).message).toContain(`plain=${JSON.stringify(plain)}`)
    expect((failure as Error).message).toContain(`compressed=${JSON.stringify(compressed)}`)
    expect((failure as Error).message).toContain('compressionRssOverheadBytes=67108865')
  })
})

describe('WebSocket downlink worker process control', () => {
  it.each(['stdout', 'stderr'] as const)('kills a worker whose %s exceeds the output cap', async (channel) => {
    const signals: NodeJS.Signals[] = []
    const { controller, scheduled } = lifecycleController('off', (signal) => {
      signals.push(signal)
      return true
    })
    const outcome = controller.result.catch((error: unknown) => error)

    controller.spawned()
    if (channel === 'stdout') controller.writeStdout(Buffer.alloc(64 * 1024 + 1))
    else controller.writeStderr(Buffer.alloc(64 * 1024 + 1))
    controller.close(null, 'SIGTERM')

    expect(await outcome).toMatchObject({
      message: `compression-off worker ${channel} bytes actual=>65536 threshold=<=65536`,
    })
    expect(signals).toEqual(['SIGTERM'])
    expect(scheduled).toMatchObject([{ milliseconds: 1_000, cancelled: true }])
  })

  it('kills a timed-out worker without waiting for the real deadline', async () => {
    const signals: NodeJS.Signals[] = []
    const { controller, scheduled } = lifecycleController('on', (signal) => {
      signals.push(signal)
      return true
    })
    const outcome = controller.result.catch((error: unknown) => error)

    controller.spawned()
    controller.timeout()
    controller.close(null, 'SIGTERM')

    expect(await outcome).toMatchObject({
      message: 'compression-on worker wallMs actual=>120000 threshold=<=120000',
    })
    expect(signals).toEqual(['SIGTERM'])
    expect(scheduled).toMatchObject([{ milliseconds: 1_000, cancelled: true }])
  })

  it('reports a child spawn error without copying its payload', async () => {
    const signals: NodeJS.Signals[] = []
    const { controller } = lifecycleController('off', (signal) => {
      signals.push(signal)
      return true
    })
    const outcome = controller.result.catch((error: unknown) => error)
    const error = Object.assign(new Error('forbidden-payload-text'), { code: 'ENOENT' })

    controller.processError(error)

    expect(await outcome).toMatchObject({ message: 'compression-off worker spawnError code=ENOENT' })
    expect(signals).toEqual([])
  })

  it('bounds termination when signals are rejected and close never arrives', async () => {
    const signals: NodeJS.Signals[] = []
    const { controller, scheduled } = lifecycleController('on', (signal) => {
      signals.push(signal)
      return false
    })
    const outcome = controller.result.catch((error: unknown) => error)

    controller.spawned()
    controller.timeout()
    expect(scheduled.map(item => item.milliseconds)).toEqual([1_000])
    scheduled[0]?.callback()
    expect(scheduled.map(item => item.milliseconds)).toEqual([1_000, 1_000])
    scheduled[1]?.callback()

    expect(await outcome).toMatchObject({
      message: 'compression-on worker wallMs actual=>120000 threshold=<=120000 '
        + 'termination actual=unclosed terminateAccepted=false forceAccepted=false',
    })
    expect(signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(scheduled.every(item => item.cancelled)).toBe(true)
  })

  it('distinguishes a running process error and waits for close', async () => {
    const signals: NodeJS.Signals[] = []
    const { controller, scheduled } = lifecycleController('off', (signal) => {
      signals.push(signal)
      return true
    })
    const outcome = controller.result.catch((error: unknown) => error)

    controller.spawned()
    controller.processError(Object.assign(new Error('forbidden-payload-text'), { code: 'EIO' }))
    controller.close(null, 'SIGTERM')

    const failure = await outcome as Error
    expect(failure.message).toBe('compression-off worker runtimeError code=EIO')
    expect(failure.message).not.toContain('forbidden-payload-text')
    expect(signals).toEqual(['SIGTERM'])
    expect(scheduled).toMatchObject([{ milliseconds: 1_000, cancelled: true }])
  })

  it('reports a nonzero exit using stderr size without copying stderr', async () => {
    const { controller } = lifecycleController('on', () => true)
    const outcome = controller.result.catch((error: unknown) => error)

    controller.spawned()
    controller.writeStderr(Buffer.from('forbidden-payload-text'))
    controller.close(2, null)

    const failure = await outcome as Error
    expect(failure.message).toContain('compression-on worker exitCode actual=2 expected=0 signal=null stderrBytes=22')
    expect(failure.message).not.toContain('forbidden-payload-text')
  })

  it('rejects unexpected stderr using only its byte count', async () => {
    const { controller } = lifecycleController('off', () => true)
    const outcome = controller.result.catch((error: unknown) => error)

    controller.spawned()
    controller.writeStderr(Buffer.from('forbidden-payload-text'))
    controller.close(0, null)

    const failure = await outcome as Error
    expect(failure.message).toBe('compression-off worker stderrBytes actual=22 expected=0')
    expect(failure.message).not.toContain('forbidden-payload-text')
  })

  it('returns bounded stdout for the existing exact parser', async () => {
    const expected = report(false)
    const signals: NodeJS.Signals[] = []
    const { controller, scheduled } = lifecycleController('off', (signal) => {
      signals.push(signal)
      return true
    })

    controller.spawned()
    controller.writeStdout(Buffer.from(`${JSON.stringify(expected)}\n`))
    controller.close(0, null)

    expect(parseWorkerReport(await controller.result, false)).toEqual(expected)
    expect(signals).toEqual([])
    expect(scheduled).toEqual([])
  })

  it('ignores duplicate events after normal close', async () => {
    const signals: NodeJS.Signals[] = []
    const { controller, scheduled } = lifecycleController('off', (signal) => {
      signals.push(signal)
      return true
    })
    const expected = report(false)

    controller.spawned()
    controller.writeStdout(Buffer.from(`${JSON.stringify(expected)}\n`))
    controller.close(0, null)
    controller.close(1, null)
    controller.processError(Object.assign(new Error('forbidden-payload-text'), { code: 'EIO' }))
    controller.timeout()

    expect(parseWorkerReport(await controller.result, false)).toEqual(expected)
    expect(signals).toEqual([])
    expect(scheduled).toEqual([])
  })
})

describe('WebSocket downlink child lifecycle', () => {
  it('cleans streams, listeners, timers, and handles after double-false termination without close', async () => {
    const child = new FakeChildProcess()
    child.acceptSignals = false
    const termination: ScheduledCallback[] = []
    const watchdog: ScheduledCallback[] = []
    const outcome = captureWorkerProcess('on', child, {
      scheduleTermination: manualSchedule(termination),
      scheduleWatchdog: manualSchedule(watchdog),
    }).catch((error: unknown) => error)

    child.emit('spawn')
    watchdog[0]?.callback()
    termination[0]?.callback()
    termination[1]?.callback()

    const failure = await outcome as Error
    expect(failure.message).toContain(
      'termination actual=unclosed terminateAccepted=false forceAccepted=false',
    )
    expect(child.signals).toEqual(['SIGTERM', 'SIGKILL'])
    expect(child.stdout.destroyed).toBe(true)
    expect(child.stderr.destroyed).toBe(true)
    expect(child.eventNames()).toEqual([])
    expect(child.unrefs).toBe(1)
    expect([...termination, ...watchdog].every(item => item.cancelled)).toBe(true)
  })

  it('observes repeated running-process errors until close and then cleans listeners', async () => {
    const child = new FakeChildProcess()
    const termination: ScheduledCallback[] = []
    const watchdog: ScheduledCallback[] = []
    const outcome = captureWorkerProcess('off', child, {
      scheduleTermination: manualSchedule(termination),
      scheduleWatchdog: manualSchedule(watchdog),
    }).catch((error: unknown) => error)

    child.emit('spawn')
    child.emit('error', Object.assign(new Error('forbidden-one'), { code: 'EIO' }))
    expect(() => {
      child.emit('error', Object.assign(new Error('forbidden-two'), { code: 'EAGAIN' }))
    }).not.toThrow()
    child.emit('close', null, 'SIGTERM')

    const failure = await outcome as Error
    expect(failure.message).toBe('compression-off worker runtimeError code=EIO')
    expect(failure.message).not.toContain('forbidden')
    expect(child.eventNames()).toEqual([])
    expect(child.unrefs).toBe(1)
    expect([...termination, ...watchdog].every(item => item.cancelled)).toBe(true)
  })

  it('force-kills a real long-lived child after the graceful signal is ignored', async () => {
    const child = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    const pid = child.pid
    const termination: ScheduledCallback[] = []
    const watchdog: ScheduledCallback[] = []
    const outcome = captureWorkerProcess('on', child, {
      terminate: signal => signal === 'SIGTERM' ? true : child.kill(signal),
      scheduleTermination: manualSchedule(termination),
      scheduleWatchdog: manualSchedule(watchdog),
    }).catch((error: unknown) => error)

    try {
      await once(child, 'spawn')
      watchdog[0]?.callback()
      termination[0]?.callback()

      expect(await outcome).toMatchObject({
        message: 'compression-on worker wallMs actual=>120000 threshold=<=120000',
      })
      expect(pid).toBeTypeOf('number')
      expect(() => { process.kill(pid as number, 0) }).toThrow()
    } finally {
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
  })
})

describe('WebSocket downlink worker teardown', () => {
  it('releases pre-start producers and settles their rejection before returning', async () => {
    let releaseStart!: () => void
    const start = new Promise<void>((resolve) => { releaseStart = resolve })
    let producerSettled = false
    const producer = start.then(() => { throw new Error('expected producer stop') })
      .finally(() => { producerSettled = true })
    const order: string[] = []

    await settleWorkerTeardown(
      () => {
        order.push('start')
        releaseStart()
      },
      () => { order.push('sources') },
      [producer],
      [async () => { order.push('resource') }],
    )

    expect(order.slice(0, 2)).toEqual(['start', 'sources'])
    expect(order).toContain('resource')
    expect(producerSettled).toBe(true)
  })

  it('settles producers before propagating a resource close failure', async () => {
    let producerSettled = false
    const producer = Promise.reject(new Error('expected producer stop'))
      .finally(() => { producerSettled = true })

    await expect(settleWorkerTeardown(
      () => {},
      () => {},
      [producer],
      [async () => { throw new Error('resource close failed') }],
    )).rejects.toThrow('resource close failed')
    expect(producerSettled).toBe(true)
  })

  it('observes listen and open failures from creation under strict rejection handling', () => {
    const benchmarkUrl = new URL('./websocket-downlink-benchmark.ts', import.meta.url).href
    const script = `
      import { observeOwnedPromise } from ${JSON.stringify(benchmarkUrl)}
      const listenFailure = observeOwnedPromise(Promise.reject(new Error('listen failed')))
      const openFailure = observeOwnedPromise(Promise.reject(new Error('open failed')))
      await new Promise(resolve => setImmediate(resolve))
      const results = await Promise.allSettled([listenFailure, openFailure])
      if (results.some(result => result.status !== 'rejected')) process.exitCode = 2
    `

    const result = spawnSync(process.execPath, [
      '--unhandled-rejections=strict',
      '--import', import.meta.resolve('tsx/esm'),
      '--input-type=module',
      '--eval', script,
    ], {
      cwd: process.cwd(),
      encoding: 'utf8',
      windowsHide: true,
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stderr).toBe('')
  })
})

describe('WebSocket downlink worker output parsing', () => {
  it('parses one report line with the expected mode', () => {
    const expected = report(true)
    expect(parseWorkerReport(`${JSON.stringify(expected)}\n`, true)).toEqual(expected)
  })

  it('rejects malformed JSON', () => {
    expect(() => parseWorkerReport('{not json}\n', false)).toThrow('worker stdout is not valid JSON')
  })

  it('rejects extra stdout', () => {
    const output = `${JSON.stringify(report(false))}\nunexpected log\n`
    expect(() => parseWorkerReport(output, false)).toThrow('worker stdout must contain exactly one JSON report line')
  })

  it.each([
    ['unexpected', { ...report(false), payload: 'forbidden' }],
    ['missing', (() => {
      const value = { ...report(false) }
      delete (value as Record<string, unknown>).producerIntervalMs
      return value
    })()],
  ])('rejects %s report fields', (_name, value) => {
    expect(() => parseWorkerReport(`${JSON.stringify(value)}\n`, false)).toThrow(
      'worker report fields actual=',
    )
  })

  it.each([
    ['webSocketMessages', -1],
    ['webSocketMessages', 1.5],
    ['maxBatchFrames', -1],
    ['maxBatchFrames', 1.5],
    ['maxBatchBytes', -1],
    ['maxBatchBytes', 1.5],
  ])('rejects a non-integer %s value of %s', (field, value) => {
    expect(() => parseWorkerReport(
      `${JSON.stringify(report(false, { [field]: value }))}\n`,
      false,
    )).toThrow(`worker.${field} actual=${String(value)} expected=nonnegative finite integer`)
  })
})
