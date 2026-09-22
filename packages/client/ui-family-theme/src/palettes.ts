/** Family palette values shared by the Client and fixed login presentation. */
import type { Config } from './config.ts'

/** Named surfaces and readable text/accent pairs. */
export const PALETTES = {
  morning: { background: '#FFF9F1', paper: '#FFFDF8', surface: '#F5EBDF', accent: '#AC492B', text: '#4E382C', muted: '#705F53', onAccent: '#FFFDF8' },
  garden: { background: '#F7F8EF', paper: '#FFFDF8', surface: '#EBEFDF', accent: '#46654C', text: '#344738', muted: '#5C6859', onAccent: '#FFFDF8' },
  evening: { background: '#29231F', paper: '#332C26', surface: '#3E352D', accent: '#F0AE7C', text: '#F8E8D3', muted: '#D0BFA9', onAccent: '#392A20' },
} satisfies Record<Config['palette'], { background: string; paper: string; surface: string; accent: string; text: string; muted: string; onAccent: string }>

/**
 * Map family colors onto the shared UI's documented semantic variables.
 * @param palette - selected family palette.
 * @returns alias and component-specific tokens, including local illustration/layout accents.
 */
export function paletteTokens(palette: Config['palette']): Record<string, string> {
  const p = PALETTES[palette]
  return {
    '--dsw-alias-bg-base': p.background,
    '--dsw-alias-bg-layer-1': p.paper, '--dsw-alias-bg-layer-2': p.surface, '--dsw-alias-bg-layer-3': p.paper,
    '--dsw-alias-label-primary': p.text, '--dsw-alias-label-secondary': p.muted, '--dsw-alias-label-tertiary': p.muted,
    '--dsw-alias-label-caption': p.muted, '--dsw-alias-label-primary-bluish': p.text,
    '--dsw-alias-label-primary-foreground': p.onAccent, '--dsw-alias-label-primary-inverted': p.onAccent,
    '--dsw-alias-brand-primary': p.accent, '--dsw-alias-brand-text': p.accent,
    '--dsw-alias-brand-primary-new-colorprimary-new-color': p.accent,
    '--dsw-alias-button-primary-fill': p.accent, '--dsw-alias-button-primary-hover': `color-mix(in srgb, ${p.accent} 90%, ${p.text})`,
    '--dsw-alias-button-elevated-fill': p.paper, '--dsw-alias-button-floating-fill': p.paper,
    '--dsw-alias-button-floating-hover': p.surface, '--dsw-alias-button-primary-dimmed': p.surface,
    '--dsw-alias-button-ghost-active-fill': p.surface, '--dsw-alias-button-ghost-active-hover': p.surface,
    '--dsw-alias-button-info-fill': p.accent, '--dsw-alias-button-info-hover': p.accent,
    '--dsw-alias-interactive-bg-hover': `color-mix(in srgb, ${p.accent} 8%, transparent)`,
    '--dsw-alias-interactive-bg-active': `color-mix(in srgb, ${p.accent} 14%, transparent)`,
    '--dsw-alias-interactive-bg-hover-solid': p.surface,
    '--dsw-alias-link': p.accent, '--dsw-alias-state-business-primary': p.accent, '--dsw-alias-state-business-tertiary': p.surface,
    '--dsw-alias-border-l1': `color-mix(in srgb, ${p.text} 10%, transparent)`,
    '--dsw-alias-border-l2': `color-mix(in srgb, ${p.text} 18%, transparent)`,
    '--dsw-alias-border-l3': `color-mix(in srgb, ${p.text} 26%, transparent)`,
    '--dsw-specific-sidebar-fill': p.surface, '--dsw-specific-sidebar-nav-item-active': p.paper,
    '--dsw-specific-sidebar-nav-item-active-accent': p.paper, '--dsw-specific-sidebar-nav-item-hover': p.background,
    '--dsw-specific-input-major': p.paper, '--dsw-specific-bubble': p.surface,
    '--dsw-specific-selector': p.surface, '--dsw-specific-tip': p.surface,
    '--dsw-alias-family-paper': p.paper, '--dsw-alias-family-surface': p.surface,
  }
}
