# Standalone Mesh Terrain Editor Roadmap

Status: proposed

Audit baseline: `main` at `3d295b7`, 2026-08-17

Target: a focused, browser-first terrain authoring application inspired by Unreal Engine 5.8 Mesh Terrain, not a recreation of the full Unreal Editor.

## Executive decision

The repository already has a strong real-time terrain-engine prototype. The next product milestone should not be “add more brushes.” It should be to turn the prototype into a durable editor document with a correctly ordered mesh build graph.

The recommended sequence is:

1. make projects, history, persistence, and recovery trustworthy;
2. make modifier ordering and local topology editing semantically correct;
3. expose create/import/section workflows and a real Mesh Partition outliner;
4. add sculpt layers, weight-channel painting, and configurable materials;
5. add spline, water, procedural, scatter, and runtime build workflows;
6. productionize rendering, streaming, testing, and distribution.

This ordering matters. Material painting, PCG, water, and procedural tools all depend on stable project data, stable element identity, ordered layers, and attributes surviving remesh/LOD operations.

## Scope

### Product target

The target is an isolated editor that lets a user:

- create a terrain from a rectangle, heightmap, or arbitrary mesh;
- split, merge, load, and unload base sections;
- build non-heightfield terrain with cliffs, overhangs, arches, caves, and tunnels;
- compose named, ordered, non-destructive modifier layers;
- sculpt geometry and paint named weight channels;
- author terrain materials and scatter rules from those channels;
- use splines for roads, rivers, ridges, cuts, and other projected shapes;
- run deterministic procedural operations such as erosion and scattering;
- preview quickly while compiling a higher-quality runtime result separately;
- generate LODs, collision, far field, channel tiles, and a streamable export;
- save, recover, undo, redo, import, export, and reopen real projects.

### Deliberate non-goals for v1

- recreating Unreal's complete level editor, actor system, Blueprint system, or source-control stack;
- exact Nanite, Lumen, World Partition, or Runtime Virtual Texture compatibility;
- multiplayer or simultaneous collaborative editing;
- general-purpose character, animation, physics, or gameplay authoring;
- silently supporting WebGL. WebGPU remains a declared requirement.

Equivalent focused solutions are in scope: meshlets and GPU-driven culling instead of exact Nanite, tiled weight-channel clipmaps instead of Unreal RVT assets, and an explicit terrain build graph instead of Unreal actor components.

## Verified baseline

### What is already real

| Area | Current capability |
| --- | --- |
| World model | Sparse 16 km world divided into configurable 128 m logical sections. |
| Source geometry | Procedural sources plus section-local arbitrary `EditableMesh` sources with stable vertex/triangle IDs and attributes. |
| Topology | Real Boolean subtraction for tunnels and arbitrary closed cutters; caves are geometry, not shader holes. |
| Sculpting | Raise, lower, smooth, and flatten in heightfield-Y and mesh-normal-XYZ domains, with immediate resident-mesh preview. |
| Modifiers | Non-destructive stack with spatial bounds, enable/disable, transforms, deterministic numeric priority, and section invalidation. |
| Compilation | Persistent worker pool, transferable buffers, revisions, stale-result rejection, cancellation, and budgeted main-thread swaps. |
| LOD | Five geometric LOD levels, measured error, hysteresis, neighboring-level constraints, locked authored features, and skirts. |
| Streaming | Bounded CPU/GPU residency, view-target-centered working set, prefetch, retention, LRU-style eviction, and a coarse horizon proxy. |
| Rendering | Three.js WebGPU renderer, preview/full modes, procedural layered terrain shader, parallax detail, sky, haze, shadows, and post processing. |
| Diagnostics | Section/LOD/density/streaming overlays, detailed telemetry, and three stress scenarios. |
| Persistence | Automatic and manual IndexedDB storage for the current modifier stack. |
| Verification | 80 unit/integration tests pass; typecheck and lint pass; a deterministic headless render capture harness exists. |

### Important limitations hidden by the current UI

These are the highest-priority correctness gaps:

