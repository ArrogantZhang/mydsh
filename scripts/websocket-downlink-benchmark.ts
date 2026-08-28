import { spawn } from 'node:child_process'
import { resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const EXPECTED_BROWSERS = 5
const EXPECTED_DOWNLINKS = 10
const EXPECTED_MUX_FRAMES_PER_BROWSER = 24_000
const EXPECTED_HOST_FRAMES_PER_BROWSER = 256
const EXPECTED_PRODUCER_BURST_FRAMES = 24
const EXPECTED_PRODUCER_INTERVAL_MS = 16
const EXPECTED_APPLICATION_FRAMES = EXPECTED_BROWSERS
  * (EXPECTED_MUX_FRAMES_PER_BROWSER + EXPECTED_HOST_FRAMES_PER_BROWSER)
const MAX_QUEUE_FRAMES = 4_096
const MAX_BATCH_FRAMES = 64
const MAX_BATCH_BYTES = 262_144
const MIN_MESSAGE_REDUCTION = 0.90
const MIN_BYTE_REDUCTION = 0.60
const MAX_COMPRESSION_RSS_OVERHEAD_BYTES = 64 * 1024 * 1024
const MAX_WORKER_OUTPUT_BYTES = 64 * 1024
const MAX_FAILURE_DETAIL_BYTES = 4 * 1024
const WORKER_TIMEOUT_MS = 120_000

const REPORT_FIELDS = [
  'browsers',
  'compression',
  'downlinks',
  'hostFramesPerBrowser',
  'maxBatchBytes',
  'maxBatchFrames',
  'muxFramesPerBrowser',
  'peakQueueFrames',
  'producerBurstFrames',
  'producerIntervalMs',
  'rssDeltaBytes',
  'serializedBytes',
  'transportBytes',
  'wallMs',
  'webSocketMessages',
] as const

/** Metrics emitted by one fresh-process WebSocket downlink benchmark run. */
export interface WebSocketDownlinkBenchmarkReport {
  compression: boolean
  browsers: 5
  downlinks: 10
  muxFramesPerBrowser: 24_000
  hostFramesPerBrowser: 256
  serializedBytes: number
  transportBytes: number
  wallMs: number
  peakQueueFrames: number
  rssDeltaBytes: number
  webSocketMessages: number
  maxBatchFrames: number
  maxBatchBytes: number
  producerBurstFrames: 24
  producerIntervalMs: 16
}

/** Reports and cross-mode byte reduction printed by a successful benchmark. */
export interface WebSocketDownlinkBenchmarkSummary {
  plain: WebSocketDownlinkBenchmarkReport
  compressed: WebSocketDownlinkBenchmarkReport
  byteReduction: number
  plainMessageReduction: number
  compressedMessageReduction: number
  compressionRssOverheadBytes: number
}

function reportRecord(value: unknown): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`worker report actual=${JSON.stringify(value)} expected=JSON object`)
  }
  return value as Record<string, unknown>
}

function validateFields(report: Record<string, unknown>): void {
  const actual = Object.keys(report).sort()
  const expected = [...REPORT_FIELDS]
  if (actual.length !== expected.length || actual.some((field, index) => field !== expected[index])) {
    throw new Error(`worker report fields actual=${JSON.stringify(actual)} expected=${JSON.stringify(expected)}`)
  }
}

function validateBoolean(
  report: Record<string, unknown>,
  label: string,
  field: 'compression',
): boolean {
  const actual = report[field]
  if (typeof actual !== 'boolean') {
    throw new Error(`${label}.${field} actual=${JSON.stringify(actual)} expected=boolean`)
  }
  return actual
}

function validateNumber(
  report: Record<string, unknown>,
  label: string,
  field: Exclude<(typeof REPORT_FIELDS)[number], 'compression'>,
  integer: boolean,
): number {
  const actual = report[field]
  if (typeof actual !== 'number' || !Number.isFinite(actual) || actual < 0 || (integer && !Number.isInteger(actual))) {
    const expected = integer ? 'nonnegative finite integer' : 'nonnegative finite number'
    throw new Error(`${label}.${field} actual=${JSON.stringify(actual)} expected=${expected}`)
  }
  return actual
}

function expectedValue(label: string, field: string, actual: unknown, expected: unknown): void {
  if (actual !== expected) {
    throw new Error(`${label}.${field} actual=${String(actual)} expected=${String(expected)}`)
  }
}

