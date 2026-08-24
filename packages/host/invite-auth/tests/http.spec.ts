import { Readable } from 'node:stream'
import { describe, expect, it } from 'vitest'
import { HttpError, readUrlEncodedForm, redirect, writeEmpty, writeHtml } from '../src/http.ts'
import { renderLoginPage, securityHeaders } from '../src/page.ts'

/** Create an IncomingMessage-shaped readable request with the supplied headers and chunks. */
function request(chunks: Iterable<string | Buffer>, contentType?: string): import('node:http').IncomingMessage {
  return Object.assign(Readable.from(chunks), {
    headers: contentType === undefined ? {} : { 'content-type': contentType },
  }) as import('node:http').IncomingMessage
}

interface RecordedResponse {
  readonly calls: Array<{ status: number; headers: Record<string, string | string[]> }>
  readonly bodies: unknown[]
  readonly response: import('node:http').ServerResponse
}

/** Create the smallest ServerResponse recorder needed to observe HTTP helper output. */
function response(): RecordedResponse {
  const calls: Array<{ status: number; headers: Record<string, string | string[]> }> = []
  const bodies: unknown[] = []
  const recorded = {
    writeHead(status: number, headers: Record<string, string | string[]>) {
      calls.push({ status, headers })
      return recorded
    },
    end(body?: unknown) {
      bodies.push(body)
      return recorded
    },
  }
  return { calls, bodies, response: recorded as unknown as import('node:http').ServerResponse }
}

describe('readUrlEncodedForm', () => {
  it('parses URL-encoded fields and accepts a content-type charset', async () => {
    const form = await readUrlEncodedForm(request(['inviteCode=abc'], 'Application/X-WWW-Form-Urlencoded; charset=UTF-8'), 4_096)
    expect(form.get('inviteCode')).toBe('abc')
  })

  it('rejects non-form and missing content types', async () => {
    const jsonRequest = readUrlEncodedForm(request(['inviteCode=abc'], 'application/json'), 4_096)
    await expect(jsonRequest).rejects.toBeInstanceOf(HttpError)
    await expect(jsonRequest).rejects.toMatchObject({ status: 415 })
    await expect(readUrlEncodedForm(request(['inviteCode=abc']), 4_096)).rejects.toMatchObject({ status: 415 })
  })

  it('rejects form bodies above the byte limit but accepts the exact limit', async () => {
    await expect(readUrlEncodedForm(request([Buffer.alloc(4_097)], 'application/x-www-form-urlencoded'), 4_096)).rejects.toMatchObject({ status: 413 })
    await expect(readUrlEncodedForm(request([Buffer.alloc(4_096)], 'application/x-www-form-urlencoded'), 4_096)).resolves.toBeInstanceOf(URLSearchParams)
  })

  it('counts multibyte strings by encoded bytes', async () => {
    await expect(readUrlEncodedForm(request(['inviteCode=你'], 'application/x-www-form-urlencoded'), 13)).rejects.toMatchObject({ status: 413 })
    await expect(readUrlEncodedForm(request(['inviteCode=你'], 'application/x-www-form-urlencoded'), 14)).resolves.toBeInstanceOf(URLSearchParams)
  })

  it('rejects non-positive and unsafe form byte limits', async () => {
    for (const maxBytes of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1]) {
      await expect(readUrlEncodedForm(request([], 'application/x-www-form-urlencoded'), maxBytes)).rejects.toThrow(RangeError)
    }
  })

  it('propagates request stream errors', async () => {
    const failure = new Error('socket failed')
    async function* chunks(): AsyncGenerator<Buffer> {
      throw failure
    }
    const broken = Object.assign(Readable.from(chunks()), {
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
    }) as import('node:http').IncomingMessage
    await expect(readUrlEncodedForm(broken, 4_096)).rejects.toBe(failure)
  })
})

describe('renderLoginPage', () => {
  it('renders the Chinese login form with its accessible required password input', () => {
    const page = renderLoginPage('/sessions', true)
    expect(page).toContain('<html lang="zh-CN">')
    expect(page).toContain('<title>访问 DSH</title>')
    expect(page).toContain('<h1>访问 DSH</h1>')
    expect(page).toContain('<form method="post" action="/__invite/login">')
    expect(page).toContain('<input type="hidden" name="next" value="/sessions">')
    expect(page).toContain('<label for="inviteCode">邀请码</label>')
    expect(page).toContain('type="password" id="inviteCode" name="inviteCode" autocomplete="current-password" required autofocus')
    expect(page).toContain('<button type="submit">进入</button>')
    expect(page).toContain('<p role="alert">邀请码无效，请重试。</p>')
    expect(page).not.toContain('<script')
  })

  it('omits the invalid-code alert and safely escapes hidden next values', () => {
    const page = renderLoginPage('"<&\'', false)
    expect(page).not.toContain('<p role="alert">')
    expect(page).toContain('value="&quot;&lt;&amp;&#39;"')
    expect(page).not.toContain('value=""<&\'"')
  })
})

describe('HTTP response helpers', () => {
  it('returns the fixed security headers', () => {
    expect(securityHeaders()).toEqual({
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
      'referrer-policy': 'no-referrer',
      'x-content-type-options': 'nosniff',
      'x-frame-options': 'DENY',
    })
  })

  it('writes empty secure responses while retaining permitted caller headers', () => {
    const recorded = response()
    writeEmpty(recorded.response, 429, {
      'Cache-Control': 'public',
      'Content-Security-Policy': 'default-src *',
      'set-cookie': 'session=abc',
      'retry-after': '60',
    })
    expect(recorded.calls).toEqual([{
      status: 429,
      headers: expect.objectContaining({
        'cache-control': 'no-store',
        'content-security-policy': securityHeaders()['content-security-policy'],
        'set-cookie': 'session=abc',
        'retry-after': '60',
      }),
    }])
    expect(recorded.bodies).toEqual([undefined])
  })

  it('writes HTML with a fixed UTF-8 content type', () => {
    const recorded = response()
    writeHtml(recorded.response, 200, '<h1>访问 DSH</h1>', { 'content-type': 'text/plain', connection: 'close' })
    expect(recorded.calls[0]).toEqual({
      status: 200,
      headers: expect.objectContaining({ 'content-type': 'text/html; charset=utf-8', connection: 'close' }),
    })
    expect(recorded.bodies).toEqual(['<h1>访问 DSH</h1>'])
  })

  it('redirects with a 303 location and no response body', () => {
    const recorded = response()
    redirect(recorded.response, '/sessions', { location: 'https://evil.example', allow: 'POST' })
    expect(recorded.calls[0]).toEqual({
      status: 303,
      headers: expect.objectContaining({ Location: '/sessions', allow: 'POST', 'cache-control': 'no-store' }),
    })
    expect(recorded.bodies).toEqual([undefined])
  })
})
