import { useStore } from '@nanostores/react'
import { useLayoutEffect, useRef } from 'react'

import type { SandboxRealm } from './realm'

interface SandboxSlotProps {
  /** Pane/workspace bodies fill their zone; bar chips take the guest-reported size. */
  fill: boolean
  realm: SandboxRealm
  slotId: string
}

/**
 * The host-side placeholder for a contribution a sandboxed plugin renders.
 * It paints nothing itself: the realm streams this element's rect to the
 * guest, whose React tree appears over it inside the plugin's frame.
 */
export function SandboxSlot({ fill, realm, slotId }: SandboxSlotProps) {
  const ref = useRef<HTMLDivElement>(null)
  const size = useStore(realm.$slotSizes)[slotId]

  useLayoutEffect(() => {
    const el = ref.current

    return el ? realm.mountSlot(slotId, el) : undefined
  }, [realm, slotId])

  return (
    <div
      className={fill ? 'size-full' : 'inline-block h-full'}
      data-sandbox-slot={slotId}
      ref={ref}
      style={fill ? undefined : { minWidth: size ? `${Math.ceil(size.width)}px` : '1px' }}
    />
  )
}
