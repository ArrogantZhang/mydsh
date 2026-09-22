/** Optional family appearance for the existing invite login owner. */
import type { Context } from '@deepseek-ai/cordis'
import type { InvitePageRegistry } from '@deepseek-ai/dsh-host-invite-auth/types'
import { Config } from './config.ts'
import { loginAppearance } from './login.ts'
export { Config } from './config.ts'

/**
 * Add presentation when invite-auth is mounted, without creating authentication routes.
 * @param ctx - Host plugin context.
 * @param config - public appearance defaults serialized to the Client.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.inject(['invitePage'], (owner) => {
    const page = owner.get('invitePage') as InvitePageRegistry
    owner.effect(() => page.register(loginAppearance(config)))
  })
}
