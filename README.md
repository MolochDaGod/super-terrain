# Mesh Terrain Lab

A browser-first, partitioned mesh-terrain editor inspired by Unreal Engine 5.8's Mesh Terrain architecture. It runs on Three.js `WebGPURenderer` through React Three Fiber and keeps terrain authoring, compilation, streaming, and rendering as separate systems.

This is not a single heightmap mesh. The demo world is a sparse 4 km × 4 km logical terrain with sculpt layers, configurable weight-painted materials, editable topology, live add/subtract CSG objects, local density control, tunnel interiors, five geometric LODs, worker compilation, bounded residency, and IndexedDB persistence.

## Requirements

- Bun 1.3+ (or Node.js 20.19+/22.12+ with a current package manager)
- A current browser with WebGPU enabled

There is intentionally no WebGL fallback.

## Run

```bash
bun install
bun run dev
```

Quality checks:

```bash
bun run typecheck
bun run lint
bun run test
bun run build
```

## Visual review

Review frames are captured from the running editor in real Chrome, because the
browser's WebGPU path — tone mapping, clustered lighting, streaming — is the
thing being judged:

```bash
bun run dev
node tools/browser/shot.mjs --name=hero --url=http://localhost:5173 \
  --cam=150,0,335 --above=30 --target=368,112,184 --fov=42
```

The camera, render mode, tone-mapping exposure, material debug view and editor
chrome are all driven from the URL, so a frame is reproducible from a link:
`?cam=x,y,z&target=x,y,z&fov=42&quality=full&exposure=1.9&debug=albedo&ui=off`.
`--above=<metres>` places the camera relative to the terrain surface once
streaming has settled. `docs/reference-hero.md` and `docs/visual-target.md` hold
the target frame and the scoring rubric.

`bun run tools/scoutSites.ts` scans the height field for candidate viewpoints —
alpine climate, high relief, a valley floor in front — without rendering.

## Editor controls

- Inspect mode: left-drag orbits, right-drag pans, wheel/middle dollies.
- Editing mode: left-drag applies the brush; Alt+left-drag orbits.
- `W A S D` flies laterally, `Q / E` changes elevation, and Shift accelerates.
- `1`–`0` selects inspect and the sculpt tools; `P`, `G`, and `T` select paint, density, and tunnel.
- `[` / `]` changes brush radius; `H` toggles telemetry.

The inspector exposes two authoring domains. **Heightfield · Y** keeps brush displacement vertical for traditional landscape work. **Mesh · XYZ** follows the picked surface normal, so strokes can push into X/Z and form lateral deformation or overhangs. Raise/lower, smooth, flatten, clay, pinch, scrape, terrace, and seeded noise strokes remain grouped into editable sculpt layers. Four paint channels have configurable names, colors, and roughness.

The Granite Rock Lab ports scifi-kit's seed-driven fractured-granite SDF through QEF dual contouring and the source metre conversion. Formation, uniform placement scale, wetness, lichen, moss, snow, relief, seed, and topology quality stay editable after placement. A selected scene rock can be snapshotted with its current transform as an exact add/subtract CSG operand without removing or coupling the original rock.

Procedural boxes, spheres, capsules, and imported GLB triangle meshes also become live exact-CSG modifiers. Choose add or subtract, then select the operand to translate, pitch/yaw/roll, or scale it with the viewport gizmo or numeric controls. Moving it later re-evaluates the terrain instead of baking the result.

Edits preview immediately on the active GPU mesh. The authoritative modifier stack is compiled off-thread, revision-checked, and swapped into the scene only when the frame budget permits.

## Architecture

```text
WorldTerrain (plain TypeScript)
  ├─ MeshPartition + EditableMeshSection
  ├─ spatial ModifierStack
  ├─ TerrainCompiler → persistent worker pool
  ├─ FrameBudgetScheduler
  ├─ screen-error LOD selector
  ├─ TerrainStreamer + residency/LRU budgets
  ├─ IndexedDB TerrainStorage
  └─ TerrainRenderBackend
       └─ ThreeTerrainRenderBackend (imperative WebGPU objects)

React / R3F
  ├─ one stable TerrainView
  ├─ WebGPU renderer lifecycle and resize guard
  ├─ editor camera + brush picking
  └─ controls, overlays, and live telemetry
```

Core engine state lives under `src/terrain` and does not depend on React. `BufferGeometry` is a compiled render output, not authoring data. Section builds carry monotonic revisions; stale worker results cannot replace newer source data. Existing meshes stay visible while replacements compile, and retired GPU geometry is disposed through a delayed queue.

### Authoritative mesh sources

A section can now use either the lightweight procedural recipe or an arbitrary
`EditableMesh` as its authoritative source. Editable sources carry stable
vertex/triangle IDs, arbitrary float attributes, compact adjacency, a lazy
triangle AABB tree, and deterministic boundary ownership/weld keys. Worker
builds consume that source directly; they do not project it back onto an X/Z
height grid. LODs retain stable vertex identity, and exact CSG supports both
open terrain shells and closed meshes.

Install a section-local mesh through `WorldTerrain.replaceSectionMesh()`. X/Z
coordinates are local to the section and Y remains in world elevation space.
The world takes ownership, enforces the editable-source memory budget, retains
authored source through streaming eviction, and exposes defensive copies through
`getSectionMesh()`. `restoreProceduralSection()` switches the section back to
its deterministic recipe.

This source contract is intentionally internal while the editor is a prototype.
The current IndexedDB record stores modifiers and authored procedural-rock
recipes/transforms. Arbitrary section source meshes still need the later
project/document workflow, so this phase does not freeze or migrate a public
mesh file format for those sources.

## Terrain pipeline

Each resident 128 m section is generated and compiled independently. Procedural sections evaluate their deterministic terrain recipe, while editable sections begin from their supplied indexed source topology. A build evaluates transformed spatial modifiers, emits adaptive local coordinates for procedural density regions, applies BVH-accelerated volumetric CSG for tunnel topology, validates one authoritative indexed mesh, and derives the coarser levels with error-bounded QEM simplification. Borders, stable IDs, sculpted regions, tunnel interiors, normals, colors, and cached material fields are retained from that source mesh, so topology cannot vanish merely because an independently sampled coarse grid missed it.

Streaming is centered on the camera's orbit/fly target rather than the camera's ground position. The resident radius expands with the projected viewport footprint, contracts slowly with hysteresis, and never shrinks because of a transient slow frame. A worker-generated coarse far-field mesh keeps the full world silhouette visible beyond the editable working set and while newly requested sections compile.

The editor includes repeatable sculpt, rebuild, and high-speed streaming torture scenarios. The HUD exposes frame time, terrain scheduling time, LOD triangles, worker cancellation/staleness, swap/upload activity, CPU/GPU residency, stream churn, and accumulated budget violations.

## Persistence

Modifier data and authored granite-rock recipes/transforms are stored locally in IndexedDB. Save writes the current terrain edit graph and placed rocks; Reset clears local data and restores the demonstration tunnel and remeshed high-density region. Persistence sits behind `TerrainStorage`, so another section-oriented backend can replace IndexedDB without changing the editor or terrain engine.

## Tests

The Vitest suite covers section addressing and bounds, boundary invalidation, editable-mesh operations, modifier ordering/transforms, worker packet transfer/cancellation/staleness, deterministic compilation, XYZ mesh brushes, shared-edge continuity, tunnel topology, LOD error/hysteresis/neighbor constraints, streaming priority/LRU behavior, scheduler budgets/coalescing, and IndexedDB serialization.

The detailed target architecture and invariants are documented in `IMPLEMENTATION_PLAN.md`.
