/** Family presentation leaves the ordinary Session, Composer, and authorization controls with their owners. */
import { useEffect, useId, useRef, useState } from 'react'
import { Button, Input, Modal, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { Config } from '../config.ts'
import type { FamilyProps } from './props.ts'
import type { CoverClientSnapshot } from './cover-client.ts'
import { HOME_SCENE } from './home-scene.ts'
import css from './Family.module.css'

/**
 * Render the sidebar's house mark using the active brand color.
 * @param props - sidebar-requested mark geometry.
 * @returns a decorative house mark.
 */
export function FamilyMark({ size }: { size: number }) {
  return <svg width={size} height={size} viewBox="0 0 36 36" fill="none" aria-hidden="true" className={css.mark}>
    <path d="M5 17 18 6l13 11M9 16v14h18V16" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    <path d="M14 30V20h8v10" stroke="currentColor" strokeWidth="2.2" strokeLinejoin="round" />
    <path d="M25 7v6" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" />
  </svg>
}

/**
 * Render the browser-local family name as plain text.
 * @param props - bound local preferences.
 * @returns the user's family name.
 */
export function FamilyName({ usePreferences }: Pick<FamilyProps, 'usePreferences'>) {
  const name = usePreferences(state => state.preferences.name)
  return <span className={css.brand}>{name}</span>
}

/**
 * Preserve the Session title prefix and restore the supplied stock title on withdrawal.
 * @param props - root Session selection and local name.
 * @returns no visible DOM.
 */
export function FamilyTitle({ useSessions, usePanelInfo, usePreferences, productTitle }:
  PropsRuntime<'shell.document.title'> & Pick<FamilyProps, 'usePreferences'>): null {
  const name = usePreferences(state => state.preferences.name)
  const conversation = usePanelInfo(info => info.activePanelId === null)
  const title = useSessions(state => conversation
    ? Object.values(state.byId).find(row => (row.retainedBy.mainView ?? 0) > 0)?.title : undefined)
  useEffect(() => {
    document.title = title === undefined ? name : `${title} — ${name}`
    return () => { document.title = productTitle }
  }, [name, title, productTitle])
  return null
}

function PhotoPicker({ t, upload, cover, enabled = true }:
  Pick<FamilyProps, 't' | 'upload'> & { cover: CoverClientSnapshot; enabled?: boolean }) {
  const input = useRef<HTMLInputElement>(null)
  const disabled = cover.busy || cover.cover === undefined || !enabled
  return <>
    <input ref={input} type="file" className={css.file} accept="image/jpeg,image/png,image/webp" tabIndex={-1}
      aria-label={t('upload')} disabled={disabled}
      onChange={(event) => { const file = event.currentTarget.files?.[0]; event.currentTarget.value = ''; if (file !== undefined) upload(file) }} />
    <Button variant="outline" disabled={disabled} onClick={() => input.current?.click()}>
      {cover.busy ? t('working') : t(cover.url === undefined ? 'upload' : 'replace')}
    </Button>
  </>
}

/**
 * Render the family welcome and photo without owning the Composer.
 * @param props - session-maybe input actions and family presentation facts.
 * @returns the family home above the native Composer.
 */
export function FamilyHero({ usePreferences, useCover, inputActions, t, upload, refresh }: FamilyProps & PropsRuntime<'conversation.hero.content'>) {
  const preferences = usePreferences(state => state.preferences)
  const cover = useCover(state => state)
  return <section className={css.hero} aria-label={preferences.name} data-family-home>
    <div className={css.welcome}>
      <p className={css.eyebrow}><FamilyMark size={20} />{t('eyebrow')}</p>
      <h1>{preferences.greeting}</h1>
      <p className={css.subtitle}>{t('welcome')}</p>
    </div>
    <figure className={css.photo}>
      <img src={cover.url ?? HOME_SCENE} alt={t(cover.url === undefined ? 'illustrationAlt' : 'coverAlt')} />
      <figcaption>
        <span className={css.caption}><span>{preferences.name}</span><small>{t('sharedBadge')}</small></span>
        <PhotoPicker t={t} upload={upload} cover={cover} />
      </figcaption>
    </figure>
    {cover.error !== undefined && <p role="alert" className={css.notice}>
      {t(`error.${cover.error}`)} <Button size="sm" onClick={refresh}>{t('retry')}</Button>
    </p>}
    <div className={css.starters} aria-label={t('draftHint')}>
      {(['meal', 'trip', 'story'] as const).map(key => <Button key={key} className={css.starter} disabled={inputActions === undefined}
        title={t('draftHint')} onClick={() => inputActions?.setDraft(t(`draft.${key}`))}>{t(`starter.${key}`)}<span aria-hidden="true">↗</span></Button>)}
    </div>
  </section>
}

function ConfirmRemoval({ t, onCancel, onConfirm }: Pick<FamilyProps, 't'> & { onCancel: () => void; onConfirm: () => void }) {
  const content = useRef<HTMLDivElement>(null)
  useEffect(() => {
    const previous = document.activeElement
    content.current?.querySelector('button')?.focus()
    return () => { if (previous instanceof HTMLElement && previous.isConnected) previous.focus() }
  }, [])
  return <Modal open headless title={t('deleteTitle')} onClose={onCancel}>
    <div ref={content} className={css.confirm} onKeyDown={(event) => {
      if (event.key === 'Escape') { event.stopPropagation(); onCancel(); return }
      if (event.key !== 'Tab') return
      const buttons = content.current?.querySelectorAll('button')
      const first = buttons?.[0]
      const last = buttons?.[1]
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus() }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus() }
    }}>
      <h2>{t('deleteTitle')}</h2><p>{t('deleteMessage')}</p>
      <div className={css.actions}>
        <Button variant="outline" onClick={onCancel}>{t('cancel')}</Button>
        <Button variant="primary" onClick={onConfirm}>{t('confirm')}</Button>
      </div>
    </div>
  </Modal>
}

