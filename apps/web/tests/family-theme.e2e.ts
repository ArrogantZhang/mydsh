/** Built Web composition verifies personal appearance and authorized shared-cover persistence. */
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser, type Page } from 'playwright'
import { afterEach, expect, it } from 'vitest'
import type {} from '@deepseek-ai/dsh-family-cover'
import { launchWebScaffold, watchConsole, type WebScaffold } from './scaffold.ts'
import { saveFailureShot, ZH_BROWSER_LOCALE } from './support.ts'

const OVERLAY = fileURLToPath(new URL('../../../packages/bundle/family-theme/cordis.patch.yml', import.meta.url))
const PHOTO = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABgAAAAQCAIAAACDRijCAAAACXBIWXMAAAPoAAAD6AG1e1JrAAAAIElEQVQ4jWO4smUCVRDDqEFXRsPoymg62jKaRbaQnw4A9gYkLgpDhHYAAAAASUVORK5CYII=', 'base64')
let scaffold: WebScaffold | undefined
let browser: Browser | undefined
let home: string | undefined
let evidencePage: Page | undefined

afterEach(async (context) => {
  if (context.task.result?.state === 'fail' && evidencePage !== undefined) await saveFailureShot(evidencePage, 'family-theme')
  try { await browser?.close() } finally {
    browser = undefined
    evidencePage = undefined
    try { await scaffold?.close() } finally {
      scaffold = undefined
      if (home !== undefined) await rm(home, { recursive: true, force: true })
      home = undefined
    }
  }
})

async function settings(page: Page) {
  await page.getByRole('button', { name: '设置', exact: true }).click()
  const dialog = page.getByRole('dialog', { name: '设置', exact: true })
  await dialog.getByRole('button', { name: '通用设置' }).click()
  await dialog.getByRole('region', { name: '布置小屋' }).waitFor()
  return dialog
}