1. **There is no project document.** `App.tsx` constructs one hard-coded world, and persistence saves only the modifier array under the ID `default`. Authoritative editable source meshes, assets, terrain definition, build settings, editor state, and derived data are not persisted.
2. **The current density tool is not general mesh remeshing.** Procedural sections receive extra X/Z coordinate bands. Editable arbitrary meshes are not edge-split, edge-collapsed, edge-flipped, or isotropically remeshed. The current tessellate type has no distinct topology implementation.
3. **Modifier priority is not fully compositional.** The stack is sorted, but the compiler collects density and Boolean modifiers into separate groups. A Boolean cannot reliably feed a later displacement/remesh operation according to layer order, which is central to Unreal's workflow.
4. **The far field does not contain authored results.** It is generated from the base procedural height function and does not incorporate saved source meshes, sculpting, channels, or topology modifiers.
5. **Origin rebasing is only an unused abstraction.** `WorldCoordinates` exists but is not integrated into camera, rendering, picking, modifiers, or streaming.
6. **The buffer pool is unused.** `ArrayBufferPool` exists but compilation and transfer paths do not consume it.
7. **The target frame rate is currently 30 FPS.** The original architecture brief says 60 FPS, while `DEFAULT_TERRAIN_CONFIG.targetFps` is 30. Product targets and quality tiers need an explicit decision.
8. **Only a subset of existing internal types is authorable.** Noise, field displacement, tessellation, and arbitrary Boolean volumes exist in types or demo content but do not have complete create/edit workflows in the UI.
9. **Compiled output has no collision, channel tile, or runtime package.** `CompiledSection` contains render LOD buffers only.
10. **There is no undo/redo transaction model.** Destructive UI actions immediately mutate the stack and autosave it.

## Unreal 5.8 parity gap matrix

The priorities below refer to this focused editor, not full engine parity.

| Capability | Current state | Target state | Priority |
| --- | --- | --- | --- |
| Create rectangle | Hard-coded world/config | New-project wizard with size, resolution, layout, automatic/explicit sections, and initial definition | P0 |
| Import heightmap | Missing | 16-bit PNG/TIFF/RAW import, scale/axis preview, validation, resampling, and section partitioning | P0 |
| Convert/import mesh | Internal section replacement API only | GLB/glTF first, optional OBJ; units/up-axis, repair report, automatic partitioning, and attribute mapping | P0 |
| Project/document workflow | One `default` IndexedDB record | Multiple named projects, Save As, recent projects, dirty state, autosave, recovery, package import/export | P0 |
| Undo/redo | Missing | Transactional history for strokes, paint, transforms, layer operations, imports, and section edits | P0 |
| Section editing | Fixed grid | Select, split, merge, add, remove, load, unload, inspect complexity, and validate boundaries | P0 |
| Modifier order | Numeric priority, only partly respected by compiler | Named priority layers, sub-priority, strict sequential evaluation, groups, dependency/cache keys | P0 |
| Mesh Partition outliner | Flat reverse list | Layered build-order tree, rename, reorder, duplicate, group, multi-select, timing, error state, and Build To | P0 |
| Preview/build enable state | One `enabled` flag | Separate editor-preview and final-build enable flags | P0 |
| Sculpting | Four brush modes | Sculpt layers, erase, grab, inflate, pinch, plane, ramp, terrace, noise, erosion, masks, alphas, presets, stylus pressure | P1 |
| Weight channels / paint | Broad compiler fields are fixed and internal | Named persistent channels, paint modes, masks, visualization, packing, and tiled bake | P1 |
| Remesh / tessellate | Adaptive Cartesian sampling for procedural sections | True local arbitrary-mesh remesh and tessellation with density masks and boundary constraints | P0 |
| Boolean tools | Subtraction-oriented cave/tunnel support | Add, subtract, intersect, trim, union; mesh/spline/primitive sources; repair and diagnostics | P1 |
| Texture modifier | Placeholder field abstraction only | Imported texture/stamp displacement, projection controls, masks, and adaptive tessellation | P1 |
| Spline modifiers | Missing | Deform, remesh, paint, road, river, ridge, trench, and mesh-projection spline workflows | P1 |
| Mesh/patch projection | Missing | Reusable patch assets, projected meshes, instanced modifiers, snapping, and attribute transfer | P1 |
| Materials | One hard-coded procedural material | Terrain-definition material layer stack, PBR asset import, triplanar/UV rules, channel bindings, physical material metadata | P1 |
| Material inspection | Preview/full plus internal debug variants | Existing, diffuse, grey, soft-light, normal, channel, wireframe, complexity, and custom inspection modes | P1 |
| Definition asset | Runtime config constants | Reusable terrain definition containing channels, priority layers, material, preview profile, and build profiles | P0 |
| Preview/runtime separation | Render modes share compiled terrain LODs | Independent preview compiler and deterministic final build pipeline with different complexity/quality settings | P1 |
| Transformer pipeline | Hard-coded compiler stages | Configurable repair, subsection, LOD, meshlet, collision, far-field, channel-bake, seam, and packaging stages | P1 |
| Build variants | Missing | High/medium/low and per-platform profiles with budgets and reproducible build manifests | P1 |
| Collision | Missing | Decoupled simplified triangle/heightfield collision generation and export | P1 |
| PCG read/write | Missing | Query terrain at a layer boundary, run deterministic graph nodes, write geometry/channels, scatter patch instances | P2 |
| Water | Missing | Lake/river/ocean surfaces, spline terraforming, shore/flow channels, and water-aware materials | P2 |
| Virtual texturing equivalent | Missing | Sparse tiled/clipmapped channel and material data that streams independently of geometry | P2 |
| Scatter/foliage | Shader-only grass appearance | Asset library plus deterministic GPU-instanced rocks, grass, trees, culling, LOD, masks, and bake/export | P2 |
| Runtime export | Missing | Versioned streamable terrain package and GLB/texture/collision interchange exports | P1 |
| Production QA | Unit tests and manual captures | Browser E2E, visual regression, fuzz/property tests, performance gates, leak tests, device-loss tests, and CI | P0-P1 |

