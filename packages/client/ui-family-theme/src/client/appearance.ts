/** Reversible family palette and presentation ownership. */
import type { ThemeRuntime } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { FamilyPreferences } from '../preferences.ts'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { PALETTES, paletteTokens } from '../palettes.ts'
import type { Config } from '../config.ts'

/** Activation facts, distinct from the user's saved enablement choice. */
export interface SkinSnapshot { readonly active: boolean; readonly conflict: boolean }

/** Local skin activation, conditional on the existing presentation owners. */
export class SkinController {
  private readonly state = createSnapshotStore<SkinSnapshot>({ active: false, conflict: false })
  private readonly unregister: (() => void)[] = []
  private unsubscribe: (() => void) | undefined
  private releaseSlots: (() => void) | undefined
  private releasePalette: (() => void) | undefined
  private palette: Config['palette'] | undefined
  private updating = false
  private disposed = false

  /**
   * @param theme - shared theme registry, never written through its durable preference setter.
   * @param preferences - browser-local appearance.
   * @param availability - whether required seats exist and have no foreign occupant.
   * @param mount - effect-owned presentation registrations, returning their disposer.
   */
  constructor(private readonly theme: ThemeRuntime, private readonly preferences: FamilyPreferences,
    private readonly availability: () => 'ready' | 'waiting' | 'conflict', private readonly mount: () => () => void) {
    try {
      for (const id of Object.keys(PALETTES) as Config['palette'][]) {
        this.unregister.push(theme.register({ id: `family-${id}`, colorScheme: id === 'evening' ? 'dark' : 'light', tokens: paletteTokens(id) }))
      }
      this.unsubscribe = preferences.subscribe(() => { this.sync() })
      this.sync()
    } catch (error) {
      this.dispose()
      throw error
    }
  }

  /** Read activation facts. @returns stable activation facts. */
  getSnapshot = (): SkinSnapshot => this.state.getSnapshot()
  /**
   * Observe activation changes.
   * @param listener - invalidation callback.
   * @returns subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  /** Reconcile personal enablement with presentation availability. */
  sync(): void {
    if (this.disposed || this.updating) return
    this.updating = true
    try {
      const prefs = this.preferences.getSnapshot().preferences
      const available = this.availability()
      const snapshot = this.theme.getTheme()
      const expected = this.palette === undefined ? undefined : paletteTokens(this.palette)
      const foreign = !['light', 'dark', 'system'].includes(snapshot.preference)
        || (expected === undefined
          ? !['light', 'dark'].includes(snapshot.active.id) || Object.keys(snapshot.active.tokens).length > 0
          : snapshot.active.id !== `family-${this.palette}`
            || Object.entries(expected).some(([token, value]) => snapshot.active.tokens[token] !== value))
      if (!prefs.enabled || available !== 'ready' || foreign) {
        this.releaseSlots?.(); this.releaseSlots = undefined
        this.releasePalette?.(); this.releasePalette = undefined; this.palette = undefined
        this.set(false, prefs.enabled && (available === 'conflict' || foreign))
        return
      }
      this.releaseSlots ??= this.mount()
      if (this.palette !== prefs.palette) {
        const release = this.theme.present(`family-${prefs.palette}`)
        this.releasePalette?.()
        this.releasePalette = release
        this.palette = prefs.palette
      }
      this.set(true, false)
    } finally { this.updating = false }
  }

  /** Remove only owned presentation layers and registrations. */
  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.unsubscribe?.()
    this.releaseSlots?.()
    this.releasePalette?.()
    for (const dispose of this.unregister.reverse()) dispose()
    this.set(false, false)
  }

  private set(active: boolean, conflict: boolean): void {
    const previous = this.state.getSnapshot()
    if (previous.active !== active || previous.conflict !== conflict) this.state.set({ active, conflict })
  }
}
