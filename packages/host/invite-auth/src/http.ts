/**
 * Bound invite-authentication HTTP request parsing and secure response writing.
 * Route handlers use these helpers to keep stream limits and response security policy consistent.
 */

import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http'
import { securityHeaders } from './page.ts'

const FORM_CONTENT_TYPE = 'application/x-www-form-urlencoded'

/** HTTP failure whose status may be written directly by an invite-authentication route. */
export class HttpError extends Error {
  /** HTTP status code describing this expected request failure. */
  readonly status: number

  /** Whether the caller must close the connection because the request body may remain unread. */
  readonly closeConnection: boolean

  /**
   * Create an expected HTTP request failure.
   * @param status HTTP status code a route should return.
   * @param message Error message for diagnostics; it is not safe to expose unconditionally to a client.
   * @param closeConnection Whether a route must write `Connection: close` before ending its response.
   */
  constructor(status: number, message: string, closeConnection = false) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.closeConnection = closeConnection
  }
}

/**
 * Read one URL-encoded request body without retaining more than the configured byte limit.
 * Request stream errors and aborts reject with their original error.
 * Unsupported media types and oversized bodies become HttpError instances.
 * @param req Incoming request whose raw body bytes are read once; decoding after the limit check uses UTF-8.
 * @param maxBytes Positive safe maximum number of UTF-8 bytes to accept.
 * @returns Parsed URL-encoded fields after the complete body is received within the limit.
 * @throws {RangeError} If maxBytes is not a positive safe integer.
 * @throws {HttpError} With status 415 for a non-form content type or 413 for a body larger than maxBytes.
 * Both failures require closing the connection.
 */
export async function readUrlEncodedForm(req: IncomingMessage, maxBytes: number): Promise<URLSearchParams> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes <= 0) throw new RangeError('maxBytes must be a positive safe integer')
  if (!isUrlEncodedContentType(req.headers['content-type'])) {
    throw new HttpError(415, 'expected application/x-www-form-urlencoded', true)
  }

  let size = 0
  const chunks: Buffer[] = []
  for await (const chunk of req) {
    const bytes = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk as Buffer
    size += bytes.length
    if (size > maxBytes) throw new HttpError(413, 'form body exceeds maximum size', true)
    chunks.push(bytes)
  }
  return new URLSearchParams(Buffer.concat(chunks).toString('utf8'))
}

/**
 * Write a secure response with no body.
 * Caller headers may add ordinary response metadata but cannot replace security headers.
 * @param res Response to complete.
 * @param status HTTP status code to write.
 * @param headers Additional non-security headers.
 */
export function writeEmpty(res: ServerResponse, status: number, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, mergeHeaders({}, headers))
  res.end()
}

/**
 * Write a secure UTF-8 HTML response.
 * Caller headers may add ordinary response metadata but cannot replace security headers or the HTML media type.
 * @param res Response to complete.
 * @param status HTTP status code to write.
 * @param body Complete HTML response body.
 * @param headers Additional non-security headers.
 */
export function writeHtml(res: ServerResponse, status: number, body: string, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(status, mergeHeaders({ 'content-type': 'text/html; charset=utf-8' }, headers))
  res.end(body)
}

/**
 * Write a secure POST-redirect-GET response with no body.
 * Caller headers may add ordinary response metadata but cannot replace security headers or the redirect location.
 * @param res Response to complete.
 * @param location Redirect location selected by the route policy.
 * @param headers Additional non-security headers.
 */
export function redirect(res: ServerResponse, location: string, headers: OutgoingHttpHeaders = {}): void {
  res.writeHead(303, mergeHeaders({ location }, headers))
  res.end()
}

/** Return whether an incoming Content-Type identifies URL-encoded form data. */
function isUrlEncodedContentType(contentType: string | string[] | undefined): boolean {
  if (typeof contentType !== 'string') return false
  return contentType.split(';', 1)[0]?.trim().toLowerCase() === FORM_CONTENT_TYPE
}

/** Merge fixed headers with permitted caller headers without allowing case-insensitive replacement. */
function mergeHeaders(fixed: OutgoingHttpHeaders, caller: OutgoingHttpHeaders): OutgoingHttpHeaders {
  const protectedNames = new Set([...Object.keys(securityHeaders()), ...Object.keys(fixed)].map(name => name.toLowerCase()))
  const merged: OutgoingHttpHeaders = {}
  for (const [name, value] of Object.entries(caller)) {
    if (!protectedNames.has(name.toLowerCase())) merged[name] = value
  }
  return { ...merged, ...fixed, ...securityHeaders() }
}
