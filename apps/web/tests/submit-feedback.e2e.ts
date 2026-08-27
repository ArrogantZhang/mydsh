// Real-browser submit receipt: both composer gestures paint feedback before
// Host admission, then converge on one durable user/assistant turn.
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Browser, Page, Route } from 'playwright'
import { chromium } from 'playwright'
import { afterEach, describe, expect, it, onTestFailed } from 'vitest'
import { deriveReplayScript, parseSessionLog } from '@deepseek-ai/dsh-llm-replay'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import {
  assertFixtureInventory,
  captureStableAria,
  compareOrRefreshGolden,
  fixtureUserPrompts,
  launchWebScaffold,
  watchConsole,
  webSnapshotMode,
  type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspace, newEnglishPage, saveFailureShot } from './support.ts'

const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/submit-feedback', import.meta.url))
const PENDING_EXPECTED = join(SNAPSHOT_DIR, 'pending.expected.md')
const FIXTURE = fileURLToPath(new URL('./snapshots/live-interactions/session.jsonl', import.meta.url))
const MODE = webSnapshotMode()
const PROMPT = 'Reply with a one-sentence description of event sourcing, then stop.'

type Gesture = 'Enter' | 'pointer button'

interface SubmitProbe {
  readonly button: HTMLButtonElement
  readonly status: HTMLElement
  observer: MutationObserver
  gestureAt: number | null
  paintedAt: number | null
  statusAtPaint: string | null
  sameButton: boolean | null
  sameStatus: boolean | null
  frameScheduled: boolean
}

interface PendingContrast {
  readonly markerBackground: string
  readonly buttonBackground: string
  readonly buttonOpacity: string
  readonly ratio: number
}

function userText(event: SessionEvent<'user/message'>): string {
  return event.data.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

function assistantText(event: SessionEvent<'assistant/message'>): string {
  return event.data.message.content
    .filter(block => block.type === 'text')
    .map(block => block.text)
    .join('')
}

async function installSubmitProbe(page: Page, gesture: Gesture): Promise<void> {
  await page.evaluate((gestureName) => {
    const card = document.querySelector<HTMLElement>('[data-composer-card]')
    if (card === null) {
      throw new Error('submit probe requires the composed Send button and permanent status')
    }
    const button = card.querySelector<HTMLButtonElement>('button[aria-label="Send message"]')
    const status = card.querySelector<HTMLElement>('span[role="status"]')
    if (button === null || status === null) {
      throw new Error('submit probe requires the composed Send button and permanent status')
    }
    const stableCard = card
    const probe: SubmitProbe = {
      button,
      status,
      observer: undefined as unknown as MutationObserver,
      gestureAt: null,
      paintedAt: null,
      statusAtPaint: null,
      sameButton: null,
      sameStatus: null,
      frameScheduled: false,
    }
    const markGesture = (event: Event): void => {
      if (probe.gestureAt !== null) return
      if (gestureName === 'Enter') {
        if (!(event instanceof KeyboardEvent) || event.key !== 'Enter' || !(event.target instanceof HTMLTextAreaElement)) return
      } else {
        if (!(event instanceof PointerEvent) || !(event.target instanceof Element)
          || event.target.closest('button[aria-label="Send message"]') !== button) return
      }
      probe.gestureAt = performance.now()
    }
    document.addEventListener(gestureName === 'Enter' ? 'keydown' : 'pointerdown', markGesture, true)
    probe.observer = new MutationObserver(() => {
      if (probe.frameScheduled || status.textContent !== 'Sending…') return
      probe.frameScheduled = true
      requestAnimationFrame(() => {
        probe.paintedAt = performance.now()
        probe.statusAtPaint = status.textContent
        probe.sameButton = stableCard.querySelector('button[aria-label="Send message"]') === button
        probe.sameStatus = stableCard.querySelector('span[role="status"]') === status
      })
    })
    probe.observer.observe(status, { childList: true, characterData: true, subtree: true })
    ;(window as typeof window & { __dshSubmitProbe?: SubmitProbe }).__dshSubmitProbe = probe
  }, gesture)
}

async function readSubmitTiming(page: Page): Promise<{
  gestureAt: number | null
  paintedAt: number | null
  statusAtPaint: string | null
  sameButton: boolean | null
  sameStatus: boolean | null
}> {
  return await page.evaluate(() => {
    const probe = (window as typeof window & { __dshSubmitProbe?: SubmitProbe }).__dshSubmitProbe
    if (probe === undefined) throw new Error('submit timing probe is not installed')
    return {
      gestureAt: probe.gestureAt,
      paintedAt: probe.paintedAt,
      statusAtPaint: probe.statusAtPaint,
      sameButton: probe.sameButton,
      sameStatus: probe.sameStatus,
    }
  })
}

async function pendingContrast(page: Page): Promise<PendingContrast> {
  return await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>('[data-submit-pending]')
    const button = marker?.closest<HTMLButtonElement>('button[aria-label="Send message"]')
    if (marker === null || marker === undefined || button === null || button === undefined) {
      throw new Error('pending contrast requires the painted marker and Send button')
    }
    const channels = (color: string): readonly [number, number, number] => {
      const values = color.match(/[\d.]+/g)?.slice(0, 3).map(Number)
      if (values === undefined || values.length !== 3) throw new Error(`unsupported computed color ${color}`)
      return [values[0]!, values[1]!, values[2]!]
    }
    const luminance = (color: string): number => {
      const linear = channels(color).map((channel) => {
        const value = channel / 255
        return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
      })
      return 0.2126 * linear[0]! + 0.7152 * linear[1]! + 0.0722 * linear[2]!
    }
    const markerStyle = getComputedStyle(marker)
    const buttonStyle = getComputedStyle(button)
    const markerLuminance = luminance(markerStyle.backgroundColor)
    const buttonLuminance = luminance(buttonStyle.backgroundColor)
    return {
      markerBackground: markerStyle.backgroundColor,
      buttonBackground: buttonStyle.backgroundColor,
      buttonOpacity: buttonStyle.opacity,
      ratio: (Math.max(markerLuminance, buttonLuminance) + 0.05)
        / (Math.min(markerLuminance, buttonLuminance) + 0.05),
    }
  })
}

