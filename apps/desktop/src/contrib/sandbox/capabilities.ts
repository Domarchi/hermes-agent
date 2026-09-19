/**
 * The capability vocabulary for sandboxed (catalog-tier) desktop plugins.
 * A plugin declares `desktop_capabilities:` in its plugin.yaml; absent, it
 * gets DEFAULT_CAPABILITIES. Every bridge method (sandbox/host-bridge.ts)
 * names the ONE capability it needs; the host refuses the call — and toasts
 * the plugin + capability — when that capability was not granted.
 */

export const CAPABILITIES = {
  /** Contribute UI + data (register/registerMany), toast, read host.state,
   *  open a workspace tab, watch pane visibility. */
  ui: 'contribute UI, toast, read host state',
  /** Plugin-scoped persistence (ctx.storage). */
  storage: 'plugin-scoped storage',
  /** Listen to the gateway event stream (ctx.onEvent / host.onEvent). */
  events: 'gateway event stream',
  /** REST to the plugin's OWN backend namespace (`/api/plugins/<id>`). */
  rest: "REST to the plugin's own backend namespace",
  /** REST to any `/api/` route on the backend. */
  'rest:any': 'REST to any backend route',
  /** Gateway JSON-RPC (host.request), limited to GATEWAY_METHOD_ALLOWLIST. */
  'gateway:request': 'gateway RPC (allowlisted methods)',
  /** Change the app route (host.navigate). */
  navigate: 'navigate the app',
  'os:clipboard': 'write the clipboard',
  'os:open-external': 'open URLs in the OS browser',
  'os:reveal-path': 'reveal paths in the file manager',
  'os:notify': 'native OS notifications'
} as const

export type Capability = keyof typeof CAPABILITIES

export const DEFAULT_CAPABILITIES: readonly Capability[] = ['ui', 'storage', 'events', 'rest']

export const isCapability = (value: unknown): value is Capability =>
  typeof value === 'string' && Object.hasOwn(CAPABILITIES, value)

/** Declared list -> granted set. Unknown names are dropped (reported by the
 *  caller), never silently widened; an absent list means the defaults. */
export function resolveCapabilities(declared: readonly unknown[] | undefined): {
  granted: ReadonlySet<Capability>
  unknown: string[]
} {
  if (!declared) {
    return { granted: new Set(DEFAULT_CAPABILITIES), unknown: [] }
  }

  const granted = new Set<Capability>()
  const unknown: string[] = []

  for (const name of declared) {
    if (isCapability(name)) {
      granted.add(name)
    } else {
      unknown.push(String(name))
    }
  }

  return { granted, unknown }
}

/** `host.request` methods a sandboxed plugin may call under `gateway:request`.
 *  Read-mostly session/profile/catalog surfaces; anything that installs,
 *  reconfigures or executes on the user's machine stays host-only. Prefixes
 *  end with `.`; exact names match whole. */
export const GATEWAY_METHOD_ALLOWLIST: readonly string[] = [
  'commands.catalog',
  'cron.list',
  'free_tier.status',
  'kanban.',
  'profiles.list',
  'session.history',
  'session.info',
  'session.list',
  'skills.list',
  'status'
]

export const gatewayMethodAllowed = (method: string): boolean =>
  GATEWAY_METHOD_ALLOWLIST.some(entry => (entry.endsWith('.') ? method.startsWith(entry) : method === entry))
