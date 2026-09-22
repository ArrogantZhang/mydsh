// @vitest-environment jsdom
/** Family controls change appearance and drafts without taking over the Composer. */
import { cleanup, fireEvent, render } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { Config } from '../src/config.ts'
import { FamilyHero, FamilySettings } from '../src/client/components.tsx'
import { zh } from '../src/client/locales.ts'
import type { FamilyProps } from '../src/client/props.ts'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { Modal } from '@deepseek-ai/dsh-client-ui-primitives'

afterEach(cleanup)
const appearance = { preferences: Config({}), persistent: true }
const cover = { busy: false }
const common = {
  usePreferences: (select: (value: typeof appearance) => unknown) => select(appearance),
  useCover: (select: (value: typeof cover) => unknown) => select(cover),
  useSkin: (select: (value: { active: boolean; conflict: boolean }) => unknown) => select({ active: true, conflict: false }),
  t: (key: keyof typeof zh) => zh[key], save: vi.fn(), upload: vi.fn(), remove: vi.fn(), refresh: vi.fn(),
}

it('shows the family name and greeting and fills a draft without submitting it', () => {
  const setDraft = vi.fn()
  const submit = vi.fn()
  const view = render(<FamilyHero {...common as unknown as FamilyProps & PropsRuntime<'conversation.hero.content'>} inputActions={{ setDraft, submit } as never} />)
  expect(view.getByText('回来啦，先歇一会儿。')).toBeTruthy()
  expect(view.getByText('封面由受邀家人共享')).toBeTruthy()
  expect((view.getByRole('button', { name: '上传家庭照片' }) as HTMLButtonElement).disabled).toBe(true)
  fireEvent.click(view.getByRole('button', { name: '今天吃什么' }))
  expect(setDraft).toHaveBeenCalledWith(zh['draft.meal'])
  expect(submit).not.toHaveBeenCalled()
})

it('saves personal text and never removes a shared photo without confirmation', () => {
  const remove = vi.fn()
  const save = vi.fn()
  const photo = { busy: false, cover: { revision: '0', cover: { width: 10, height: 10 } }, url: 'blob:shared' }
  const view = render(<FamilySettings {...common as unknown as FamilyProps} save={save} remove={remove}
    useCover={((select: (value: typeof photo) => unknown) => select(photo)) as never} />)
  fireEvent.change(view.getByLabelText('小屋名称'), { target: { value: '温暖的家' } })
  fireEvent.click(view.getByRole('button', { name: '保存设置' }))
  expect(save).toHaveBeenCalledWith({ ...Config({}), name: '温暖的家' })
  fireEvent.click(view.getByRole('button', { name: '移除共享照片' }))
  expect(view.getByRole('dialog', { name: '移除大家的封面？' })).toBeTruthy()
  expect(remove).not.toHaveBeenCalled()
  fireEvent.click(view.getByRole('button', { name: '确认移除' }))
  expect(remove).toHaveBeenCalledOnce()
})

it('keeps Escape inside removal confirmation without closing its parent settings dialog', () => {
  const closeSettings = vi.fn()
  const photo = { busy: false, cover: { revision: '0', cover: { width: 10, height: 10 } }, url: 'blob:shared' }
  const view = render(<Modal open title="Settings" closeLabel="Close settings" onClose={closeSettings}>
    <FamilySettings {...common as unknown as FamilyProps}
      useCover={((select: (value: typeof photo) => unknown) => select(photo)) as never} />
  </Modal>)
  fireEvent.click(view.getByRole('button', { name: '移除共享照片' }))
  const cancel = view.getByRole('button', { name: '先留着' })
  expect(document.activeElement).toBe(cancel)
  fireEvent.keyDown(cancel, { key: 'Escape' })
  expect(closeSettings).not.toHaveBeenCalled()
  expect(view.queryByRole('dialog', { name: '移除大家的封面？' })).toBeNull()
})
