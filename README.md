# Mesh Terrain Lab

A browser-first, partitioned mesh-terrain editor inspired by Unreal Engine 5.8's Mesh Terrain architecture. It runs on Three.js `WebGPURenderer` through React Three Fiber and keeps terrain authoring, compilation, streaming, and rendering as separate systems.

This is not a single heightmap mesh. The demo world is a sparse 16 km × 16 km logical terrain with editable topology, local density control, real tunnel interior geometry, five geometric LODs, worker compilation, bounded residency, and IndexedDB persistence.

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

## Editor controls

- Inspect mode: left-drag orbits, right-drag pans, wheel/middle dollies.
- Editing mode: left-drag applies the brush; Alt+left-drag orbits.
- `W A S D` flies laterally, `Q / E` changes elevation, and Shift accelerates.
- `1`–`7` selects inspect, raise, lower, smooth, flatten, density, and tunnel tools.
- `[` / `]` changes brush radius; `H` toggles telemetry.

The inspector exposes two authoring domains. **Heightfield · Y** keeps brush displacement vertical for traditional landscape work. **Mesh · XYZ** follows the picked surface normal, so strokes can push into X/Z and form lateral deformation or overhangs. One uninterrupted press/drag creates one non-destructive modifier containing spatially resampled, frame-scaled brush flow: holding in place raises or lowers continuously instead of stamping discrete full-strength dabs. Density operations and tunnel subtractions are modifiers too. Select a stack entry to enable, move, rotate, scale, or delete it; affected sections are then rebuilt from source.

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

## Terrain pipeline

Each resident 128 m section is generated and compiled independently. A build evaluates transformed spatial modifiers, emits adaptive local coordinates for density regions, applies BVH-accelerated volumetric CSG for tunnel topology, validates the indexed mesh, computes normals/colors, and generates five nested LOD buffers. Shared boundary samples and analytical boundary normals keep neighboring sections visually continuous without dark skirt walls.

Streaming is centered on the camera's orbit/fly target rather than the camera's ground position. The resident radius expands with the projected viewport footprint, contracts slowly with hysteresis, and never shrinks because of a transient slow frame. A worker-generated coarse far-field mesh keeps the full world silhouette visible beyond the editable working set and while newly requested sections compile.

The editor includes repeatable sculpt, rebuild, and high-speed streaming torture scenarios. The HUD exposes frame time, terrain scheduling time, LOD triangles, worker cancellation/staleness, swap/upload activity, CPU/GPU residency, stream churn, and accumulated budget violations.

## Persistence

Modifier data is stored locally in IndexedDB. Save writes the current terrain edit graph; Reset clears local data and restores the demonstration tunnel and remeshed high-density region. Persistence sits behind `TerrainStorage`, so another section-oriented backend can replace IndexedDB without changing the editor or terrain engine.

## Tests

The Vitest suite covers section addressing and bounds, boundary invalidation, editable-mesh operations, modifier ordering/transforms, worker packet transfer/cancellation/staleness, deterministic compilation, XYZ mesh brushes, shared-edge continuity, tunnel topology, LOD error/hysteresis/neighbor constraints, streaming priority/LRU behavior, scheduler budgets/coalescing, and IndexedDB serialization.

The detailed target architecture and invariants are documented in `IMPLEMENTATION_PLAN.md`.
