import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Check, ChevronDown } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

/**
 * A desktop-application menu bar: click a title to open it, then move across
 * the bar to walk between menus without clicking again. One menu is open at a
 * time, Escape and any outside click close it, and choosing an item closes it
 * too — so no action can leave a panel hanging over the viewport.
 */

interface MenuBarContextValue {
  openId?: string
  open: (id: string) => void
  close: () => void
  /** True once a menu has been opened, which is what enables hover switching. */
  active: boolean
}

const MenuBarContext = createContext<MenuBarContextValue | undefined>(undefined)
const MenuCloseContext = createContext<() => void>(() => {})

export function MenuBar({ children }: { children: ReactNode }) {
  const [openId, setOpenId] = useState<string | undefined>(undefined)
  const rootRef = useRef<HTMLDivElement>(null)

  const close = useCallback(() => setOpenId(undefined), [])

  useEffect(() => {
    if (!openId) return
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) close()
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close()
    }
    // Pointer capture on the window rather than a backdrop element: a backdrop
    // would swallow the first click meant for the viewport.
    window.addEventListener('pointerdown', onPointerDown, true)
    window.addEventListener('keydown', onKeyDown)
    return () => {
      window.removeEventListener('pointerdown', onPointerDown, true)
      window.removeEventListener('keydown', onKeyDown)
    }
  }, [close, openId])

  const value = useMemo<MenuBarContextValue>(
    () => ({ openId, open: setOpenId, close, active: openId !== undefined }),
    [close, openId],
  )

  return (
    <MenuBarContext.Provider value={value}>
      <div ref={rootRef} role="menubar" className="flex items-center gap-0.5">
        {children}
      </div>
    </MenuBarContext.Provider>
  )
}

export function Menu({
  label,
  caret,
  children,
}: {
  label: string
  /** Toolbar dropdowns need the affordance; menu-bar titles do not. */
  caret?: boolean
  children: ReactNode
}) {
  const bar = useContext(MenuBarContext)
  const id = useId()
  if (!bar) throw new Error('Menu must be rendered inside a MenuBar')
  const open = bar.openId === id

  return (
    <div className="relative">
      <button
        type="button"
        role="menuitem"
        aria-haspopup="menu"
        aria-expanded={open}
        data-open={open}
        className={`menu-title ${caret ? 'flex items-center' : ''}`}
        onPointerDown={(event) => {
          event.preventDefault()
          if (open) bar.close()
          else bar.open(id)
        }}
        onPointerEnter={() => {
          if (bar.active && !open) bar.open(id)
        }}
      >
        {label}
        {caret && <ChevronDown size={11} className="ml-1 opacity-55" />}
      </button>
      {open && (
        <MenuCloseContext.Provider value={bar.close}>
          <div role="menu" aria-label={label} className="menu-popup">
            {children}
          </div>
        </MenuCloseContext.Provider>
      )}
    </div>
  )
}

interface MenuItemProps {
  label: string
  /** Rendered right-aligned; the shortcut the keyboard handler really binds. */
  shortcut?: string
  icon?: LucideIcon
  disabled?: boolean
  /** Draws a tick column, so radio groups and toggles line up with plain items. */
  checked?: boolean
  onSelect: () => void
}

export function MenuItem({
  label,
  shortcut,
  icon: Icon,
  disabled,
  checked,
  onSelect,
}: MenuItemProps) {
  const close = useContext(MenuCloseContext)
  return (
    <button
      type="button"
      role="menuitem"
      disabled={disabled}
      aria-checked={checked}
      className="menu-item"
      onClick={() => {
        close()
        onSelect()
      }}
    >
      <span className="menu-item-mark">
        {checked === true ? <Check size={11} strokeWidth={2.6} /> : Icon ? <Icon size={12} /> : null}
      </span>
      <span className="flex-1 truncate">{label}</span>
      {shortcut && <kbd className="menu-item-key">{shortcut}</kbd>}
    </button>
  )
}

export function MenuSeparator() {
  return <div role="separator" className="menu-separator" />
}

/** A caption above a run of related items; menus here are long enough to need them. */
export function MenuGroupLabel({ children }: { children: string }) {
  return <div className="menu-group-label">{children}</div>
}
