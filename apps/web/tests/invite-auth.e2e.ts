// Browser coverage for the deployment overlay's unauthenticated login page.
// The scenario reaches the real Host route but deliberately does not submit:
// Caddy owns the TLS, origin, and forward-auth integration around that POST.
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it, onTestFailed } from 'vitest'
import {
  assertFixtureInventory, captureStableAria, compareOrRefreshGolden,
  launchWebScaffold, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { ZH_BROWSER_LOCALE, saveFailureShot } from './support.ts'

const DEPLOYMENT_OVERLAY = fileURLToPath(new URL('../../../deploy/alibaba-cloud/invite-auth.cordis.yml', import.meta.url))
const SNAPSHOT_DIR = fileURLToPath(new URL('./snapshots/invite-auth', import.meta.url))
const LOGIN_EXPECTED = join(SNAPSHOT_DIR, 'login.expected.md')
const MODE = webSnapshotMode()
const INVITE_SENTINEL = 'web-e2e-invite-sentinel-8f41d2a6'
const SESSION_SENTINEL = 'web-e2e-session-sentinel-3d7c91af-9e0b5d28-6a4f1c73'
const CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"

interface Closeable {
  close(): Promise<void>
}

async function closeBrowserAndScaffold(browser: Closeable | undefined, scaffold: Closeable | undefined): Promise<void> {
  const failures: unknown[] = []
  for (const resource of [browser, scaffold]) {
    if (resource === undefined) continue
    try {
      await resource.close()
    } catch (error) {
      failures.push(error)
    }
  }
  if (failures.length > 0) throw new AggregateError(failures, 'invite-auth browser teardown failed')
}

describe('invite-auth browser teardown', () => {
  it('closes the scaffold after a browser failure and aggregates independent close failures', async () => {
    const browserFailure = new Error('browser close failed')
    const scaffoldFailure = new Error('scaffold close failed')
    let scaffoldCloseCalls = 0
    const browser: Closeable = { close: async () => { throw browserFailure } }
    const scaffold: Closeable = {
      close: async () => {
        scaffoldCloseCalls += 1
        throw scaffoldFailure
      },
    }

    let received: unknown
    try {
      await closeBrowserAndScaffold(browser, scaffold)
    } catch (error) {
      received = error
    }

    expect(scaffoldCloseCalls).toBe(1)
    expect(received).toBeInstanceOf(AggregateError)
    expect((received as AggregateError).errors).toEqual([browserFailure, scaffoldFailure])
  })
})

describe('web e2e: invite authentication login', () => {
  let scaffold: WebScaffold | undefined
  let browser: Browser | undefined
  let page: Page | undefined
  let tripwire: ReturnType<typeof watchConsole> | undefined
  const consoleMessages: string[] = []

  beforeAll(async () => {
    const previousInviteSecret = process.env.DSH_INVITE_CODE_SECRET
    const previousSessionSecret = process.env.DSH_INVITE_SESSION_SECRET
    process.env.DSH_INVITE_CODE_SECRET = INVITE_SENTINEL
    process.env.DSH_INVITE_SESSION_SECRET = SESSION_SENTINEL
    try {
      scaffold = await launchWebScaffold({ extraOverlayPath: DEPLOYMENT_OVERLAY })
    } finally {
      if (previousInviteSecret === undefined) delete process.env.DSH_INVITE_CODE_SECRET
      else process.env.DSH_INVITE_CODE_SECRET = previousInviteSecret
      if (previousSessionSecret === undefined) delete process.env.DSH_INVITE_SESSION_SECRET
      else process.env.DSH_INVITE_SESSION_SECRET = previousSessionSecret
    }

    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 960 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    page.on('console', message => consoleMessages.push(message.text()))
  }, 120_000)

  afterAll(async () => {
    await closeBrowserAndScaffold(browser, scaffold)
  })

  it('serves the static Chinese invite-code login form without exposing its boot secrets', async () => {
    if (scaffold === undefined || page === undefined || tripwire === undefined) throw new Error('invite-auth browser setup did not finish')
    const screenshotPage = page
    onTestFailed(() => saveFailureShot(screenshotPage, 'web-e2e-invite-auth-login'))

    const response = await page.goto(`${scaffold.baseUrl}/__invite/login?next=%2Fsessions`, { waitUntil: 'load' })
    if (response === null) throw new Error('invite-auth login navigation returned no HTTP response')

    expect(response.headers()['cache-control']).toBe('no-store')
    expect(response.headers()['content-security-policy']).toBe(CONTENT_SECURITY_POLICY)
    expect(response.headers()['x-content-type-options']).toBe('nosniff')
    expect(response.headers()['x-frame-options']).toBe('DENY')
    expect(response.headers()['referrer-policy']).toBe('no-referrer')

    const heading = page.getByRole('heading', { name: '访问 DSH', exact: true })
    expect(await heading.count()).toBe(1)
    const label = page.locator('label').filter({ hasText: /^邀请码$/ })
    expect(await label.count()).toBe(1)
    const inviteCode = page.getByLabel('邀请码', { exact: true })
    expect(await inviteCode.count()).toBe(1)
    expect(await inviteCode.getAttribute('type')).toBe('password')
    expect(await inviteCode.getAttribute('name')).toBe('inviteCode')
    expect(await inviteCode.getAttribute('autocomplete')).toBe('current-password')
    expect(await inviteCode.evaluate((element: HTMLInputElement) => element.required)).toBe(true)
    expect(await inviteCode.evaluate(node => document.activeElement === node)).toBe(true)
    expect(await page.getByRole('button', { name: '进入', exact: true }).count()).toBe(1)
    expect(await page.getByText('请输入共享邀请码后继续。', { exact: true }).count()).toBe(1)
    expect(await page.getByRole('alert').count()).toBe(0)

    const form = page.locator('form')
    expect(await form.count()).toBe(1)
    expect(await form.getAttribute('action')).toBe('/__invite/login')
    expect(await form.getAttribute('method')).toBe('post')
    expect(await form.locator('input[type="hidden"][name="next"]').inputValue()).toBe('/sessions')
    expect(await page.locator('script').count()).toBe(0)
    expect(await page.locator('link[href], img[src], iframe[src], audio[src], video[src], source[src]').count()).toBe(0)

    const html = await page.content()
    const aria = await captureStableAria(page, 'body', scaffold.workspaceCwd)
    for (const sentinel of [INVITE_SENTINEL, SESSION_SENTINEL]) {
      expect(html).not.toContain(sentinel)
      expect(aria).not.toContain(sentinel)
      expect(consoleMessages.join('\n')).not.toContain(sentinel)
    }
    expect(tripwire.warnings).toEqual([])
    expect(tripwire.pageErrors).toEqual([])
    await compareOrRefreshGolden(LOGIN_EXPECTED, aria, MODE)
  }, 60_000)

  it('keeps its snapshot inventory closed', async () => {
    await assertFixtureInventory(SNAPSHOT_DIR, ['login.expected.md'])
  })
})
