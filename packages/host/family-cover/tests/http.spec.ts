/** Real Loader, browser authentication, and streaming cover routes. */
import { request } from 'node:http'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import Include from '@deepseek-ai/cordis-plugin-include'
import HttpServer from '@deepseek-ai/dsh-host-webserver'
import * as Connection from '@deepseek-ai/dsh-client-connection'
import LocalCredentials from '@deepseek-ai/dsh-credentials-local'
import sharp from 'sharp'
import { afterEach, expect, it } from 'vitest'
import FamilyCover from '../src/index.ts'
import type { CoverSnapshot } from '../src/types.ts'

const fixtures: { root: string; ctx: Context }[] = []
afterEach(async () => {
  for (const { root, ctx } of fixtures.splice(0)) {
    await ctx.fiber.dispose()
    await rm(root, { recursive: true, force: true })
  }
})

async function boot(corruptMetadata = false) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-cover-http-'))
  const ctx = new Context()
  fixtures.push({ root, ctx })
  if (corruptMetadata) {
    await mkdir(join(root, 'cover'))
    await writeFile(join(root, 'cover', 'cover.json'), '{invalid')
  }
  ctx.baseUrl = pathToFileURL(root).href + '/'
  const configPath = join(root, 'cordis.yml')
  await writeFile(configPath, [
    '- name: webserver', '  config:', '    host: 127.0.0.1', '    port: 0',
    '- name: credentials', '  config:', `    path: ${JSON.stringify(join(root, 'credentials.yml'))}`, '    watch: false',
    '- name: connection', '  config:', '    trustedHosts: [dsh.example]',
    '- name: cover', '  config:', `    root: ${JSON.stringify(join(root, 'cover'))}`, '    maxInputBytes: 1024',
    '',
  ].join('\n'))
  await ctx.plugin(Loader)
  ctx.loader.builtins.include = Include
  const modules = new Map<string, unknown>([['webserver', HttpServer], ['credentials', LocalCredentials], ['connection', Connection], ['cover', FamilyCover]])
  ctx.loader.internal = { version: 'v2', async import(name: string) {
    if (!modules.has(name)) throw new Error(`Unexpected import: ${name}`)
    return modules.get(name)
  } } as unknown as NonNullable<typeof ctx.loader.internal>
  await ctx.loader.create({ name: 'cordis:include', config: { path: pathToFileURL(configPath).href } })
  await ctx.loader.await()
  for (const entry of ctx.loader.entries()) await entry.fiber?.await()
  let cookie = ''
  const url = new URL(ctx.connection.authenticatedUrl('http://dsh.example'))
  ctx.connection.authorizeIndex({ method: 'GET', url: url.pathname + url.search, headers: { host: 'dsh.example' } }, {
    writeHead(_status, headers) { cookie = String(headers?.['set-cookie']).split(';')[0]! }, end() {},
  })
  function send(path: string, method = 'GET', headers: Record<string, string> = {}, body?: Uint8Array) {
    return new Promise<{ status: number; headers: Headers; body: Buffer }>((resolve, reject) => {
      const req = request({ hostname: '127.0.0.1', port: ctx.webServer.port, path, method,
        headers: { host: 'dsh.example', ...headers } }, (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('error', reject)
        res.on('end', () => { resolve({ status: res.statusCode!, headers: new Headers(Object.entries(res.headers).flatMap(([key, value]) =>
          value === undefined ? [] : [[key, Array.isArray(value) ? value.join(', ') : value] as [string, string]])), body: Buffer.concat(chunks) }) })
      })
      req.on('error', reject)
      req.end(body)
    })
  }
  return { ctx, cookie, send }
}

it('shares normalized bytes only through authenticated reads and revision-checked same-origin uploads', async () => {
  const { ctx, send, cookie } = await boot()
  expect((await send('/api/family-cover/image?revision=0')).status).toBe(401)
  const picture = await sharp({ create: { width: 12, height: 8, channels: 3, background: '#bb7755' } }).png().toBuffer()
  const headers = { cookie, origin: 'http://dsh.example', 'content-type': 'image/png', 'if-match': '0' }
  const uploaded = await send('/api/family-cover/upload', 'POST', headers, picture)
  expect(uploaded.status).toBe(200)
  const saved = JSON.parse(uploaded.body.toString()) as CoverSnapshot
  expect(saved.cover).toMatchObject({ width: 12, height: 8, mediaType: 'image/webp' })
  expect(await ctx.familyCover.current(new AbortController().signal)).toEqual(saved)
  const photo = await send(`/api/family-cover/image?revision=${saved.revision}`, 'GET', { cookie })
  expect(photo.status, photo.body.toString()).toBe(200)
  expect(photo.headers.get('cache-control')).toBe('private, no-store')
  expect(photo.headers.get('content-type')).toBe('image/webp')
  expect((await sharp(photo.body).metadata()).format).toBe('webp')
  expect((await send('/api/family-cover/upload', 'POST', headers, picture)).status).toBe(409)
  const removed = await ctx.familyCover.remove(saved.revision, new AbortController().signal)
  expect(removed.cover).toBeNull()
  expect((await send(`/api/family-cover/image?revision=${removed.revision}`, 'GET', { cookie })).status).toBe(404)
  const entry = [...ctx.loader.entries()].find(entry => entry.options.name === 'cover')!
  await entry.fiber!.dispose()
  expect((await send('/api/family-cover/image?revision=0', 'GET', { cookie })).status).toBe(404)
})

it('refuses missing or foreign origins, invalid revisions, unsupported bodies, and excess bytes', async () => {
  const { ctx, send, cookie } = await boot()
  const headers = { cookie, origin: 'http://dsh.example', 'if-match': '0', 'content-type': 'image/png' }
  expect((await send('/api/family-cover/upload', 'POST', { ...headers, origin: 'https://evil.example' }, Buffer.from('x'))).status).toBe(403)
  const { origin: _origin, ...noOrigin } = headers
  expect((await send('/api/family-cover/upload', 'POST', noOrigin, Buffer.from('x'))).status).toBe(403)
  expect((await send('/api/family-cover/upload', 'POST', { ...headers, 'if-match': '../secret' }, Buffer.from('x'))).status).toBe(400)
  expect((await send('/api/family-cover/upload', 'POST', { ...headers, 'content-type': 'image/svg+xml' }, Buffer.from('<svg/>'))).status).toBe(415)
  expect((await send('/api/family-cover/upload', 'POST', headers, Buffer.alloc(1025))).status).toBe(413)
  expect((await ctx.familyCover.current(new AbortController().signal)).cover).toBeNull()
})

it('rejects Loader activation when durable cover metadata is unreadable', async () => {
  await expect(boot(true)).rejects.toThrow('Cover metadata is not valid JSON')
})
