/**
 * HOST side of the catalog-plugin sandbox: one `SandboxRealm` per plugin owns
 * the plugin's `<iframe sandbox="allow-scripts">`, routes its postMessage
 * traffic, and multiplexes every contribution the plugin renders into the
 * host layout.
 *
 * Boundary, in order of what stops what:
 *  - `sandbox="allow-scripts"` (no allow-same-origin) → opaque origin: the
 *    guest cannot touch `parent.document`, our localStorage, our cookies, or
 *    the SDK singletons; `window.parent.document` throws SecurityError.
 *  - srcdoc CSP `default-src 'none'` → no network, no remote scripts.
 *  - This class answers ONLY the methods in `methods.ts`, each behind ONE
 *    capability from `capabilities.ts`; anything else is refused with a
 *    toast naming the plugin and the capability.
 *  - `event.source === iframe.contentWindow` → no other document can speak
 *    for the plugin.
 *
 * Layout: the frame is a full-window transparent overlay (`z-40`, under the
 * app's dialogs/popovers at z-50). For every contribution the host renders a
 * placeholder (`SandboxSlot`) and streams its on-screen rect to the guest,
 * which positions that contribution's React tree over it; `clip-path` on the
 * iframe limits hit-testing to those rects so the rest of the window stays
 * clickable. One frame per plugin — not one per contribution — because a
 * plugin is one module with one state: per-contribution frames would evaluate
 * it N times and break `openWorkspace`, shared stores and `onDispose`.
 */

import { atom } from 'nanostores'

import { createPluginContext, type PluginContext } from '@/contrib/plugin'
import { notify } from '@/store/notifications'

import { CAPABILITIES, type Capability } from './capabilities'
import { METHODS } from './methods'
import { type GuestMessage, type HostMessage, isGuestMessage, SANDBOX_PROTOCOL, type SlotRect } from './protocol'

export interface SandboxFrame {
  element: HTMLIFrameElement
  post: (message: HostMessage & { hermes: string }) => void
  remove: () => void
  window: null | Window
}

export interface SandboxRealmOptions {
  /** Trusted key: the install folder. Scopes storage/REST/provenance. */
  pluginId: string
  name: string
  granted: ReadonlySet<Capability>
  srcdoc: string
  /** Frame factory seam — tests inject a fake that speaks as the guest
   *  through `realm.handle`; production builds the iframe. */
  createFrame?: (srcdoc: string, realm: SandboxRealm) => SandboxFrame
  onError?: (message: string) => void
  onManifest?: (manifest: Extract<GuestMessage, { type: 'manifest' }>) => void
  onReady?: () => void
}

const CONTAINER_ID = 'hermes-plugin-sandboxes'

function sandboxContainer(): HTMLElement {
  let container = document.getElementById(CONTAINER_ID)

  if (!container) {
    container = document.createElement('div')
    container.id = CONTAINER_ID
    container.style.cssText = 'position:fixed;inset:0;z-index:40;pointer-events:none;'
    document.body.appendChild(container)
  }

  return container
}

function createIframeFrame(srcdoc: string): SandboxFrame {
  const element = document.createElement('iframe')
  // allow-scripts ONLY. Never add allow-same-origin: it would collapse the
  // opaque origin and hand the guest the whole app.
  element.setAttribute('sandbox', 'allow-scripts')
  element.setAttribute('title', 'plugin sandbox')
  element.style.cssText =
    'position:absolute;inset:0;width:100%;height:100%;border:0;background:transparent;pointer-events:none;'
  element.srcdoc = srcdoc
  sandboxContainer().appendChild(element)

  return {
    element,
    post: message => element.contentWindow?.postMessage(message, '*'),
    remove: () => element.remove(),
    get window() {
      return element.contentWindow
    }
  }
}

const EMPTY_RECT: SlotRect = { height: 0, left: 0, top: 0, width: 0 }

/** Placeholder rect clipped by every overflow-hiding ancestor, so a chip
 *  scrolled out of a pane body does not paint over unrelated chrome. */
