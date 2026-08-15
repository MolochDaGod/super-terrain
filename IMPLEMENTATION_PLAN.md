# /goal

Build a production-quality terrain/world editor inside this fresh Vite + React + TypeScript + React Three Fiber application using **three.js WebGPURenderer**.

The system should take architectural inspiration from Unreal's new Mesh Terrain / Mesh Partition approach, but be designed specifically for browser/WebGPU constraints.

This is NOT a heightmap-only terrain component.

Build a general **partitioned editable terrain mesh system** capable of:

* huge open worlds
* arbitrary 3D terrain topology
* cliffs
* overhangs
* caves/tunnels
* sculpting
* local remeshing
* procedural modifiers
* asynchronous compilation
* aggressive LOD
* streaming
* persistent editing

The editor must remain interactive at 60 FPS while terrain processing occurs.

## Absolute performance invariant

The render/game thread must NEVER synchronously perform expensive terrain processing.

Treat 16.67 ms as a hard frame deadline.

Prefer:

1. lower terrain LOD
2. delayed rebuild
3. coarser preview
4. reduced streaming radius
5. reduced background work
6. temporary proxy geometry

BEFORE allowing terrain work to stall a frame.

No operation such as:

* sculpting
* remeshing
* mesh simplification
* boolean CSG
* chunk generation
* BVH construction
* serialization
* loading
* LOD generation

may cause a large synchronous main-thread spike.

Build an explicit frame-budget scheduler.

Target terrain-specific main-thread overhead:

* normal frame: <1 ms CPU
* editor interaction: <2 ms CPU
* absolutely avoid >4 ms terrain CPU spikes

Heavy geometry processing belongs in Web Workers and later may be moved to WASM/WebGPU compute where useful.

---

# Core architectural principle

Separate:

```text
AUTHORING DATA
      ↓
PARTITIONED EDITABLE MESH
      ↓
MODIFIER / BUILD GRAPH
      ↓
ASYNC COMPILATION
      ↓
COMPILED TERRAIN CHUNKS
      ↓
LOD + STREAMING
      ↓
RENDER REPRESENTATION
```

The mesh being edited must NOT need to be identical to the mesh currently rendered.

A temporary old compiled mesh is preferable to stalling while producing a new one.

---

# 1. WorldTerrain

Create a framework-level `WorldTerrain` system independent from React.

React/R3F should only expose/editor-bind it.

Do NOT place core terrain state in React state.

Suggested structure:

```text
src/terrain/
  core/
  mesh/
  partition/
  modifiers/
  compiler/
  lod/
  streaming/
  workers/
  rendering/
  editor/
  persistence/
  debug/
  benchmarks/
```

Core engine code should be plain TypeScript.

R3F is merely the presentation/integration layer.

---

# 2. MeshPartition

The world is divided spatially into sections.

For example:

```text
World
 ├── Section (-1,-1)
 ├── Section ( 0,-1)
 ├── Section ( 1,-1)
 ├── Section (-1, 0)
 ├── Section ( 0, 0)
 └── ...
```

Do NOT treat sections as separate disconnected terrain tiles conceptually.

They are ownership, compilation, LOD and streaming boundaries of one logical terrain surface.

Use configurable world-space section sizes, initially approximately:

```ts
sectionSize = 128 // meters
```

Do not hardcode it.

Each section needs something conceptually similar to:

```ts
interface TerrainSection {
  key: SectionKey

  source: EditableMeshSection

  revision: number

  bounds: AABB

  dirtyRegion?: AABB

  buildState:
    | 'clean'
    | 'queued'
    | 'building'
    | 'ready'
    | 'failed'

  compiled?: CompiledSection

  pendingCompiled?: CompiledSection
}
```

---

# 3. Editable mesh representation

Do NOT base the architecture around `THREE.BufferGeometry`.

BufferGeometry is an output/render representation.

Create a proper editable indexed mesh structure.

It must support:

* vertices
* edges
* triangles
* adjacency
* boundary detection
* vertex attributes
* triangle attributes
* insertion/removal
* local topology changes
* extracting regions
* spatial queries

Use compact typed-array-friendly data where practical.

A half-edge or similarly capable topology representation is acceptable, but avoid excessive object-per-edge garbage.

Design interfaces so a future Rust/WASM implementation can replace the TypeScript implementation without changing the terrain architecture.

