/** Browser preferences contain no shared image bytes or authentication secrets. */
import { expect, it } from 'vitest'
import { Config } from '../src/config.ts'
import { FamilyPreferences, PREFERENCE_KEY } from '../src/preferences.ts'

function storage() {
  const data = new Map<string, string>()
  return { data, getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value) } }
}

it('uses validated defaults and retains only personal preferences across instances', () => {
  const disk = storage()
  const defaults = Config({})
  const state = new FamilyPreferences(defaults, disk)
  expect(state.getSnapshot().preferences).toEqual({ enabled: true, name: '家人小屋', greeting: '回来啦，先歇一会儿。', palette: 'morning' })
  state.save({ ...defaults, name: '我们家', palette: 'garden' })
  expect(new FamilyPreferences(defaults, disk).getSnapshot().preferences.name).toBe('我们家')
  expect(JSON.parse(disk.data.get(PREFERENCE_KEY)!)).toEqual({ version: 1, enabled: true, name: '我们家', greeting: defaults.greeting, palette: 'garden' })
})

it('refuses unsafe saved values and counts names as Unicode characters', () => {
  const disk = storage()
  disk.setItem(PREFERENCE_KEY, JSON.stringify({ version: 1, enabled: true, name: 'x'.repeat(17), greeting: 'ok', palette: 'morning', photo: 'data:secret' }))
  const state = new FamilyPreferences(Config({}), disk)
  expect(state.getSnapshot().preferences.name).toBe('家人小屋')
  expect(() => { state.save({ ...Config({}), name: '🏡'.repeat(16) }) }).not.toThrow()
  expect(() => { state.save({ ...Config({}), greeting: 'x'.repeat(33) }) }).toThrow()
  expect(() => Config({ palette: 'unknown' } as never)).toThrow()
})

it('keeps memory preferences usable and reports unavailable browser storage', () => {
  const state = new FamilyPreferences(Config({}), { getItem() { throw new Error('blocked') }, setItem() { throw new Error('quota') } })
  expect(state.getSnapshot().persistent).toBe(false)
  state.save({ ...Config({}), enabled: false })
  expect(state.getSnapshot().preferences.enabled).toBe(false)
  expect(state.getSnapshot().persistent).toBe(false)
})