it('shares a private cover across browsers and restart while keeping personal palettes local and reversible', async () => {
  home = await mkdtemp(join(tmpdir(), 'dsh-family-web-'))
  scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, harnessHome: home })
  browser = await chromium.launch()
  const first = await browser.newPage({ viewport: { width: 1440, height: 1000 }, locale: ZH_BROWSER_LOCALE })
  evidencePage = first
  const second = await browser.newPage({ viewport: { width: 390, height: 844 }, locale: ZH_BROWSER_LOCALE })
  const tripwire = watchConsole(first)
  await first.goto(scaffold.authenticatedUrl)
  await first.getByRole('heading', { name: '回来啦，先歇一会儿。' }).waitFor()
  expect(await first.title()).toBe('家人小屋')
  await mkdir('output/playwright/family-theme', { recursive: true })
  await first.screenshot({ path: 'output/playwright/family-theme/morning.png', fullPage: true })
  const anonymous = await fetch(`${scaffold.baseUrl}/api/family-cover/image?revision=0`)
  expect(anonymous.status).toBe(401)
  const initial = await scaffold.ctx.familyCover.current(new AbortController().signal)
  const remoteCurrent = await scaffold.hostFetch('/api/familyCover/current', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'client-request', rpcId: 'family-test', method: 'familyCover/current', payload: { args: {} } }) })
  expect(await remoteCurrent.json()).toMatchObject({ result: { ok: true, value: initial } })
  const response = first.waitForResponse(value => value.url().endsWith('/api/family-cover/upload'))
  await expect.poll(() => first.getByLabel('上传家庭照片', { exact: true }).isEnabled()).toBe(true)
  await first.getByLabel('上传家庭照片', { exact: true }).setInputFiles({ name: 'family-private.png', mimeType: 'image/png', buffer: PHOTO })
  const uploaded = await response
  expect(uploaded.status()).toBe(200)
  await first.getByRole('img', { name: '大家共享的家庭封面' }).waitFor()
  const saved = await scaffold.ctx.familyCover.current(new AbortController().signal)
  expect(saved.cover).toMatchObject({ width: 24, height: 16 })
  await second.goto(scaffold.authenticatedUrl)
  await second.getByRole('img', { name: '大家共享的家庭封面' }).waitFor()
  expect(await second.locator('body').evaluate(element => element.scrollWidth <= window.innerWidth)).toBe(true)
  await second.screenshot({ path: 'output/playwright/family-theme/mobile.png', fullPage: true })
  const otherChange = await scaffold.hostFetch('/api/family-cover/upload', { method: 'POST', body: PHOTO,
    headers: { origin: scaffold.baseUrl, 'content-type': 'image/png', 'if-match': saved.revision } })
  expect(otherChange.status).toBe(200)
  await first.getByLabel('上传家庭照片', { exact: true }).setInputFiles({ name: 'stale.png', mimeType: 'image/png', buffer: PHOTO })
  await first.getByRole('alert').filter({ hasText: '另一位家人刚换了照片' }).waitFor()
  await first.getByRole('button', { name: '刷新照片', exact: true }).click()
  await first.getByRole('alert').waitFor({ state: 'hidden' })
  const dialog = await settings(first)
  const family = dialog.getByRole('region', { name: '布置小屋' })
  await family.getByLabel('小屋名称').fill('我们的小家')
  await family.getByRole('button', { name: '花园午后' }).click()
  await family.getByRole('button', { name: '保存设置' }).click()
  await expect.poll(() => first.locator('body').evaluate(element => getComputedStyle(element).backgroundColor)).toBe('rgb(247, 248, 239)')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await first.screenshot({ path: 'output/playwright/family-theme/garden.png', fullPage: true })
  await settings(first)
  await family.getByRole('button', { name: '炉火夜晚' }).click()
  await family.getByRole('button', { name: '保存设置' }).click()
  expect(await first.title()).toBe('我们的小家')
  await expect.poll(() => first.locator('html').evaluate(element => getComputedStyle(element).colorScheme)).toBe('dark')
  expect(await second.title()).toBe('家人小屋')
  await dialog.getByRole('button', { name: '关闭', exact: true }).click()
  await first.screenshot({ path: 'output/playwright/family-theme/evening.png', fullPage: true })
  await first.reload()
  await first.getByRole('heading', { name: '回来啦，先歇一会儿。' }).waitFor()
  expect(await first.title()).toBe('我们的小家')
  const stale = await scaffold.hostFetch('/api/family-cover/upload', { method: 'POST', body: PHOTO,
    headers: { origin: scaffold.baseUrl, 'content-type': 'image/png', 'if-match': initial.revision } })
  expect(stale.status).toBe(409)
  const durableBefore = await readFile(join(home, 'family-theme', 'cover.json'), 'utf8')
  await first.context().clearCookies()
  await first.evaluate(() => window.dispatchEvent(new Event('focus')))
  await expect.poll(() => first.getByRole('img', { name: '大家共享的家庭封面' }).count()).toBe(0)
  await first.getByRole('alert').filter({ hasText: '刷新网页并确认登录' }).waitFor()
  evidencePage = second
  // A port-zero restart creates a new origin; the expired page cannot reconnect to that Host.
  await first.close()
  await scaffold.close()
  scaffold = await launchWebScaffold({ extraOverlayPath: OVERLAY, harnessHome: home })
  expect(await readFile(join(home, 'family-theme', 'cover.json'), 'utf8')).toBe(durableBefore)
  await second.goto(scaffold.authenticatedUrl)
  await second.getByRole('img', { name: '大家共享的家庭封面' }).waitFor()
  const fresh = await settings(second)
  const restartedWire = watchConsole(second)
  const shared = fresh.getByRole('region', { name: '布置小屋' })
  await shared.getByRole('button', { name: '移除共享照片' }).click()
  await second.getByRole('dialog', { name: '移除大家的封面？' }).getByRole('button', { name: '确认移除' }).click()
  try {
    await expect.poll(async () => (await scaffold!.ctx.familyCover.current(new AbortController().signal)).cover).toBeNull()
  } catch (error) {
    console.log('family removal failure', await second.locator('[role="alert"]').allTextContents(), restartedWire)
    throw error
  }
  await shared.getByRole('switch', { name: '使用家庭主题' }).click()
  await fresh.getByRole('button', { name: '关闭', exact: true }).click()
  await expect.poll(() => second.locator('[data-family-home]').count()).toBe(0)
  expect(await second.getByText('探索未至之境', { exact: true }).count()).toBe(1)
  expect(tripwire.pageErrors).toEqual([])
})
