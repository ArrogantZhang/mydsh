/** The family presentation retains the native Composer and recorded Session rendering. */
import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { join } from 'node:path'
import { chromium, type Browser, type Page } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, fixtureUserPrompts, launchWebScaffold,
  selectedSessionFixture, watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { connectFreshWorkspaceZh, ZH_BROWSER_LOCALE } from './support.ts'

const SCENARIO = fileURLToPath(new URL('../../../snapshots/web/family-theme/', import.meta.url))
const CANONICAL = fileURLToPath(new URL('../../../snapshots/web/deepseek-messages-chat/session.v3.jsonl', import.meta.url))
const OVERLAY = fileURLToPath(new URL('../../../packages/bundle/family-theme/cordis.patch.yml', import.meta.url))
const MODE = webSnapshotMode()

describe.skipIf(MODE === 'record')('family theme recorded conversation', () => {
  let browser: Browser | undefined
  let scaffold: WebScaffold | undefined
  let page: Page
  let fixture: string
  let tripwire: ReturnType<typeof watchConsole>
  beforeAll(async () => {
    fixture = await selectedSessionFixture(CANONICAL, false)
    scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, deepSeekMessages: true, replayFixture: fixture, paceMs: 5,
      replayProviders: [{ id: 'deepseek-messages', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash',
        contextWindow: 1_000_000, defaultMaxTokens: 256_000, reasoningEfforts: ['off', 'low', 'high', 'max'], defaultReasoningEffort: 'high' }] }] })
    browser = await chromium.launch()
    page = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
    tripwire = watchConsole(page)
    await page.goto(scaffold.authenticatedUrl)
    await page.getByRole('heading', { name: '回来啦，先歇一会儿。' }).waitFor()
    await connectFreshWorkspaceZh(page, scaffold.workspaceCwd)
  })
  afterAll(async () => { try { await browser?.close() } finally { await scaffold?.close() } })

  it('fills a draft, sends through the existing Composer, and renders the canonical reply', async () => {
    const host = scaffold!
    const input = page.locator('[data-composer-input]').first()
    await page.getByRole('button', { name: '今天吃什么', exact: true }).click()
    await expect.poll(() => input.innerText()).toBe('帮我想一份适合家人一起吃的晚餐菜单。')
    const prompts = fixtureUserPrompts(await readFile(fixture, 'utf8'))
    const settled = host.whenTurnSettled()
    await input.fill(prompts[0]!)
    await input.press('Enter')
    await settled
    await page.getByText('MESSAGES_WEB_READY', { exact: true }).waitFor()
    expect(await page.locator('[data-family-home]').count()).toBe(0)
    expect(await page.title()).toContain('家人小屋')
    await compareOrRefreshGolden(join(SCENARIO, 'ui.expected.md'),
      await captureStableAria(page, '[data-conversation-content]', host.workspaceCwd), MODE)
    expect(tripwire.pageErrors).toEqual([])
  })
})
