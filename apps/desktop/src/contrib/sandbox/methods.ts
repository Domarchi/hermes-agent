/**
 * The SDK subset a sandboxed plugin can reach, as a TABLE: guest method name
 * -> the ONE capability it needs + the host code that runs it. `realm.ts`
 * looks a call up here, checks the capability, and refuses everything else —
 * so adding a row is the only way to widen what a catalog plugin can do, and
 * the row states its price.
 *
 * Host DOM access (`host.querySelector` & co.) is deliberately absent: the
 * guest runtime throws for it with a "needs an SDK hook" hint.
 */

import { createElement } from 'react'

import { hermesApi, profileScoped } from '@/api/client'
import type { PluginContext, PluginContribution } from '@/contrib/plugin'
import * as sdk from '@/sdk'

import { type Capability, gatewayMethodAllowed } from './capabilities'
import { isCallbackRef } from './protocol'
import type { SandboxRealm } from './realm'
import { SandboxSlot } from './slot'

export interface MethodEnv {
  ctx: PluginContext
  realm: SandboxRealm
}

export interface SandboxMethod {
  capability: Capability
  run: (env: MethodEnv, args: unknown[]) => Promise<unknown> | unknown
}

const str = (value: unknown, what: string): string => {
  if (typeof value !== 'string' || !value) {
    throw new Error(`${what} must be a non-empty string`)
  }

  return value
}

const record = (value: unknown): Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** Rebuild guest callbacks (`{ __hermesCallback }`) as host functions that
 *  invoke them over the bridge. Depth-bounded like the guest's marshal. */
function unmarshal(realm: SandboxRealm, value: unknown, depth = 0): unknown {
  if (isCallbackRef(value)) {
    const id = value.__hermesCallback

    return (...args: unknown[]) => realm.invoke(id, args)
  }

  if (!value || typeof value !== 'object' || depth > 6) {
    return value
  }

  if (Array.isArray(value)) {
    return value.map(item => unmarshal(realm, item, depth + 1))
  }

  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, unmarshal(realm, item, depth + 1)]))
}

const slotRender = (realm: SandboxRealm, slotId: string, fill: boolean) => () =>
  createElement(SandboxSlot, { fill, realm, slotId })

/** Areas whose items size themselves (bars); everything else fills its zone. */
const INTRINSIC_AREA_PREFIXES = ['statusBar.', 'titleBar.', 'composer.']

const fillsArea = (area: string) => !INTRINSIC_AREA_PREFIXES.some(prefix => area.startsWith(prefix))

function register({ ctx, realm }: MethodEnv, [raw]: unknown[]): string {
  const input = record(raw)
  const id = str(input.id, 'contribution id')
  const area = str(input.area, 'contribution area')
  const { hasRender, ...fields } = unmarshal(realm, input) as Record<string, unknown> & { hasRender?: boolean }

  const contribution: PluginContribution = {
    ...(fields as PluginContribution),
    id,
    area,
    ...(hasRender ? { render: slotRender(realm, id, fillsArea(area)) } : {})
  }

  realm.registrations.get(id)?.()
  realm.registrations.set(id, ctx.register(contribution))

  return id
}

export const METHODS: Record<string, SandboxMethod> = {
  register: { capability: 'ui', run: register },
  unregister: {
    capability: 'ui',
    run: ({ realm }, [id]) => {
      realm.registrations.get(str(id, 'contribution id'))?.()
      realm.registrations.delete(id as string)
    }
  },
  notify: { capability: 'ui', run: (_env, [input]) => void sdk.host.notify(record(input) as { message: string }) },
  notifyError: {
    capability: 'ui',
    run: (_env, [message, fallback]) =>
      void sdk.host.notifyError(new Error(String(message)), String(fallback ?? message))
  },
  paneVisibility: {
    capability: 'ui',
    run: ({ realm }, [paneId]) => {
      const id = str(paneId, 'pane id')
      realm.track(
        sdk.host
          .paneVisibility(id)
          .subscribe(visible => realm.send({ paneId: id, type: 'pane-visibility', visible: Boolean(visible) }))
      )
    }
  },
  openWorkspace: {
    capability: 'ui',
    run: ({ realm }, [id, options]) => {
      const key = str(id, 'workspace id')
      const opts = unmarshal(realm, record(options)) as Record<string, unknown>
      realm.workspaces.get(key)?.()
      realm.workspaces.set(
        key,
        realm.track(
          sdk.host.openWorkspace(`${realm.pluginId}:${key}`, {
            ...(opts as { title?: string; onClose?: () => void }),
            render: slotRender(realm, `workspace:${key}`, true)
          })
        )
      )
    }
  },
  closeWorkspace: {
    capability: 'ui',
    run: ({ realm }, [id]) => {
      realm.workspaces.get(str(id, 'workspace id'))?.()
      realm.workspaces.delete(id as string)
    }
  },
  navigate: { capability: 'navigate', run: (_env, [path]) => sdk.host.navigate(str(path, 'path')) },

  onEvent: {
    capability: 'events',
    run: ({ ctx, realm }, [subId, type]) => {
      const id = Number(subId)
      realm.eventSubs.set(
        id,
        ctx.onEvent(str(type, 'event type'), event => realm.send({ event, subId: id, type: 'event' }))
      )
    }
  },
  offEvent: {
    capability: 'events',
    run: ({ realm }, [subId]) => {
      realm.eventSubs.get(Number(subId))?.()
      realm.eventSubs.delete(Number(subId))
    }
  },

  storageSet: {
    capability: 'storage',
    run: ({ ctx }, [key, value]) => ctx.storage.set(str(key, 'storage key'), value)
  },
  storageRemove: { capability: 'storage', run: ({ ctx }, [key]) => ctx.storage.remove(str(key, 'storage key')) },

  rest: {
    capability: 'rest',
    run: ({ ctx }, [path, opts]) => ctx.rest(str(path, 'path'), record(opts))
  },
  restAny: {
    capability: 'rest:any',
    run: (_env, [path, opts]) => {
      const target = str(path, 'path')

      if (!target.startsWith('/api/')) {
        throw new Error('restAny: path must start with /api/')
      }

      const o = record(opts)

      return hermesApi({ path: target, method: o.method as never, body: o.body, ...profileScoped() })
    }
  },
  request: {
    capability: 'gateway:request',
    run: (_env, [method, params]) => {
      const name = str(method, 'method')

      if (!gatewayMethodAllowed(name)) {
        throw new Error(`gateway method "${name}" is not on the sandbox allowlist`)
      }

      return sdk.host.request(name, record(params))
    }
  },

  osNotify: { capability: 'os:notify', run: ({ ctx }, [input]) => ctx.os.notify(record(input) as never) },
  osWriteClipboard: { capability: 'os:clipboard', run: ({ ctx }, [text]) => ctx.os.writeClipboard(String(text)) },
  osOpenExternal: { capability: 'os:open-external', run: ({ ctx }, [url]) => ctx.os.openExternal(str(url, 'url')) },
  osRevealPath: { capability: 'os:reveal-path', run: ({ ctx }, [path]) => ctx.os.revealPath(str(path, 'path')) }
}
