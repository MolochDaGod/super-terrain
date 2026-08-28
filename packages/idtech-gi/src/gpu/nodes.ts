/**
 * Loosely typed re-exports of the TSL builders used by the GI passes.
 *
 * The published TSL types resolve a concrete node type per call, which is
 * useful in short expressions and unusable in shader code that threads vectors
 * through a dozen generic helpers — every intermediate has to be re-annotated.
 * Shader graphs are checked by the WGSL compiler, not by TypeScript, so the GI
 * modules import their builders from here and keep the type noise in one file.
 */
import * as TSL from 'three/tsl'

/** A TSL shader-graph value. */
export type Node = any

type AnyFn = (...args: any[]) => Node

export const abs = TSL.abs as AnyFn
export const clamp = TSL.clamp as AnyFn
export const cross = TSL.cross as AnyFn
export const dot = TSL.dot as AnyFn
export const exp2 = TSL.exp2 as AnyFn
export const float = TSL.float as AnyFn
export const floor = TSL.floor as AnyFn
export const fract = TSL.fract as AnyFn
export const int = TSL.int as AnyFn
export const length = TSL.length as AnyFn
export const log2 = TSL.log2 as AnyFn
export const max = TSL.max as AnyFn
export const min = TSL.min as AnyFn
export const mix = TSL.mix as AnyFn
export const normalize = TSL.normalize as AnyFn
export const pow = TSL.pow as AnyFn
export const saturate = TSL.saturate as AnyFn
export const select = TSL.select as AnyFn
export const sign = TSL.sign as AnyFn
export const smoothstep = TSL.smoothstep as AnyFn
export const sqrt = TSL.sqrt as AnyFn
export const step = TSL.step as AnyFn
export const uint = TSL.uint as AnyFn
export const uniform = TSL.uniform as AnyFn
export const vec2 = TSL.vec2 as AnyFn
export const vec3 = TSL.vec3 as AnyFn
export const vec4 = TSL.vec4 as AnyFn
export const texture = TSL.texture as AnyFn
export const texture3D = TSL.texture3D as AnyFn
export const textureLoad = TSL.textureLoad as AnyFn
export const textureStore = TSL.textureStore as AnyFn
export const instancedArray = TSL.instancedArray as AnyFn
export const storage = TSL.storage as AnyFn
export const attributeArray = TSL.attributeArray as AnyFn

export const Fn = TSL.Fn as (fn: (...args: any[]) => any, layout?: any) => any
export const If = TSL.If as (condition: any, body: () => void) => any
export const Loop = TSL.Loop as (params: any, body: (indices: any) => void) => any
export const Break = TSL.Break as () => void
export const Continue = TSL.Continue as () => void

export const instanceIndex = TSL.instanceIndex as Node
export const positionWorld = TSL.positionWorld as Node
export const normalWorld = TSL.normalWorld as Node
export const transformedNormalWorld = TSL.transformedNormalWorld as Node
export const positionViewDirection = TSL.positionViewDirection as Node
export const cameraPosition = TSL.cameraPosition as Node
export const screenUV = TSL.screenUV as Node
export const screenCoordinate = TSL.screenCoordinate as Node
export const modelWorldMatrix = TSL.modelWorldMatrix as Node
export const cameraProjectionMatrix = TSL.cameraProjectionMatrix as Node
export const cameraViewMatrix = TSL.cameraViewMatrix as Node
export const positionView = TSL.positionView as Node
export const uv = TSL.uv as AnyFn
