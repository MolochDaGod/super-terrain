# Hero reference — "the shard at sunset"

The standing target for the hero frame. The reviewer does not have the image;
this describes it in enough detail to judge a render against it. Reproduce the
frame at `captures/browser/hero.png` via `tools/browser/shot.mjs`, which drives
the real editor in real Chrome — the offline `tools/capture` harness uses a
different tone mapper and lighting path and is not evidence about the editor.

## The frame

A glacial valley at low sun, 16:9, viewed from a hillside above the valley
floor. Depth is built from four clearly separated planes:

1. **Foreground (bottom sixth)** — a dark slope in shadow: coarse turf, bare
   scree, and several house-sized angular boulders, the nearest one bottom-left
   catching a hard grazing highlight along its top edge. Moss and grass grow in
   the seams between rock. Fully in shade, but never black: it holds visible
   blue-green colour and readable texture.
2. **Mid-ground hero (centre)** — a huge tilted slab of layered rock thrust out
   of the valley at roughly 35° from horizontal, its long axis running from
   lower-left to upper-right and its sharp crest breaking the skyline. The
   bedding planes are unmistakable: dozens of parallel bands running the length
   of the slab, harder bands standing proud with a shadow line under each. The
   sunward face is warm grey-tan; the shaded face falls away into cool
   blue-grey. **Two irregular openings pierce the flank**, and inside them the
   rock glows molten orange-red, bright enough to bloom slightly and to spill a
   warm bounce onto the rock lips around each opening. This is the focal point
   of the whole image.
3. **Ranges behind (left and right thirds)** — two further ridge planes, each
   lighter, bluer and lower in contrast than the one in front. Snow and pale
   rock on the tops, deep shadow in their flanks. The rightmost range is almost
   dissolved in warm backlit haze.
4. **Valley floor (right of centre)** — a braided river of pale water winding
   away from the camera between gravel bars, with low mist lying on the water
   and drifting into the mouths of the side valleys.

## Light

- Sun very low, roughly 6–10° above the horizon, behind and to the right of the
  hero slab, so the frame is three-quarter backlit: ridge edges carry a warm
  rim, faces turned to camera are mostly in shade.
- Warm, saturated key (deep amber-gold), cool sky fill (blue) in the shadows.
  The contrast between them is what makes the frame read as evening; a neutral
  grey shadow kills it.
- High dynamic range: the sky near the sun is several stops above the shaded
  rock, with visible glare/bloom around the sun's side of the frame.
- Sky is mostly clear with high thin cirrus catching pink-gold on the sun side,
  and heavier cloud banked over the right-hand range.

## What must be true of a successful render

- The molten openings read as a light source, not as an orange texture: the
  rock immediately around them is lifted and warmed.
- The strata bands are geometric — they catch light and cast their own shadow
  lines — not a painted stripe pattern.
- Aerial perspective separates all four depth planes without turning the near
  rock milky.
- The foreground holds texture and colour in shadow; the sky does not clip to
  white except in the immediate glare around the sun.