function visibleRect(el: HTMLElement): SlotRect {
  const box = el.getBoundingClientRect()
  let left = box.left
  let top = box.top
  let right = box.right
  let bottom = box.bottom

  for (let node = el.parentElement; node; node = node.parentElement) {
    const overflow = getComputedStyle(node).overflow

    if (overflow && overflow !== 'visible') {
      const clip = node.getBoundingClientRect()
      left = Math.max(left, clip.left)
      top = Math.max(top, clip.top)
      right = Math.min(right, clip.right)
      bottom = Math.min(bottom, clip.bottom)
    }
  }

  return right > left && bottom > top ? { height: bottom - top, left, top, width: right - left } : EMPTY_RECT
}

const sameRect = (a: SlotRect, b: SlotRect) =>
  a.left === b.left && a.top === b.top && a.width === b.width && a.height === b.height

export class SandboxRealm {
  readonly pluginId: string
  readonly name: string
  readonly granted: ReadonlySet<Capability>
  /** Intrinsic size the guest reports per slot — bars size their placeholder from it. */
  readonly $slotSizes = atom<Record<string, { height: number; width: number }>>({})

  private readonly frame: SandboxFrame
  private readonly options: SandboxRealmOptions
  private readonly onMessage: (event: MessageEvent) => void
  private ctx: null | PluginContext = null
  private disposers: (() => void)[] = []
  private readonly refused = new Set<Capability>()
  private readonly slots = new Map<string, { el: HTMLElement; rect: SlotRect }>()
  private rafId: null | number = null
  private nextInvokeId = 1
  private readonly invocations = new Map<number, { reject: (e: Error) => void; resolve: (v: unknown) => void }>()
  private disposed = false

  /** Per-method scratch the method table may use (registrations, subscriptions…). */
  readonly registrations = new Map<string, () => void>()
  readonly eventSubs = new Map<number, () => void>()
  readonly workspaces = new Map<string, () => void>()

  constructor(options: SandboxRealmOptions) {
    this.options = options
    this.pluginId = options.pluginId
    this.name = options.name
    this.granted = options.granted
    this.onMessage = event => this.receive(event)
    window.addEventListener('message', this.onMessage)
    this.frame = (options.createFrame ?? createIframeFrame)(options.srcdoc, this)
  }

  // ── transport ─────────────────────────────────────────────────────────────

  send(message: HostMessage): void {
    if (!this.disposed) {
      this.frame.post({ hermes: SANDBOX_PROTOCOL, ...message })
    }
  }

  private receive(event: MessageEvent): void {
    // A detached frame has no window; `null === null` must never authenticate.
    const guest = this.frame.window

    if (!guest || event.source !== guest || !isGuestMessage(event.data)) {
      return
    }

    this.handle(event.data)
  }

  /** Dispatch one authenticated guest message (exposed for tests). */
  handle(message: GuestMessage): void {
    switch (message.type) {
      case 'call':
        void this.dispatch(message)

        return

      case 'error':
        this.options.onError?.(message.message)

        return
      case 'invoke-result': {
        const pending = this.invocations.get(message.invokeId)
        this.invocations.delete(message.invokeId)

        if (message.ok) {
          pending?.resolve(message.result)
        } else {
          pending?.reject(new Error(message.error))
        }

        return
      }

      case 'manifest':
        this.options.onManifest?.(message)

        return

      case 'ready':
        this.options.onReady?.()

        return

      case 'slot-size':
        this.$slotSizes.set({
          ...this.$slotSizes.get(),
          [message.slotId]: { height: message.height, width: message.width }
        })
    }
  }

  private async dispatch(message: Extract<GuestMessage, { type: 'call' }>): Promise<void> {
    const method = METHODS[message.method]

    const reply = (ok: boolean, result?: unknown, error?: string) =>
      this.send({ callId: message.callId, error, ok, result, type: 'reply' })

    if (!method) {
      reply(false, undefined, `${message.method} is not part of the sandbox SDK`)

      return
    }

    if (!this.granted.has(method.capability)) {
      this.refuse(method.capability, message.method)
      reply(false, undefined, `capability "${method.capability}" not granted to plugin "${this.name}"`)

      return
    }

    if (!this.ctx) {
      reply(false, undefined, 'plugin is not active')

      return
    }

    try {
      reply(true, await method.run({ ctx: this.ctx, realm: this }, message.args))
    } catch (error) {
      reply(false, undefined, error instanceof Error ? error.message : String(error))
    }
  }

