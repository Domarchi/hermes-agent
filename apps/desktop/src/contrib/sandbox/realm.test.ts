import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { $pluginRecords } from '@/contrib/plugins-store'
import { registry } from '@/contrib/registry'

import { DEFAULT_CAPABILITIES, gatewayMethodAllowed, resolveCapabilities } from './capabilities'
import { buildFrameDocument, SANDBOX_CSP } from './frame-document'
import { loadSandboxedPlugin, unloadSandboxedPlugin } from './loader'
import type { GuestMessage, HostMessage } from './protocol'
import { type SandboxFrame, SandboxRealm } from './realm'

const notify = vi.fn()
const hostRequest = vi.fn(async (_method: string, _params: unknown) => ({ ok: true }))
const hostNavigate = vi.fn()

vi.mock('@/store/notifications', () => ({
  notify: (input: unknown) => notify(input),
  notifyError: (error: unknown, fallback: string) => notify({ error, fallback })
}))

vi.mock('@/sdk', () => ({
  host: {
    navigate: (path: string) => hostNavigate(path),
    notify: (input: unknown) => notify(input),
    notifyError: (error: unknown, fallback: string) => notify({ error, fallback }),
    request: (method: string, params: unknown) => hostRequest(method, params),
    state: { gateway: { get: () => 'open', listen: () => () => {} } }
  },
  cn: () => '',
  useValue: () => undefined
}))

/** A guest that never runs script: records host->guest frames; the test
 *  speaks as the guest through `realm.handle`. */
class FakeFrame implements SandboxFrame {
  element = document.createElement('iframe')
  sent: (HostMessage & { hermes: string })[] = []
  removed = false
  window = null

  constructor(readonly realm: SandboxRealm) {}

  post = (message: HostMessage & { hermes: string }) => void this.sent.push(message)
  remove = () => void (this.removed = true)

  replies() {
    return this.sent.filter(m => m.type === 'reply') as Extract<HostMessage, { type: 'reply' }>[]
  }
}

function realmWith(granted: Parameters<typeof resolveCapabilities>[0], name = 'fixture') {
  let frame!: FakeFrame

  const realm = new SandboxRealm({
    createFrame: (_srcdoc, owner) => (frame = new FakeFrame(owner)),
    granted: resolveCapabilities(granted).granted,
    name,
    pluginId: name,
    srcdoc: ''
  })

  realm.activate(() => {})

  return { frame, realm }
}

const call = (realm: SandboxRealm, callId: number, method: string, args: unknown[] = []) =>
  realm.handle({ args, callId, method, type: 'call' } satisfies GuestMessage)

const flush = () => new Promise(resolve => setTimeout(resolve, 0))

beforeEach(() => {
  notify.mockClear()
  hostRequest.mockClear()
  hostNavigate.mockClear()
})

afterEach(() => {
  document.body.innerHTML = ''
})

describe('capability table', () => {
  it('defaults to the minimal set and drops unknown names without widening', () => {
    expect([...resolveCapabilities(undefined).granted]).toEqual([...DEFAULT_CAPABILITIES])

    const { granted, unknown } = resolveCapabilities(['ui', 'os:clipboard', 'root', 'gateway:request'])
    expect([...granted]).toEqual(['ui', 'os:clipboard', 'gateway:request'])
    expect(unknown).toEqual(['root'])
  })

  it('allowlists gateway methods by exact name or prefix', () => {
    expect(gatewayMethodAllowed('session.list')).toBe(true)
    expect(gatewayMethodAllowed('kanban.board')).toBe(true)
    expect(gatewayMethodAllowed('plugins.manage')).toBe(false)
    expect(gatewayMethodAllowed('cli.exec')).toBe(false)
  })
})

