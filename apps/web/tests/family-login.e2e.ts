/** The family login uses nonce-authorized local preferences without loading shared photos. */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { chromium, type Browser } from 'playwright'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { launchWebScaffold, type WebScaffold } from './scaffold.ts'

let root: string | undefined
let browser: Browser | undefined
let scaffold: WebScaffold | undefined
beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'dsh-family-login-'))
  const overlay = join(root, 'family.cordis.yml')
  await writeFile(overlay, await readFile(fileURLToPath(new URL('../../../packages/bundle/family-theme/cordis.patch.yml', import.meta.url)), 'utf8')
    + '\n- insert:\n    - name: "@deepseek-ai/dsh-host-invite-auth"\n')
  const previousCode = process.env.DSH_INVITE_CODE_SECRET
  const previousSecret = process.env.DSH_INVITE_SESSION_SECRET
  process.env.DSH_INVITE_CODE_SECRET = 'family-login-test-code'
  process.env.DSH_INVITE_SESSION_SECRET = 'family-login-test-signing-secret-0123456789'
  try { scaffold = await launchWebScaffold({ extraOverlayPath: overlay, harnessHome: join(root, 'home') }) }
  finally {
    if (previousCode === undefined) delete process.env.DSH_INVITE_CODE_SECRET
    else process.env.DSH_INVITE_CODE_SECRET = previousCode
    if (previousSecret === undefined) delete process.env.DSH_INVITE_SESSION_SECRET
    else process.env.DSH_INVITE_SESSION_SECRET = previousSecret
  }
  browser = await chromium.launch()
})
afterAll(async () => {
  try { await browser?.close() } finally {
    try { await scaffold?.close() } finally { if (root !== undefined) await rm(root, { recursive: true, force: true }) }
  }
})

it('renders the saved local name safely under CSP while retaining the real invite form', async () => {
  const page = await browser!.newPage({ viewport: { width: 390, height: 844 } })
  const requested: string[] = []
  const errors: string[] = []
  page.on('request', request => requested.push(request.url()))
  page.on('pageerror', error => errors.push(error.message))
  await page.addInitScript(() => { localStorage.setItem('dsh.family-home.v1', JSON.stringify({
    version: 1, enabled: true, name: '<我们的家>', greeting: '欢迎', palette: 'evening',
  })) })
  const response = await page.goto(`${scaffold!.baseUrl}/__invite/login`)
  expect(response!.status()).toBe(200)
  expect((await response!.allHeaders())['content-security-policy']).toContain("script-src 'nonce-")
  expect(await page.title()).toBe('<我们的家>')
  expect(await page.getByRole('heading', { name: '<我们的家>' }).count()).toBe(1)
  expect(await page.locator('html').getAttribute('data-family-palette')).toBe('evening')
  expect(await page.locator('form').getAttribute('action')).toBe('/__invite/login')
  expect(await page.getByLabel('邀请码').getAttribute('type')).toBe('password')
  expect(requested.some(url => url.includes('/api/') || url.startsWith('https://'))).toBe(false)
  expect(errors).toEqual([])
  await page.screenshot({ path: 'output/playwright/family-theme/login.png', fullPage: true })
})
