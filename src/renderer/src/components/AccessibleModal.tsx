import { createPortal } from 'react-dom'
import { useEffect, useMemo, useRef } from 'react'

const focusableSelector = [
  'button:not([disabled])',
  '[href]',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])'
].join(',')

interface AccessibleModalProps {
  children: React.ReactNode
  layerClassName: string
  dialogClassName: string
  labelledBy: string
  describedBy?: string
  role?: 'dialog' | 'alertdialog'
  onDismiss?: () => void
}

interface PreservedAttribute {
  element: Element
  inert: string | null
  ariaHidden: string | null
}

function focusableElements(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(focusableSelector)]
    .filter((element) => !element.hidden && element.getAttribute('aria-hidden') !== 'true')
}

/**
 * Renders a truly isolated modal next to the React root. The portal lets the
 * app root become inert without also hiding the dialog from assistive tech.
 */
export function AccessibleModal({
  children,
  layerClassName,
  dialogClassName,
  labelledBy,
  describedBy,
  role = 'dialog',
  onDismiss
}: AccessibleModalProps): React.JSX.Element {
  const portalHost = useMemo(() => {
    const host = document.createElement('div')
    host.dataset.duoModalHost = 'true'
    return host
  }, [])
  const dialogRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const returnFocus = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null
    document.body.append(portalHost)

    const preserved: PreservedAttribute[] = [...document.body.children]
      .filter((element) => element !== portalHost)
      .map((element) => ({
        element,
        inert: element.getAttribute('inert'),
        ariaHidden: element.getAttribute('aria-hidden')
      }))
    for (const item of preserved) {
      item.element.setAttribute('inert', '')
      item.element.setAttribute('aria-hidden', 'true')
    }

    const initialFocus = dialogRef.current?.querySelector<HTMLElement>('[data-modal-initial-focus]')
      ?? (dialogRef.current ? focusableElements(dialogRef.current).at(0) : undefined)
      ?? dialogRef.current
    initialFocus?.focus()

    return () => {
      for (const item of preserved) {
        if (item.inert === null) item.element.removeAttribute('inert')
        else item.element.setAttribute('inert', item.inert)
        if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden')
        else item.element.setAttribute('aria-hidden', item.ariaHidden)
      }
      portalHost.remove()
      if (returnFocus?.isConnected) returnFocus.focus()
    }
  }, [portalHost])

  const onKeyDown = (event: React.KeyboardEvent<HTMLElement>): void => {
    if (event.key === 'Escape' && onDismiss) {
      event.preventDefault()
      event.stopPropagation()
      onDismiss()
      return
    }
    if (event.key !== 'Tab' || !dialogRef.current) return

    const focusable = focusableElements(dialogRef.current)
    if (focusable.length === 0) {
      event.preventDefault()
      dialogRef.current.focus()
      return
    }
    const first = focusable.at(0)
    const last = focusable.at(-1)
    if (!first || !last) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || !dialogRef.current.contains(active))) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || !dialogRef.current.contains(active))) {
      event.preventDefault()
      first.focus()
    }
  }

  return createPortal(
    <div className={layerClassName}>
      <section
        ref={dialogRef}
        className={dialogClassName}
        role={role}
        aria-modal="true"
        aria-labelledby={labelledBy}
        {...(describedBy ? { 'aria-describedby': describedBy } : {})}
        tabIndex={-1}
        onKeyDown={onKeyDown}
      >
        {children}
      </section>
    </div>,
    portalHost
  )
}
