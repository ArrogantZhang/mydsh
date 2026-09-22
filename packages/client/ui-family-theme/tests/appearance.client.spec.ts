// @vitest-environment jsdom
/** Family palette activation is local and releases exactly its own contributions. */
import { Context } from '@deepseek-ai/cordis'
import { stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { ThemeRuntime, type ThemeSettings } from '@deepseek-ai/dsh-client-ui-theme/client'
import { expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { FamilyPreferences } from '../src/preferences.ts'
import { SkinController } from '../src/client/appearance.ts'

it('activates the saved palette, follows personal changes, and restores stock without Host writes', async () => {
  const ctx = new Context()
  const host = stubSettingsScope<ThemeSettings>()
  const theme = new ThemeRuntime(ctx, host.scope)
  const preferences = new FamilyPreferences(Config({}), { getItem: () => null, setItem: () => {} })
  const unmount = vi.fn()
  const mount = vi.fn(() => unmount)
  const skin = new SkinController(theme, preferences, () => 'ready', mount)
  try {
    expect(theme.getTheme().active.id).toBe('family-morning')
    preferences.save({ ...Config({}), palette: 'evening' })
    expect(theme.getTheme().active.colorScheme).toBe('dark')
    expect(mount).toHaveBeenCalledOnce()
    preferences.save({ ...Config({}), enabled: false })
    expect(unmount).toHaveBeenCalledOnce()
    expect(theme.getTheme().active.id).toBe('light')
    expect(host.set).not.toHaveBeenCalled()
  } finally { skin.dispose(); await ctx.fiber.dispose() }
  expect(theme.getTheme().themes.map(row => row.id)).toEqual(['light', 'dark'])
})

it('refuses occupied branding without changing an existing theme', async () => {
  const ctx = new Context()
  const theme = new ThemeRuntime(ctx, stubSettingsScope<ThemeSettings>().scope)
  const preferences = new FamilyPreferences(Config({}))
  const mount = vi.fn(() => () => {})
  const skin = new SkinController(theme, preferences, () => 'conflict', mount)
  try {
    expect(skin.getSnapshot()).toEqual({ active: false, conflict: true })
    expect(theme.getTheme().active.id).toBe('light')
    expect(mount).not.toHaveBeenCalled()
  } finally { skin.dispose(); await ctx.fiber.dispose() }
})

it('unwinds partial palette registration when another package already owns a family palette id', async () => {
  const ctx = new Context()
  const theme = new ThemeRuntime(ctx, stubSettingsScope<ThemeSettings>().scope)
  const removeForeign = theme.register({ id: 'family-garden', colorScheme: 'light', tokens: {} })
  try {
    expect(() => new SkinController(theme, new FamilyPreferences(Config({})), () => 'ready', () => () => {})).toThrow('already registered')
    expect(theme.getTheme().themes.map(row => row.id)).toEqual(['light', 'dark', 'family-garden'])
  } finally { removeForeign(); await ctx.fiber.dispose() }
})

it('preserves an existing token override instead of applying a conflicting palette', async () => {
  const ctx = new Context()
  const theme = new ThemeRuntime(ctx, stubSettingsScope<ThemeSettings>().scope)
  const removeOverride = theme.overrideTokens('another-theme', { '--dsw-alias-brand-primary': { light: '#222222', dark: '#eeeeee' } })
  const mount = vi.fn(() => () => {})
  const skin = new SkinController(theme, new FamilyPreferences(Config({})), () => 'ready', mount)
  try {
    expect(skin.getSnapshot()).toEqual({ active: false, conflict: true })
    expect(theme.getTheme().active.tokens['--dsw-alias-brand-primary']).toBe('#222222')
    expect(mount).not.toHaveBeenCalled()
  } finally { skin.dispose(); removeOverride(); await ctx.fiber.dispose() }
})