function validateReport(
  value: unknown,
  label: string,
  expectedCompression: boolean,
): WebSocketDownlinkBenchmarkReport {
  const report = reportRecord(value)
  validateFields(report)
  expectedValue(label, 'compression', validateBoolean(report, label, 'compression'), expectedCompression)
  expectedValue(label, 'browsers', validateNumber(report, label, 'browsers', true), EXPECTED_BROWSERS)
  expectedValue(label, 'downlinks', validateNumber(report, label, 'downlinks', true), EXPECTED_DOWNLINKS)
  expectedValue(
    label,
    'muxFramesPerBrowser',
    validateNumber(report, label, 'muxFramesPerBrowser', true),
    EXPECTED_MUX_FRAMES_PER_BROWSER,
  )
  expectedValue(
    label,
    'hostFramesPerBrowser',
    validateNumber(report, label, 'hostFramesPerBrowser', true),
    EXPECTED_HOST_FRAMES_PER_BROWSER,
  )
  expectedValue(
    label,
    'producerBurstFrames',
    validateNumber(report, label, 'producerBurstFrames', true),
    EXPECTED_PRODUCER_BURST_FRAMES,
  )
  expectedValue(
    label,
    'producerIntervalMs',
    validateNumber(report, label, 'producerIntervalMs', true),
    EXPECTED_PRODUCER_INTERVAL_MS,
  )
  validateNumber(report, label, 'serializedBytes', true)
  validateNumber(report, label, 'transportBytes', true)
  validateNumber(report, label, 'wallMs', false)
  validateNumber(report, label, 'peakQueueFrames', true)
  validateNumber(report, label, 'rssDeltaBytes', true)
  validateNumber(report, label, 'webSocketMessages', true)
  validateNumber(report, label, 'maxBatchFrames', true)
  validateNumber(report, label, 'maxBatchBytes', true)
  return report as unknown as WebSocketDownlinkBenchmarkReport
}

function requirePositive(label: string, field: string, actual: number): void {
  if (actual <= 0) throw new Error(`${label}.${field} actual=${String(actual)} threshold=>0`)
}

function requireAtMost(label: string, field: string, actual: number, threshold: number): void {
  if (actual > threshold) {
    throw new Error(`${label}.${field} actual=${String(actual)} threshold=<=${String(threshold)}`)
  }
}

/**
 * Parse and validate one worker's stdout record.
 * @param stdout - Complete bounded stdout captured from the worker.
 * @param expectedCompression - Compression mode requested from the worker.
 * @returns The exact benchmark report emitted by that worker.
 */
export function parseWorkerReport(
  stdout: string,
  expectedCompression: boolean,
): WebSocketDownlinkBenchmarkReport {
  const lines = stdout.split(/\r?\n/)
  if (lines.at(-1) === '') lines.pop()
  if (lines.length !== 1 || lines[0] === '') {
    throw new Error('worker stdout must contain exactly one JSON report line')
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(lines[0] as string)
  } catch {
    throw new Error('worker stdout is not valid JSON')
  }
  return validateReport(parsed, 'worker', expectedCompression)
}

/**
 * Enforce the reproducible workload and compression resource thresholds.
 * @param plainValue - Report from the compression-disabled worker.
 * @param compressedValue - Report from the compression-enabled worker.
 * @returns The reports and computed transport-byte reduction.
 */
export function evaluateBenchmarkReports(
  plainValue: WebSocketDownlinkBenchmarkReport,
  compressedValue: WebSocketDownlinkBenchmarkReport,
): WebSocketDownlinkBenchmarkSummary {
  const plain = validateReport(plainValue, 'plain', false)
  const compressed = validateReport(compressedValue, 'compressed', true)
  requirePositive('plain', 'serializedBytes', plain.serializedBytes)
  requirePositive('compressed', 'serializedBytes', compressed.serializedBytes)
  requirePositive('plain', 'transportBytes', plain.transportBytes)
  requirePositive('compressed', 'transportBytes', compressed.transportBytes)
  requirePositive('plain', 'webSocketMessages', plain.webSocketMessages)
  requirePositive('compressed', 'webSocketMessages', compressed.webSocketMessages)
  if (plain.serializedBytes !== compressed.serializedBytes) {
    throw new Error(
      `serializedBytes mismatch: plain=${String(plain.serializedBytes)} compressed=${String(compressed.serializedBytes)}`,
    )
  }
  requireAtMost('plain', 'peakQueueFrames', plain.peakQueueFrames, MAX_QUEUE_FRAMES)
  requireAtMost('compressed', 'peakQueueFrames', compressed.peakQueueFrames, MAX_QUEUE_FRAMES)
  requireAtMost('plain', 'maxBatchFrames', plain.maxBatchFrames, MAX_BATCH_FRAMES)
  requireAtMost('compressed', 'maxBatchFrames', compressed.maxBatchFrames, MAX_BATCH_FRAMES)
  requireAtMost('plain', 'maxBatchBytes', plain.maxBatchBytes, MAX_BATCH_BYTES)
  requireAtMost('compressed', 'maxBatchBytes', compressed.maxBatchBytes, MAX_BATCH_BYTES)
  const compressionRssOverheadBytes = Math.max(0, compressed.rssDeltaBytes - plain.rssDeltaBytes)
  if (compressionRssOverheadBytes > MAX_COMPRESSION_RSS_OVERHEAD_BYTES) {
    throw new Error(
      `compressionRssOverheadBytes actual=${String(compressionRssOverheadBytes)} `
      + `threshold=<=${String(MAX_COMPRESSION_RSS_OVERHEAD_BYTES)}`,
    )
  }
  const byteReduction = 1 - compressed.transportBytes / plain.transportBytes
  if (byteReduction < MIN_BYTE_REDUCTION) {
    throw new Error(`byteReduction actual=${String(byteReduction)} threshold=>=${String(MIN_BYTE_REDUCTION)}`)
  }
  const plainMessageReduction = 1 - plain.webSocketMessages / EXPECTED_APPLICATION_FRAMES
  if (plainMessageReduction < MIN_MESSAGE_REDUCTION) {
    throw new Error(
      `plainMessageReduction actual=${String(plainMessageReduction)} `
      + `threshold=>=${String(MIN_MESSAGE_REDUCTION)}`,
    )
  }
  const compressedMessageReduction = 1 - compressed.webSocketMessages / EXPECTED_APPLICATION_FRAMES
  if (compressedMessageReduction < MIN_MESSAGE_REDUCTION) {
    throw new Error(
      `compressedMessageReduction actual=${String(compressedMessageReduction)} `
      + `threshold=>=${String(MIN_MESSAGE_REDUCTION)}`,
    )
  }
  return {
    plain,
    compressed,
    byteReduction,
    plainMessageReduction,
    compressedMessageReduction,
    compressionRssOverheadBytes,
  }
}

function childEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(process.env).filter(([name]) =>
    !/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name)))
}

async function runWorker(compression: boolean): Promise<WebSocketDownlinkBenchmarkReport> {
  const worker = fileURLToPath(new URL('./websocket-downlink-benchmark-worker.ts', import.meta.url))
  const mode = compression ? 'on' : 'off'
  const child = spawn(process.execPath, [
    '--import',
    import.meta.resolve('tsx/esm'),
    worker,
    `--compression=${mode}`,
  ], {
    cwd: process.cwd(),
    env: childEnvironment(),
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  let stdout = ''
  let stderr = ''
  let outputFailure: Error | undefined
  const append = (current: string, chunk: Buffer, channel: 'stdout' | 'stderr'): string => {
    const next = current + chunk.toString('utf8')
    if (Buffer.byteLength(next, 'utf8') > MAX_WORKER_OUTPUT_BYTES && outputFailure === undefined) {
      outputFailure = new Error(
        `compression-${mode} worker ${channel} bytes actual=>${String(MAX_WORKER_OUTPUT_BYTES)} `
        + `threshold=<=${String(MAX_WORKER_OUTPUT_BYTES)}`,
      )
      child.kill()
    }
    return next
  }
  child.stdout.on('data', (chunk: Buffer) => { stdout = append(stdout, chunk, 'stdout') })
  child.stderr.on('data', (chunk: Buffer) => { stderr = append(stderr, chunk, 'stderr') })
  const timeout = setTimeout(() => {
    outputFailure ??= new Error(
      `compression-${mode} worker wallMs actual=>${String(WORKER_TIMEOUT_MS)} `
      + `threshold=<=${String(WORKER_TIMEOUT_MS)}`,
    )
    child.kill()
  }, WORKER_TIMEOUT_MS)
  const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolveExit, reject) => {
    child.once('error', reject)
    child.once('close', (code, signal) => { resolveExit({ code, signal }) })
  }).finally(() => { clearTimeout(timeout) })
  if (outputFailure !== undefined) throw outputFailure
  if (exit.code !== 0) {
    throw new Error(
      `compression-${mode} worker exitCode actual=${String(exit.code)} expected=0 `
      + `signal=${String(exit.signal)} stderr=${JSON.stringify(stderr.trim())}`,
    )
  }
  if (stderr !== '') {
    throw new Error(`compression-${mode} worker stderr actual=${JSON.stringify(stderr)} expected=""`)
  }
  return parseWorkerReport(stdout, compression)
}

async function main(): Promise<void> {
  const plain = await runWorker(false)
  let compressed: WebSocketDownlinkBenchmarkReport
  try {
    compressed = await runWorker(true)
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error)
    const boundedDetail = Buffer.from(detail, 'utf8').subarray(0, MAX_FAILURE_DETAIL_BYTES).toString('utf8')
    throw new Error(
      `compressed benchmark failed after validated plain metrics=${JSON.stringify(plain)} `
      + `failure=${JSON.stringify(boundedDetail)}`,
    )
  }
  let summary: WebSocketDownlinkBenchmarkSummary
  try {
    summary = evaluateBenchmarkReports(plain, compressed)
  } catch (error) {
    const compressionRssOverheadBytes = Math.max(0, compressed.rssDeltaBytes - plain.rssDeltaBytes)
    const detail = error instanceof Error ? error.message : String(error)
    const boundedDetail = Buffer.from(detail, 'utf8').subarray(0, MAX_FAILURE_DETAIL_BYTES).toString('utf8')
    throw new Error(
      `benchmark evaluation failed plain=${JSON.stringify(plain)} compressed=${JSON.stringify(compressed)} `
      + `compressionRssOverheadBytes=${String(compressionRssOverheadBytes)} `
      + `failure=${JSON.stringify(boundedDetail)}`,
    )
  }
  process.stdout.write(`${JSON.stringify(summary)}\n`)
}

const entry = process.argv[1]
if (entry !== undefined && import.meta.url === pathToFileURL(resolve(entry)).href) {
  void main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`)
    process.exitCode = 1
  })
}