## Target architecture

### 1. Project and editor state

Introduce a renderer-independent document model above `WorldTerrain`:

```text
TerrainProject
├── manifest + schema version
├── one or more TerrainDocuments
│   ├── TerrainDefinition reference
│   ├── base section descriptors
│   ├── modifier layer tree
│   ├── channel declarations
│   ├── build profiles
│   └── editor metadata
├── assets
│   ├── meshes
│   ├── heightmaps / masks / alphas
│   ├── material textures
│   └── scatter assets
└── derived-data cache
    ├── preview sections
    ├── runtime sections
    ├── collision
    ├── far field
    └── channel tiles
```

`WorldTerrain` becomes the live evaluation/runtime service for an open `TerrainDocument`; it should not own the only durable copy of authoring state.

Minimum durable interfaces:

```ts
interface TerrainProjectManifest {
  schemaVersion: number
  id: string
  name: string
  createdAt: number
  updatedAt: number
  terrainDocumentIds: string[]
  assetIndexVersion: number
}

interface TerrainDefinition {
  id: string
  sectionPolicy: SectionPolicy
  priorityLayers: PriorityLayerDefinition[]
  channels: WeightChannelDefinition[]
  material: TerrainMaterialDefinition
  previewProfile: PreviewBuildProfile
  buildProfiles: RuntimeBuildProfile[]
}

interface ModifierPlacement {
  id: string
  type: string
  schemaVersion: number
  layerId: string
  subPriority: number
  enabledInPreview: boolean
  enabledInBuild: boolean
  transform: Transform3D
  localBounds: AABB
  parameters: unknown
}
```

### 2. Transactions and history

Every authoring action must be a transaction with a reversible document patch:

```text
pointer-down
  -> begin SculptStrokeTransaction
pointer samples
  -> update live preview + transaction payload
pointer-up
  -> commit one history entry
  -> invalidate derived cache keys
  -> queue preview build
  -> autosave changed shards
```

History should store compact semantic patches, not full world snapshots. Large imported assets are content-addressed and referenced by hash. Undoing an import removes references but lets garbage collection reclaim unreferenced blobs later.

### 3. Strict staged build graph

Replace type-specific gathering with an ordered intermediate representation:

```text
base source
  -> layer 10 / sub 0: procedural deformation
  -> layer 20 / sub 0: true remesh
  -> layer 30 / sub 0: Boolean add
  -> layer 30 / sub 10: Boolean subtract
  -> layer 40 / sub 0: sculpt layer
  -> layer 50 / sub 0: channel paint
  -> transformer pipeline
```

Each stage declares:

- geometry read/write behavior;
- channel read/write behavior;
- bounds and base-growth behavior;
- topology/attribute invalidation;
- preview and final implementations;
- deterministic cache key inputs;
- cancellation points and estimated cost.

The compiler must be able to stop at any layer boundary for Build To, PCG queries, debugging, and incremental cache reuse.

