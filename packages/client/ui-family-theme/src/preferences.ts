/** Browser-local appearance, separate from the Host's shared cover. */
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { Config } from './config.ts'
/** Versioned browser-local appearance key, also read by the fixed login bootstrap. */
export const PREFERENCE_KEY = 'dsh.family-home.v1'

/** Observable personal preferences and persistence availability. */
export interface PreferenceSnapshot {
  readonly preferences: Config
  readonly persistent: boolean
}

/**
 * Validate one stored record without accepting shared image data or arbitrary markup.
 * @param raw - serialized localStorage record.
 * @param defaults - validated deployment defaults.
 * @returns valid personal preferences or the deployment defaults.
 */
export function readPreferences(raw: string | null, defaults: Config): Config {
  if (raw === null || raw.length > 2048) return defaults
  try {
    const value: unknown = JSON.parse(raw)
    if (typeof value !== 'object' || value === null || !('version' in value) || value.version !== 1
      || !('enabled' in value) || typeof value.enabled !== 'boolean'
      || !('name' in value) || typeof value.name !== 'string'
      || !('greeting' in value) || typeof value.greeting !== 'string'
      || !('palette' in value) || !['morning', 'garden', 'evening'].includes(String(value.palette))) return defaults
    return Config({ enabled: value.enabled, name: value.name, greeting: value.greeting, palette: value.palette as Config['palette'] })
  } catch { return defaults }
}

/** One stable observable source for browser-local appearance. */
export class FamilyPreferences {
  private readonly state = createSnapshotStore<PreferenceSnapshot>({ preferences: Config({}), persistent: true })
  /** @param defaults - validated deployment defaults. @param storage - browser storage or undefined when blocked. */
  constructor(private readonly defaults: Config, private readonly storage?: Pick<Storage, 'getItem' | 'setItem'>) { this.reload() }

  /** Read personal preferences. @returns immutable appearance snapshot, stable until a change. */
  getSnapshot = (): PreferenceSnapshot => this.state.getSnapshot()
  /**
   * Observe local preference changes.
   * @param listener - invalidation callback.
   * @returns subscription disposer.
   */
  subscribe = (listener: () => void): (() => void) => this.state.subscribe(listener)

  /** Adopt another tab's validated local preferences. */
  reload(): void {
    try {
      if (this.storage === undefined) throw new Error('Browser storage unavailable')
      this.state.set({ preferences: readPreferences(this.storage.getItem(PREFERENCE_KEY), this.defaults), persistent: true })
    } catch { this.state.set({ preferences: this.defaults, persistent: false }) }
  }

  /**
   * Validate and save personal preferences; storage refusal keeps an in-memory choice and reports it.
   * @param value - complete next personal preferences.
   */
  save(value: Config): void {
    const preferences = Config(value)
    let persistent = true
    try {
      if (this.storage === undefined) throw new Error('Browser storage unavailable')
      this.storage.setItem(PREFERENCE_KEY, JSON.stringify({ version: 1, ...preferences }))
    } catch { persistent = false }
    this.state.set({ preferences, persistent })
  }
}
