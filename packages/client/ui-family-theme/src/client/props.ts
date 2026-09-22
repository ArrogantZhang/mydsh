/** Family presentation inputs bound by the slot framework. */
import type { HostObservable, InjectFace, PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { Config } from '../config.ts'
import type { PreferenceSnapshot } from '../preferences.ts'
import type { CoverClientSnapshot } from './cover-client.ts'
import type { SkinSnapshot } from './appearance.ts'
import type { FamilyKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap { family: FamilyKey }
}

/** Runtime-side sources and commands; components receive framework-generated hooks. */
export interface FamilyInjected {
  readonly hooks: {
    readonly preferences: HostObservable<PreferenceSnapshot>
    readonly cover: HostObservable<CoverClientSnapshot>
    readonly skin: HostObservable<SkinSnapshot>
  }
  /** @param value - validated complete personal preferences. */
  save(value: Config): void
  /** @param file - explicitly selected photo. */
  upload(file: File): void
  /** Remove the shared cover after UI confirmation. */
  remove(): void
  /** Refresh the server-shared cover. */
  refresh(): void
}

/** Plain UI callbacks, localized text, and framework-bound selectors. */
export type FamilyProps = InjectFace<FamilyInjected> & PropsLocale<'family'>
