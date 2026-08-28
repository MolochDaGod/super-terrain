import { Quaternion, Vector3 } from 'three/webgpu'
import type ComputeNode from 'three/src/nodes/gpgpu/ComputeNode.js'
import type { Node } from './nodes.ts'
import {
  Fn,
  If,
  Loop,
  exp2,
  float,
  floor,
  instanceIndex,
  instancedArray,
  log2,
  max,
  min,
  mix,
  pow,
  saturate,
  select,
  smoothstep,
  storage,
  uint,
  uniform,
  vec2,
  vec3,
  vec4,
} from './nodes.ts'
import { GOLDEN_ANGLE } from '../math.ts'
import { SH_A0, SH_A1, SH_Y00, SH_Y1 } from '../sphericalHarmonics.ts'
import { octDecode, octEncode } from './octahedral.ts'
import { sampleDistance, sampleGradient, traceSdf, type SdfBinding } from './sdfTrace.ts'
import { lambert, skyRadiance, sunIrradiance, type SunSky } from './lighting.ts'
import type { PointLightField } from './pointLights.ts'


export interface ProbeConfig {
  /** Camera-centred cascades; each doubles the probe spacing. */
  cascades: number
  /** Probes per axis in every cascade. */
  resolution: number
  /** Probe spacing of cascade 0, in world units. */
  spacing: number
  raysPerProbe: number
  /** Octahedral depth resolution per probe (visibility test). */
  octResolution: number
  /** Frames between full re-integrations of the depth moments. */
  depthRefreshInterval: number
  /** Fraction of the previous frame kept per update. */
  hysteresis: number
  /** Cascades refreshed per frame; Sousa budgets one. */
  cascadesPerFrame: number
  /** Radiance clamp on a single ray, kills fireflies from the sun disc. */
  fireflyClamp: number
  /**
   * Cone exponent for the octahedral depth lobe.
   *
   * This has to be matched to `raysPerProbe`. DDGI's canonical 50 assumes
   * hundreds of rays; at 32 the lobe is narrower than the average gap between
   * rays, most texels receive none, and their moments collapse to zero — which
   * reads as visibility rejecting every probe, and the rejection pattern
   * changes with each frame's ray rotation. That is a crawling shadow.
   */
  depthSharpness: number
}

export const DEFAULT_PROBES: ProbeConfig = {
  cascades: 3,
  resolution: 16,
  spacing: 1.1,
  raysPerProbe: 32,
  octResolution: 8,
  hysteresis: 0.97,
  cascadesPerFrame: 1,
  fireflyClamp: 6,
  depthSharpness: 5,
  depthRefreshInterval: 8,
}

const C0 = SH_A0 * SH_Y00
const C1 = SH_A1 * SH_Y1

function readOnlyView(buffer: Node, type: string, count: number): Node {
  // A second node over the same attribute: the writable binding stays with the
  // pass that owns it, so no shader binds one buffer twice with mixed access.
  return (storage as Node)(buffer.value, type, count).toReadOnly()
}

export interface ProbeField {
  config: ProbeConfig
  probeCount: number
  probesPerCascade: number
  passes: {
    relocate: ComputeNode
    trace: ComputeNode
    shade: ComputeNode
    visibility: ComputeNode
  }
  /** Call once per frame, before dispatching any cascade. */
  update(camera: Vector3, frame: number): void
  /**
   * Selects which cascade the passes refresh this frame (-1 refreshes all) and
   * scrolls that cascade's lattice. Call between `update` and dispatching.
   */
  scheduleCascade(frame: number, camera: Vector3): number
  /** Full-quality irradiance with per-probe visibility. For final shading. */
  irradiance(position: Node, normal: Node, viewDir: Node): Node
  /** Cheap trilinear irradiance without the visibility test. For ray hits. */
  irradianceFast(position: Node, normal: Node): Node
  reset(): void
  /** float uniform: 0 disables the indirect contribution. */
  enabled: Node
  /** float uniform: artistic multiplier on indirect light. */
  intensity: Node
  debug: { activeCascade: number; base: Vector3[] }
}

