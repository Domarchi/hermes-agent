/**
 * Wire types shared by the host bridge and (by convention) guest-runtime.js.
 * Every frame carries `hermes: PROTOCOL`; the host additionally checks that
 * `event.source` is the plugin's own frame window, so a message from any
 * other document (another plugin, an artifact preview) is dropped unread.
 */

export const SANDBOX_PROTOCOL = 'hermes-plugin-sandbox'

export interface SlotRect {
  height: number
  left: number
  top: number
  width: number
}

/** Guest -> host. */
export type GuestMessage =
  | { type: 'call'; callId: number; method: string; args: unknown[] }
  | { type: 'error'; message: string }
  | { type: 'invoke-result'; invokeId: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'manifest'; id: string; name?: string; description?: string; defaultEnabled?: boolean }
  | { type: 'ready' }
  | { type: 'slot-size'; slotId: string; width: number; height: number }

/** Host -> guest. */
export type HostMessage =
  | { type: 'activate' }
  | { type: 'deactivate' }
  | { type: 'event'; subId: number; event: unknown }
  | { type: 'invoke'; invokeId: number; callbackId: number; args: unknown[] }
  | { type: 'pane-visibility'; paneId: string; visible: boolean }
  | { type: 'reply'; callId: number; ok: boolean; result?: unknown; error?: string }
  | { type: 'slot-mount'; slotId: string; rect: SlotRect }
  | { type: 'slot-rect'; slotId: string; rect: SlotRect }
  | { type: 'slot-unmount'; slotId: string }
  | { type: 'state'; values: Record<string, unknown> }
  | { type: 'storage'; values: Record<string, unknown> }
  | { type: 'theme'; className: string; style: string }

/** A function the guest handed over inside a data contribution. */
export interface CallbackRef {
  __hermesCallback: number
}

export const isCallbackRef = (value: unknown): value is CallbackRef =>
  typeof value === 'object' && value !== null && typeof (value as CallbackRef).__hermesCallback === 'number'

export function isGuestMessage(value: unknown): value is GuestMessage {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as { hermes?: unknown }).hermes === SANDBOX_PROTOCOL &&
    typeof (value as { type?: unknown }).type === 'string'
  )
}