describe('SandboxRealm bridge', () => {
  it('runs a granted call and replies with its result', async () => {
    const { frame, realm } = realmWith(['ui', 'gateway:request'])

    call(realm, 1, 'request', ['session.list', { limit: 1 }])
    await flush()

    expect(hostRequest).toHaveBeenCalledWith('session.list', { limit: 1 })
    expect(frame.replies()).toEqual([expect.objectContaining({ callId: 1, ok: true, result: { ok: true } })])
    realm.dispose()
  })

  it('refuses an ungranted call with an error reply and ONE toast naming plugin + capability', async () => {
    const { frame, realm } = realmWith(['ui'], 'weather-widget')

    call(realm, 1, 'navigate', ['/settings'])
    call(realm, 2, 'navigate', ['/settings'])
    await flush()

    expect(hostNavigate).not.toHaveBeenCalled()
    expect(frame.replies().map(r => r.ok)).toEqual([false, false])
    expect(frame.replies()[0].error).toContain('"navigate" not granted')
    expect(notify).toHaveBeenCalledTimes(1)
    expect(notify.mock.calls[0][0]).toMatchObject({ kind: 'error', title: 'Plugin "weather-widget" blocked' })
    expect(String(notify.mock.calls[0][0].message)).toContain('"navigate"')
    expect(String(notify.mock.calls[0][0].message)).toContain('desktop_capabilities')
    realm.dispose()
  })

  it('refuses gateway methods outside the allowlist even when gateway:request is granted', async () => {
    const { frame, realm } = realmWith(['gateway:request'])

    call(realm, 1, 'request', ['plugins.manage', { action: 'install' }])
    await flush()

    expect(hostRequest).not.toHaveBeenCalled()
    expect(frame.replies()[0]).toMatchObject({ ok: false, error: expect.stringContaining('allowlist') })
    realm.dispose()
  })

  it('has no method that reaches the host DOM', async () => {
    const { frame, realm } = realmWith(['ui', 'storage', 'events', 'rest', 'rest:any', 'gateway:request'])

    for (const [index, method] of ['querySelector', 'insertBefore', 'firstChild', 'eval'].entries()) {
      call(realm, index + 1, method, ['body'])
    }

    await flush()
    expect(frame.replies()).toHaveLength(4)
    expect(frame.replies().every(r => !r.ok && r.error?.includes('not part of the sandbox SDK'))).toBe(true)
    realm.dispose()
  })

  it('ignores messages that do not come from its own frame window', () => {
    const { frame, realm } = realmWith(['ui', 'gateway:request'])

    window.dispatchEvent(
      new MessageEvent('message', {
        data: {
          args: ['session.list', {}],
          callId: 9,
          hermes: 'hermes-plugin-sandbox',
          method: 'request',
          type: 'call'
        }
      })
    )

    expect(hostRequest).not.toHaveBeenCalled()
    expect(frame.replies()).toEqual([])
    realm.dispose()
  })

  it('registers a contribution whose render is a host placeholder, and dispose tears it all down', async () => {
    const { frame, realm } = realmWith(['ui'])

    call(realm, 1, 'register', [{ area: 'statusBar.right', hasRender: true, id: 'chip', order: 5 }])
    await flush()

    const item = registry.getArea('statusBar.right').find(c => c.id === 'fixture:chip')
    expect(item?.source).toBe('plugin:fixture')
    expect(typeof item?.render).toBe('function')

    realm.dispose()

    expect(registry.getArea('statusBar.right').some(c => c.id === 'fixture:chip')).toBe(false)
    expect(frame.removed).toBe(true)
    expect(frame.sent.some(m => m.type === 'deactivate')).toBe(true)
  })
})

describe('frame document', () => {
  it('locks the frame down: no-network CSP, plugin source can never close the script tag', () => {
    const html = buildFrameDocument({
      pluginId: 'p',
      pluginSource: 'export default { id: "p", register() {} } // </script><script>alert(1)</script>',
      sdkExports: ['host'],
      styleText: ''
    })

    expect(html).toContain(`content="${SANDBOX_CSP}"`)
    expect(SANDBOX_CSP.startsWith("default-src 'none'")).toBe(true)
    expect(SANDBOX_CSP).not.toContain('connect-src')
    // Exactly the two real script tags: the plugin's `</script>` is escaped.
    expect(html.split('</script>')).toHaveLength(3)
  })

  it('builds an iframe with sandbox="allow-scripts" and nothing more; dispose removes it', () => {
    const realm = new SandboxRealm({ granted: new Set(['ui']), name: 'p', pluginId: 'p', srcdoc: '<html></html>' })
    const frames = document.querySelectorAll('iframe')

    expect(frames).toHaveLength(1)
    expect(frames[0].getAttribute('sandbox')).toBe('allow-scripts')
    realm.dispose()
    expect(document.querySelectorAll('iframe')).toHaveLength(0)
  })
})

describe('loadSandboxedPlugin', () => {
  it('inventories the plugin from the guest manifest under its TRUSTED id and unloads cleanly', async () => {
    const frames: FakeFrame[] = []

    const load = loadSandboxedPlugin('export default {}', 'cat-plugin', {
      bootTimeoutMs: 0,
      capabilities: ['ui'],
      createFrame: (_srcdoc, realm) => {
        frames.push(new FakeFrame(realm))

        return frames[frames.length - 1]
      },
      packageName: 'cat-plugin',
      packageOrigin: { catalogName: 'cat-plugin', repo: 'https://example.invalid/r.git' }
    })

    await flush()
    expect(frames).toHaveLength(1)
    // The guest declares another id; the host keeps scoping to the install folder.
    frames[0].realm.handle({ description: 'd', id: 'kanban', name: 'Cat Plugin', type: 'manifest' })

    expect(await load).toBe('cat-plugin')
    expect($pluginRecords.get()['cat-plugin']).toMatchObject({ name: 'Cat Plugin', status: 'loaded' })
    expect($pluginRecords.get().kanban).toBeUndefined()
    expect(frames[0].sent.map(m => m.type)).toEqual(expect.arrayContaining(['storage', 'state', 'theme', 'activate']))

    unloadSandboxedPlugin('cat-plugin')
    expect(frames[0].removed).toBe(true)
  })
})
