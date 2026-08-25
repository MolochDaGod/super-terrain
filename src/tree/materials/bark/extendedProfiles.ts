import type { BarkProfile } from './types'

/**
 * Bark families added with the breadth catalog.
 *
 * Every recipe that once lived here has since been rebuilt against the scale
 * and crease structures in `profiles.ts`, and the duplicates were shadowed by
 * the spread in the routing table rather than used — two definitions of
 * `birch-white`, only one of which had any effect, is exactly how a profile
 * gets tuned for an hour with nothing changing on screen. The map is kept as
 * the extension point it was meant to be.
 */
export const EXTENDED_BARK_PROFILES: Readonly<Record<string, BarkProfile>> = {}