### 4. Mesh kernel boundary

Keep the TypeScript-facing `EditableMesh` contract, but move heavy and failure-prone topology work behind a replaceable kernel interface. A Rust/WASM implementation is the preferred production direction after a short proof of concept.

Required kernel operations:

- constrained edge split, collapse, flip, and smoothing;
- isotropic and density-field remeshing;
- tessellation without global grid artifacts;
- Boolean add/subtract/intersect/trim/union;
- hole fill, weld, self-intersection detection, and repair;
- simplification with geometry, boundary, normal, UV, and channel constraints;
- region extraction and patch application with stable ID remapping;
- abort checks between bounded work batches;
- attribute interpolation and provenance reporting.

### 5. Storage

Use a two-layer browser strategy:

- OPFS/IndexedDB stores projects, shards, content-addressed assets, autosave journals, and derived data locally;
- File System Access API opens/saves a user-selected directory where supported;
- a portable `.meshterrain` package (ZIP container with manifest, binary section data, and assets) is the universal fallback.

Persist source sections independently. Never rewrite the complete modifier graph or all source meshes for a small stroke. Derived data is disposable and keyed by source/config hashes.

## Phased implementation plan

Effort ranges below are rough single-senior-engineer implementation ranges, including tests but excluding major visual-content production. They are planning aids, not commitments. Two or three engineers can overlap UI, mesh-kernel, rendering, and test work after Phase 1 stabilizes the data contracts.

### Phase 0 — Product contract and measurable baselines (1-2 weeks)

Deliverables:

- adopt this scope and mark the original `IMPLEMENTATION_PLAN.md` as the engine-prototype baseline;
- write target-device tiers and settle 60 FPS interactive target versus a declared 30 FPS quality fallback;
- capture baseline compile, memory, streaming, input-latency, first-shader, and steady-frame metrics;
- define three reference projects: 2 km authoring project, 16 km streaming project, and pathological cave/overhang project;
- define compatibility behavior for missing WebGPU features, storage quota, and unsupported import formats;
- add a capability/version registry for project schema, modifier types, and build stages.

Exit gate:

- a written product contract and benchmark JSON establish what “interactive,” “saved,” “portable,” and “runtime-ready” mean.

### Phase 1 — Real project document, history, and recovery (3-5 weeks)

Deliverables:

- add `TerrainProject`, `TerrainDocument`, `TerrainDefinition`, `EditorSession`, and `HistoryManager` boundaries;
- remove the hard-coded `default` world ownership from the app shell;
- implement New, Open, Save, Save As, Close, recent projects, project rename, and dirty-state UI;
- implement transactional undo/redo with Ctrl/Cmd+Z, Shift+Ctrl/Cmd+Z, and Ctrl/Cmd+Y;
- shard storage into manifest, definition, modifier layers, source sections, assets, journal, and derived cache;
- persist authoritative editable meshes and arbitrary attributes;
- add debounced autosave, crash journal, recovery prompt, multi-tab writer lock, quota reporting, and migration tests;
- add portable `.meshterrain` package import/export.

Exit gate:

- create two named projects, edit each, undo/redo across reloads, force-close during autosave, recover, export one package, delete local data, and reopen it with identical source hashes.

### Phase 2 — Create/import/export and base-section editing (4-6 weeks)

Deliverables:

- build Create, Edit, and Shapes editor modes;
- rectangle wizard: world size, units, base resolution, explicit layout or automatic maximum-triangle partitioning, definition selection, and save/unload option;
- heightmap import: 16-bit formats first, raw dimensions/endianness, elevation range, horizontal scale, crop/pad/resample, and visual preview;
- mesh import: GLB/glTF first, units/up-axis, transforms, selected attributes, manifold/winding/sliver report, repair options, and automatic section partitioning;
- expose current arbitrary-source APIs through document-safe commands;
- add primitive base shapes and conversion into mesh terrain;
- add base-section select, box select, split, merge, add, remove, load, unload, complexity inspection, and boundary validation;
- export selected/all compiled geometry to GLB, source mesh where possible, weight channels to images, and heightmaps only for representable heightfield regions.

Exit gate:

- create the same project from a rectangle, heightmap, and closed mesh; round-trip the mesh project; split and merge sections without visible cracks or lost attributes.

