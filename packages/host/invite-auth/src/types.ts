/** Browser-safe presentation contracts for the invite-page owner. */
/** Trusted plugin presentation; user-supplied names are escaped by the page owner. */
export interface InvitePageAppearance {
  readonly title: string
  readonly message: string
  readonly submit: string
  /** Fixed plugin stylesheet; no user-authored CSS or remote assets. */
  readonly style: string
  /** Fixed plugin bootstrap; the owner supplies a fresh CSP nonce per response. */
  readonly script: string
}

/** Exclusive, reversible presentation registration independent of login policy. */
export interface InvitePageRegistry {
  /**
   * Register one trusted presentation; an occupied registration rejects.
   * @param appearance - fixed plugin markup inputs, never authentication secrets.
   * @returns disposer restoring the stock page.
   */
  register(appearance: InvitePageAppearance): () => void
}
