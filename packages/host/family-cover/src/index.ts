/** Authenticated shared family-cover provider. */
import { Service, type Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { Remote, RemoteError, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import type {} from '@deepseek-ai/dsh-client-connection'
import { CoverError } from './errors.ts'
import { coverHttp } from './http.ts'
import { FamilyCoverStore } from './store.ts'
import type { CoverLimits, CoverRevision, CoverSnapshot } from './types.ts'

export type * from './types.ts'

/** Private data location and deployment-specific resource budgets. */
export interface Config extends CoverLimits {
  /** Absolute directory outside application releases; include it in backups. */
  root: string
}

/** Validated processing defaults; no original image or metadata is retained. */
export const Config: z<Partial<Config> & Pick<Config, 'root'>, Config> = z.object({
  root: z.string().required(),
  maxInputBytes: z.natural().min(1).max(2_147_483_647).default(10 * 1024 * 1024),
  maxInputPixels: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(24_000_000),
  maxOutputDimension: z.natural().min(1).max(16_383).default(1600),
  maxOutputBytes: z.natural().min(1).max(2_147_483_647).default(10 * 1024 * 1024),
  maxConcurrentUploads: z.natural().min(1).max(32).default(2),
  timeoutSeconds: z.natural().min(1).max(300).default(15),
  lockWaitMs: z.natural().min(1).max(60_000).default(5_000),
})

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Shared cover metadata and revision-checked removal; binary intake uses Connection. */
    familyCover: FamilyCover
  }
}

/** Authenticated Host capability with one plugin-owned storage lifetime. */
export default class FamilyCover extends TypertRemoteService {
  static inject = ['connection']
  static Config = Config
  private readonly store: Promise<FamilyCoverStore>

  /** @param ctx - Host context. @param config - validated data root and budgets. */
  constructor(ctx: Context, config: Config) {
    super(ctx, 'familyCover')
    this.store = FamilyCoverStore.open(config.root, config)
    ctx.effect(async () => {
      const store = await this.store
      return () => store.dispose()
    })
  }

  /** Publish both authenticated routes before the Loader releases dependent plugins. */
  protected async [Service.init](): Promise<void> {
    const store = await this.store
    this.ctx.effect(() => this.ctx.connection.fetch.register({
      path: '/api/family-cover/upload', methods: ['POST'], requestBody: 'streaming',
      fetch: request => coverHttp(store, request),
    }))
    this.ctx.effect(() => this.ctx.connection.fetch.register({
      path: '/api/family-cover/image', methods: ['GET'], requestBody: 'buffered',
      fetch: request => coverHttp(store, request),
    }))
  }

  /**
   * Read current cover metadata without exposing private storage paths.
   * @param signal - Remote caller cancellation.
   * @returns the current shared revision and normalized image dimensions.
   */
  @Remote
  current(signal: AbortSignal): Promise<CoverSnapshot> {
    return this.call(store => store.snapshot(signal))
  }

  /**
   * Remove the shared cover for all authorized visitors.
   * @param revision - last observed revision; stale removals fail.
   * @param signal - Remote caller cancellation before commit.
   * @returns a new empty revision.
   */
  @Remote('removeCover')
  remove(revision: CoverRevision, signal: AbortSignal): Promise<CoverSnapshot> {
    return this.call(store => store.remove(revision, signal))
  }

  private async call<T>(operation: (store: FamilyCoverStore) => Promise<T>): Promise<T> {
    try { return await operation(await this.store) } catch (cause) {
      throw new RemoteError('family-cover/failed', 'Shared cover operation failed.',
        { reason: cause instanceof CoverError ? cause.code : 'unavailable' }, { cause })
    }
  }
}