### Phase 3 — Correct modifier graph and Mesh Partition outliner (4-6 weeks)

Deliverables:

- introduce named priority layers and numeric sub-priority in `TerrainDefinition`;
- make compiler evaluation strictly respect build order across deformation, topology, and channels;
- add separate preview/build enable flags, base growth, coverage, local/world bounds, and affected-terrain references;
- build a modifier registry with versioned parameter schemas, factories, inspectors, icons, and migrations;
- replace the flat stack with a layered outliner showing build order, timing, cache state, errors, and affected sections;
- support rename, reorder, drag/drop, duplicate, group, multi-select, delete, solo/mute, and transform;
- add a Build To control and cached layer-boundary previews;
- add proper translate/rotate/scale gizmos, world/local orientation, snapping, typed values, pivot controls, and focus selection;
- expose existing noise, tessellate, arbitrary cutter, and field concepts as complete tools or explicitly remove placeholders.

Exit gate:

- a Boolean can create geometry that a later displacement and paint modifier affect, reordering produces the inverse deterministic result, and Build To shows every intermediate layer without rebuilding unchanged earlier stages.

### Phase 4 — Production mesh kernel, remeshing, and topology tools (8-12 weeks)

Deliverables:

- run a time-boxed Rust/WASM versus current-library kernel spike using the cave/overhang reference project;
- implement true local isotropic remesh with target edge length, min/max lengths, iterations, smooth strength, feature constraints, and density masks;
- implement distinct tessellation that subdivides existing faces without pretending to be remesh;
- support arbitrary editable sources, closed meshes, terrain shells, and section boundaries;
- preserve/interpolate stable IDs, normals, UVs, weight channels, material IDs, and custom attributes;
- coordinate cross-section boundary operations and produce deterministic weld mappings;
- add Boolean add, subtract, intersect, trim, and union with primitive, imported mesh, and generated spline sources;
- add repair diagnostics for self intersections, non-manifold edges, open boundaries, flipped winding, degenerates, and operation failure;
- add direct region tools: triangle selection, delete, fill holes, weld, simplify, remesh, project, and normals repair;
- replace worker termination as routine cancellation with bounded abort points where the kernel permits it;
- add property/fuzz tests and golden topology fixtures.

Exit gate:

- remesh a vertical closed mesh and a cross-section cave region without projecting to X/Z, preserve declared channels within tolerance, keep shared section boundaries compatible, and successfully undo/redo the result.

### Phase 5 — Sculpt layers, brush system, and weight-channel painting (6-9 weeks)

Deliverables:

- make Sculpt and Paint first-class editor modes operating on a selected modifier/layer;
- add local sculpt layers inside a sculpt modifier with reorder, opacity/strength, visibility, duplicate, merge, and erase;
- add grab, inflate/deflate, pinch, plane, ramp, terrace, noise, and erosion brushes after the current four core modes;
- add brush alphas/stamps, rotation, spacing, flow, jitter, backface control, connected-surface control, symmetry, masks, invert, and presets;
- add pointer pressure/tilt support with mouse fallbacks and configurable input mapping;
- define named float weight channels in `TerrainDefinition`;
- add paint add/subtract, replace, smooth, flood, erase, sample, exclusive-group painting, and per-channel clamp/default behavior;
- preserve channels through remesh, Boolean, simplification, section seams, save/load, and export;
- bake channel data to sparse section tiles/texture arrays and provide channel/packing debug overlays;
- reconcile the immediate GPU preview with authoritative results without visible snapping.

Exit gate:

- sculpt and paint across a section boundary for five minutes at the target frame rate, undo the complete strokes one at a time, reload the project, and verify geometry/channel hashes and seam continuity.

### Phase 6 — Terrain definitions, materials, and content browser (5-8 weeks)

Deliverables:

- add a project content browser for meshes, heightmaps, alphas, masks, material textures, definitions, build profiles, and scatter assets;
- turn the current hard-coded alpine shader into a bundled starter terrain material/template rather than global behavior;
- add configurable material layers with base color, normal, roughness, ambient occlusion, displacement/relief, scale, projection, and channel bindings;
- support triplanar/world projection and imported UVs on arbitrary mesh sources;
- add height/slope/curvature/channel rule blending and deterministic height-based interlocking;
- declare physical-material metadata per channel/layer for collision export consumers;
- add material inspection modes: existing, diffuse, grey, soft, normal, channels, wireframe, density, and complexity;
- add sparse tiled/clipmapped channel/material storage so authored paint does not require world-sized textures;
- compile and cache shader/material variants ahead of interaction; show progress and errors.

