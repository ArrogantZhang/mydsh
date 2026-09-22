/** Fixed unauthenticated presentation: local appearance only, no cover or API requests. */
import type { InvitePageAppearance } from '@deepseek-ai/dsh-host-invite-auth/types'
import type { Config } from './config.ts'
import { PALETTES } from './palettes.ts'

/**
 * Create the trusted login presentation. Names are serialized as data and assigned with textContent.
 * @param defaults - validated public defaults, never credentials or cover bytes.
 * @returns fixed stylesheet and bootstrap for the invite page owner to nonce-authorize.
 */
export function loginAppearance(defaults: Config): InvitePageAppearance {
  const json = JSON.stringify(defaults).replace(/</g, '\\u003c')
  const variables = Object.entries(PALETTES).map(([id, p]) =>
    `:root[data-family-skin][data-family-palette="${id}"]{--family-bg:${p.background};--family-paper:${p.paper};--family-text:${p.text};--family-accent:${p.accent};--family-on-accent:${p.onAccent};color-scheme:${id === 'evening' ? 'dark' : 'light'}}`).join('\n')
  return {
    title: defaults.enabled ? defaults.name : '访问 DSH', message: '输入邀请码，进屋坐坐。', submit: '进入小屋',
    style: `${variables}
      [data-family-skin] body{background:var(--family-bg);color:var(--family-text)}
      [data-family-skin] main{max-width:29rem;padding:2.5rem;border-radius:2rem 2rem 1rem 1rem;background:var(--family-paper);border-color:color-mix(in srgb,var(--family-text) 18%,transparent)}
      [data-family-skin] main::before{content:"⌂";display:block;color:var(--family-accent);font-size:3rem;margin-bottom:1rem}
      [data-family-skin] h1{font-family:KaiTi,STKaiti,"Kaiti SC",serif;font-size:2rem;font-weight:600;overflow-wrap:anywhere}
      [data-family-skin] input{background:var(--family-bg);color:var(--family-text);border-color:color-mix(in srgb,var(--family-text) 30%,transparent);border-radius:.6rem}
      [data-family-skin] button{background:var(--family-accent);color:var(--family-on-accent);border-radius:1.5rem}
      [data-family-skin] button:hover{background:var(--family-accent);filter:brightness(.95)}
      [data-family-skin] input:focus-visible,[data-family-skin] button:focus-visible{outline-color:var(--family-accent)}
      [data-family-skin] [role=alert]{color:var(--family-text)}
      @media(max-width:480px){[data-family-skin] main{padding:1.5rem}}`,
    script: `(()=>{let p=${json};try{const raw=localStorage.getItem('dsh.family-home.v1');if(raw&&raw.length<=2048){const s=JSON.parse(raw);if(s&&s.version===1&&typeof s.enabled==='boolean'&&typeof s.name==='string'&&/^[^\\p{Cc}]{1,16}$/u.test(s.name)&&typeof s.greeting==='string'&&/^[^\\p{Cc}]{1,32}$/u.test(s.greeting)&&['morning','garden','evening'].includes(s.palette))p=s}}catch{}const r=document.documentElement;if(p.enabled){r.dataset.familySkin='';r.dataset.familyPalette=p.palette;document.title=p.name;document.querySelector('[data-invite-title]').textContent=p.name}else{document.title='访问 DSH';document.querySelector('[data-invite-title]').textContent='访问 DSH';document.querySelector('[data-invite-message]').textContent='请输入共享邀请码后继续。';document.querySelector('button[type=submit]').textContent='进入'}})()`,
  }
}