Example:

```ts
interface EditableMesh {
  positions: ...
  triangles: ...

  getVertexNeighbors(...)
  getTriangleNeighbors(...)
  queryTriangles(...)
  extractRegion(...)
  applyPatch(...)
}
```

Do NOT create millions of tiny JS objects.

---

# 4. Section boundaries

This is critical.

Terrain must remain visually and topologically seamless across partitions.

Implement a formal boundary ownership policy.

Operations affecting a section edge must also invalidate neighboring sections.

Use dirty bounds + an operation halo.

For example:

```text
modifier bounds
      +
remesh safety margin
      ↓

[section A][section B]
       ↑
 both rebuild
```

Compiled LOD meshes must preserve section boundary constraints.

LOD simplification may NOT arbitrarily move/remove required boundary vertices.

No cracks.

---

# 5. Initial world generation

Start with a large flat triangulated plane, but DO NOT make it one enormous regular grid.

Generate it section-by-section.

The default world should immediately demonstrate that the engine can represent something much larger than what is currently resident.

Example logical test world:

```text
16 km × 16 km
```

Do NOT allocate high-resolution geometry for the entire 16 km world.

Only nearby sections should have resident render geometry.

---

# 6. Terrain modifiers

Create a non-destructive modifier architecture.

```ts
interface TerrainModifier {
  id: string
  enabled: boolean
  priority: number
  bounds: AABB

  evaluate(ctx: ModifierContext): void | Promise<void>
}
```

Modifiers should be spatially indexed.

Changing a modifier should invalidate only intersecting terrain sections.

Initial modifiers:

### Deformation

* RaiseLowerBrush
* SmoothBrush
* FlattenBrush
* NoiseModifier
* Texture/field displacement abstraction

### Topology

* TessellateModifier
* RemeshModifier

### 3D topology

Architect for:

* BooleanAdd
* BooleanSubtract
* BooleanIntersect

Implement at least BooleanSubtract sufficiently to demonstrate a tunnel/cave through terrain.

Robustness matters more than building every CSG algorithm ourselves. A reliable geometry/WASM dependency may be wrapped behind our own `MeshBooleanBackend` interface if appropriate.

Never couple the terrain architecture to one Boolean implementation.

---

# 7. Sculpting

Build an actual editor brush.

Controls:

* radius
* strength
* falloff
* raise/lower
* smooth
* flatten

Visualize the brush in world space.

Sculpting must feel immediate.

Do NOT rebuild the final terrain synchronously on every pointer event.

Use a two-stage system:

```text
pointer movement
      ↓
immediate interactive preview
      ↓
record sparse edit/modifier
      ↓
mark local sections dirty
      ↓
background rebuild
      ↓
atomic compiled-section swap
```

Old geometry remains rendered until replacement geometry is ready.

Never blank/remove a section while rebuilding.

Coalesce rapid brush events.

Do not start 50 redundant builds while dragging.

Use revision IDs/cancellation:

```text
revision 21 building
revision 22 requested
revision 23 requested

→ result 21 is stale
→ skip 22 if possible
→ build 23
```

---

# 8. Adaptive remeshing

This is a MESH TERRAIN system, so terrain resolution must not be globally fixed.

Implement local remeshing architecture.

Terrain can have:

```text
large smooth hill:
   long edges / low triangle density

hero cliff:
   short edges / high triangle density

tunnel entrance:
   extremely local high density
```

Remeshing should target an approximate edge length/density field.

Example conceptual API:

```ts
remesh(region, {
  targetEdgeLength,
  minEdgeLength,
  maxEdgeLength,
  iterations
})
```

Support future density fields:

```ts
targetEdgeLength = densityField(position)
```

Topology processing MUST occur off-main-thread.

---

# 9. Worker architecture

Create a persistent terrain worker pool.

Do NOT create a new worker per operation.

Conceptually:

```text
MAIN THREAD

camera
renderer
input
selection
LOD selection
stream scheduler
frame scheduler

         ↕ transferable buffers

WORKER POOL

modifier evaluation
remeshing
booleans
simplification
BVH construction
LOD generation
serialization
```

Use transferable `ArrayBuffer`s / typed arrays.

Avoid structured-cloning giant JS object graphs.

Define explicit binary-ish worker messages.