Exit gate:

- create a definition with rock/soil/grass/snow channels, import PBR textures, paint and procedurally drive them, reopen the project, and render the same result without changing engine source.

### Phase 7 — Splines, water, procedural graph, and scattering (8-12 weeks)

Deliverables:

- add editable spline objects with points, tangents, width/depth profiles, closed/open state, snapping, and terrain projection;
- implement spline deformation, remesh/tessellate, channel paint, cut/fill, road/path, ridge/trench, and mesh-projection modifiers;
- add lake, river, and ocean water surfaces with terrain carving, banks, shore/flow/wetness channels, and material hooks;
- add a deterministic terrain graph with Query, To Points, Write Geometry, Write Channel, Noise, Filter, Erosion, Scatter, Patch Instance, and Mesh Projection nodes;
- make graph queries read terrain up to a selected layer/sub-priority and prevent dependency cycles/feedback loops;
- add hydraulic/thermal erosion as cancellable cached procedural jobs;
- add deterministic GPU-instanced grass, rocks, and trees driven by channels, slope, altitude, and seeded rules;
- add instance selection, exclusion masks, culling, LOD, density scaling, and bake/export.

Exit gate:

- author a river that carves the terrain, paints wetness and gravel, feeds a scatter graph, survives layer reordering, and rebuilds only affected sections and instance cells.

### Phase 8 — Preview/runtime build profiles and export (7-11 weeks)

Deliverables:

- separate low-latency preview compilation from reproducible final compilation;
- add reusable build profiles and High/Medium/Low platform variants;
- implement an ordered transformer pipeline with repair, subsection, render LOD, meshlet, collision, far-field, channel bake, seam, compression, and package stages;
- generate decoupled collision meshes/heightfields with error tolerance and physical-material mapping;
- regenerate far-field/HLOD data from authored sources and modifiers, not the procedural base;
- create subsection/HLOD policies independent from authoring section size;
- add deterministic incremental build cache, dependency invalidation, cancellation, progress, logs, timing, and failure recovery;
- export a versioned runtime package with manifest, section index, bounds, LOD/meshlet buffers, channel tiles, collision, far field, and integrity hashes;
- document and provide a small TypeScript loader example for exported terrain.

Exit gate:

- modify one small region, rebuild a 16 km project, prove only dependent artifacts changed, stream the exported package in the sample viewer, and collide/raycast correctly through caves and overhangs.

### Phase 9 — Rendering, streaming, and scale productionization (6-10 weeks)

Deliverables:

- integrate origin rebasing through camera, renderer, picking, modifiers, water, scatter, and exports;
- make streaming frustum/occlusion aware rather than treating the full radius as visible;
- add velocity prediction, teleport handling, edit-region pinning, IO queues, and storage-backed source streaming;
- use pooled/WASM memory and GPU staging buffers; expose allocation and high-water metrics;
- add meshlet generation, GPU frustum/cone/occlusion culling, indirect draws, and compact section batches where supported;
- add LOD cross-fade/geomorph or robust stitch transitions to reduce visible popping beyond skirts;
- stream updated far-field/channel data and blend transitions without double surfaces;
- add adapter capability tiers, quality presets, automatic pressure control, and reproducible quality decisions;
- recover from WebGPU device loss and renderer recreation without losing the open document;
- meet frame, memory, upload, compile-latency, and shader-warmup budgets on all target tiers.

Exit gate:

- traverse and edit the 16 km reference project for 30 minutes with bounded memory, no cracks, no lost edits, no long main-thread terrain tasks, stable quality transitions, and successful device-loss recovery.

### Phase 10 — Product QA, accessibility, distribution, and documentation (5-8 weeks)

Deliverables:

