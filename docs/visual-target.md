# Visual target and review rubric

This is the standing brief for the visual review pass. Screenshots are produced
by `npm run capture` into `captures/` from four fixed viewpoints (`vista`,
`cliff`, `meadow`, `ridgeline`) so successive passes are directly comparable.

## The three reference frames

The reviewer does not have the reference images. They are described here in
enough detail to judge against.

### Reference A — "the arch" (weathered limestone, alpine hillside)

A huge natural rock arch cut through a grassy alpine hillside, photographed in
warm raking sunlight from the upper left.

- **Rock**: pale grey-buff limestone, water-smoothed into rounded shoulders and
  scalloped concavities. Strong *micro*-contrast: every square metre has pits,
  hairline cracks and small spalled patches, but the large forms stay smooth.
  Rock reads as hard and dense, never like clay or plaster.
- **Vegetation**: coarse alpine turf creeping over the rounded rock shoulders,
  breaking into irregular clumps and tongues at the edges rather than a clean
  boundary. Grass colour varies from yellow-green to deep blue-green in patches
  metres across. Bare soil and small stones show through in worn areas.
- **Foreground**: turf with angular rock outcrops pushing through it, loose
  stones of many sizes scattered on the surface, casting small hard shadows.
- **Lighting**: strong directional sun, deep occlusion inside the arch, with a
  visible soft bounce lighting the cave ceiling. Blue-hazed distant peak framed
  through the opening — the interior is dark and cool, the exterior warm.

### Reference B — "the shard" (tilted strata slab at sunset)

A dramatic tilted slab of layered rock rising out of a misty valley at sunset,
glowing fissures in its flank, with ranges receding into the distance.

- **Strata**: unmistakable horizontal-to-tilted sedimentary banding. Alternating
  band colours and hardness; harder bands stand proud and cast a shadow line,
  softer bands recess. Bands stay continuous across the whole cliff face.
- **Cliffs**: genuinely vertical faces with sharp top edges, not steep slopes.
  Talus and scree fans at the base, coarse near the cliff, fining outwards.
- **Depth**: the single strongest cue in the frame. Each successive ridge is
  lighter, bluer and lower-contrast than the one in front of it, with mist
  pooling in the valley floors. Near rock keeps full contrast and saturation.
- **Light**: low sun, warm rim light on ridge edges, long shadows, high dynamic
  range with the sky several stops above the shadowed rock.

### Reference C — "the meadow" (alpine pasture, midday)

A crisp midday alpine meadow with a path, boulders, conifers and a snow peak.

- **Sky**: clear blue with a strong zenith-to-horizon gradient and well-formed
  cumulus clouds.
- **Foreground boulders**: large rounded grey stones with visible horizontal
  bedding lines, lichen mottling, and clear contact shadows where they meet the
  grass.
- **Ground**: dense sharp grass with visible individual blades near camera,
  wildflowers, worn dirt path, and a smooth transition from lush green to dry
  yellow-green with slope and wear.
- **Overall**: high sharpness, saturated but not garish greens, crisp shadow
  edges, snow peak reading pale and desaturated at distance.

## What the render is aiming for

Combine all three: reference C's crisp lit foreground detail, reference B's
strata, cliffs and aerial perspective, reference A's rock micro-contrast and
believable rock/vegetation interlocking.

## Rubric (score 0–100)

Score each axis, then report the weighted total. Be strict: 90 means a frame
that would pass as a shipped AAA open-world screenshot.

| Axis | Weight | What earns marks |
| --- | --- | --- |
| Material realism and variety | 25 | Distinct, believable rock / scree / soil / grass / snow. Height-based interlocking at boundaries, not cross-fades. Colour variation at multiple scales. No large flat single-colour regions. |
| Surface micro-detail | 20 | Cracks, pits, pebbles, grass clumps visible near camera. Normal detail that survives at mid distance. Parallax/self-shadowing depth in relief. No visible tiling or repeating pattern. |
| Macro form and silhouette | 15 | Cliff faces, ridgelines, strata benches, valley floors. Sharp silhouettes. No blobby or melted geometry. No LOD popping seams or cracks between sections. |
| Lighting | 15 | Plausible sun/sky balance, contact and cast shadows, ambient occlusion in crevices, sky-coloured fill in shadow. Shadows neither black nor washed out. |
| Atmosphere and depth | 15 | Aerial perspective separating ridge planes, believable sky, haze that matches the sky colour, valley mist. Distance reads correctly. |
| Image quality | 10 | Exposure without clipping or crushing, no aliasing/shimmer, no banding, no obvious shader artifacts (stretching, seams, black speckles). |

## Report format

For each pass return:

1. A per-axis score with one concrete sentence of evidence from a named capture.
2. The weighted total.
3. A ranked list of the **specific** defects that cost the most points, each
   phrased as something the renderer can act on (e.g. "cliff faces at 200 m are
   a single flat grey — the mesoscale normal detail is fading out too early"),
   not as a general wish ("add more detail").