Jobs have:

* job ID
* section key
* revision
* priority
* operation
* transferable input buffers
* cancellation/staleness handling

Prioritize:

1. section underneath active brush
2. camera-near dirty sections
3. visible section rebuilds
4. incoming streaming sections
5. far LOD generation
6. background persistence

---

# 10. Compiler

Create:

```ts
TerrainCompiler
```

It converts an editable section into a runtime representation.

Pipeline:

```text
editable mesh
     ↓
apply modifiers
     ↓
repair/validate
     ↓
normals/tangents
     ↓
build acceleration data
     ↓
LOD generation
     ↓
render buffers
     ↓
CompiledSection
```

Example:

```ts
interface CompiledSection {
  key: SectionKey
  sourceRevision: number

  bounds: AABB

  lods: CompiledLOD[]

  collision?: CompiledCollision

  metadata?: CompiledTerrainMetadata
}
```

Compilation is asynchronous.

At completion:

```ts
section.pendingCompiled = result
```

The main thread performs only a cheap atomic-style swap:

```ts
section.compiled = section.pendingCompiled
```

Dispose old GPU resources later through a safe deferred-disposal queue.

---

# 11. LOD system

Do NOT use one terrain mesh resolution.

Generate multiple geometric LODs per compiled section.

Start with approximately:

```text
LOD0 100%
LOD1 50%
LOD2 25%
LOD3 12.5%
LOD4 ~6%
```

But drive selection using screen-space geometric error rather than hardcoded distances.

Each LOD should have an error metric.

Selection should consider:

```text
projectedError =
    geometricError
    * projectionScale
    / cameraDistance
```

Add hysteresis so chunks do not rapidly flip between LODs.

Adjacent terrain sections should preferably differ by no more than one LOD.

Implement crack prevention.

Possible implementation:

* locked boundary vertices
* explicit edge stitching
* skirts as a robust fallback

Keep architecture open for future geomorphing.

---

# 12. Streaming

Build a real `TerrainStreamer`.

The logical world may contain tens of thousands of sections.

Only a bounded working set may remain resident.

States:

```text
UNLOADED
SOURCE_RESIDENT
COMPILED_CPU
GPU_RESIDENT
VISIBLE
```

These are separate concepts.

A section can have source data without GPU geometry.

Use:

* camera position
* camera velocity
* view frustum
* projected size
* edit focus

to determine priority.

Prefetch in the movement direction.

Example:

```text
camera --->

low priority  medium   HIGH   HIGH   prefetch
```

Use separate budgets:

```ts
maxGpuBytes
maxCpuCompiledBytes
maxEditableMeshBytes
maxUploadsPerFrame
maxSectionSwapsPerFrame
```

Implement LRU/priority eviction.

Do NOT unload a section merely because it leaves the frustum for one frame.

---

# 13. FrameBudgetScheduler

This is mandatory.

Create a central scheduler.

```ts
interface FrameBudget {
  cpuTerrainMs: number
  gpuUploadBytes: number
  sectionSwaps: number
}
```

Every main-thread terrain task must go through it.

Example:

```ts
if (budget.remainingCpuMs < estimatedCost) {
  defer(task)
}
```

The renderer takes priority over terrain maintenance.

Never upload dozens of large buffers in one frame.

Spread GPU uploads across frames.

Track timings using `performance.now()` initially.

Expose them in the debug HUD.

---

# 14. Dynamic quality pressure

If performance falls below target:

```text
60fps target missed
      ↓
increase LOD error tolerance
      ↓
reduce far render radius
      ↓
reduce prefetch
      ↓
reduce uploads/rebuild consumption
      ↓
reduce expensive visual detail
```

If plenty of frame budget is available, progressively restore quality.

Do not oscillate every frame; use moving averages and hysteresis.

The terrain engine should behave like a real-time system rather than assuming all desired work must happen immediately.

---

# 15. Rendering architecture

Use:

```ts
three/webgpu
THREE.WebGPURenderer
React Three Fiber
```

Do not accidentally instantiate WebGLRenderer.

Keep terrain rendering imperative internally.

React should NOT rerender thousands of individual terrain components when the camera moves.

Prefer something conceptually like:

```tsx
<TerrainView terrain={terrainEngine} />
```