- add Playwright editor journeys for project, import, sculpt, paint, modifiers, build, export, and recovery;
- automate headless visual regression with stored tolerances and artifact review;
- add mesh property/fuzz tests, malformed import corpus, migration fixtures, cross-section stress cases, and CSG failure fixtures;
- add performance CI for compile P50/P95, frame time, input latency, memory, upload volume, and worker cancellation;
- add GPU/resource leak tests, repeated project-open tests, mode-switch tests, and device-loss tests;
- run Chrome/Edge and supported OS/GPU matrix checks; clearly gate unsupported environments;
- make panels keyboard reachable, label controls, manage dialog focus, support reduced motion/high contrast, and retain user keymap/layout settings;
- add onboarding, sample projects, in-app tool help, recovery/build error guidance, and format documentation;
- ship an installable PWA; evaluate a thin Tauri desktop wrapper only if filesystem/large-project testing proves the browser shell insufficient;
- add CI, release versioning, schema support policy, changelog, licenses, and signed release artifacts.

Exit gate:

- a new user can install/open the editor, complete the core tutorial, build/export a sample terrain, recover from a forced crash, and pass the release test matrix without developer tools.

## Milestones

| Milestone | Included phases | User-visible outcome | Rough single-engineer range |
| --- | --- | --- | --- |
| A — Trustworthy standalone editor | 0-3 | Real projects, undo/recovery, create/import, sections, ordered layers, outliner, Build To | 12-19 weeks |
| B — Mesh Terrain authoring core | 4-5 | True arbitrary-mesh remesh/CSG, layered sculpting, weight-channel paint | 14-21 weeks |
| C — World-building workflows | 6-7 | Configurable materials, content, splines, water, procedural graph, scatter | 13-20 weeks |
| D — Runtime-ready product | 8-10 | Build variants, collision/export, production rendering/streaming, QA, installable release | 18-29 weeks |

The full roadmap is approximately 57-89 engineer-weeks for one experienced engineer. A focused two-to-three-person team can shorten elapsed time by splitting mesh kernel, editor/document, and renderer/build work once Phase 1 contracts are stable. The first genuinely useful standalone release is Milestone A; the first release that deserves “Mesh Terrain editor” rather than “terrain prototype” is Milestone B.

## First implementation backlog

These are the recommended first twelve engineering tickets after roadmap approval:

1. Add project/document/definition IDs, schemas, validators, and migration registry.
2. Add semantic command transactions and history tests around existing modifier actions.
3. Replace monolithic `TerrainStorage` with project manifest and sharded storage interfaces.
4. Persist/restore `EditableMesh` source buffers and arbitrary attributes.
5. Build New/Open/Save As/Recover shell and remove hard-coded `default` ownership.
6. Define compiler stage IR and write failing tests proving strict cross-type modifier order.
7. Add priority-layer/sub-priority data model and migrate numeric priorities.
8. Implement cached Build To evaluation at layer boundaries.
9. Build the layered Mesh Partition outliner and transform gizmo command flow.
10. Add rectangle project wizard and 16-bit heightmap importer.
11. Add GLB/glTF import plus automatic section partition/validation report.
12. Run the WASM mesh-kernel spike on remesh, attribute transfer, CSG, cancellation, and bundle cost.

Do not start the full material editor, PCG graph, water, or foliage system before tickets 1-9 establish durable authoring semantics.

## Acceptance metrics

Final numeric budgets should be fixed in Phase 0. Recommended starting targets:

### Interaction

- target tier: 60 FPS while navigating and applying brush input;
- quality fallback tier: never below declared 30 FPS because of terrain maintenance;
- pointer-to-preview latency: under one displayed frame at steady state;
- terrain main-thread work: P95 under 2 ms, no terrain task over 4 ms;
- no full-document serialization, mesh processing, shader compilation, or bulk upload on the interaction path.

### Compilation and streaming

- stale compiled data can never replace a newer document revision;
- edits remain visible while authoritative builds run;
- active edit section starts before non-visible background work;
- one-section edit does not invalidate unrelated section, far-field, collision, channel, or scatter artifacts;
- memory remains within configured CPU, GPU, WASM, asset-cache, and storage high-water budgets;
- teleport and fast flight cannot leave permanent holes or an unbounded queue.

### Correctness

- deterministic source and build hashes for identical input/configuration;
- no NaN/Inf, invalid indices, unintended open edges, non-manifold output, or stale attributes;
- shared boundaries agree in position, identity, normal policy, channel values, and LOD constraints;
- topology-changing stages emit an attribute/provenance report;
- save/reload, package round-trip, undo/redo, and migration preserve source hashes;
- authored changes propagate to preview, final LODs, collision, far field, channels, scatter, and export as applicable.

### UX