async function pendingAnimation(page: Page): Promise<{
  reducedMotion: boolean
  animationName: string
  properties: string[]
  transform: string
}> {
  return await page.evaluate(() => {
    const marker = document.querySelector<HTMLElement>('[data-submit-pending]')
    if (marker === null) throw new Error('pending animation requires the painted marker')
    const style = getComputedStyle(marker)
    const properties = new Set<string>()
    const visit = (rules: CSSRuleList): void => {
      for (const rule of Array.from(rules)) {
        if (rule instanceof CSSKeyframesRule && rule.name === style.animationName) {
          for (const frame of Array.from(rule.cssRules) as CSSKeyframeRule[]) {
            for (const property of Array.from(frame.style)) properties.add(property)
          }
          continue
        }
        const nested = (rule as CSSRule & { cssRules?: CSSRuleList }).cssRules
        if (nested !== undefined) visit(nested)
      }
    }
    for (const sheet of Array.from(document.styleSheets)) visit(sheet.cssRules)
    return {
      reducedMotion: matchMedia('(prefers-reduced-motion: reduce)').matches,
      animationName: style.animationName,
      properties: [...properties].sort(),
      transform: style.transform,
    }
  })
}

describe.skipIf(MODE === 'record')('web e2e: submit feedback before Host admission', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let heldRoute: Route | undefined
  let heldRoutePending = false

  afterEach(async () => {
    const failures: unknown[] = []
    if (heldRoutePending && heldRoute !== undefined) {
      heldRoutePending = false
      await heldRoute.abort('failed').catch((error: unknown) => failures.push(error))
    }
    heldRoute = undefined
    await browser?.close().catch((error: unknown) => failures.push(error))
    browser = undefined
    const closing = scaffold
    scaffold = undefined
    await closing?.close().catch((error: unknown) => failures.push(error))
    if (failures.length === 1) throw failures[0]
    if (failures.length > 1) throw new AggregateError(failures, 'submit-feedback teardown failed')
  })

  it.each(['Enter', 'pointer button'] as const)(
    '%s paints a pending receipt before admission and settles exactly once',
    async (gesture) => {
      const fixture = await readFile(FIXTURE, 'utf8')
      expect(fixtureUserPrompts(fixture)).toEqual([PROMPT])
      const replay = deriveReplayScript(parseSessionLog(fixture))
      expect(replay).toHaveLength(1)
      const entry = replay[0]
      if (entry === undefined || entry.kind !== 'chunks') throw new Error('submit fixture must replay one chunk stream')
      const recordedTextBlocks = entry.chunks.flatMap(chunk => (
        chunk.type === 'block-end' && chunk.block.type === 'text' ? [chunk.block.text] : []
      ))
      expect(recordedTextBlocks).toHaveLength(1)
      const expectedAssistant = recordedTextBlocks[0]!

      const sessionEvents: SessionEvent[] = []
      const consoleWarnings: string[] = []
      scaffold = await launchWebScaffold({ replayFixture: FIXTURE })
      scaffold.ctx.on('session/event', (_session, event: SessionEvent) => { sessionEvents.push(event) })
      browser = await chromium.launch()
      const page = await newEnglishPage(browser)
      const tripwire = watchConsole(page)
      page.on('console', (message) => {
        if (message.type() === 'warning') consoleWarnings.push(message.text())
      })
      await page.goto(scaffold.baseUrl, { waitUntil: 'load' })
      await page.waitForSelector('[class*="frame"]', { timeout: 30_000 })
      await connectFreshWorkspace(page, scaffold.workspaceCwd)
      onTestFailed(() => saveFailureShot(page, `web-e2e-submit-feedback-${gesture === 'Enter' ? 'enter' : 'pointer'}`))

      const composerCard = page.locator('[data-composer-card]').last()
      const textarea = composerCard.locator('textarea')
      const sendButton = composerCard.getByRole('button', { name: 'Send message', exact: true })
      const status = composerCard.locator('span[role="status"]')
      await textarea.waitFor({ state: 'visible', timeout: 10_000 })
      expect(await status.count()).toBe(1)
      expect(await status.textContent()).toBe('')

      let resolveHeldRoute!: (route: Route) => void
      const requestHeld = new Promise<Route>((resolve) => { resolveHeldRoute = resolve })
      await page.route('**/api/session.prompt', (route) => {
        heldRoute = route
        heldRoutePending = true
        resolveHeldRoute(route)
      })
      await installSubmitProbe(page, gesture)
      await textarea.fill(PROMPT)
      const sessionEventCountBeforeSubmit = sessionEvents.length
      if (gesture === 'Enter') await textarea.press('Enter')
      else await sendButton.click()
      const route = await requestHeld

      await expect.poll(async () => (await readSubmitTiming(page)).paintedAt, {
        timeout: 5_000,
        message: 'pending receipt did not reach its first animation frame',
      }).not.toBeNull()
      const timing = await readSubmitTiming(page)
      expect(timing.gestureAt).not.toBeNull()
      expect(timing.paintedAt).not.toBeNull()
      expect(timing.paintedAt! - timing.gestureAt!).toBeLessThan(100)
      expect(timing.statusAtPaint).toBe('Sending…')
      expect(timing.sameButton).toBe(true)
      expect(timing.sameStatus).toBe(true)
      expect(await status.textContent()).toBe('Sending…')
      expect(await sendButton.getAttribute('aria-busy')).toBe('true')
      expect(await sendButton.locator('[data-submit-pending]').count()).toBe(1)
      expect(await textarea.evaluate((element) => {
        if (!(element instanceof HTMLTextAreaElement)) throw new Error('composer locator did not resolve to a textarea')
        return element.readOnly
      })).toBe(true)
      expect(await textarea.inputValue()).toBe(PROMPT)

      expect(sessionEvents).toHaveLength(sessionEventCountBeforeSubmit)
      expect(await page.locator('[class*="userRow"]').count()).toBe(0)
      expect(await page.locator('[data-chat-flow-kind="user"]').count()).toBe(0)
      expect(await page.locator('[data-chat-anchor-key]').count()).toBe(0)
      const pendingSnapshot = await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd)
      expect(pendingSnapshot).toContain(PROMPT)
      expect(pendingSnapshot).toContain('Sending…')
      expect(pendingSnapshot).not.toContain(expectedAssistant)
      await compareOrRefreshGolden(PENDING_EXPECTED, pendingSnapshot, MODE)

      await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
      const lightContrast = await pendingContrast(page)
      let darkContrast: PendingContrast
      try {
        await page.evaluate(() => { document.body.setAttribute('data-ds-dark-theme', '') })
        darkContrast = await pendingContrast(page)
      } finally {
        await page.evaluate(() => { document.body.removeAttribute('data-ds-dark-theme') })
      }
      expect(lightContrast.buttonOpacity).toBe('1')
      expect(darkContrast!.buttonOpacity).toBe('1')
      expect(lightContrast.ratio).toBeGreaterThanOrEqual(3)
      expect(darkContrast!.ratio).toBeGreaterThanOrEqual(3)
      const animation = await pendingAnimation(page)
      if (animation.reducedMotion) {
        expect(animation.animationName).toBe('none')
        expect(animation.transform === 'none' || animation.transform === 'matrix(1, 0, 0, 1, 0, 0)').toBe(true)
      } else {
        expect(animation.animationName).not.toBe('none')
        expect(animation.properties).toEqual(['transform'])
      }

      const settled = scaffold.whenTurnSettled(60_000)
      await route.continue()
      heldRoutePending = false
      await settled

      const userRows = page.locator('[data-chat-flow-kind="user"]').filter({ hasText: PROMPT })
      await expect.poll(() => userRows.count(), { timeout: 15_000 }).toBe(1)
      expect(await userRows.getByText(PROMPT, { exact: true }).count()).toBe(1)
      const assistantRows = page.locator('[data-chat-flow-kind="assistant-step"]').filter({ hasText: expectedAssistant })
      await expect.poll(() => assistantRows.count(), { timeout: 15_000 }).toBe(1)
      expect(await assistantRows.getByText(expectedAssistant, { exact: true }).count()).toBe(1)
      expect(await page.locator('[data-chat-flow-kind="user"]').count()).toBe(1)
      expect(await page.locator('[data-chat-flow-kind="assistant-step"]').count()).toBe(1)
      await expect.poll(() => status.textContent(), { timeout: 10_000 }).toBe('')
      expect(await sendButton.getAttribute('aria-busy')).toBeNull()
      expect(await sendButton.locator('[data-submit-pending]').count()).toBe(0)
      expect(await textarea.isEnabled()).toBe(true)
      expect(await textarea.evaluate((element) => {
        if (!(element instanceof HTMLTextAreaElement)) throw new Error('composer locator did not resolve to a textarea')
        return element.readOnly
      })).toBe(false)
      expect(await textarea.inputValue()).toBe('')

      const users = sessionEvents.filter((event): event is SessionEvent<'user/message'> => (
        event.type === 'user/message' && event.data.source.kind === 'user' && userText(event) === PROMPT
      ))
      const assistants = sessionEvents.filter((event): event is SessionEvent<'assistant/message'> => (
        event.type === 'assistant/message'
      ))
      expect(users).toHaveLength(1)
      expect(users[0]?.surfaceOp).toBe('append')
      expect(assistants).toHaveLength(1)
      expect(assistantText(assistants[0]!)).toBe(expectedAssistant)
      expect(assistants[0]?.data.turn).toBe(1)
      expect(consoleWarnings).toEqual([])
      expect(tripwire.warnings).toEqual([])
      expect(tripwire.pageErrors).toEqual([])
    },
    120_000,
  )

  it('keeps the fixture inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['pending.expected.md'])
  })
})
