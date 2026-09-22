/** Family skin composition over public presentation seats and authenticated shared-cover transport. */
import type { Context } from '@deepseek-ai/cordis'
import type { RemoteResult } from '@deepseek-ai/dsh-api-remotes/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type { StoredEntry } from '@deepseek-ai/dsh-client-ui-slots'
import { Config } from '../config.ts'
import { FamilyPreferences, PREFERENCE_KEY } from '../preferences.ts'
import { SkinController } from './appearance.ts'
import { CoverClient, CoverFailure, type CoverFailureReason } from './cover-client.ts'
import { FamilyHero, FamilyMark, FamilyName, FamilySettings, FamilyTitle } from './components.tsx'
import type { FamilyInjected } from './props.ts'
import { en, zh } from './locales.ts'

export { Config } from '../config.ts'

/** Required Client services; Session and sidebar owners are tracked through their slot declarations. */
export const inject = ['slots', 'theme', 'locale', 'remote', 'remote.familyCover', 'connection']

const SEATS = ['sidebar.brand.mark', 'sidebar.brand.name', 'shell.document.title', 'conversation.hero.content'] as const

function unwrap<T>(result: RemoteResult<T>): T {
  if (result.ok) return result.value
  if (result.error.code === 'family-cover/failed') {
    const reason = result.error.details.reason
    const localized: CoverFailureReason = reason === 'corrupt' || reason === 'not-found' ? 'unavailable' : reason
    throw new CoverFailure(localized)
  }
  throw new CoverFailure('unavailable')
}

/**
 * Register reversible family UI and per-browser preferences; never mutate shared theme settings.
 * @param ctx - Client plugin lifetime.
 * @param config - validated public defaults.
 */
export function apply(ctx: Context, config: Config): void {
  ctx.effect(() => ctx.locale.register('family', { zh, en }))
  ctx.effect(() => {
    let storage: Storage | undefined
    try { storage = window.localStorage } catch { /* Browser storage can be denied independently of the page. */ }
    const preferences = new FamilyPreferences(config, storage)
    const connection = ctx.get('connection') as ConnectionHandle
    const cover = new CoverClient({
      current: async signal => unwrap(await ctx.remote.familyCover.current(signal)),
      remove: async (revision, signal) => unwrap(await ctx.remote.familyCover.removeCover(revision, signal)),
      fetch: (url, init) => fetch(url, init),
      createUrl: blob => URL.createObjectURL(blob), revokeUrl: (url) => { URL.revokeObjectURL(url) },
    })
    const owned = new Set<StoredEntry>()
    const injected = (): FamilyInjected => ({
      hooks: { preferences, cover, skin }, save: (value) => { preferences.save(value) },
      upload: (file) => { if (skin.getSnapshot().active) void cover.upload(file) },
      remove: () => { if (skin.getSnapshot().active) void cover.remove() },
      refresh: () => { if (skin.getSnapshot().active) void cover.refresh() },
    })
    const availability = (): 'ready' | 'waiting' | 'conflict' => {
      if (SEATS.some(seat => ctx.slots.spec(seat) === undefined)) return 'waiting'
      return SEATS.some(seat => ctx.slots.entries(seat).some(entry => !owned.has(entry))) ? 'conflict' : 'ready'
    }
    const skin = new SkinController(ctx.theme, preferences, availability, () => {
      const mount = (seat: typeof SEATS[number], register: () => () => void): (() => void) => ctx.slots.inject(seat, () => {
        const previous = new Set(ctx.slots.entries(seat))
        const dispose = register()
        const entries = ctx.slots.entries(seat).filter(entry => !previous.has(entry))
        for (const entry of entries) owned.add(entry)
        return () => { dispose(); for (const entry of entries) owned.delete(entry) }
      })
      const disposers = [
        mount('sidebar.brand.mark', () => ctx.slots.register({ name: 'sidebar.brand.mark' }, FamilyMark)),
        mount('sidebar.brand.name', () => ctx.slots.register({ name: 'sidebar.brand.name', inject: injected }, FamilyName)),
        mount('shell.document.title', () => ctx.slots.register({ name: 'shell.document.title', inject: injected }, FamilyTitle)),
        mount('conversation.hero.content', () => ctx.slots.register({ name: 'conversation.hero.content', locale: 'family', inject: injected }, FamilyHero)),
      ]
      return () => { for (const dispose of disposers.reverse()) dispose(); owned.clear() }
    })
    const disposeSettings = ctx.slots.inject('settings.general.item', () =>
      ctx.slots.register({ name: 'settings.general.item', id: 'family-home', order: 60, locale: 'family', inject: injected }, FamilySettings))
    const subscriptions = SEATS.map(seat => ctx.slots.subscribe(seat, () => { skin.sync() }))
    const onFocus = (): void => { if (skin.getSnapshot().active && connection.generation.getSnapshot() !== undefined) void cover.refresh() }
    const onStorage = (event: StorageEvent): void => { if (event.key === PREFERENCE_KEY || event.key === null) preferences.reload() }
    const onGeneration = (): void => { cover.clear(); onFocus() }
    const disposeGeneration = connection.generation.subscribe(onGeneration)
    const disposeSkin = skin.subscribe(() => { if (skin.getSnapshot().active) onFocus(); else cover.clear() })
    const disposeTheme = ctx.on('theme/change', () => { skin.sync() })
    window.addEventListener('focus', onFocus)
    window.addEventListener('storage', onStorage)
    onFocus()
    return async () => {
      window.removeEventListener('focus', onFocus)
      window.removeEventListener('storage', onStorage)
      disposeGeneration(); disposeSkin(); disposeTheme()
      for (const dispose of subscriptions) dispose()
      disposeSettings(); skin.dispose()
      await cover.dispose()
    }
  })
}
