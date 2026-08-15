import type { AABB, SectionId, SectionKey, Vec3Like } from './types'

export function sectionId(key: SectionKey): SectionId {
  return `${key.x}:${key.z}`
}

export function parseSectionId(id: SectionId): SectionKey {
  const separator = id.indexOf(':')
  return {
    x: Number(id.slice(0, separator)),
    z: Number(id.slice(separator + 1)),
  }
}

export function worldToSection(
  x: number,
  z: number,
  sectionSize: number,
): SectionKey {
  return {
    x: Math.floor(x / sectionSize),
    z: Math.floor(z / sectionSize),
  }
}

export function sectionBounds(
  key: SectionKey,
  sectionSize: number,
  minY = -512,
  maxY = 512,
): AABB {
  return {
    min: { x: key.x * sectionSize, y: minY, z: key.z * sectionSize },
    max: {
      x: (key.x + 1) * sectionSize,
      y: maxY,
      z: (key.z + 1) * sectionSize,
    },
  }
}

export function intersects(a: AABB, b: AABB): boolean {
  return !(
    a.max.x < b.min.x ||
    a.min.x > b.max.x ||
    a.max.y < b.min.y ||
    a.min.y > b.max.y ||
    a.max.z < b.min.z ||
    a.min.z > b.max.z
  )
}

export function containsPoint(bounds: AABB, point: Vec3Like): boolean {
  return (
    point.x >= bounds.min.x &&
    point.x <= bounds.max.x &&
    point.y >= bounds.min.y &&
    point.y <= bounds.max.y &&
    point.z >= bounds.min.z &&
    point.z <= bounds.max.z
  )
}

export function expandBounds(bounds: AABB, amount: number): AABB {
  return {
    min: {
      x: bounds.min.x - amount,
      y: bounds.min.y - amount,
      z: bounds.min.z - amount,
    },
    max: {
      x: bounds.max.x + amount,
      y: bounds.max.y + amount,
      z: bounds.max.z + amount,
    },
  }
}

export function unionBounds(a: AABB | undefined, b: AABB): AABB {
  if (!a) return cloneBounds(b)
  return {
    min: {
      x: Math.min(a.min.x, b.min.x),
      y: Math.min(a.min.y, b.min.y),
      z: Math.min(a.min.z, b.min.z),
    },
    max: {
      x: Math.max(a.max.x, b.max.x),
      y: Math.max(a.max.y, b.max.y),
      z: Math.max(a.max.z, b.max.z),
    },
  }
}

export function cloneBounds(bounds: AABB): AABB {
  return {
    min: { ...bounds.min },
    max: { ...bounds.max },
  }
}

export function boundsFromSphere(center: Vec3Like, radius: number): AABB {
  return {
    min: {
      x: center.x - radius,
      y: center.y - radius,
      z: center.z - radius,
    },
    max: {
      x: center.x + radius,
      y: center.y + radius,
      z: center.z + radius,
    },
  }
}

export function distanceToAabb(point: Vec3Like, bounds: AABB): number {
  const dx = Math.max(bounds.min.x - point.x, 0, point.x - bounds.max.x)
  const dy = Math.max(bounds.min.y - point.y, 0, point.y - bounds.max.y)
  const dz = Math.max(bounds.min.z - point.z, 0, point.z - bounds.max.z)
  return Math.hypot(dx, dy, dz)
}

export function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value))
}

export function lerp(a: number, b: number, amount: number): number {
  return a + (b - a) * amount
}

export function smoothstep(edge0: number, edge1: number, value: number): number {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1)
  return t * t * (3 - 2 * t)
}