- every long task shows scope, progress, current stage, cancellation state, logs, and actionable failure details;
- every destructive command is undoable or clearly confirmed when it cannot be;
- selection, transform, layer, project, build, and viewport shortcuts are discoverable and remappable;
- unsupported files and devices fail before mutating the document.

## Risk register

| Risk | Why it matters | Mitigation |
| --- | --- | --- |
| Robust arbitrary topology | Local remesh and CSG dominate correctness and schedule risk. | Time-box a kernel spike, keep a replaceable interface, add adversarial fixtures, and make failure non-destructive. |
| Attribute continuity | Channels/UVs/normals/stable IDs can be silently damaged by topology and LOD changes. | Make attribute policy explicit per stage; return provenance and error metrics; gate builds on validation. |
| Browser storage limits | Large meshes, textures, journals, and derived data can exceed quotas. | Content-addressed assets, OPFS, quota UI, cache eviction, portable packages, and optional desktop shell evaluation. |
| Full graph invalidation | A naive ordered graph can rebuild too much and destroy interaction. | Bounds-aware stage cache keys, Build To cache, dirty shards, dependency traces, and benchmark gates. |
| Shader/virtual-texture scope | A configurable material system can create variant explosions and GPU stalls. | Fixed material schema for v1, bounded layers/channels, precompile, sparse tiles, and capability tiers. |
| Worker cancellation | Current synchronous work is cancelled by terminating workers, losing warm state. | Add bounded kernel batches, abort checks, persistent WASM memory, and restart only on hard hangs. |
| Far-field inconsistency | Base-only horizon data makes large authored forms disappear with distance. | Treat far field/HLOD as revisioned derived data with localized invalidation and transition tests. |
| Device/browser variance | WebGPU limits and driver behavior vary. | Adapter capability report, target matrix, conservative tier, device-loss recovery, and automated captures. |
| Scope expansion into a general engine | World-building requests can dilute the terrain editor. | Keep the product contract and place unrelated level/gameplay features outside v1. |

## Definition of v1 success

The focused editor is v1-ready when a user can:

1. create or open a named project and recover it after a forced close;
2. create terrain from a rectangle, 16-bit heightmap, or arbitrary mesh;
3. split/merge sections and stream a large world without visible cracks;
4. create, name, group, reorder, duplicate, transform, solo, and Build To modifier layers;
5. perform true local remesh/tessellation on vertical, overhanging, and closed topology;
6. sculpt and paint named channels non-destructively across section boundaries;
7. construct arches/caves/tunnels with ordered Boolean operations and inspect repair failures;
8. configure material layers without editing source code;
9. author at least one spline road/river workflow and one procedural/scatter graph workflow;
10. compile independent preview and final profiles with LOD, collision, channels, and authored far field;
11. export and stream a versioned runtime package in the supplied viewer;
12. undo/redo all normal authoring actions and round-trip the project package deterministically;
13. remain within the agreed frame, memory, compile, and storage budgets;
14. pass unit, fuzz, E2E, visual, performance, migration, recovery, and target-platform checks.

## Primary Unreal 5.8 references

This roadmap uses Epic's official documentation as the comparison target:

- [Mesh Terrain overview](https://dev.epicgames.com/documentation/unreal-engine/mesh-terrain-in-unreal-engine)
- [Accessing Mesh Terrain and its six editor tabs](https://dev.epicgames.com/documentation/unreal-engine/accessing-mesh-terrain-in-unreal-engine)
- [Crafting Mesh Terrain](https://dev.epicgames.com/documentation/unreal-engine/crafting-mesh-terrain-in-unreal-engine)
- [Mesh Partition Definition and transformer pipelines](https://dev.epicgames.com/documentation/unreal-engine/mesh-partition-definition-in-unreal-engine)
- [Mesh Terrain materials](https://dev.epicgames.com/documentation/unreal-engine/mesh-terrain-material-in-unreal-engine)
- [PCG and Mesh Terrain](https://dev.epicgames.com/documentation/unreal-engine/pcg-and-mesh-terrain-in-unreal-engine)
- [Runtime Virtual Textures and Mesh Terrain](https://dev.epicgames.com/documentation/unreal-engine/runtime-virtual-textures-and-mesh-terrain-in-unreal-engine)
- [Unreal Engine 5.8 release notes](https://dev.epicgames.com/documentation/unreal-engine/unreal-engine-5-8-release-notes)
