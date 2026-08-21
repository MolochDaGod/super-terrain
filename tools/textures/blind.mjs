import { copyFileSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

/**
 * Builds a blind A/B set for review.
 *
 * The reviewer must not be able to tell which image is the procedural bake,
 * so the two candidates are copied to neutrally named files in a random
 * order and the key is written where only this harness reads it. Both
 * candidates for a material always come from the same renderer, so the only
 * difference the reviewer can see is in the maps themselves.
 */
const pairs = {
  'rock-ground': ['rock-ground-lit-mine.png', 'rock-ground-lit-ref.png'],
  'cliff-side': ['cliff-side-lit-mine.png', 'cliff-side-lit-ref.png'],
  'alpine-cliff-rock': ['alpine-cliff-rock-lit-mine.png', 'alpine-cliff-rock-albedo-ref.png'],
  'ember-fault-rock': ['ember-fault-rock-lit-mine.png', 'ember-fault-rock-albedo-ref.png'],
}

const round = process.argv[2] ?? 'r1'
const src = resolve(process.cwd(), '.textures/out')
const dst = resolve(process.cwd(), '.textures/blind', round)
mkdirSync(dst, { recursive: true })

const key = {}
for (const [id, [mine, reference]] of Object.entries(pairs)) {
  const flip = randomBytes(1)[0] % 2 === 0
  const a = flip ? mine : reference
  const b = flip ? reference : mine
  copyFileSync(resolve(src, a), resolve(dst, `${id}-A.png`))
  copyFileSync(resolve(src, b), resolve(dst, `${id}-B.png`))
  key[id] = { A: a === mine ? 'procedural' : 'reference', B: b === mine ? 'procedural' : 'reference' }
}
writeFileSync(resolve(dst, 'key.json'), JSON.stringify(key, null, 2))
console.log(JSON.stringify(key, null, 2))
console.log(dst)