where `TerrainView` owns a stable group and the terrain renderer imperatively adds/removes/swaps Three objects.

Avoid one React component per triangle/meshlet/etc.

Use shared materials.

Use a TSL-compatible terrain material.

Keep shader/material variants tightly controlled.

Avoid runtime shader recompilation while editing.

---

# 16. GPU representation

The initial renderer may use indexed `BufferGeometry`, but hide this behind:

```ts
TerrainRenderBackend
```

so we can later implement:

* merged render buffers
* pooled GPU buffers
* meshlets
* indirect rendering
* GPU culling
* compute-driven terrain
* virtual geometry

without rewriting the terrain engine.

Do not architect the system around `THREE.Mesh` as the canonical terrain object.

---

# 17. Buffer pooling

Avoid allocation churn.

Build:

```text
ArrayBufferPool
GeometryPool
GPU resource lifecycle manager
```

Reuse memory where possible.

Never allocate huge transient typed arrays every frame.

No per-frame terrain garbage.

Track allocation counts in development.

---

# 18. Spatial acceleration

Terrain needs fast:

* raycasts
* brush queries
* modifier intersection
* visible-section lookup
* triangle queries

Build separate acceleration structures for appropriate jobs.

At world level use a sparse section grid / spatial hash.

Inside editable sections use a triangle acceleration abstraction, initially BVH/AABB tree.

Do not raycast every triangle in every section.

Brush picking should only query relevant resident sections.

---

# 19. Persistence

Architect sections to serialize independently.

Use a format conceptually like:

```text
world/
   metadata
   section_-12_8
   section_-11_8
   ...
```

For the browser demo, implement IndexedDB-backed persistence behind:

```ts
TerrainStorage
```

Do not serialize the whole world after each edit.

Only changed source sections/modifier data should become dirty.

Persistence is low-priority background work.

---

# 20. Coordinate precision

This system is intended for large open worlds.

Do not assume world coordinates can grow indefinitely without precision issues.

Create an explicit world-coordinate abstraction.

Architect for floating-origin / origin rebasing from the beginning.

Rendering coordinates should remain camera-local enough to preserve precision.

Section keys should be integer world-grid coordinates rather than deriving identity from floating-point positions.

---

# 21. Editor UI

Build a clean editor overlay.

Need:

* select tool
* sculpt raise/lower
* smooth
* flatten
* remesh density tool
* tunnel/Boolean test tool

Controls:

* brush radius
* strength
* falloff
* target edge length

Add fly/orbit navigation suitable for world editing.

Provide visual overlays for:

* section boundaries
* current section LOD
* dirty sections
* rebuilding sections
* streaming state
* triangle density
* section IDs

---

# 22. Performance/debug HUD

Make this excellent.

Display live:

```text
FPS
frame ms

terrain main-thread ms
terrain scheduling ms

visible sections
GPU-resident sections
source-resident sections

triangles rendered
triangles LOD0/1/2/3/...

worker jobs
queued jobs
cancelled/stale jobs

sections rebuilding
sections swapped this frame

GPU upload bytes/frame

estimated GPU terrain memory
estimated CPU terrain memory

stream loads/sec
stream evictions/sec
```

Also visualize frame-budget violations.

This HUD is part of the deliverable, not an afterthought.

---

# 23. Test scenes

Build several scenarios.

## A — Sculpt benchmark

Rapidly sculpt continuously while moving the camera.

The camera/render thread must stay smooth while background terrain catches up.

## B — Large world

Logical world:

```text
16 km × 16 km
```

Camera can fly across it rapidly.

Only a bounded set of sections stays resident.

## C — High density cliff

Create adaptive high-resolution topology on a cliff while surrounding terrain stays coarse.

## D — Tunnel

Create an actual opening through terrain.

It must demonstrate arbitrary topology:

* entrance
* walls
* ceiling
* underside

It must NOT be a visual shader illusion.

## E — Streaming torture test

Move the camera at extreme speed across section boundaries.

No giant synchronous loading spikes.

## F — rebuild torture test

Continuously modify terrain while flying around.

Old compiled geometry remains usable while new geometry compiles.

---

# 24. Architecture rules

Follow these rigorously.

### DO

* use plain TS engine systems
* isolate R3F integration
* use workers
* use typed arrays
* spatially invalidate
* aggressively cache
* use revisions
* cancel obsolete work
* enforce budgets
* asynchronously compile
* stream sections
* create geometric LODs
* keep old render data until replacements exist
* profile everything