/**
 * Render personal appearance settings and confirmation-protected shared-cover controls.
 * @param props - local preference commands and authorized shared-cover controls.
 * @returns the family settings section.
 */
export function FamilySettings({ usePreferences, useCover, useSkin, save, upload, remove, refresh, t }: FamilyProps) {
  const { preferences, persistent } = usePreferences(state => state)
  const cover = useCover(state => state)
  const skin = useSkin(state => state)
  const [draft, setDraft] = useState(preferences)
  const [notice, setNotice] = useState<'saved' | 'invalid'>()
  const [confirm, setConfirm] = useState(false)
  const nameId = useId()
  const greetingId = useId()
  useEffect(() => { setDraft(preferences) }, [preferences])
  return <section className={css.settings} aria-label={t('settings')}>
    <div className={css.settingsHeader}><h3>{t('settings')}</h3><Switch checked={preferences.enabled} label={t('enabled')}
      onChange={(enabled) => { save({ ...preferences, enabled }) }} /></div>
    <p>{t('personal')}</p>
    {!persistent && <p role="status">{t('localWarning')}</p>}
    {skin.conflict && <p role="alert">{t('conflictWarning')}</p>}
    <div className={css.fields}>
      <label htmlFor={nameId}>{t('name')}</label><Input id={nameId} value={draft.name} onChange={(event) => { setDraft({ ...draft, name: event.currentTarget.value }) }} />
      <label htmlFor={greetingId}>{t('greeting')}</label><Input id={greetingId} value={draft.greeting} onChange={(event) => { setDraft({ ...draft, greeting: event.currentTarget.value }) }} />
    </div>
    <fieldset className={css.palettes}><legend>{t('palette')}</legend>
      {(['morning', 'garden', 'evening'] as const).map(palette => <Button key={palette} variant={draft.palette === palette ? 'primary' : 'outline'}
        aria-pressed={draft.palette === palette} onClick={() => { setDraft({ ...draft, palette }) }}>{t(palette)}</Button>)}
    </fieldset>
    <div className={css.actions}><Button variant="primary" onClick={() => {
      try { save(Config(draft)); setNotice('saved') } catch { setNotice('invalid') }
    }}>{t('save')}</Button>{notice !== undefined && <span role={notice === 'invalid' ? 'alert' : 'status'}>{t(notice)}</span>}</div>
    <div className={css.shared}>
      <h4>{t('cover')}</h4><p>{t('shared')}</p>
      {cover.url !== undefined && <img className={css.preview} src={cover.url} alt={t('coverAlt')} />}
      <p>{t('formats')}</p>
      <div className={css.actions}>
        <PhotoPicker t={t} upload={upload} cover={cover} enabled={skin.active} />
        <Button disabled={cover.busy || cover.cover?.cover == null || !skin.active} onClick={() => { setConfirm(true) }}>{t('remove')}</Button>
        <Button disabled={cover.busy || !skin.active} onClick={refresh}>{t('retry')}</Button>
      </div>
      {cover.error !== undefined && <p role="alert">{t(`error.${cover.error}`)}</p>}
    </div>
    {confirm && <ConfirmRemoval t={t} onCancel={() => { setConfirm(false) }} onConfirm={() => { setConfirm(false); remove() }} />}
  </section>
}
