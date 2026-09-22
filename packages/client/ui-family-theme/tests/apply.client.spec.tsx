// @vitest-environment jsdom
/** Production slot registry and renderer verify family activation and full disposal. */
import { act, fireEvent } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { SlotTestRuntime, stubSettingsScope } from '@deepseek-ai/dsh-client-test-runtime'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
import { LocaleRuntime } from '@deepseek-ai/dsh-client-locale/client'
import { ThemeRuntime, type ThemeSettings } from '@deepseek-ai/dsh-client-ui-theme/client'
import type { ConnectionGeneration } from '@deepseek-ai/dsh-client-connection/client'
import { apply, inject, Config } from '../src/client/index.ts'
import { PREFERENCE_KEY } from '../src/preferences.ts'

const runtimes: SlotTestRuntime[] = []
const restorers: (() => void)[] = []
it('waits for the generated shared-cover namespace before making its first request', () => {
  expect(inject).toContain('remote.familyCover')
  expect(inject).toContain('remote')
})
afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.dispose()
  for (const restore of restorers.splice(0)) restore()
})

async function bench() {
  const previous = localStorage.getItem(PREFERENCE_KEY)
  localStorage.removeItem(PREFERENCE_KEY)
  restorers.push(() => {
    if (previous === null) localStorage.removeItem(PREFERENCE_KEY)
    else localStorage.setItem(PREFERENCE_KEY, previous)
  })
  const runtime = await SlotTestRuntime.create()
  runtimes.push(runtime)
  const { ctx } = runtime
  runtime.remote.provideNamespaces({ familyCover: {} })
  ctx.provide('locale', new LocaleRuntime(ctx))
  runtime.slots.installLocale(ctx.locale)
  ctx.provide('theme', new ThemeRuntime(ctx, stubSettingsScope<ThemeSettings>().scope))
  const generation = createSnapshotStore<ConnectionGeneration | undefined>(undefined)
  ctx.provide('connection', { generation } as never)
  await runtime.declare({
    'sidebar.brand.mark': { kind: 'single', scope: 'root' }, 'sidebar.brand.name': { kind: 'single', scope: 'root' },
    'shell.document.title': { kind: 'single', scope: 'root' }, 'conversation.hero.content': { kind: 'single', scope: 'session-maybe' },
    'settings.general.item': { kind: 'list', scope: 'root' },
  })
  const feature = await runtime.mount({ inject, apply: (owned) => { apply(owned, Config({})) } })
  return { runtime, feature }
}

it('renders personal branding, saves the name, and releases every occupied seat when disabled', async () => {
  const { runtime, feature } = await bench()
  const brand = runtime.renderSlot('sidebar.brand.name', {})
  expect(brand.view.getByText('家人小屋')).toBeTruthy()
  const settings = runtime.renderSlot('settings.general.item', {}, { only: 'family-home' })
  fireEvent.change(settings.view.getByLabelText(/Home name|小屋名称/), { target: { value: '我们的小家' } })
  await act(async () => { fireEvent.click(settings.view.getByRole('button', { name: /Save settings|保存设置/ })) })
  expect(brand.view.getByText('我们的小家')).toBeTruthy()
  await act(async () => { fireEvent.click(settings.view.getByRole('switch')) })
  expect(runtime.slots.entries('sidebar.brand.name')).toHaveLength(0)
  expect(runtime.slots.entries('conversation.hero.content')).toHaveLength(0)
  expect(runtime.ctx.theme.getTheme().active.id).toBe('light')
  expect(JSON.parse(localStorage.getItem(PREFERENCE_KEY)!)).toMatchObject({ enabled: false })
  await feature.dispose()
  expect(runtime.slots.entries('settings.general.item')).toHaveLength(0)
  expect(runtime.ctx.theme.getTheme().themes.map(theme => theme.id)).toEqual(['light', 'dark'])
})