### DO NOT

* store terrain geometry in React state
* rebuild the entire terrain after edits
* use a single giant geometry
* use one high-resolution mesh for the whole world
* synchronously remesh during pointer movement
* regenerate all LODs on the main thread
* recreate materials every render
* allocate large arrays every frame
* serialize the complete world on edits
* let section loading dictate frame time
* block rendering waiting for workers
* silently simplify arbitrary topology back into a heightfield

---

# 25. Correctness invariants

Add runtime assertions in development for:

```text
no NaN positions
valid triangle indices
no zero-area triangles after compilation where avoidable
section revision monotonicity
stale build result never replaces newer result
no disposed GPU resource remains referenced
no duplicate active build for same section/revision
neighbor boundary compatibility
memory budgets respected
```

Build mesh validation utilities.

---

# 26. Tests

Add unit tests for:

* section addressing
* bounds
* dirty-region propagation
* boundary ownership
* modifier ordering
* job cancellation
* stale revisions
* LOD selection
* LOD hysteresis
* neighbor constraints
* streaming priority
* LRU eviction
* serialization
* worker message encode/decode

Add deterministic procedural tests for mesh editing.

Do not make visual/manual testing the only verification.

---

# 27. Benchmark harness

Create repeatable benchmarks rather than relying on intuition.

Record:

```text
section compile time
remesh time
LOD generation time
BVH generation time
serialization time
worker roundtrip
GPU upload cost
main-thread terrain time
```

Allow benchmark scenarios to run from the editor UI.

Keep a rolling performance history.

---

# 28. Development order

Do NOT attempt every feature simultaneously.

Implement vertically:

### Phase 1

WebGPURenderer + editor shell + world/section architecture.

### Phase 2

Partitioned flat terrain + streaming.

### Phase 3

Compiled section representation + async worker compilation.

### Phase 4

LOD hierarchy + screen-space selection.

### Phase 5

Sculpting with dirty-region rebuilds.

### Phase 6

Editable topology + adaptive remeshing.

### Phase 7

Actual arbitrary mesh terrain / overhang topology.

### Phase 8

Boolean tunnel.

### Phase 9

persistence + memory budgets.

### Phase 10

performance torture tests and optimization.

At the end of EVERY phase, run the app and validate the existing architecture before continuing.

Do not paper over structural issues because later phases depend on them.

---

# Definition of success

When complete, I should be able to:

1. open the editor
2. see a large streamed terrain world
3. fly rapidly through it
4. watch sections stream and change LOD
5. sculpt terrain continuously
6. see immediate feedback while final geometry rebuilds asynchronously
7. locally increase topology density
8. create steep/vertical/overhanging terrain
9. subtract a real tunnel/cave through the terrain mesh
10. continue navigating while these operations compile
11. save and reload edits
12. inspect all partition/LOD/worker/streaming behavior visually

The architecture should reasonably scale toward **tens of kilometers of terrain and thousands/tens-of-thousands of logical sections**, with runtime cost primarily determined by the bounded visible/resident working set rather than total world size.

The final system should resemble this conceptual pipeline:

```text
                       WORLD TERRAIN
                            │
                 ┌──────────┴──────────┐
                 │  spatial sections   │
                 └──────────┬──────────┘
                            │
                   editable mesh data
                            │
                   modifier build graph
                            │
                      dirty regions
                            │
                    priority scheduler
                            │
                       worker pool
                            │
             ┌──────────────┼──────────────┐
             │              │              │
          remesh           CSG          simplify
             │              │              │
             └──────────────┼──────────────┘
                            │
                       compiler
                            │
                  CompiledSection
                            │
            ┌───────────────┼────────────────┐
            │               │                │
          LODs          collision       metadata
            │
            ▼
                  streaming manager
                            │
                     GPU residency
                            │
                     render backend
                            │
                   THREE.WebGPURenderer
```

Prioritize architecture, correctness, profiling and bounded frame-time behavior over flashy visuals.

Do not produce a toy demo disguised as this architecture.

If an implementation choice conflicts with maintaining responsive frame times, choose the architecture that allows work to be **deferred, reduced, cancelled, streamed, or moved off-thread**.
