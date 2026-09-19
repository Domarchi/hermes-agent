/**
 * `loadSandboxedPlugin` — the catalog-tier twin of `loadRuntimePlugin`
 * (contrib/runtime-loader.ts). Same inputs, same inventory contract
 * (publishPlugin + activate/deactivate handles, bundled-shadow rule), but the
 * source is never evaluated in this realm: it goes into a `SandboxRealm`
 * frame and only the capability-gated method table reaches back.
 */

import { type PluginContext } from '@/contrib/plugin'
import { $pluginRecords, pluginActive, type PluginRecord, publishPlugin } from '@/contrib/plugins-store'
import * as sdk from '@/sdk'
import { notifyError } from '@/store/notifications'

import { resolveCapabilities } from './capabilities'
import { buildFrameDocument, collectHostStyleText } from './frame-document'
import type { GuestMessage } from './protocol'
import { type SandboxFrame, SandboxRealm } from './realm'

export interface SandboxLoadOptions {
  /** Declared `desktop_capabilities` from plugin.yaml; undefined = defaults. */
  capabilities?: readonly unknown[]
  defaultEnabled?: boolean
  file?: string
  packageName?: string
  packageOrigin?: PluginRecord['packageOrigin']
  /** Test seam: fake frame factory + no boot timeout. */
  createFrame?: (srcdoc: string, realm: SandboxRealm) => SandboxFrame
  bootTimeoutMs?: number
}

type Manifest = Extract<GuestMessage, { type: 'manifest' }>

const realms = new Map<string, SandboxRealm>()

export function unloadSandboxedPlugin(id: string): void {
  realms.get(id)?.dispose()
  realms.delete(id)
}

/** Everything under `hermes.plugin.<id>.` — the guest's storage cache seed. */
function storageSnapshot(pluginId: string): Record<string, unknown> {
  const prefix = `hermes.plugin.${pluginId}.`
  const values: Record<string, unknown> = {}

  try {
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index)

      if (key?.startsWith(prefix)) {
        try {
          values[key.slice(prefix.length)] = JSON.parse(window.localStorage.getItem(key) ?? 'null')
        } catch {
          // Unparseable leftovers are not the guest's problem.
        }
      }
    }
  } catch {
    // Restricted storage — the guest starts empty.
  }

  return values
}

/** Push `host.state` into the frame: a snapshot now, then every change,
 *  coalesced per microtask so a burst of atom writes is one message. */
function bridgeHostState(realm: SandboxRealm): void {
  const entries = Object.entries(sdk.host.state)
  const snapshot = () => Object.fromEntries(entries.map(([key, store]) => [key, store.get()]))
  let queued = false

  const flush = () => {
    queued = false
    realm.send({ type: 'state', values: snapshot() })
  }

  flush()

  for (const [, store] of entries) {
    realm.track(
      store.listen(() => {
        if (!queued) {
          queued = true
          queueMicrotask(flush)
        }
      })
    )
  }
}

/** Mirror the host's theme (class + inline tokens on <html>) into the frame. */
function bridgeTheme(realm: SandboxRealm): void {
  const root = document.documentElement
  const push = () => realm.send({ className: root.className, style: root.getAttribute('style') ?? '', type: 'theme' })

  push()

  if (typeof MutationObserver === 'function') {
    const observer = new MutationObserver(push)
    observer.observe(root, { attributeFilter: ['class', 'style'], attributes: true })
    realm.track(() => observer.disconnect())
  }
}

function bootstrap(realm: SandboxRealm, _ctx: PluginContext): void {
  realm.send({ type: 'storage', values: storageSnapshot(realm.pluginId) })
  bridgeHostState(realm)
  bridgeTheme(realm)
}

function awaitManifest(
  create: (hooks: { onError: (message: string) => void; onManifest: (manifest: Manifest) => void }) => SandboxRealm,
  timeoutMs: number
): Promise<{ manifest: Manifest; realm: SandboxRealm }> {
  return new Promise((resolve, reject) => {
    let realm: SandboxRealm | null = null

    const timer =
      timeoutMs > 0 ? window.setTimeout(() => reject(new Error('sandbox frame did not boot in time')), timeoutMs) : 0

    const settle = (fn: () => void) => {
      window.clearTimeout(timer)
      fn()
    }

    realm = create({
      onError: message => settle(() => reject(new Error(message))),
      onManifest: manifest => settle(() => resolve({ manifest, realm: realm! }))
    })
  })
}

/** Load one catalog-tier plugin into a sandbox frame. Returns its trusted id
 *  (the install folder), or null on failure — same contract as
 *  `loadRuntimePlugin`, so the disk door treats both tiers alike. */
export async function loadSandboxedPlugin(
  source: string,
  origin: string,
  options: SandboxLoadOptions = {}
): Promise<null | string> {
  const pluginId = options.packageName ?? origin
  const { granted, unknown } = resolveCapabilities(options.capabilities)

  if (unknown.length > 0) {
    console.warn(`[plugins] ${pluginId}: unknown desktop_capabilities ignored: ${unknown.join(', ')}`)
  }

  unloadSandboxedPlugin(pluginId)

  const record = {
    id: pluginId,
    name: pluginId,
    kind: 'disk' as const,
    file: options.file,
    packageName: options.packageName,
    packageOrigin: options.packageOrigin
  }

  try {
    if ($pluginRecords.get()[pluginId]?.kind === 'bundled') {
      console.info(`[plugins] ${origin} skipped — "${pluginId}" already ships bundled with the app`)
      publishPlugin({
        ...record,
        id: `${pluginId}:disk-shadowed`,
        name: `${pluginId} (stale disk copy)`,
        description: `Shadowed by the bundled "${pluginId}" plugin — this folder is no longer used and can be deleted.`,
        status: 'disabled'
      })

      return null
    }

    const srcdoc = buildFrameDocument({
      pluginId,
      pluginSource: source,
      sdkExports: Object.keys(sdk),
      styleText: collectHostStyleText()
    })

    const { manifest, realm } = await awaitManifest(
      hooks =>
        new SandboxRealm({
          createFrame: options.createFrame,
          granted,
          name: pluginId,
          pluginId,
          srcdoc,
          onError: message => {
            hooks.onError(message)
            console.error(`[plugins] ${pluginId} (sandbox)`, message)
          },
          onManifest: hooks.onManifest
        }),
      options.bootTimeoutMs ?? 15_000
    )

    realms.set(pluginId, realm)

    const named = { ...record, name: manifest.name ?? pluginId, description: manifest.description }
    console.info(
      `[plugins] ${pluginId} loaded in a sandboxed realm (catalog tier); capabilities: ${[...granted].join(', ')}`
    )

    const activate = () => {
      realm.activate(bootstrap)
      publishPlugin({ ...named, status: 'loaded' })
    }

    publishPlugin({ ...named, status: 'disabled' }, { activate, deactivate: () => realm.deactivate() })

    if (pluginActive(pluginId, (manifest.defaultEnabled ?? true) && (options.defaultEnabled ?? true))) {
      activate()
    }

    return pluginId
  } catch (error) {
    console.error(`[plugins] sandbox load failed (${origin})`, error)
    notifyError(error, `Plugin "${origin}" failed to load`)
    unloadSandboxedPlugin(pluginId)
    publishPlugin({
      ...record,
      id: origin,
      name: origin,
      status: 'error',
      error: error instanceof Error ? error.message : String(error)
    })

    return null
  }
}
