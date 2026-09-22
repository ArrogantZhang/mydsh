/** Public defaults for browser-local family appearance. */
import z from '@deepseek-ai/schemastery'

/** Initial appearance; a valid browser preference takes precedence. */
export interface FamilyAppearance {
  /** Enable the skin in browsers without a saved choice. */
  enabled: boolean
  /** Plain-text family name, at most 16 Unicode characters. */
  name: string
  /** Plain-text welcome line, at most 32 Unicode characters. */
  greeting: string
  /** Initial family palette. */
  palette: 'morning' | 'garden' | 'evening'
}

/** Public plugin defaults use the same fields as personal appearance. */
export type Config = FamilyAppearance

/** Validated public defaults shared by the Host bootstrap and Client. */
export const Config: z<Partial<FamilyAppearance>, FamilyAppearance> = z.object({
  enabled: z.boolean().default(true),
  name: z.string().pattern(/^[^\p{Cc}]{1,16}$/u).default('家人小屋'),
  greeting: z.string().pattern(/^[^\p{Cc}]{1,32}$/u).default('回来啦，先歇一会儿。'),
  palette: z.union([z.const('morning'), z.const('garden'), z.const('evening')]).default('morning'),
})