  /** One toast per (plugin, capability) per activation — a render loop that
   *  keeps retrying must not flood the notification stack. */
  private refuse(capability: Capability, method: string): void {
    console.warn(`[plugins] ${this.pluginId}: "${method}" refused — capability "${capability}" not granted`)

    if (this.refused.has(capability)) {
      return
    }

    this.refused.add(capability)
    notify({
      kind: 'error',
      title: `Plugin "${this.name}" blocked`,
      message: `It tried to ${CAPABILITIES[capability]} ("${method}") without the "${capability}" capability. The plugin must declare it under desktop_capabilities in its plugin.yaml.`
    })
  }

  /** Call a function the guest handed over in a data contribution. */
  invoke(callbackId: number, args: unknown[]): Promise<unknown> {
    return new Promise((resolve, reject) => {
      const invokeId = this.nextInvokeId++
      this.invocations.set(invokeId, { reject, resolve })
      this.send({ args, callbackId, invokeId, type: 'invoke' })
    })
  }

  /** Track a disposer that runs on deactivate/dispose. */
  track(dispose: () => void): () => void {
    this.disposers.push(dispose)

    return dispose
  }

  // ── lifecycle ─────────────────────────────────────────────────────────────

  activate(bootstrap: (realm: SandboxRealm, ctx: PluginContext) => void): void {
    this.deactivate()
    this.ctx = createPluginContext(this.pluginId, dispose => this.track(dispose))
    bootstrap(this, this.ctx)
    this.send({ type: 'activate' })
  }

  deactivate(): void {
    if (this.ctx) {
      this.send({ type: 'deactivate' })
    }

    this.disposers.splice(0).forEach(dispose => dispose())
    this.registrations.clear()
    this.eventSubs.clear()
    this.workspaces.clear()
    this.refused.clear()
    this.ctx = null
  }

  dispose(): void {
    this.deactivate()
    this.disposed = true
    window.removeEventListener('message', this.onMessage)
    this.stopRectLoop()
    this.slots.clear()
    this.frame.remove()
  }

  // ── slots ─────────────────────────────────────────────────────────────────

  /** Mount a contribution's placeholder: the guest renders the contribution
   *  over this element's rect until the returned disposer runs. */
  mountSlot(slotId: string, el: HTMLElement): () => void {
    const rect = visibleRect(el)
    this.slots.set(slotId, { el, rect })
    this.send({ rect, slotId, type: 'slot-mount' })
    this.syncHitRegion()
    this.startRectLoop()

    return () => {
      this.slots.delete(slotId)
      this.send({ slotId, type: 'slot-unmount' })
      this.syncHitRegion()

      if (this.slots.size === 0) {
        this.stopRectLoop()
      }
    }
  }

  private startRectLoop(): void {
    if (this.rafId !== null || typeof requestAnimationFrame !== 'function') {
      return
    }

    const tick = () => {
      this.rafId = requestAnimationFrame(tick)
      let changed = false

      for (const [slotId, slot] of this.slots) {
        const rect = visibleRect(slot.el)

        if (!sameRect(rect, slot.rect)) {
          slot.rect = rect
          changed = true
          this.send({ rect, slotId, type: 'slot-rect' })
        }
      }

      if (changed) {
        this.syncHitRegion()
      }
    }

    this.rafId = requestAnimationFrame(tick)
  }

  private stopRectLoop(): void {
    if (this.rafId !== null) {
      cancelAnimationFrame(this.rafId)
      this.rafId = null
    }
  }

  /** Hit-test only where a slot is: clip-path clips pointer events too. */
  private syncHitRegion(): void {
    const rects = [...this.slots.values()].map(slot => slot.rect).filter(rect => rect.width > 0 && rect.height > 0)
    const style = this.frame.element.style

    if (rects.length === 0) {
      style.pointerEvents = 'none'
      style.clipPath = ''

      return
    }

    style.pointerEvents = 'auto'
    style.clipPath = `path('${rects.map(r => `M${r.left} ${r.top}h${r.width}v${r.height}h${-r.width}Z`).join('')}')`
  }
}