export function createProbeField(
  sdf: SdfBinding,
  sky: SunSky,
  lights: PointLightField,
  config: Partial<ProbeConfig> = {},
): ProbeField {
  const cfg: ProbeConfig = { ...DEFAULT_PROBES, ...config }
  const res = cfg.resolution
  const oct = cfg.octResolution
  const rays = cfg.raysPerProbe
  const probesPerCascade = res * res * res
  const probeCount = probesPerCascade * cfg.cascades
  const octPerProbe = oct * oct

  // --- storage -------------------------------------------------------------
  // 3 vec4 per probe: one per colour channel, holding (L0, L1x, L1y, L1z).
  const shBuf = instancedArray(probeCount * 3, 'vec4')
  // (mean distance, mean squared distance) per octahedral texel.
  const depthBuf = instancedArray(probeCount * octPerProbe, 'vec2')
  // xyz: world cell this slot currently holds. w: 1 once converged.
  const stateBuf = instancedArray(probeCount, 'vec4')
  // xyz: relocation offset in world units. w: 0 when the probe is buried.
  const offsetBuf = instancedArray(probeCount, 'vec4')
  // rgb radiance, w hit distance, for the cascade traced this frame.
  const rayBuf = instancedArray(probeCount * rays, 'vec4')

  const shRead = readOnlyView(shBuf, 'vec4', probeCount * 3)
  const depthRead = readOnlyView(depthBuf, 'vec2', probeCount * octPerProbe)
  const stateRead = readOnlyView(stateBuf, 'vec4', probeCount)
  const offsetRead = readOnlyView(offsetBuf, 'vec4', probeCount)
  const rayRead = readOnlyView(rayBuf, 'vec4', probeCount * rays)

  // --- uniforms ------------------------------------------------------------
  const activeCascade = uniform(0) as Node
  const cameraU = uniform(new Vector3()) as Node
  const enabled = uniform(1) as Node
  const intensity = uniform(1) as Node
  const resetAll = uniform(0) as Node
  const depthRefresh = uniform(1) as Node
  // Per-cascade min-corner world cell. Integers, so probe world positions are
  // identical every frame regardless of where the camera drifted — this is the
  // whole reason the field does not swim.
  const baseU: Node[] = []
  for (let c = 0; c < cfg.cascades; c += 1) baseU.push(uniform(new Vector3()) as Node)
  const rotX = uniform(new Vector3(1, 0, 0)) as Node
  const rotY = uniform(new Vector3(0, 1, 0)) as Node
  const rotZ = uniform(new Vector3(0, 0, 1)) as Node
  const maxTrace = uniform(64) as Node

  const spacing0 = float(cfg.spacing)
  const resF = float(res)
  const invRays = float(1 / rays)
  const solidAngle = float((4 * Math.PI) / rays)

  const pickBase = (cNode: Node): Node => {
    let acc: Node = baseU[cfg.cascades - 1]
    for (let c = cfg.cascades - 2; c >= 0; c -= 1) {
      acc = select(cNode.lessThan(float(c + 0.5)), baseU[c], acc)
    }
    return acc
  }
  const spacingOf = (cNode: Node): Node => spacing0.mul(exp2(cNode))

  /** Spherical Fibonacci direction `i` of `rays`, rotated by this frame's basis. */
  const rayDirection = (i: Node): Node => {
    const fi = float(i)
    const y = float(1).sub(fi.mul(2).add(1).mul(invRays))
    const r = max(float(0), float(1).sub(y.mul(y))).sqrt()
    const phi = fi.mul(float(GOLDEN_ANGLE))
    const local = vec3(phi.cos().mul(r), y, phi.sin().mul(r))
    return rotX.mul(local.x).add(rotY.mul(local.y)).add(rotZ.mul(local.z))
  }

  /** Toroidal slot for a world cell inside cascade `c`. */
  const slotOfCell = (cNode: Node, cell: Node): Node => {
    const wrapped = cell.sub(floor(cell.div(resF)).mul(resF))
    const i = wrapped.x
    const j = wrapped.y
    const k = wrapped.z
    return cNode.mul(float(probesPerCascade)).add(k.mul(resF).add(j).mul(resF)).add(i)
  }

  const probeWorldPosition = (cNode: Node, cell: Node, offset: Node): Node =>
    cell.add(0.5).mul(spacingOf(cNode)).add(offset)

  // --- sampling ------------------------------------------------------------

  interface CascadeSample {
    irradiance: Node
    weight: Node
  }

  function gatherCascade(
    cNode: Node,
    position: Node,
    normal: Node,
    viewDir: Node,
    useVisibility: boolean,
  ): CascadeSample {
    const spacing = spacingOf(cNode)
    const base = pickBase(cNode)
    // Surface bias: pushing the sample point off the surface along the normal
    // (and slightly toward the viewer) is what stops a probe on the far side of
    // a wall from being trilinearly blended into the result.
    const biased = position
      .add(normal.mul(spacing.mul(0.32)))
      .add(viewDir.mul(spacing.mul(0.14)))
    const gridF = biased.div(spacing).sub(0.5)
    const cellBase = floor(gridF)
    const frac = gridF.sub(cellBase).clamp(0, 1)

    const accL0 = vec3(0).toVar()
    const accLx = vec3(0).toVar()
    const accLy = vec3(0).toVar()
    const accLz = vec3(0).toVar()
    const wsum = float(0).toVar()

    for (let o = 0; o < 8; o += 1) {
      const ox = o & 1
      const oy = (o >> 1) & 1
      const oz = (o >> 2) & 1
      const cell = cellBase.add(vec3(ox, oy, oz))
      const rel = cell.sub(base)
      // Cells outside the cascade window belong to a different scroll epoch.
      const inside = rel.x
        .greaterThanEqual(0)
        .and(rel.y.greaterThanEqual(0))
        .and(rel.z.greaterThanEqual(0))
        .and(rel.x.lessThan(resF))
        .and(rel.y.lessThan(resF))
        .and(rel.z.lessThan(resF))
      const trilinear = (ox === 1 ? frac.x : float(1).sub(frac.x))
        .mul(oy === 1 ? frac.y : float(1).sub(frac.y))
        .mul(oz === 1 ? frac.z : float(1).sub(frac.z))

      const slot = slotOfCell(cNode, cell)
      const slotU = uint(slot)
      const state = stateRead.element(slotU)
      const offset = offsetRead.element(slotU)
      const probePos = probeWorldPosition(cNode, cell, offset.xyz)
      // The slot must still hold the cell we asked for; after a scroll it may
      // be carrying a probe from the far side of the volume.
      const matches = state.xyz.sub(cell).abs().length().lessThan(float(0.25))

      const toProbe = probePos.sub(position)
      const distToProbe = max(toProbe.length(), float(1e-4))
      const dirToProbe = toProbe.div(distToProbe)
      const facing = dirToProbe.dot(normal).add(1).mul(0.5)
      const backfaceWeight = facing.mul(facing).add(0.2)

      let weight = trilinear
        .mul(backfaceWeight)
        .mul(state.w)
        .mul(offset.w)
        .mul(select(inside, float(1), float(0)))
        .mul(select(matches, float(1), float(0)))

      if (useVisibility) {
        const biasVec = probePos.sub(biased)
        const biasDist = max(biasVec.length(), float(1e-4))
        const octUv = octEncode(biasVec.div(biasDist).negate())
        const moments = sampleOctDepth(slotU, octUv)
        const mean = moments.x
        const variance = max(moments.y.sub(mean.mul(mean)), float(1e-5))
        const delta = max(biasDist.sub(mean), float(0))
        const cheb = variance.div(variance.add(delta.mul(delta)))
        const visibility = select(
          biasDist.lessThanEqual(mean),
          float(1),
          max(cheb.mul(cheb).mul(cheb), float(0)),
        )
        weight = weight.mul(visibility)
      }

      // Crushing near-zero weights avoids a single surviving probe from behind
      // a wall dominating once everything else is rejected.
      weight = select(weight.lessThan(float(0.002)), float(0), weight)

      const shBase = slotU.mul(uint(3))
      const shR = shRead.element(shBase)
      const shG = shRead.element(shBase.add(uint(1)))
      const shB = shRead.element(shBase.add(uint(2)))
      accL0.addAssign(vec3(shR.x, shG.x, shB.x).mul(weight))
      accLx.addAssign(vec3(shR.y, shG.y, shB.y).mul(weight))
      accLy.addAssign(vec3(shR.z, shG.z, shB.z).mul(weight))
      accLz.addAssign(vec3(shR.w, shG.w, shB.w).mul(weight))
      wsum.addAssign(weight)
    }

    const inv = float(1).div(max(wsum, float(1e-5)))
    const irr = accL0
      .mul(inv)
      .mul(float(C0))
      .add(
        accLx
          .mul(normal.x)
          .add(accLy.mul(normal.y))
          .add(accLz.mul(normal.z))
          .mul(inv)
          .mul(float(C1)),
      )
    return { irradiance: max(irr, vec3(0)), weight: min(wsum.mul(4), float(1)) }
  }

  /** Bilinear fetch from a probe's octahedral depth tile. */
  function sampleOctDepth(slotU: Node, octUv: Node): Node {
    const uv = octUv.mul(0.5).add(0.5).clamp(0, 1).mul(float(oct)).sub(0.5)
    const p0 = floor(uv).clamp(0, oct - 1)
    const p1 = p0.add(1).clamp(0, oct - 1)
    const t = uv.sub(p0).clamp(0, 1)
    const tileBase = slotU.mul(uint(octPerProbe))
    const fetch = (x: Node, y: Node) =>
      depthRead.element(tileBase.add(uint(y.mul(float(oct)).add(x))))
    const a = fetch(p0.x, p0.y)
    const b = fetch(p1.x, p0.y)
    const c = fetch(p0.x, p1.y)
    const d = fetch(p1.x, p1.y)
    return mix(mix(a, b, t.x), mix(c, d, t.x), t.y)
  }

  /**
   * Chooses the finest cascade that still contains `position` with a margin,
   * and cross-fades into the next one over the outer band so the transition is
   * invisible rather than a hard shell.
   */
  function selectCascade(position: Node): { c: Node; blend: Node } {
    const rel = position.sub(cameraU).abs()
    const reach = max(max(rel.x, rel.y), rel.z)
    const usable = float((res * 0.5 - 2.0) * cfg.spacing)
    const cFloat = max(float(0), log2(max(reach.div(max(usable, float(1e-3))), float(1e-6))))
    const c = min(floor(cFloat), float(cfg.cascades - 1))
    const blend = smoothstep(float(0.6), float(1), cFloat.sub(c)).mul(
      select(c.lessThan(float(cfg.cascades - 1)), float(1), float(0)),
    )
    return { c, blend }
  }

  function irradiance(position: Node, normal: Node, viewDir: Node): Node {
    const { c, blend } = selectCascade(position)
    const fine = gatherCascade(c, position, normal, viewDir, true)
    const coarse = gatherCascade(
      min(c.add(1), float(cfg.cascades - 1)),
      position,
      normal,
      viewDir,
      true,
    )
    // A cascade with no surviving probes hands over to the coarser one instead
    // of going black.
    const handover = max(blend, float(1).sub(fine.weight))
    return mix(fine.irradiance, coarse.irradiance, handover).mul(intensity).mul(enabled)
  }

  function irradianceFast(position: Node, normal: Node): Node {
    const { c } = selectCascade(position)
    return gatherCascade(c, position, normal, normal.negate(), false).irradiance.mul(intensity)
  }

  /**
   * Full replace when the slot has just scrolled onto a different world cell or
   * has never converged; otherwise the configured hysteresis. Blending into a
   * scrolled slot would drag light from the far side of the volume across the
   * scene for a dozen frames — the smearing the previous build showed.
   */
  function blendAlpha(state: Node, cell: Node): Node {
    const scrolled = state.xyz.sub(cell).abs().length().greaterThan(float(0.25))
    return select(
      scrolled.or(state.w.lessThan(0.5)).or(resetAll.greaterThan(0.5)),
      float(1),
      float(1 - cfg.hysteresis),
    )
  }

  /**
   * Widens the blend when the estimate has genuinely changed.
   *
   * A fixed hysteresis has to choose between quiet steady state and keeping up
   * with a light that moves. Scaling it by how far the new estimate is from the
   * stored one buys both: sampling noise is a small relative change and stays
   * heavily filtered, while a lamp swinging past a wall is a large one and
   * lands in a few updates.
   */
  function adaptiveAlpha(base: Node, previous: Node, current: Node): Node {
    const before = max(previous.x.add(previous.y).add(previous.z), float(0))
    const after = max(current.x.add(current.y).add(current.z), float(0))
    const change = after.sub(before).abs().div(max(max(before, after), float(0.02)))
    return min(base.mul(float(1).add(change.mul(float(4)))), float(0.35)).max(base)
  }

  // --- passes --------------------------------------------------------------
  //
  // Every kernel is dispatched over all cascades and gates on `activeCascade`,
  // rather than being dispatched once per cascade with the index in a uniform.
  // Compute dispatches inside one frame share a command buffer, so a uniform
  // rewritten between them would be seen by all of them — the second dispatch
  // would silently redo the first one's cascade.

  /** Cascade index and in-cascade index for a probe slot. */
  function decodeProbe(globalProbe: Node): { c: Node; local: Node; slotU: Node; cell: Node } {
    const slotU = uint(globalProbe)
    const c = floor(float(globalProbe).div(float(probesPerCascade)))
    const local = slotU.mod(uint(probesPerCascade))
    const base = pickBase(c)
    const lx = float(local.mod(uint(res)))
    const ly = float(local.div(uint(res)).mod(uint(res)))
    const lz = float(local.div(uint(res * res)))
    // Toroidal addressing: a slot holds whichever world cell is congruent to it
    // inside the current window, so scrolling the camera moves no probe data.
    const lattice = vec3(lx, ly, lz)
    const cell = base.add(
      lattice.sub(base).sub(floor(lattice.sub(base).div(resF)).mul(resF)),
    )
    return { c, local, slotU, cell }
  }

  const isActive = (c: Node): Node =>
    activeCascade.lessThan(float(0)).or(c.sub(activeCascade).abs().lessThan(float(0.5)))

  /**
   * Probe relocation. A probe that lands inside a column or under the floor is
   * useless; the distance field gives the shortest push back into open space
   * for a handful of taps.
   */
  const relocate = Fn(() => {
    const { c, slotU, cell } = decodeProbe(instanceIndex)
    If(isActive(c), () => {
      const spacing = spacingOf(c)
      const home = cell.add(0.5).mul(spacing)
      const limit = spacing.mul(0.45)
      const clearance = spacing.mul(0.6)

      // Two fixed-point steps from the lattice position, never from the stored
      // offset. Iterating on the previous frame's result lets a probe that sits
      // right at the clearance threshold oscillate in and out of its obstacle
      // every frame, and a probe that moves is a shadow that moves with it.
      const offset = vec3(0).toVar()
      Loop({ start: 0, end: 2, type: 'int' }, () => {
        const guess = home.add(offset)
        const d = sampleDistance(sdf, guess)
        const grad = sampleGradient(sdf, guess)
        const gradLen = grad.length()
        const dir = select(
          gradLen.greaterThan(float(1e-5)),
          grad.div(max(gradLen, float(1e-5))),
          vec3(0, 1, 0),
        )
        const wanted = offset.add(dir.mul(max(clearance.sub(d), float(0))))
        const wantedLen = wanted.length()
        offset.assign(wanted.mul(min(float(1), limit.div(max(wantedLen, float(1e-5))))))
      })
      const valid = select(
        sampleDistance(sdf, home.add(offset)).greaterThan(spacing.mul(0.08)),
        float(1),
        float(0),
      )
      offsetBuf.element(slotU).assign(vec4(offset, valid))
    })
  })().compute(probeCount)

  /** One thread per (probe, ray): trace, shade, and store incoming radiance. */
  const trace = Fn(() => {
    const id = instanceIndex
    const rayI = id.mod(uint(rays))
    const { c, slotU, cell } = decodeProbe(id.div(uint(rays)))
    If(isActive(c), () => {
      const spacing = spacingOf(c)
      const offset = offsetRead.element(slotU)
      const origin = cell.add(0.5).mul(spacing).add(offset.xyz)
      const dir = rayDirection(rayI)

      const hit = traceSdf(sdf, origin, dir, maxTrace, {
        maxSteps: 72,
        epsilon: 0.45,
        startOffset: 0,
      })
      const radiance = vec3(0).toVar()
      const distance = hit.distance.toVar()
      If(hit.hit.greaterThan(0.5), () => {
        const direct = sunIrradiance(sky, sdf, hit.position, hit.normal, 20).add(
          lights.irradiance(sdf, hit.position, hit.normal, 20),
        )
        // Second and later bounces come from the field itself. Reading the
        // state we are about to overwrite is deliberate: it is a temporally
        // filtered cache and one frame of staleness is invisible.
        const bounce = irradianceFast(hit.position, hit.normal)
        radiance.assign(lambert(hit.albedo, direct.add(bounce)))
      })
      If(hit.hit.lessThan(0.5), () => {
        radiance.assign(skyRadiance(sky, dir))
        distance.assign(maxTrace)
      })
      // Clamp luminance, not channels: a per-channel min desaturates bright
      // coloured bounce, while the thing we actually need to bound is the
      // single outlier ray whose energy would swamp the other 31.
      const luma = radiance.dot(vec3(0.2126, 0.7152, 0.0722))
      const clamped = radiance.mul(
        min(float(1), float(cfg.fireflyClamp).div(max(luma, float(1e-4)))),
      )
      rayBuf.element(id).assign(vec4(clamped, distance))
    })
  })().compute(probeCount * rays)

  /**
   * One thread per octahedral texel: cone-weighted distance moments, the input
   * to the Chebyshev visibility test that keeps light out of sealed rooms.
   *
   * Runs before `shade`, so the state buffer still describes the slot's
   * previous occupant and the scroll test below is meaningful.
   */
  const visibility = Fn(() => {
    const id = instanceIndex
    const texel = id.mod(uint(octPerProbe))
    const { c, slotU, cell } = decodeProbe(id.div(uint(octPerProbe)))
    const state = stateRead.element(slotU)
    const scrolled = state.xyz.sub(cell).abs().length().greaterThan(float(0.25))
    // Distance moments describe geometry, and geometry is static between
    // scrolls. Re-integrating them every frame is most of this pass's cost for
    // a result that does not change; a slot that just moved, or the periodic
    // refresh that catches genuinely moved geometry, is enough.
    const needsUpdate = scrolled
      .or(state.w.lessThan(0.5))
      .or(resetAll.greaterThan(0.5))
      .or(depthRefresh.greaterThan(0.5))
    If(isActive(c).and(needsUpdate), () => {
      const tx = float(texel.mod(uint(oct)))
      const ty = float(texel.div(uint(oct)))
      const texelDir = octDecode(
        vec2(tx.add(0.5).div(float(oct)), ty.add(0.5).div(float(oct))).mul(2).sub(1),
      )

      const sum = float(0).toVar()
      const sum2 = float(0).toVar()
      const wsum = float(0).toVar()
      Loop({ start: 0, end: rays, type: 'uint' }, ({ i }: { i: Node }) => {
        const sample = rayRead.element(slotU.mul(uint(rays)).add(i))
        const cone = max(texelDir.dot(rayDirection(i)), float(0))
        // A sharp lobe: each texel must describe the geometry it actually
        // faces, not a hemisphere average, or Chebyshev loses its teeth.
        const w = pow(cone, float(cfg.depthSharpness))
        const d = min(sample.w, maxTrace)
        sum.addAssign(d.mul(w))
        sum2.addAssign(d.mul(d).mul(w))
        wsum.addAssign(w)
      })
      const inv = float(1).div(max(wsum, float(1e-6)))
      const current = vec2(sum.mul(inv), sum2.mul(inv))

      // Fade the update by how much ray coverage this texel actually got, so a
      // texel the rotation happened to miss keeps its history instead of
      // writing a zero-distance "fully occluded" reading.
      const confidence = saturate(wsum.mul(float(4)))
      const alpha = min(blendAlpha(state, cell).mul(confidence).add(
        select(state.w.lessThan(0.5), float(1), float(0)),
      ), float(1))
      const slotTexel = slotU.mul(uint(octPerProbe)).add(texel)
      const previous = depthBuf.element(slotTexel)
      depthBuf.element(slotTexel).assign(mix(previous, current, alpha))
    })
  })().compute(probeCount * octPerProbe)

  /** One thread per probe: project this frame's ray set onto SH-L1 and blend. */
  const shade = Fn(() => {
    const { c, slotU, cell } = decodeProbe(instanceIndex)
    If(isActive(c), () => {
      const l0 = vec3(0).toVar()
      const lxs = vec3(0).toVar()
      const lys = vec3(0).toVar()
      const lzs = vec3(0).toVar()
      Loop({ start: 0, end: rays, type: 'uint' }, ({ i }: { i: Node }) => {
        const radiance = rayRead.element(slotU.mul(uint(rays)).add(i)).rgb
        const dir = rayDirection(i)
        l0.addAssign(radiance.mul(float(SH_Y00)).mul(solidAngle))
        lxs.addAssign(radiance.mul(float(SH_Y1)).mul(dir.x).mul(solidAngle))
        lys.addAssign(radiance.mul(float(SH_Y1)).mul(dir.y).mul(solidAngle))
        lzs.addAssign(radiance.mul(float(SH_Y1)).mul(dir.z).mul(solidAngle))
      })

      const state = stateBuf.element(slotU)
      const shBase = slotU.mul(uint(3))
      const prevR = shBuf.element(shBase)
      const prevG = shBuf.element(shBase.add(uint(1)))
      const prevB = shBuf.element(shBase.add(uint(2)))
      const base = blendAlpha(state, cell)
      const alpha = adaptiveAlpha(
        base,
        vec3(prevR.x, prevG.x, prevB.x),
        vec3(l0.x, l0.y, l0.z),
      )
      shBuf.element(shBase).assign(mix(prevR, vec4(l0.x, lxs.x, lys.x, lzs.x), alpha))
      shBuf.element(shBase.add(uint(1))).assign(mix(prevG, vec4(l0.y, lxs.y, lys.y, lzs.y), alpha))
      shBuf.element(shBase.add(uint(2))).assign(mix(prevB, vec4(l0.z, lxs.z, lys.z, lzs.z), alpha))
      stateBuf.element(slotU).assign(vec4(cell, 1))
    })
  })().compute(probeCount)

  // --- CPU side ------------------------------------------------------------

  const quaternion = new Quaternion()
  const axisX = new Vector3()
  const axisY = new Vector3()
  const axisZ = new Vector3()
  const bases: Vector3[] = baseU.map(() => new Vector3())
  let pendingReset = cfg.cascades + 1

  maxTrace.value = sdf.scene.extent.length()

  const GOLDEN = [0.618033988749895, 0.7548776662466927, 0.5698402909980532]

  function update(camera: Vector3, frame: number): void {
    cameraU.value.copy(camera)
    resetAll.value = pendingReset > 0 ? 1 : 0

    // Shoemake's uniform quaternion driven by a low-discrepancy sequence rather
    // than Math.random. The ray set has to cover the sphere evenly *over time*;
    // independent random rotations clump, and the clumping is what the eye
    // reads as noise crawling over a surface.
    const u1 = (frame * GOLDEN[0]!) % 1
    const u2 = (frame * GOLDEN[1]!) % 1
    const u3 = (frame * GOLDEN[2]!) % 1
    const r1 = Math.sqrt(1 - u1)
    const r2 = Math.sqrt(u1)
    quaternion.set(
      r1 * Math.sin(2 * Math.PI * u2),
      r1 * Math.cos(2 * Math.PI * u2),
      r2 * Math.sin(2 * Math.PI * u3),
      r2 * Math.cos(2 * Math.PI * u3),
    )
    axisX.set(1, 0, 0).applyQuaternion(quaternion)
    axisY.set(0, 1, 0).applyQuaternion(quaternion)
    axisZ.set(0, 0, 1).applyQuaternion(quaternion)
    rotX.value.copy(axisX)
    rotY.value.copy(axisY)
    rotZ.value.copy(axisZ)
  }

  /**
   * Advances one cascade's lattice origin.
   *
   * Only the cascade being refreshed may scroll. The gather rejects a probe
   * whose stored world cell no longer matches the cell its slot maps to, and
   * only the refresh pass restores that agreement — so moving an origin on a
   * frame its probes are not rewritten blanks a slab of probes for as long as
   * it takes the round robin to come back. Sweeping the camera then sweeps a
   * band of missing bounce light across the scene.
   */
  function scrollCascade(c: number, camera: Vector3): void {
    const spacing = cfg.spacing * 2 ** c
    bases[c]!.set(
      Math.floor(camera.x / spacing) - res / 2,
      Math.floor(camera.y / spacing) - res / 2,
      Math.floor(camera.z / spacing) - res / 2,
    )
    baseU[c]!.value.copy(bases[c]!)
  }

  /**
   * Round-robins one cascade per frame, Sousa's budget. While the field is
   * still cold every cascade is refreshed each frame so the first image is
   * lit rather than black.
   */
  // Cascade 0 every other frame, the coarser ones sharing the rest. Plain
  // round robin refreshes the near field at only a third of the frame rate,
  // which a moving light's bounce visibly trails behind.
  const rota: number[] = []
  for (let i = 1; i < cfg.cascades; i += 1) rota.push(0, i)
  if (rota.length === 0) rota.push(0)

  function scheduleCascade(frame: number, camera: Vector3): number {
    const all = pendingReset > 0 || cfg.cascadesPerFrame >= cfg.cascades
    if (pendingReset > 0) pendingReset -= 1
    const c = all ? -1 : rota[frame % rota.length]!
    if (all) {
      for (let i = 0; i < cfg.cascades; i += 1) scrollCascade(i, camera)
    } else {
      scrollCascade(c, camera)
    }
    activeCascade.value = c
    depthRefresh.value =
      all || frame % Math.max(1, cfg.depthRefreshInterval) === 0 ? 1 : 0
    field.debug.activeCascade = c
    return c
  }

  const field: ProbeField = {
    config: cfg,
    probeCount,
    probesPerCascade,
    passes: { relocate, trace, shade, visibility },
    update,
    scheduleCascade,
    irradiance,
    irradianceFast,
    reset() {
      pendingReset = cfg.cascades + 1
    },
    enabled,
    intensity,
    debug: { activeCascade: 0, base: bases },
  }
  return field
}
