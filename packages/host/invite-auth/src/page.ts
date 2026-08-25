/**
 * Render the static, same-origin invite-authentication page and its response security headers.
 * The page accepts only a supplied local redirect path; invite codes and session secrets never enter its markup.
 */

const CONTENT_SECURITY_POLICY = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'"
const ATTRIBUTE_ENTITIES = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

/**
 * Return security headers shared by every invite-authentication response.
 * @returns Fresh header values that prevent caching, embedding, MIME sniffing, referrer disclosure, and non-self form actions.
 */
export function securityHeaders(): Record<string, string> {
  return {
    'cache-control': 'no-store',
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY',
  }
}

/**
 * Render the Chinese invite-code login page.
 * @param next Policy-approved local redirect path; this function escapes it before inserting it into the hidden input.
 * @param invalid Whether to show the static invalid-invite-code alert.
 * @returns A complete responsive HTML document with no client-side code or external assets.
 */
export function renderLoginPage(next: string, invalid: boolean): string {
  const alert = invalid ? '<p role="alert">邀请码无效，请重试。</p>' : ''
  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>访问 DSH</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; }
    *, *::before, *::after { box-sizing: border-box; }
    body { align-items: center; background: Canvas; color: CanvasText; display: flex; justify-content: center; margin: 0; min-height: 100vh; padding: 1.5rem; }
    main { border: 1px solid color-mix(in srgb, CanvasText 25%, transparent); border-radius: 0.75rem; max-width: 26rem; padding: 2rem; width: 100%; }
    h1 { font-size: 1.5rem; margin: 0 0 0.75rem; }
    p { line-height: 1.55; }
    [role="alert"] { font-weight: 600; }
    @media (prefers-color-scheme: light) { [role="alert"] { color: #b42318; } }
    @media (prefers-color-scheme: dark) { [role="alert"] { color: #fda4af; } }
    form { display: grid; gap: 0.75rem; margin-top: 1.25rem; }
    input, button { box-sizing: border-box; font: inherit; min-height: 2.75rem; padding: 0.55rem 0.7rem; width: 100%; }
    input { border: 1px solid color-mix(in srgb, CanvasText 35%, transparent); border-radius: 0.4rem; background: Canvas; color: CanvasText; }
    button { border: 0; border-radius: 0.4rem; background: #2563eb; color: white; cursor: pointer; font-weight: 650; }
    button:hover { background: #1d4ed8; }
    input:focus-visible, button:focus-visible { outline: 3px solid #60a5fa; outline-offset: 2px; }
  </style>
</head>
<body>
  <main>
    <h1>访问 DSH</h1>
    <p>请输入共享邀请码后继续。</p>
    ${alert}
    <form method="post" action="/__invite/login">
      <input type="hidden" name="next" value="${escapeAttribute(next)}">
      <label for="inviteCode">邀请码</label>
      <input type="password" id="inviteCode" name="inviteCode" autocomplete="current-password" required autofocus>
      <button type="submit">进入</button>
    </form>
  </main>
</body>
</html>`
}

/** Escape untrusted text for one quoted HTML attribute. */
function escapeAttribute(value: string): string {
  return value.replace(/[&<>"']/g, character => ATTRIBUTE_ENTITIES[character as keyof typeof ATTRIBUTE_ENTITIES])
}
