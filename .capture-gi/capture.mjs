import { createRequire } from "node:module";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { ACESFilmicToneMapping, BoxGeometry, ClampToEdgeWrapping, Color, Data3DTexture, FloatType, LinearFilter, Matrix4, Mesh, MeshStandardNodeMaterial, NearestFilter, PerspectiveCamera, PointLight, RGBAFormat, RenderTarget, SRGBColorSpace, Scene, SpotLight, Storage3DTexture, StorageTexture, UnsignedByteType, Vector2, Vector3, Vector4, WebGPURenderer } from "three/webgpu";
import { deflateSync } from "node:zlib";
import { Break, Fn, If, Loop, abs, clamp, cross, float, fract, instanceIndex, instancedArray, int, ivec2, ivec3, max, mix, normalWorld, normalize, positionWorld, pow, screenUV, select, storage, texture, texture3D, textureStore, uint, uniform, vec2, vec3, vec4 } from "three/tsl";
//#region tools/capture/headlessGpu.ts
var require = createRequire(import.meta.url);
/**
* Boots three's WebGPU renderer on Google Dawn inside Node. There is no DOM, so
* the canvas and the swap-chain context are stubbed; every frame is rendered
* into an offscreen render target that we read back for the PNG.
*/
/**
* WebGPU buffer copies require rows padded to 256 bytes. Rather than unpack a
* padded readback, capture widths are constrained to a multiple of 64 pixels
* (64 x 4 bytes = 256) so the returned rows are already tightly packed.
*/
function alignCaptureWidth(width) {
	return Math.max(64, Math.round(width / 64) * 64);
}
async function createHeadlessRenderer(width, height) {
	if (width % 64 !== 0) throw new Error(`capture: width must be a multiple of 64, got ${width} (use ${alignCaptureWidth(width)})`);
	const dawn = require("@kmamal/gpu");
	for (const [key, value] of Object.entries(dawn)) if (key.startsWith("GPU") && globalThis[key] === void 0) globalThis[key] = value;
	globalThis.self = globalThis;
	globalThis.requestAnimationFrame ??= (callback) => setTimeout(() => callback(performance.now()), 16);
	globalThis.cancelAnimationFrame ??= (handle) => clearTimeout(handle);
	const instance = dawn.create([]);
	Object.defineProperty(globalThis.navigator, "gpu", {
		value: instance,
		configurable: true
	});
	const adapter = await instance.requestAdapter({ powerPreference: "high-performance" });
	if (!adapter) throw new Error("capture: no WebGPU adapter from Dawn");
	const device = await adapter.requestDevice();
	Object.defineProperty(device, "onuncapturederror", {
		get: () => null,
		set: () => {},
		configurable: true
	});
	const canvas = {
		width,
		height,
		style: {},
		addEventListener() {},
		removeEventListener() {},
		getContext: () => null,
		getBoundingClientRect: () => ({
			x: 0,
			y: 0,
			width,
			height,
			top: 0,
			left: 0,
			right: width,
			bottom: height
		})
	};
	let swapTexture = null;
	const renderer = new WebGPURenderer({
		canvas,
		device,
		context: {
			configure() {},
			unconfigure() {},
			getCurrentTexture() {
				swapTexture ??= device.createTexture({
					size: [
						width,
						height,
						1
					],
					format: "bgra8unorm",
					usage: GPUTextureUsage.RENDER_ATTACHMENT | GPUTextureUsage.COPY_SRC | GPUTextureUsage.TEXTURE_BINDING
				});
				return swapTexture;
			}
		},
		antialias: true,
		alpha: false
	});
	renderer._getFallback = null;
	renderer.setSize(width, height, false);
	await renderer.init();
	const target = new RenderTarget(width, height, {
		depthBuffer: true,
		samples: 4
	});
	target.texture.colorSpace = SRGBColorSpace;
	return {
		renderer,
		async capture(render) {
			renderer.setRenderTarget(target);
			await render();
			renderer.setRenderTarget(null);
			const pixels = await renderer.readRenderTargetPixelsAsync(target, 0, 0, width, height);
			return new Uint8Array(pixels.buffer);
		},
		async timeFrame(render) {
			renderer.setRenderTarget(target);
			await render();
			renderer.setRenderTarget(null);
			await device.queue.onSubmittedWorkDone();
		},
		async timeFrames(render, frames) {
			renderer.setRenderTarget(target);
			const started = performance.now();
			for (let frame = 0; frame < frames; frame += 1) await render();
			renderer.setRenderTarget(null);
			await device.queue.onSubmittedWorkDone();
			return performance.now() - started;
		},
		dispose() {
			target.dispose();
			renderer.dispose();
			device.destroy();
			dawn.destroy(instance);
		}
	};
}
//#endregion
//#region tools/capture/png.ts
/**
* Minimal PNG encoder. The capture harness is the only consumer, so it writes
* a single non-interlaced RGBA8 image and skips every optional chunk.
*/
function encodePng(pixels, width, height) {
	const stride = width * 4;
	const raw = Buffer.allocUnsafe((stride + 1) * height);
	for (let row = 0; row < height; row += 1) {
		raw[row * (stride + 1)] = 0;
		Buffer.from(pixels.buffer, pixels.byteOffset + row * stride, stride).copy(raw, row * (stride + 1) + 1);
	}
	const header = Buffer.alloc(13);
	header.writeUInt32BE(width, 0);
	header.writeUInt32BE(height, 4);
	header[8] = 8;
	header[9] = 6;
	header[10] = 0;
	header[11] = 0;
	header[12] = 0;
	return Buffer.concat([
		Buffer.from([
			137,
			80,
			78,
			71,
			13,
			10,
			26,
			10
		]),
		chunk("IHDR", header),
		chunk("IDAT", deflateSync(raw, { level: 6 })),
		chunk("IEND", Buffer.alloc(0))
	]);
}
/** Vertically flips a row-major RGBA buffer; GPU readback is bottom-up. */
function flipVertically(pixels, width, height) {
	const stride = width * 4;
	const flipped = new Uint8Array(pixels.length);
	for (let row = 0; row < height; row += 1) flipped.set(pixels.subarray(row * stride, row * stride + stride), (height - 1 - row) * stride);
	return flipped;
}
function chunk(type, body) {
	const result = Buffer.allocUnsafe(body.length + 12);
	result.writeUInt32BE(body.length, 0);
	result.write(type, 4, "ascii");
	body.copy(result, 8);
	result.writeUInt32BE(crc32(result.subarray(4, 8 + body.length)), 8 + body.length);
	return result;
}
var CRC_TABLE = (() => {
	const table = /* @__PURE__ */ new Uint32Array(256);
	for (let index = 0; index < 256; index += 1) {
		let value = index;
		for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 3988292384 ^ value >>> 1 : value >>> 1;
		table[index] = value >>> 0;
	}
	return table;
})();
function crc32(buffer) {
	let crc = 4294967295;
	for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 255] ^ crc >>> 8;
	return (crc ^ 4294967295) >>> 0;
}
//#endregion
//#region packages/idtech-gi/src/types.ts
var DEFAULT_CASCADE = {
	resolution: 8,
	cascadeCount: 3,
	firstSize: 8,
	raysPerProbe: 16,
	cascadesPerFrame: 1
};
var DEFAULT_CACHE = {
	cellSize: .25,
	maxCells: 65536,
	probeSteps: 8,
	reuseFrames: 8,
	lodDistance: 8
};
function zeroSH() {
	return {
		l0: [
			0,
			0,
			0
		],
		lx: [
			0,
			0,
			0
		],
		ly: [
			0,
			0,
			0
		],
		lz: [
			0,
			0,
			0
		]
	};
}
function addRgb(a, b) {
	return [
		a[0] + b[0],
		a[1] + b[1],
		a[2] + b[2]
	];
}
function scaleRgb(a, s) {
	return [
		a[0] * s,
		a[1] * s,
		a[2] * s
	];
}
function mulRgb(a, b) {
	return [
		a[0] * b[0],
		a[1] * b[1],
		a[2] * b[2]
	];
}
//#endregion
//#region packages/idtech-gi/src/cascades.ts
function cascadeSize(cascade, config) {
	return config.firstSize * 2 ** cascade;
}
function cascadeCellSize(cascade, config) {
	return cascadeSize(cascade, config) / config.resolution;
}
/**
* Snap the cascade origin so cell centers stay stable as the camera moves
* (avoids swimming). Origin is the min corner of the volume.
*/
function cascadeOrigin(cascade, camera, config) {
	const size = cascadeSize(cascade, config);
	const cell = cascadeCellSize(cascade, config);
	const half = size * .5;
	const minX = camera[0] - half;
	const minY = camera[1] - half;
	const minZ = camera[2] - half;
	return [
		Math.floor(minX / cell) * cell,
		Math.floor(minY / cell) * cell,
		Math.floor(minZ / cell) * cell
	];
}
/** Sousa: probes live at cell centers, not corners. */
function cellCenter(cascade, ix, iy, iz, camera, config) {
	const origin = cascadeOrigin(cascade, camera, config);
	const cell = cascadeCellSize(cascade, config);
	return [
		origin[0] + (ix + .5) * cell,
		origin[1] + (iy + .5) * cell,
		origin[2] + (iz + .5) * cell
	];
}
function packProbeIndex(cascade, ix, iy, iz, resolution) {
	const layer = resolution * resolution;
	return cascade * layer * resolution + iz * layer + iy * resolution + ix;
}
function totalProbes(config) {
	return config.resolution ** 3 * config.cascadeCount;
}
/**
* Interleaved update set: Sousa refreshes 1 cascade per frame. We also
* checkerboard probes inside that cascade so the per-frame ray count stays
* budgeted on large resolutions.
*/
function interleavedUpdateSet(frame, camera, config = DEFAULT_CASCADE, probeStride = 1) {
	const cascadeCount = Math.max(1, config.cascadeCount);
	const cascade = frame * Math.max(1, config.cascadesPerFrame) % cascadeCount;
	const res = config.resolution;
	const stride = Math.max(1, probeStride);
	const phase = Math.floor(frame / cascadeCount) % stride;
	const probes = [];
	for (let iz = 0; iz < res; iz += 1) for (let iy = 0; iy < res; iy += 1) for (let ix = 0; ix < res; ix += 1) {
		if (stride > 1 && (ix + iy * 3 + iz * 7) % stride !== phase) continue;
		probes.push({
			cascade,
			ix,
			iy,
			iz,
			index: packProbeIndex(cascade, ix, iy, iz, res),
			position: cellCenter(cascade, ix, iy, iz, camera, config)
		});
	}
	return {
		cascade,
		probes
	};
}
function volumeIndex(cascade, ix, iy, iz, config) {
	const res = config.resolution;
	return packProbeIndex(cascade, ix, iy, iz, res);
}
/** Finest cascade that still contains `world` relative to `camera`. */
function cascadeForPoint(world, camera, config) {
	const dx = Math.abs(world[0] - camera[0]);
	const dy = Math.abs(world[1] - camera[1]);
	const dz = Math.abs(world[2] - camera[2]);
	const extent = Math.max(dx, dy, dz) * 2;
	for (let cascade = 0; cascade < config.cascadeCount; cascade += 1) if (extent <= cascadeSize(cascade, config) * .98) return cascade;
	return config.cascadeCount - 1;
}
function worldToCell(world, cascade, camera, config) {
	const origin = cascadeOrigin(cascade, camera, config);
	const cell = cascadeCellSize(cascade, config);
	const gx = (world[0] - origin[0]) / cell - .5;
	const gy = (world[1] - origin[1]) / cell - .5;
	const gz = (world[2] - origin[2]) / cell - .5;
	const ix = Math.floor(gx);
	const iy = Math.floor(gy);
	const iz = Math.floor(gz);
	return {
		ix,
		iy,
		iz,
		fx: gx - ix,
		fy: gy - iy,
		fz: gz - iz
	};
}
//#endregion
//#region packages/idtech-gi/src/math.ts
var PI = Math.PI;
var TAU = Math.PI * 2;
var INV_PI = 1 / Math.PI;
var GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
function add3(a, b) {
	return [
		a[0] + b[0],
		a[1] + b[1],
		a[2] + b[2]
	];
}
function sub3(a, b) {
	return [
		a[0] - b[0],
		a[1] - b[1],
		a[2] - b[2]
	];
}
function scale3(a, s) {
	return [
		a[0] * s,
		a[1] * s,
		a[2] * s
	];
}
function dot3(a, b) {
	return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}
function length3(a) {
	return Math.hypot(a[0], a[1], a[2]);
}
function normalize3(a) {
	const len = length3(a);
	if (len < 1e-8) return [
		0,
		1,
		0
	];
	return [
		a[0] / len,
		a[1] / len,
		a[2] / len
	];
}
/**
* Integer hash used by the world radiance cache (Sousa / Gautron 2020).
* Output is in [0, 2^32).
*/
function hashInt(value) {
	let x = value | 0;
	x = Math.imul(x ^ x >>> 16, 2146121005);
	x = Math.imul(x ^ x >>> 15, 2221713035);
	return (x ^ x >>> 16) >>> 0;
}
function hashCombine(a, b) {
	return hashInt(a + Math.imul(b, 2654435769) | 0);
}
/**
* Uniform spherical Fibonacci lattice. Probe visibility rays use this so every
* cell center covers the same directions across frames (Sousa traces a budgeted
* N rays per probe; we keep the set stable and rotate by a per-frame offset).
*/
function fibonacciSphere(count, index, rotate = 0) {
	const n = Math.max(count, 1);
	const i = (index % n + n) % n;
	const y = 1 - i / Math.max(n - 1, 1) * 2;
	const r = Math.sqrt(Math.max(0, 1 - y * y));
	const phi = i * GOLDEN_ANGLE + rotate;
	return [
		Math.cos(phi) * r,
		y,
		Math.sin(phi) * r
	];
}
/** Cosine-weighted hemisphere around `normal` (final gather). */
function cosineHemisphere(normal, u, v) {
	const r = Math.sqrt(Math.max(0, u));
	const phi = TAU * v;
	const x = r * Math.cos(phi);
	const y = r * Math.sin(phi);
	const z = Math.sqrt(Math.max(0, 1 - u));
	const up = Math.abs(normal[1]) < .999 ? [
		0,
		1,
		0
	] : [
		1,
		0,
		0
	];
	const tangent = normalize3([
		up[1] * normal[2] - up[2] * normal[1],
		up[2] * normal[0] - up[0] * normal[2],
		up[0] * normal[1] - up[1] * normal[0]
	]);
	const bitangent = [
		normal[1] * tangent[2] - normal[2] * tangent[1],
		normal[2] * tangent[0] - normal[0] * tangent[2],
		normal[0] * tangent[1] - normal[1] * tangent[0]
	];
	return normalize3([
		tangent[0] * x + bitangent[0] * y + normal[0] * z,
		tangent[1] * x + bitangent[1] * y + normal[1] * z,
		tangent[2] * x + bitangent[2] * y + normal[2] * z
	]);
}
/** Interleaved gradient noise, cheap blue-noise stand-in for gather jitter. */
function interleavedGradientNoise(x, y, frame = 0) {
	const f = .06711056 * (x + frame * 1.618) + .00583715 * y;
	return f - Math.floor(f);
}
//#endregion
//#region packages/idtech-gi/src/sphericalHarmonics.ts
/** Y00 */
var SH_Y00 = .28209479177387814;
/** Y1m magnitude (√(3/4π)) */
var SH_Y1 = .4886025119029199;
/** Cosine-lobe convolution of L0 (Ramamoorthi 2001). */
var SH_A0 = PI;
/** Cosine-lobe convolution of L1. */
var SH_A1 = 2 * PI / 3;
function copySH(sh) {
	return {
		l0: [
			sh.l0[0],
			sh.l0[1],
			sh.l0[2]
		],
		lx: [
			sh.lx[0],
			sh.lx[1],
			sh.lx[2]
		],
		ly: [
			sh.ly[0],
			sh.ly[1],
			sh.ly[2]
		],
		lz: [
			sh.lz[0],
			sh.lz[1],
			sh.lz[2]
		]
	};
}
function addSH(a, b) {
	return {
		l0: addRgb(a.l0, b.l0),
		lx: addRgb(a.lx, b.lx),
		ly: addRgb(a.ly, b.ly),
		lz: addRgb(a.lz, b.lz)
	};
}
function scaleSH(sh, s) {
	return {
		l0: scaleRgb(sh.l0, s),
		lx: scaleRgb(sh.lx, s),
		ly: scaleRgb(sh.ly, s),
		lz: scaleRgb(sh.lz, s)
	};
}
/**
* Project a directional radiance sample onto 2-band SH.
* `omega` is the incoming direction (from the probe toward the sample).
* `solidAngle` is the measure of that sample (4π/N for a uniform sphere).
*/
function encodeRadiance(omega, radiance, solidAngle) {
	const y00 = SH_Y00 * solidAngle;
	const y1 = SH_Y1 * solidAngle;
	return {
		l0: scaleRgb(radiance, y00),
		lx: scaleRgb(radiance, y1 * omega[0]),
		ly: scaleRgb(radiance, y1 * omega[1]),
		lz: scaleRgb(radiance, y1 * omega[2])
	};
}
/**
* Diffuse irradiance (Lambertian cosine lobe) along `normal`.
* Volumes store *radiance* SH; this applies the Ramamoorthi convolution.
*/
function evaluateIrradiance(sh, normal) {
	const c0 = SH_A0 * SH_Y00;
	const c1 = SH_A1 * SH_Y1;
	return [
		Math.max(0, c0 * sh.l0[0] + c1 * (sh.lx[0] * normal[0] + sh.ly[0] * normal[1] + sh.lz[0] * normal[2])),
		Math.max(0, c0 * sh.l0[1] + c1 * (sh.lx[1] * normal[0] + sh.ly[1] * normal[1] + sh.lz[1] * normal[2])),
		Math.max(0, c0 * sh.l0[2] + c1 * (sh.lx[2] * normal[0] + sh.ly[2] * normal[1] + sh.lz[2] * normal[2]))
	];
}
function mixSH(a, b, t) {
	return addSH(scaleSH(a, 1 - t), scaleSH(b, t));
}
function emptySH() {
	return zeroSH();
}
//#endregion
//#region packages/idtech-gi/src/tsl/irradianceNode.ts
function createGiUniforms(textures, voxelOrigin, voxelSize) {
	return {
		camera: uniform(new Vector3()),
		enabled: uniform(1),
		firstSize: uniform(textures.firstSize),
		resolution: uniform(textures.resolution),
		cascadeCount: uniform(textures.cascadeCount),
		voxelOrigin: uniform(voxelOrigin),
		voxelSize: uniform(voxelSize)
	};
}
function volumeIrradiance(textures, uniforms, p, n) {
	const c0 = float(SH_A0 * SH_Y00);
	const c1 = float(SH_A1 * SH_Y1);
	const rel = p.sub(uniforms.camera);
	const extent = max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()).mul(2);
	const size0 = uniforms.firstSize;
	const cascade = select(extent.greaterThan(size0.mul(2)), float(2), select(extent.greaterThan(size0), float(1), float(0)));
	const size = size0.mul(pow(float(2), cascade));
	const cell = size.div(uniforms.resolution);
	const origin = uniforms.camera.sub(vec3(size.mul(.5))).div(cell).floor().mul(cell);
	const local = p.sub(origin).div(size);
	const uvw = vec3(clamp(local.x, .001, .999), clamp(local.y, .001, .999), clamp(cascade.add(clamp(local.z, .001, .999)).div(uniforms.cascadeCount), .001, .999));
	const l0 = texture3D(textures.l0, uvw);
	const lx = texture3D(textures.lx, uvw);
	const ly = texture3D(textures.ly, uvw);
	const lz = texture3D(textures.lz, uvw);
	return l0.xyz.mul(c0).add(lx.xyz.mul(n.x).add(ly.xyz.mul(n.y)).add(lz.xyz.mul(n.z)).mul(c1)).max(0);
}
function readOnly(buffer, count) {
	return storage(buffer.value, "vec4", count).toReadOnly();
}
function sampleSh(bufR, bufG, bufB, width, height, uv) {
	const fx = clamp(uv.x.mul(width).sub(.5), 0, width - 1.001);
	const fy = clamp(uv.y.mul(height).sub(.5), 0, height - 1.001);
	const x0 = int(fx);
	const y0 = int(fy);
	const x1 = int(minInt(x0.add(int(1)), int(width - 1)));
	const y1 = int(minInt(y0.add(int(1)), int(height - 1)));
	const tx = fract(fx);
	const ty = fract(fy);
	const w = uint(width);
	const i00 = uint(y0).mul(w).add(uint(x0));
	const i10 = uint(y0).mul(w).add(uint(x1));
	const i01 = uint(y1).mul(w).add(uint(x0));
	const i11 = uint(y1).mul(w).add(uint(x1));
	return {
		r: mix(mix(bufR.element(i00), bufR.element(i10), tx), mix(bufR.element(i01), bufR.element(i11), tx), ty),
		g: mix(mix(bufG.element(i00), bufG.element(i10), tx), mix(bufG.element(i01), bufG.element(i11), tx), ty),
		b: mix(mix(bufB.element(i00), bufB.element(i10), tx), mix(bufB.element(i01), bufB.element(i11), tx), ty)
	};
}
function minInt(a, b) {
	return select(a.lessThan(b), a, b);
}
/**
* Fragment indirect: bilinear-upscale denoised half-res gather SH (2-band),
* evaluate with the surface normal, fall back to cascaded volumes on a miss.
*/
function createIndirectNode(textures, uniforms, albedo, denoise) {
	const albedoNode = uniform(albedo);
	const c0 = float(SH_A0 * SH_Y00);
	const c1 = float(SH_A1 * SH_Y1);
	const invPi = float(INV_PI);
	const count = denoise.width * denoise.height;
	const bufR = readOnly(denoise.r, count);
	const bufG = readOnly(denoise.g, count);
	const bufB = readOnly(denoise.b, count);
	return Fn(() => {
		const n = normalWorld.normalize();
		const sh = sampleSh(bufR, bufG, bufB, denoise.width, denoise.height, screenUV);
		const l0 = vec3(sh.r.x, sh.g.x, sh.b.x);
		const lx = vec3(sh.r.y, sh.g.y, sh.b.y);
		const ly = vec3(sh.r.z, sh.g.z, sh.b.z);
		const lz = vec3(sh.r.w, sh.g.w, sh.b.w);
		const gatherIrr = l0.mul(c0).add(lx.mul(n.x).add(ly.mul(n.y)).add(lz.mul(n.z)).mul(c1)).max(0);
		const volIrr = volumeIrradiance(textures, uniforms, positionWorld, n);
		const useGather = l0.length().greaterThan(1e-4);
		const irr = select(useGather, gatherIrr, volIrr).toVar();
		If(uniforms.enabled.lessThan(.5), () => {
			irr.assign(vec3(0));
		});
		return irr.mul(albedoNode).mul(invPi);
	})();
}
//#endregion
//#region packages/idtech-gi/src/tsl/kernels.ts
function storageTarget(width, height, name, filter = NearestFilter) {
	const texture = new StorageTexture(width, height);
	texture.name = name;
	texture.format = RGBAFormat;
	texture.type = FloatType;
	texture.minFilter = filter;
	texture.magFilter = filter;
	texture.generateMipmaps = false;
	texture.mipmapsAutoUpdate = false;
	return texture;
}
/**
* TSL Sousa stages:
* 1. Visibility: every (probe, ray) DDA writes a hit slot, shades, splats cache.
* 2. Gather: half-res, cache-only, fallback screen-space → radiance cache → volumes,
*    stored as 2-band SH.
* 3. Denoise + copy into a screen cache for the next frame.
*/
function createGiComputePasses(textures, uniforms, gatherWidth, gatherHeight, probeCount, raysPerProbe) {
	const pixelCount = gatherWidth * gatherHeight;
	const gatherR = instancedArray(pixelCount, "vec4");
	const gatherG = instancedArray(pixelCount, "vec4");
	const gatherB = instancedArray(pixelCount, "vec4");
	const denoiseR = instancedArray(pixelCount, "vec4");
	const denoiseG = instancedArray(pixelCount, "vec4");
	const denoiseB = instancedArray(pixelCount, "vec4");
	const hitDepth = instancedArray(pixelCount, "vec4");
	const hitNormal = instancedArray(pixelCount, "vec4");
	const screenCache = storageTarget(gatherWidth, gatherHeight, "gi-screen-cache", LinearFilter);
	const vr = textures.voxel.image.width;
	const cacheGpu = new Storage3DTexture(vr, vr, vr);
	cacheGpu.name = "gi-cache-gpu";
	cacheGpu.format = RGBAFormat;
	cacheGpu.type = FloatType;
	cacheGpu.minFilter = NearestFilter;
	cacheGpu.magFilter = NearestFilter;
	cacheGpu.generateMipmaps = false;
	const hitCount = probeCount * raysPerProbe;
	const hitsPos = instancedArray(hitCount, "vec4");
	const hitsNrm = instancedArray(hitCount, "vec4");
	const hitsAlb = instancedArray(hitCount, "vec4");
	const probeOrigin = uniform(new Vector3());
	const cascadeCell = uniform(1);
	const cascadeRes = uniform(textures.resolution);
	const frame = uniform(0);
	const gatherSize = uniform(new Vector2(gatherWidth, gatherHeight));
	const voxelRes = float(vr);
	const maxDist = uniforms.voxelSize.mul(1.5);
	const view = {
		pos: uniform(new Vector3()),
		right: uniform(new Vector3(1, 0, 0)),
		up: uniform(new Vector3(0, 1, 0)),
		forward: uniform(new Vector3(0, 0, -1)),
		tanHalf: uniform(.5),
		aspect: uniform(1),
		viewProjX: uniform(new Vector4(1, 0, 0, 0)),
		viewProjY: uniform(new Vector4(0, 1, 0, 0)),
		viewProjZ: uniform(new Vector4(0, 0, 1, 0)),
		viewProjW: uniform(new Vector4(0, 0, 0, 1))
	};
	const light = {
		pos: uniform(new Vector3()),
		color: uniform(new Vector3(1, 1, 1)),
		dir: uniform(new Vector3(0, -1, 0)),
		params: uniform(new Vector4(20, .4, 1, 0))
	};
	const y00 = float(SH_Y00);
	const y1 = float(SH_Y1);
	const c0 = float(SH_A0 * SH_Y00);
	const c1 = float(SH_A1 * SH_Y1);
	return {
		visibility: Fn(() => {
			const id = instanceIndex;
			const rays = uint(raysPerProbe);
			const rayI = id.mod(rays);
			const probeI = id.div(rays);
			const res = uint(cascadeRes);
			const ix = probeI.mod(res);
			const iy = probeI.div(res).mod(res);
			const iz = probeI.div(res.mul(res));
			const origin = probeOrigin.add(vec3(float(ix), float(iy), float(iz)).add(.5).mul(cascadeCell));
			const i = float(rayI);
			const nRays = float(raysPerProbe);
			const fy = float(1).sub(i.div(max(nRays.sub(1), float(1))).mul(2));
			const rad = max(float(0), float(1).sub(fy.mul(fy))).sqrt();
			const phi = i.mul(GOLDEN_ANGLE).add(frame.mul(.37));
			const dir = vec3(phi.cos().mul(rad), fy, phi.sin().mul(rad));
			const cell = uniforms.voxelSize.div(voxelRes);
			const pos = origin.toVar();
			const hit = float(0).toVar();
			const hitPos = origin.toVar();
			const hitN = vec3(0, 1, 0).toVar();
			const hitAlb = vec3(0).toVar();
			const hitDist = float(-1).toVar();
			Loop({
				start: 0,
				end: 96,
				type: "int"
			}, () => {
				const local = pos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize);
				If(local.x.lessThan(0).or(local.y.lessThan(0)).or(local.z.lessThan(0)), () => {
					Break();
				});
				If(local.x.greaterThanEqual(1).or(local.y.greaterThanEqual(1)).or(local.z.greaterThanEqual(1)), () => {
					Break();
				});
				const sample = texture3D(textures.voxel, clamp(local, .001, .999));
				If(sample.a.greaterThan(.5), () => {
					hit.assign(1);
					hitPos.assign(pos);
					hitDist.assign(pos.sub(origin).length());
					hitAlb.assign(sample.rgb);
					const nrm = normalize(pos.sub(uniforms.voxelOrigin.add(local.floor().add(.5).mul(cell))));
					hitN.assign(select(nrm.length().greaterThan(.1), nrm, dir.negate()));
					Break();
				});
				pos.addAssign(dir.mul(cell.mul(.45)));
			});
			hitsPos.element(id).assign(vec4(hitPos, hitDist));
			hitsNrm.element(id).assign(vec4(hitN, hit));
			hitsAlb.element(id).assign(vec4(hitAlb, hit));
			If(hit.greaterThan(.5), () => {
				const rel = hitPos.sub(uniforms.camera);
				const extent = max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()).mul(2);
				const size0 = uniforms.firstSize;
				const cascade = select(extent.greaterThan(size0.mul(2)), float(2), select(extent.greaterThan(size0), float(1), float(0)));
				const size = size0.mul(pow(float(2), cascade));
				const uvw = vec3(clamp(hitPos.sub(uniforms.camera.sub(vec3(size.mul(.5)))).div(size).x, .001, .999), clamp(hitPos.sub(uniforms.camera.sub(vec3(size.mul(.5)))).div(size).y, .001, .999), clamp(cascade.add(clamp(hitPos.sub(uniforms.camera.sub(vec3(size.mul(.5)))).div(size).z, .001, .999)).div(uniforms.cascadeCount), .001, .999));
				const l0 = texture3D(textures.l0, uvw);
				const lx = texture3D(textures.lx, uvw);
				const ly = texture3D(textures.ly, uvw);
				const lz = texture3D(textures.lz, uvw);
				const irr = l0.xyz.mul(c0).add(lx.xyz.mul(hitN.x).add(ly.xyz.mul(hitN.y)).add(lz.xyz.mul(hitN.z)).mul(c1)).max(0);
				const toL = light.pos.sub(hitPos);
				const distL = max(toL.length(), float(.05));
				const ldir = toL.div(distL);
				const ndotl = max(hitN.dot(ldir), float(0));
				const toward = ldir.negate().dot(light.dir);
				const inCone = select(light.params.z.greaterThan(.5), select(toward.greaterThanEqual(light.params.y), float(1), float(0)), float(1));
				const atten = light.params.x.div(float(1).add(distL.mul(distL))).mul(ndotl).mul(inCone);
				const rgb = hitAlb.mul(light.color).mul(atten).mul(float(INV_PI)).add(hitAlb.mul(irr).mul(float(INV_PI)));
				const vx = int(clamp(hitPos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize).x.mul(voxelRes), 0, voxelRes.sub(1)));
				const vy = int(clamp(hitPos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize).y.mul(voxelRes), 0, voxelRes.sub(1)));
				const vz = int(clamp(hitPos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize).z.mul(voxelRes), 0, voxelRes.sub(1)));
				textureStore(cacheGpu, ivec3(vx, vy, vz), vec4(rgb, 1));
			});
		})().compute(hitCount),
		gather: Fn(() => {
			const x = int(instanceIndex.mod(uint(gatherWidth)));
			const y = int(instanceIndex.div(uint(gatherWidth)));
			const ndcX = float(x).add(.5).div(gatherSize.x).mul(2).sub(1);
			const ndcY = float(1).sub(float(y).add(.5).div(gatherSize.y).mul(2));
			const dir = normalize(view.forward.add(view.right.mul(ndcX.mul(view.tanHalf).mul(view.aspect))).add(view.up.mul(ndcY.mul(view.tanHalf))));
			const cell = uniforms.voxelSize.div(voxelRes);
			const pos = view.pos.toVar();
			const primaryHit = float(0).toVar();
			const pPos = view.pos.toVar();
			const pN = vec3(0, 1, 0).toVar();
			const pDist = float(0).toVar();
			Loop({
				start: 0,
				end: 128,
				type: "int"
			}, () => {
				const local = pos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize);
				If(local.x.lessThan(0).or(local.y.lessThan(0)).or(local.z.lessThan(0)), () => {
					Break();
				});
				If(local.x.greaterThanEqual(1).or(local.y.greaterThanEqual(1)).or(local.z.greaterThanEqual(1)), () => {
					Break();
				});
				const sample = texture3D(textures.voxel, clamp(local, .001, .999));
				If(sample.a.greaterThan(.5), () => {
					primaryHit.assign(1);
					pPos.assign(pos);
					pDist.assign(pos.sub(view.pos).length());
					const nrm = normalize(view.pos.sub(pos)).negate();
					pN.assign(select(nrm.dot(dir.negate()).greaterThan(0), nrm, dir.negate()));
					Break();
				});
				pos.addAssign(dir.mul(cell.mul(.45)));
			});
			const u = fract(float(x).mul(.06711056).add(float(y).mul(.00583715)).add(frame.mul(.618)));
			const v = fract(float(x).mul(.00583715).add(float(y).mul(.06711056)).add(frame.mul(1.618)));
			const r = u.sqrt();
			const phi = v.mul(6.2831853);
			const up = select(abs(pN.y).lessThan(.999), vec3(0, 1, 0), vec3(1, 0, 0));
			const tangent = normalize(cross(up, pN));
			const bitangent = cross(pN, tangent);
			const gdir = normalize(tangent.mul(r.mul(phi.cos())).add(bitangent.mul(r.mul(phi.sin()))).add(pN.mul(max(float(0), float(1).sub(u)).sqrt())));
			const gpos = pPos.add(pN.mul(cell.mul(.6))).toVar();
			const gHit = float(0).toVar();
			const gHitPos = gpos.toVar();
			const gHitN = gdir.negate().toVar();
			Loop({
				start: 0,
				end: 64,
				type: "int"
			}, () => {
				If(primaryHit.lessThan(.5), () => {
					Break();
				});
				const local = gpos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize);
				If(local.x.lessThan(0).or(local.y.lessThan(0)).or(local.z.lessThan(0)), () => {
					Break();
				});
				If(local.x.greaterThanEqual(1).or(local.y.greaterThanEqual(1)).or(local.z.greaterThanEqual(1)), () => {
					Break();
				});
				const sample = texture3D(textures.voxel, clamp(local, .001, .999));
				If(sample.a.greaterThan(.5), () => {
					gHit.assign(1);
					gHitPos.assign(gpos);
					gHitN.assign(gdir.negate());
					Break();
				});
				gpos.addAssign(gdir.mul(cell.mul(.45)));
			});
			const radiance = vec3(0).toVar();
			const used = float(0).toVar();
			If(gHit.greaterThan(.5).and(primaryHit.greaterThan(.5)), () => {
				const hp = vec4(gHitPos, 1);
				const clip = vec4(view.viewProjX.dot(hp), view.viewProjY.dot(hp), view.viewProjZ.dot(hp), view.viewProjW.dot(hp));
				const w = max(clip.w, float(1e-4));
				const ndc = clip.xyz.div(w);
				const suv = vec2(ndc.x.mul(.5).add(.5), float(1).sub(ndc.y.mul(.5).add(.5)));
				If(suv.x.greaterThan(0).and(suv.x.lessThan(1)).and(suv.y.greaterThan(0)).and(suv.y.lessThan(1)).and(ndc.z.greaterThan(0)).and(ndc.z.lessThan(1)), () => {
					const screen = texture(screenCache, suv);
					If(abs(screen.a.sub(ndc.z)).lessThan(.04).and(screen.a.greaterThan(0)), () => {
						radiance.assign(screen.rgb);
						used.assign(1);
					});
				});
			});
			If(used.lessThan(.5).and(gHit.greaterThan(.5)), () => {
				const uvw = clamp(gHitPos.sub(uniforms.voxelOrigin).div(uniforms.voxelSize), .001, .999);
				const cached = texture3D(textures.radianceCache, uvw);
				If(cached.a.greaterThan(.5), () => {
					radiance.assign(cached.rgb);
					used.assign(1);
				});
			});
			If(used.lessThan(.5).and(primaryHit.greaterThan(.5)), () => {
				const samplePos = select(gHit.greaterThan(.5), gHitPos, pPos.add(gdir.mul(maxDist)));
				const rel = samplePos.sub(uniforms.camera);
				const extent = max(max(rel.x.abs(), rel.y.abs()), rel.z.abs()).mul(2);
				const size0 = uniforms.firstSize;
				const cascade = select(extent.greaterThan(size0.mul(2)), float(2), select(extent.greaterThan(size0), float(1), float(0)));
				const size = size0.mul(pow(float(2), cascade));
				const local = samplePos.sub(uniforms.camera.sub(vec3(size.mul(.5)))).div(size);
				const uvw = vec3(clamp(local.x, .001, .999), clamp(local.y, .001, .999), clamp(cascade.add(clamp(local.z, .001, .999)).div(uniforms.cascadeCount), .001, .999));
				const l0 = texture3D(textures.l0, uvw);
				const lx = texture3D(textures.lx, uvw);
				const ly = texture3D(textures.ly, uvw);
				const lz = texture3D(textures.lz, uvw);
				const nEval = select(gHit.greaterThan(.5), gHitN, gdir.negate());
				radiance.assign(l0.xyz.mul(c0).add(lx.xyz.mul(nEval.x).add(ly.xyz.mul(nEval.y)).add(lz.xyz.mul(nEval.z)).mul(c1)).max(0));
				used.assign(1);
			});
			const weight = primaryHit.mul(used);
			const l0r = radiance.mul(y00);
			const lxr = radiance.mul(y1.mul(pN.x));
			const lyr = radiance.mul(y1.mul(pN.y));
			const lzr = radiance.mul(y1.mul(pN.z));
			const pix = uint(y.mul(int(gatherWidth)).add(x));
			gatherR.element(pix).assign(vec4(l0r.x, lxr.x, lyr.x, lzr.x).mul(weight));
			gatherG.element(pix).assign(vec4(l0r.y, lxr.y, lyr.y, lzr.y).mul(weight));
			gatherB.element(pix).assign(vec4(l0r.z, lxr.z, lyr.z, lzr.z).mul(weight));
			hitDepth.element(pix).assign(vec4(pDist, primaryHit, 0, 0));
			hitNormal.element(pix).assign(vec4(pN, primaryHit));
		})().compute(gatherWidth * gatherHeight),
		denoise: Fn(() => {
			const x = int(instanceIndex.mod(uint(gatherWidth)));
			const y = int(instanceIndex.div(uint(gatherWidth)));
			const pix0 = uint(y.mul(int(gatherWidth)).add(x));
			const depth0 = hitDepth.element(pix0);
			const n0 = hitNormal.element(pix0);
			const accR = vec4(0).toVar();
			const accG = vec4(0).toVar();
			const accB = vec4(0).toVar();
			const wsum = float(0).toVar();
			Loop({
				start: -2,
				end: 2,
				type: "int",
				condition: "<="
			}, ({ i }) => {
				Loop({
					start: -2,
					end: 2,
					type: "int",
					condition: "<="
				}, ({ i: j }) => {
					const sx = clamp(x.add(i), int(0), int(gatherWidth - 1));
					const sy = clamp(y.add(j), int(0), int(gatherHeight - 1));
					const spix = uint(sy.mul(int(gatherWidth)).add(sx));
					const depth = hitDepth.element(spix);
					const nrm = hitNormal.element(spix);
					const dz = depth.x.sub(depth0.x);
					const nd = max(n0.xyz.dot(nrm.xyz), float(0));
					const w = float(1).div(float(1).add(float(i).mul(i).add(float(j).mul(j)))).mul(depth.y).mul(nd).mul(float(1).div(float(1).add(dz.mul(dz).mul(40))));
					accR.addAssign(gatherR.element(spix).mul(w));
					accG.addAssign(gatherG.element(spix).mul(w));
					accB.addAssign(gatherB.element(spix).mul(w));
					wsum.addAssign(w);
				});
			});
			const inv = float(1).div(max(wsum, float(1e-4)));
			denoiseR.element(pix0).assign(accR.mul(inv));
			denoiseG.element(pix0).assign(accG.mul(inv));
			denoiseB.element(pix0).assign(accB.mul(inv));
		})().compute(gatherWidth * gatherHeight),
		cacheScreen: Fn(() => {
			const x = int(instanceIndex.mod(uint(gatherWidth)));
			const y = int(instanceIndex.div(uint(gatherWidth)));
			const pix = uint(y.mul(int(gatherWidth)).add(x));
			const shR = denoiseR.element(pix);
			const shG = denoiseG.element(pix);
			const shB = denoiseB.element(pix);
			const depth = hitDepth.element(pix);
			const nrm = hitNormal.element(pix);
			const irr = vec3(shR.x, shG.x, shB.x).mul(c0).add(vec3(shR.y, shG.y, shB.y).mul(nrm.x).add(vec3(shR.z, shG.z, shB.z).mul(nrm.y)).add(vec3(shR.w, shG.w, shB.w).mul(nrm.z)).mul(c1)).max(0);
			const hp = vec4(view.pos.add(view.forward.mul(depth.x)), 1);
			const clip = vec4(view.viewProjX.dot(hp), view.viewProjY.dot(hp), view.viewProjZ.dot(hp), view.viewProjW.dot(hp));
			const ndcZ = clip.z.div(max(clip.w, float(1e-4)));
			textureStore(screenCache, ivec2(x, y), vec4(irr, select(depth.y.greaterThan(.5), ndcZ, float(0))));
		})().compute(gatherWidth * gatherHeight),
		hitCount,
		gatherWidth,
		gatherHeight,
		gatherSize: new Vector2(gatherWidth, gatherHeight),
		denoiseR,
		denoiseG,
		denoiseB,
		hitsPos,
		probeOrigin,
		cascadeCell,
		cascadeRes,
		frame,
		view,
		light
	};
}
//#endregion
//#region packages/idtech-gi/src/tsl/volumeTextures.ts
function makeFloat3D(width, height, depth, name) {
	const data = new Float32Array(width * height * depth * 4);
	const tex = new Data3DTexture(data, width, height, depth);
	tex.format = RGBAFormat;
	tex.type = FloatType;
	tex.minFilter = LinearFilter;
	tex.magFilter = LinearFilter;
	tex.wrapS = ClampToEdgeWrapping;
	tex.wrapT = ClampToEdgeWrapping;
	tex.wrapR = ClampToEdgeWrapping;
	tex.generateMipmaps = false;
	tex.unpackAlignment = 1;
	tex.name = name;
	tex.needsUpdate = true;
	return tex;
}
function makeByte3D(width, height, depth, name) {
	const data = new Uint8Array(width * height * depth * 4);
	const tex = new Data3DTexture(data, width, height, depth);
	tex.format = RGBAFormat;
	tex.type = UnsignedByteType;
	tex.minFilter = NearestFilter;
	tex.magFilter = NearestFilter;
	tex.wrapS = ClampToEdgeWrapping;
	tex.wrapT = ClampToEdgeWrapping;
	tex.wrapR = ClampToEdgeWrapping;
	tex.generateMipmaps = false;
	tex.unpackAlignment = 1;
	tex.name = name;
	tex.needsUpdate = true;
	return tex;
}
function createVolumeGpuTextures(config, voxel) {
	const res = config.resolution;
	const depth = res * config.cascadeCount;
	const radianceCache = makeFloat3D(voxel.resolution, voxel.resolution, voxel.resolution, "gi-radiance-cache");
	radianceCache.minFilter = NearestFilter;
	radianceCache.magFilter = NearestFilter;
	return {
		l0: makeFloat3D(res, res, depth, "gi-sh-l0"),
		lx: makeFloat3D(res, res, depth, "gi-sh-lx"),
		ly: makeFloat3D(res, res, depth, "gi-sh-ly"),
		lz: makeFloat3D(res, res, depth, "gi-sh-lz"),
		voxel: makeByte3D(voxel.resolution, voxel.resolution, voxel.resolution, "gi-voxels"),
		radianceCache,
		resolution: res,
		cascadeCount: config.cascadeCount,
		firstSize: config.firstSize
	};
}
function uploadVoxelTexture(tex, voxel) {
	const data = tex.image.data;
	const n = voxel.resolution ** 3;
	for (let i = 0; i < n; i += 1) {
		const o = i * 4;
		data[o] = Math.round((voxel.albedo[i * 3] ?? 0) * 255);
		data[o + 1] = Math.round((voxel.albedo[i * 3 + 1] ?? 0) * 255);
		data[o + 2] = Math.round((voxel.albedo[i * 3 + 2] ?? 0) * 255);
		data[o + 3] = voxel.occupancy[i] ? 255 : 0;
	}
	tex.needsUpdate = true;
}
function uploadVolumeTextures(textures, volumes) {
	const res = textures.resolution;
	const cascades = textures.cascadeCount;
	const layer = res * res;
	const pack = (tex, pick) => {
		const data = tex.image.data;
		for (let cascade = 0; cascade < cascades; cascade += 1) for (let iz = 0; iz < res; iz += 1) for (let iy = 0; iy < res; iy += 1) for (let ix = 0; ix < res; ix += 1) {
			const rgb = pick(cascade * layer * res + iz * layer + iy * res + ix);
			const o = (cascade * res + iz) * layer * 4 + iy * res * 4 + ix * 4;
			data[o] = rgb[0];
			data[o + 1] = rgb[1];
			data[o + 2] = rgb[2];
			data[o + 3] = 1;
		}
		tex.needsUpdate = true;
	};
	pack(textures.l0, (i) => volumes.current[i]?.l0 ?? [
		0,
		0,
		0
	]);
	pack(textures.lx, (i) => volumes.current[i]?.lx ?? [
		0,
		0,
		0
	]);
	pack(textures.ly, (i) => volumes.current[i]?.ly ?? [
		0,
		0,
		0
	]);
	pack(textures.lz, (i) => volumes.current[i]?.lz ?? [
		0,
		0,
		0
	]);
}
/**
* Splats hashed cache entries into a dense 3D texture so the TSL gather can
* sample world radiance at a hit without a GPU hash table.
*/
function uploadRadianceCache(tex, cache, voxel) {
	const data = tex.image.data;
	data.fill(0);
	const base = cache.config.cellSize;
	const r = voxel.resolution;
	for (const entry of cache.entries) {
		if (!entry) continue;
		const size = base * entry.lod;
		const wx = (entry.ix + .5) * size;
		const wy = (entry.iy + .5) * size;
		const wz = (entry.iz + .5) * size;
		const ix = Math.floor((wx - voxel.origin[0]) / voxel.cell);
		const iy = Math.floor((wy - voxel.origin[1]) / voxel.cell);
		const iz = Math.floor((wz - voxel.origin[2]) / voxel.cell);
		if (ix < 0 || iy < 0 || iz < 0 || ix >= r || iy >= r || iz >= r) continue;
		const o = (iz * r * r + iy * r + ix) * 4;
		data[o] = entry.radiance[0];
		data[o + 1] = entry.radiance[1];
		data[o + 2] = entry.radiance[2];
		data[o + 3] = 1;
	}
	tex.needsUpdate = true;
}
//#endregion
//#region packages/idtech-gi/src/IdTechGI.ts
var _viewProj = new Matrix4();
/**
* Isolated idTech-8-style GI for a Three.js WebGPURenderer.
*
* CPU Sousa pipeline updates the hashed radiance cache and cascaded SH
* volumes. TSL visibility writes per-probe hits into that cache; a half-res
* cache-only gather (screen → world cache → volumes) stores 2-band SH,
* denoises, upscales, and is sampled by the material as indirect light.
*/
var IdTechGI = class {
	scene;
	textures;
	uniforms;
	pipeline;
	passes;
	enabled = true;
	gpuCompute;
	lastCamera = new Vector3();
	constructor(scene, options = {}) {
		this.scene = scene;
		this.pipeline = scene.pipeline;
		this.textures = createVolumeGpuTextures(scene.pipeline.cascade, scene.voxel);
		uploadVoxelTexture(this.textures.voxel, scene.voxel);
		this.uniforms = createGiUniforms(this.textures, new Vector3(scene.voxel.origin[0], scene.voxel.origin[1], scene.voxel.origin[2]), scene.voxel.size);
		this.gpuCompute = options.gpuCompute ?? true;
		const gw = Math.max(32, options.gatherWidth ?? 320);
		const gh = Math.max(32, options.gatherHeight ?? 200);
		this.passes = createGiComputePasses(this.textures, this.uniforms, gw, gh, scene.pipeline.cascade.resolution ** 3, scene.pipeline.cascade.raysPerProbe);
		this.bindLight(scene.lights[0]);
	}
	setEnabled(enabled) {
		this.enabled = enabled;
		this.uniforms.enabled.value = enabled ? 1 : 0;
	}
	createMaterial(color) {
		const material = new MeshStandardNodeMaterial();
		const albedo = new Color(color[0], color[1], color[2]);
		material.color = albedo;
		material.roughness = .92;
		material.metalness = 0;
		material.envMapIntensity = 0;
		material.emissiveNode = createIndirectNode(this.textures, this.uniforms, albedo, {
			r: this.passes.denoiseR,
			g: this.passes.denoiseG,
			b: this.passes.denoiseB,
			width: this.passes.gatherWidth,
			height: this.passes.gatherHeight
		});
		return material;
	}
	populateThreeScene(threeScene) {
		const meshes = [];
		for (const box of this.scene.boxes) {
			const sx = box.max[0] - box.min[0];
			const sy = box.max[1] - box.min[1];
			const sz = box.max[2] - box.min[2];
			const mesh = new Mesh(new BoxGeometry(Math.max(sx, .001), Math.max(sy, .001), Math.max(sz, .001)), this.createMaterial(box.color));
			mesh.position.set((box.min[0] + box.max[0]) * .5, (box.min[1] + box.max[1]) * .5, (box.min[2] + box.max[2]) * .5);
			mesh.castShadow = true;
			mesh.receiveShadow = true;
			threeScene.add(mesh);
			meshes.push(mesh);
		}
		for (const light of this.scene.lights) if (light.direction && light.coneCos !== void 0) {
			const angle = Math.acos(Math.min(.999, Math.max(-1, light.coneCos)));
			const spot = new SpotLight(new Color(light.color[0], light.color[1], light.color[2]), Math.max(8, light.intensity * 1.4), 40, angle, .4, 2);
			spot.position.set(light.position[0], light.position[1], light.position[2]);
			spot.target.position.set(light.position[0] + light.direction[0], light.position[1] + light.direction[1], light.position[2] + light.direction[2]);
			threeScene.add(spot);
			threeScene.add(spot.target);
		} else {
			const point = new PointLight(new Color(light.color[0], light.color[1], light.color[2]), Math.max(6, light.intensity * .8), 40, 2);
			point.position.set(light.position[0], light.position[1], light.position[2]);
			threeScene.add(point);
		}
		return meshes;
	}
	warm(frames = 8, camera) {
		const cam = camera ?? this.scene.camera.position;
		for (let i = 0; i < frames; i += 1) this.pipeline.step(cam);
		this.upload(cam);
	}
	upload(camera) {
		this.lastCamera.set(camera[0], camera[1], camera[2]);
		this.uniforms.camera.value.copy(this.lastCamera);
		uploadVolumeTextures(this.textures, this.pipeline.volumes);
		uploadRadianceCache(this.textures.radianceCache, this.pipeline.cache, this.scene.voxel);
	}
	setView(camera, width, height) {
		camera.updateMatrixWorld();
		camera.updateProjectionMatrix();
		const e = camera.matrixWorld.elements;
		this.passes.view.pos.value.copy(camera.position);
		this.passes.view.right.value.set(e[0], e[1], e[2]);
		this.passes.view.up.value.set(e[4], e[5], e[6]);
		this.passes.view.forward.value.set(-e[8], -e[9], -e[10]).normalize();
		const fov = camera.fov * (Math.PI / 180);
		this.passes.view.tanHalf.value = Math.tan(fov * .5);
		this.passes.view.aspect.value = width / Math.max(height, 1);
		_viewProj.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
		const m = _viewProj.elements;
		this.passes.view.viewProjX.value.set(m[0], m[4], m[8], m[12]);
		this.passes.view.viewProjY.value.set(m[1], m[5], m[9], m[13]);
		this.passes.view.viewProjZ.value.set(m[2], m[6], m[10], m[14]);
		this.passes.view.viewProjW.value.set(m[3], m[7], m[11], m[15]);
	}
	/**
	* One budgeted GI frame. Compute errors propagate — they are not swallowed.
	*/
	tick(renderer, camera, width, height) {
		const pos = [
			camera.position.x,
			camera.position.y,
			camera.position.z
		];
		if (!this.enabled) {
			this.uniforms.enabled.value = 0;
			return;
		}
		this.uniforms.enabled.value = 1;
		this.pipeline.step(pos);
		this.upload(pos);
		if (!this.gpuCompute) return;
		this.setView(camera, width, height);
		const updated = interleavedUpdateSet(Math.max(0, this.pipeline.frame - 1), pos, this.pipeline.cascade);
		const origin = cascadeOrigin(updated.cascade, pos, this.pipeline.cascade);
		this.passes.probeOrigin.value.set(origin[0], origin[1], origin[2]);
		this.passes.cascadeCell.value = cascadeCellSize(updated.cascade, this.pipeline.cascade);
		this.passes.cascadeRes.value = this.pipeline.cascade.resolution;
		this.passes.frame.value = this.pipeline.frame;
		renderer.compute(this.passes.visibility);
		renderer.compute(this.passes.gather);
		renderer.compute(this.passes.denoise);
		renderer.compute(this.passes.cacheScreen);
	}
	dispose() {
		this.textures.l0.dispose();
		this.textures.lx.dispose();
		this.textures.ly.dispose();
		this.textures.lz.dispose();
		this.textures.voxel.dispose();
		this.textures.radianceCache.dispose();
	}
	bindLight(light) {
		if (!light) return;
		this.passes.light.pos.value.set(light.position[0], light.position[1], light.position[2]);
		this.passes.light.color.value.set(light.color[0], light.color[1], light.color[2]);
		const dir = light.direction ?? [
			0,
			-1,
			0
		];
		this.passes.light.dir.value.set(dir[0], dir[1], dir[2]).normalize();
		this.passes.light.params.value.set(light.intensity, light.coneCos ?? 0, light.direction ? 1 : 0, 0);
	}
};
//#endregion
//#region packages/idtech-gi/src/cpuRender.ts
function cameraBasis(camera) {
	const origin = camera.position;
	const forward = normalize3(sub3(camera.target, origin));
	const worldUp = camera.up ?? [
		0,
		1,
		0
	];
	const right = normalize3([
		forward[1] * worldUp[2] - forward[2] * worldUp[1],
		forward[2] * worldUp[0] - forward[0] * worldUp[2],
		forward[0] * worldUp[1] - forward[1] * worldUp[0]
	]);
	return {
		origin,
		right,
		up: [
			right[1] * forward[2] - right[2] * forward[1],
			right[2] * forward[0] - right[0] * forward[2],
			right[0] * forward[1] - right[1] * forward[0]
		],
		forward
	};
}
/**
* Rasterise the voxel scene with the shipped Sousa pipeline: primary vis via
* DDA, direct from `shadeHit`, indirect from irradiance volumes when `gi` is
* on. Used by tests and by the capture harness as a CPU proof of bounce.
*/
function renderCpuFrame(pipeline, voxel, camera, width, height, gi) {
	const rgba = new Uint8Array(width * height * 4);
	const basis = cameraBasis(camera);
	const tanHalf = Math.tan(camera.fovY * Math.PI / 360);
	const aspect = width / height;
	const maxDist = voxel.size * 1.7;
	for (let y = 0; y < height; y += 1) {
		const ny = (1 - (y + .5) / height) * 2 - 1;
		for (let x = 0; x < width; x += 1) {
			const nx = (x + .5) / width * 2 - 1;
			const dir = normalize3([
				basis.forward[0] + basis.right[0] * nx * tanHalf * aspect + basis.up[0] * ny * tanHalf,
				basis.forward[1] + basis.right[1] * nx * tanHalf * aspect + basis.up[1] * ny * tanHalf,
				basis.forward[2] + basis.right[2] * nx * tanHalf * aspect + basis.up[2] * ny * tanHalf
			]);
			const hit = voxel.trace(basis.origin, dir, maxDist);
			let rgb = [
				.01,
				.012,
				.02
			];
			if (hit) rgb = pipeline.shadeHit(hit, { gi });
			const i = (y * width + x) * 4;
			rgba[i] = toByte(rgb[0]);
			rgba[i + 1] = toByte(rgb[1]);
			rgba[i + 2] = toByte(rgb[2]);
			rgba[i + 3] = 255;
		}
	}
	return {
		width,
		height,
		rgba
	};
}
function toByte(value) {
	const mapped = value / (1 + value);
	return Math.max(0, Math.min(255, Math.round(Math.pow(mapped, 1 / 2.2) * 255)));
}
//#endregion
//#region packages/idtech-gi/src/gatherFallback.ts
/**
* Sousa final gather: 0 shading, caches only.
* Fallback order is screen-space → world radiance cache → irradiance volumes.
*/
function resolveGather(query, caches) {
	const screen = caches.screen?.sample(query.position) ?? null;
	if (screen) return {
		radiance: [
			screen[0],
			screen[1],
			screen[2]
		],
		source: "screen-space"
	};
	const distance = Math.hypot(query.position[0] - caches.camera[0], query.position[1] - caches.camera[1], query.position[2] - caches.camera[2]);
	const cached = caches.radiance.sample(query.position, distance, query.frame);
	if (cached) return {
		radiance: [
			cached[0],
			cached[1],
			cached[2]
		],
		source: "radiance-cache"
	};
	const sh = caches.volumes.sample(query.position, caches.camera);
	if (sh) {
		const incoming = evaluateIrradiance(sh, query.normal);
		if (incoming[0] + incoming[1] + incoming[2] > 1e-8) return {
			radiance: incoming,
			source: "irradiance-volume"
		};
	}
	const sky = caches.sky ?? [
		0,
		0,
		0
	];
	return {
		radiance: [
			sky[0],
			sky[1],
			sky[2]
		],
		source: "miss"
	};
}
//#endregion
//#region packages/idtech-gi/src/irradianceVolume.ts
/**
* World-space cascaded irradiance volumes. Each cell stores 2-band RGB SH of
* incoming radiance. Sampling is trilinear within a cascade; the finest
* cascade that still contains the point is chosen (Sousa uses the same
* nested-volume idea).
*/
var IrradianceVolumeField = class {
	config;
	current;
	previous;
	constructor(config = DEFAULT_CASCADE) {
		this.config = config;
		const count = totalProbes(config);
		this.current = Array.from({ length: count }, () => emptySH());
		this.previous = Array.from({ length: count }, () => emptySH());
	}
	get(index) {
		return this.current[index] ?? emptySH();
	}
	getPrevious(index) {
		return this.previous[index] ?? emptySH();
	}
	set(index, sh) {
		this.current[index] = copySH(sh);
	}
	/**
	* Write a newly traced probe. `previousFrameBlend` is Sousa's "add previous
	* frame" temporal mix — not a second trace, just feedback of last frame's
	* irradiance so extra bounces accumulate across frames.
	*/
	updateProbe(probe, traced, previousFrameBlend = .35) {
		const prev = this.previous[probe.index] ?? emptySH();
		this.current[probe.index] = mixSH(traced, prev, previousFrameBlend);
	}
	/** Swap current into previous at the end of a frame (whole-field snapshot). */
	advanceFrame() {
		for (let i = 0; i < this.current.length; i += 1) this.previous[i] = copySH(this.current[i] ?? emptySH());
	}
	sample(world, camera) {
		const cascade = cascadeForPoint(world, camera, this.config);
		const half = cascadeSize(cascade, this.config) * .5;
		if (Math.abs(world[0] - camera[0]) > half || Math.abs(world[1] - camera[1]) > half || Math.abs(world[2] - camera[2]) > half) {
			if (cascade >= this.config.cascadeCount - 1) return null;
		}
		return this.sampleCascade(world, camera, cascade);
	}
	sampleCascade(world, camera, cascade) {
		const res = this.config.resolution;
		const { ix, iy, iz, fx, fy, fz } = worldToCell(world, cascade, camera, this.config);
		const sh = emptySH();
		let weight = 0;
		for (let dz = 0; dz <= 1; dz += 1) for (let dy = 0; dy <= 1; dy += 1) for (let dx = 0; dx <= 1; dx += 1) {
			const cx = ix + dx;
			const cy = iy + dy;
			const cz = iz + dz;
			if (cx < 0 || cy < 0 || cz < 0 || cx >= res || cy >= res || cz >= res) continue;
			const w = (dx === 0 ? 1 - fx : fx) * (dy === 0 ? 1 - fy : fy) * (dz === 0 ? 1 - fz : fz);
			if (w <= 0) continue;
			const index = volumeIndex(cascade, cx, cy, cz, this.config);
			const cell = this.current[index];
			if (!cell) continue;
			sh.l0[0] += cell.l0[0] * w;
			sh.l0[1] += cell.l0[1] * w;
			sh.l0[2] += cell.l0[2] * w;
			sh.lx[0] += cell.lx[0] * w;
			sh.lx[1] += cell.lx[1] * w;
			sh.lx[2] += cell.lx[2] * w;
			sh.ly[0] += cell.ly[0] * w;
			sh.ly[1] += cell.ly[1] * w;
			sh.ly[2] += cell.ly[2] * w;
			sh.lz[0] += cell.lz[0] * w;
			sh.lz[1] += cell.lz[1] * w;
			sh.lz[2] += cell.lz[2] * w;
			weight += w;
		}
		if (weight < 1e-6) return emptySH();
		if (weight < .999) return scaleSH(sh, 1 / weight);
		return sh;
	}
	clear() {
		for (let i = 0; i < this.current.length; i += 1) {
			this.current[i] = emptySH();
			this.previous[i] = emptySH();
		}
	}
};
//#endregion
//#region packages/idtech-gi/src/spatialHash.ts
/**
* Sousa / Gautron spatial hash: 1D table indexed by a hash of quantized world
* position + LOD, collisions resolved by a short linear probe.
*/
function cellLod(distanceToCamera, lodDistance) {
	const ratio = Math.max(0, distanceToCamera) / Math.max(lodDistance, 1e-4);
	const lod = 2 ** Math.floor(Math.log2(1 + ratio));
	return Math.max(1, lod);
}
function quantizePosition(position, config, distanceToCamera) {
	const lod = cellLod(distanceToCamera, config.lodDistance);
	const size = config.cellSize * lod;
	return {
		ix: Math.floor(position[0] / size),
		iy: Math.floor(position[1] / size),
		iz: Math.floor(position[2] / size),
		lod
	};
}
/** Nested hash from the Sousa slides. */
function hashCellKey(key) {
	return hashInt(key.lod + hashCombine(key.iz, hashCombine(key.iy, hashInt(key.ix))));
}
function cellChecksum(key) {
	const value = hashCombine(key.lod + 1, hashCombine(key.iz, hashCombine(key.iy, hashInt(key.ix + 2654435769))));
	return value === 0 ? 1 : value;
}
var WorldRadianceCache = class {
	config;
	entries;
	occupied = 0;
	constructor(config = DEFAULT_CACHE) {
		this.config = config;
		this.entries = new Array(config.maxCells).fill(null);
	}
	indexOf(key) {
		return hashCellKey(key) % this.config.maxCells;
	}
	lookupKey(key, frame = 0) {
		const start = this.indexOf(key);
		const checksum = cellChecksum(key);
		const { maxCells, probeSteps, reuseFrames } = this.config;
		for (let step = 0; step < probeSteps; step += 1) {
			const index = (start + step) % maxCells;
			const entry = this.entries[index];
			if (!entry) return {
				index,
				entry: null,
				reused: false
			};
			if (entry.checksum === checksum) {
				const age = frame - entry.frame;
				return {
					index,
					entry,
					reused: age >= 0 && age <= reuseFrames
				};
			}
		}
		return {
			index: start,
			entry: null,
			reused: false
		};
	}
	lookup(position, distanceToCamera, frame = 0) {
		return this.lookupKey(quantizePosition(position, this.config, distanceToCamera), frame);
	}
	/**
	* Insert or reuse a cell. Matching recent cells are left in place (Sousa
	* reuses ~20k updates over N frames). Expired or empty slots are claimed.
	*/
	insert(position, distanceToCamera, payload, frame) {
		const key = quantizePosition(position, this.config, distanceToCamera);
		const found = this.lookupKey(key, frame);
		if (found.entry && found.reused) return found;
		const start = found.index;
		const checksum = cellChecksum(key);
		const { maxCells, probeSteps, reuseFrames } = this.config;
		let slot = start;
		let claimed = false;
		for (let step = 0; step < probeSteps; step += 1) {
			const index = (start + step) % maxCells;
			const entry = this.entries[index];
			if (!entry || entry.checksum === checksum || frame - entry.frame > reuseFrames) {
				slot = index;
				claimed = true;
				break;
			}
		}
		if (!claimed) slot = start;
		if (!this.entries[slot]) this.occupied += 1;
		this.entries[slot] = {
			checksum,
			lod: key.lod,
			ix: key.ix,
			iy: key.iy,
			iz: key.iz,
			radiance: [
				payload.radiance[0],
				payload.radiance[1],
				payload.radiance[2]
			],
			normal: [
				payload.normal[0],
				payload.normal[1],
				payload.normal[2]
			],
			albedo: [
				payload.albedo[0],
				payload.albedo[1],
				payload.albedo[2]
			],
			frame
		};
		return {
			index: slot,
			entry: this.entries[slot],
			reused: false
		};
	}
	/** Rewrite radiance of an existing cell after shading. */
	shade(index, radiance, frame) {
		const entry = this.entries[index];
		if (!entry) return;
		entry.radiance = [
			radiance[0],
			radiance[1],
			radiance[2]
		];
		entry.frame = frame;
	}
	sample(position, distanceToCamera, frame) {
		const found = this.lookup(position, distanceToCamera, frame);
		if (!found.entry || !found.reused) return null;
		return found.entry.radiance;
	}
	clear() {
		this.entries.fill(null);
		this.occupied = 0;
	}
};
//#endregion
//#region packages/idtech-gi/src/pipeline.ts
/**
* CPU Sousa frame: visibility from interleaved cell-center probes → spatially
* hashed radiance cache (shaded, reused) → irradiance volumes with previous-
* frame bounce → reduced-res cache-only final gather.
*
* Visibility is a voxel DDA so the rest of the pipeline does not depend on
* hardware RT. The TSL path ports these same stages to compute.
*/
var SousaPipeline = class {
	cascade;
	cache;
	volumes;
	lights;
	sky;
	volumeBlend;
	maxRayDistance;
	probeStride;
	frame = 0;
	lastStats = {
		frame: 0,
		cascade: 0,
		probesUpdated: 0,
		raysTraced: 0,
		cacheInserts: 0,
		cacheReuses: 0,
		hits: 0
	};
	camera = [
		0,
		0,
		0
	];
	voxel;
	constructor(voxel, options = {}) {
		this.voxel = voxel;
		this.cascade = options.cascade ?? { ...DEFAULT_CASCADE };
		this.cache = new WorldRadianceCache(options.cache ?? DEFAULT_CACHE);
		this.volumes = new IrradianceVolumeField(this.cascade);
		this.lights = options.lights ?? [];
		this.sky = options.sky ?? [
			.02,
			.03,
			.05
		];
		this.volumeBlend = options.volumeBlend ?? .35;
		this.maxRayDistance = options.maxRayDistance ?? voxel.size * 1.5;
		this.probeStride = options.probeStride ?? 1;
	}
	/**
	* One budgeted frame. Updates one cascade (interleaved), shades new cache
	* entries with previous-frame volume irradiance, then writes the cascade.
	*/
	step(camera) {
		this.camera = camera;
		const update = interleavedUpdateSet(this.frame, camera, this.cascade, this.probeStride);
		let raysTraced = 0;
		let cacheInserts = 0;
		let cacheReuses = 0;
		let hits = 0;
		const rotate = this.frame * .37;
		for (const probe of update.probes) {
			const voxel = this.voxel.worldToVoxel(probe.position);
			const ix = Math.floor(voxel[0]);
			const iy = Math.floor(voxel[1]);
			const iz = Math.floor(voxel[2]);
			if (this.voxel.inBounds(ix, iy, iz) && this.voxel.occupancy[this.voxel.index(ix, iy, iz)]) continue;
			const traced = this.traceProbe(probe, camera, rotate);
			raysTraced += this.cascade.raysPerProbe;
			hits += traced.hits;
			cacheInserts += traced.inserts;
			cacheReuses += traced.reuses;
			this.volumes.updateProbe(probe, traced.sh, this.volumeBlend);
		}
		this.volumes.advanceFrame();
		const stats = {
			frame: this.frame,
			cascade: update.cascade,
			probesUpdated: update.probes.length,
			raysTraced,
			cacheInserts,
			cacheReuses,
			hits
		};
		this.lastStats = stats;
		this.frame += 1;
		return stats;
	}
	traceProbe(probe, camera, rotate) {
		const rays = this.cascade.raysPerProbe;
		const solid = 4 * Math.PI / rays;
		const sh = emptySH();
		let hits = 0;
		let inserts = 0;
		let reuses = 0;
		for (let ray = 0; ray < rays; ray += 1) {
			const dir = fibonacciSphere(rays, ray, rotate);
			const vis = this.voxel.trace(probe.position, dir, this.maxRayDistance);
			let radiance;
			if (!vis) radiance = this.sky;
			else {
				hits += 1;
				const distance = length3(sub3(vis.position, camera));
				const found = this.cache.lookup(vis.position, distance, this.frame);
				if (found.entry && found.reused) {
					reuses += 1;
					radiance = found.entry.radiance;
				} else {
					radiance = this.shadeHit(vis);
					this.cache.insert(vis.position, distance, {
						radiance,
						normal: vis.normal,
						albedo: vis.albedo
					}, this.frame);
					inserts += 1;
				}
			}
			const encoded = encodeRadiance(dir, radiance, solid);
			sh.l0[0] += encoded.l0[0];
			sh.l0[1] += encoded.l0[1];
			sh.l0[2] += encoded.l0[2];
			sh.lx[0] += encoded.lx[0];
			sh.lx[1] += encoded.lx[1];
			sh.lx[2] += encoded.lx[2];
			sh.ly[0] += encoded.ly[0];
			sh.ly[1] += encoded.ly[1];
			sh.ly[2] += encoded.ly[2];
			sh.lz[0] += encoded.lz[0];
			sh.lz[1] += encoded.lz[1];
			sh.lz[2] += encoded.lz[2];
		}
		return {
			sh,
			hits,
			inserts,
			reuses
		};
	}
	/**
	* Shade a visibility hit: Lambert direct lights (voxel-shadowed) plus
	* previous-frame volume irradiance. That previous-frame term is the extra
	* bounce — we do not trace more rays (Sousa).
	*/
	shadeHit(hit, options = {}) {
		const n = hit.normal;
		const p = hit.position;
		const albedo = hit.albedo;
		let ev = [
			0,
			0,
			0
		];
		for (const light of this.lights) {
			const toLight = sub3(light.position, p);
			const dist = length3(toLight);
			if (dist < 1e-4) continue;
			const ldir = [
				toLight[0] / dist,
				toLight[1] / dist,
				toLight[2] / dist
			];
			const ndotl = Math.max(0, dot3(n, ldir));
			if (ndotl <= 0) continue;
			if (light.direction && light.coneCos !== void 0) {
				if (-ldir[0] * light.direction[0] - ldir[1] * light.direction[1] - ldir[2] * light.direction[2] < light.coneCos) continue;
			}
			const origin = [
				p[0] + n[0] * this.voxel.cell * .6,
				p[1] + n[1] * this.voxel.cell * .6,
				p[2] + n[2] * this.voxel.cell * .6
			];
			if (this.voxel.occluded(origin, light.position)) continue;
			const atten = light.intensity / (1 + dist * dist);
			ev = addRgb(ev, scaleRgb(mulRgb(light.color, albedo), ndotl * atten * INV_PI));
		}
		if (options.gi !== false) {
			const prev = this.volumes.sample(p, this.camera);
			if (prev) {
				const indirect = evaluateIrradiance(prev, n);
				ev = addRgb(ev, scaleRgb(mulRgb(albedo, indirect), INV_PI));
			}
		}
		return ev;
	}
	sampleIndirect(position, normal, camera) {
		const sh = this.volumes.sample(position, camera);
		if (!sh) return [
			0,
			0,
			0
		];
		return evaluateIrradiance(sh, normal);
	}
	gatherCaches(screen) {
		return {
			screen,
			radiance: this.cache,
			volumes: this.volumes,
			camera: this.camera,
			sky: this.sky
		};
	}
	/**
	* Reduced-resolution, cache-only final gather for one surface sample.
	* One cosine-weighted ray, then the Sousa fallback order.
	*/
	finalGather(position, normal, pixelX, pixelY, screen) {
		const dir = cosineHemisphere(normal, interleavedGradientNoise(pixelX, pixelY, this.frame), interleavedGradientNoise(pixelX + 19, pixelY + 47, this.frame * 3));
		const origin = [
			position[0] + normal[0] * this.voxel.cell * .5,
			position[1] + normal[1] * this.voxel.cell * .5,
			position[2] + normal[2] * this.voxel.cell * .5
		];
		const vis = this.voxel.trace(origin, dir, this.maxRayDistance);
		return resolveGather({
			position: vis?.position ?? addOffset(origin, dir, this.maxRayDistance),
			normal: vis?.normal ?? [
				-dir[0],
				-dir[1],
				-dir[2]
			],
			rayDir: dir,
			frame: this.frame
		}, this.gatherCaches(screen));
	}
	/**
	* Encode one gather radiance sample as 2-band SH about the surface normal
	* (Sousa: each gather pixel is an irradiance probe).
	*/
	gatherToSH(normal, radiance) {
		return encodeRadiance(normal, radiance, TAU / 2);
	}
};
function addOffset(origin, dir, distance) {
	return [
		origin[0] + dir[0] * distance,
		origin[1] + dir[1] * distance,
		origin[2] + dir[2] * distance
	];
}
//#endregion
//#region packages/idtech-gi/src/voxelGrid.ts
/**
* Dense occupancy + albedo grid used as the swappable visibility backend.
* Sousa traces hardware rays; WebGPU has no rayQuery, so probe visibility is
* a voxel DDA against this grid (same cache architecture, different vis).
*/
var VoxelGrid = class {
	resolution;
	origin;
	size;
	cell;
	occupancy;
	albedo;
	normal;
	constructor(resolution, origin, size) {
		this.resolution = resolution;
		this.origin = origin;
		this.size = size;
		this.cell = size / resolution;
		const count = resolution * resolution * resolution;
		this.occupancy = new Uint8Array(count);
		this.albedo = new Float32Array(count * 3);
		this.normal = new Float32Array(count * 3);
	}
	index(ix, iy, iz) {
		const r = this.resolution;
		return iz * r * r + iy * r + ix;
	}
	inBounds(ix, iy, iz) {
		const r = this.resolution;
		return ix >= 0 && iy >= 0 && iz >= 0 && ix < r && iy < r && iz < r;
	}
	worldToVoxel(p) {
		return [
			(p[0] - this.origin[0]) / this.cell,
			(p[1] - this.origin[1]) / this.cell,
			(p[2] - this.origin[2]) / this.cell
		];
	}
	voxelCenter(ix, iy, iz) {
		return [
			this.origin[0] + (ix + .5) * this.cell,
			this.origin[1] + (iy + .5) * this.cell,
			this.origin[2] + (iz + .5) * this.cell
		];
	}
	setVoxel(ix, iy, iz, albedo, normal) {
		if (!this.inBounds(ix, iy, iz)) return;
		const i = this.index(ix, iy, iz);
		this.occupancy[i] = 1;
		this.albedo[i * 3] = albedo[0];
		this.albedo[i * 3 + 1] = albedo[1];
		this.albedo[i * 3 + 2] = albedo[2];
		const len = Math.hypot(normal[0], normal[1], normal[2]) || 1;
		this.normal[i * 3] = normal[0] / len;
		this.normal[i * 3 + 1] = normal[1] / len;
		this.normal[i * 3 + 2] = normal[2] / len;
	}
	fillBox(min, max, albedo, normal) {
		const a = this.worldToVoxel(min);
		const b = this.worldToVoxel(max);
		const x0 = Math.max(0, Math.floor(Math.min(a[0], b[0])));
		const y0 = Math.max(0, Math.floor(Math.min(a[1], b[1])));
		const z0 = Math.max(0, Math.floor(Math.min(a[2], b[2])));
		const x1 = Math.min(this.resolution - 1, Math.floor(Math.max(a[0], b[0]) - 1e-6));
		const y1 = Math.min(this.resolution - 1, Math.floor(Math.max(a[1], b[1]) - 1e-6));
		const z1 = Math.min(this.resolution - 1, Math.floor(Math.max(a[2], b[2]) - 1e-6));
		const dx = max[0] - min[0];
		const dy = max[1] - min[1];
		const dz = max[2] - min[2];
		const auto = !normal ? dx <= dy && dx <= dz ? [
			Math.sign(max[0] + min[0]),
			0,
			0
		] : dy <= dz ? [
			0,
			Math.sign(max[1] + min[1]),
			0
		] : [
			0,
			0,
			Math.sign(max[2] + min[2])
		] : normal;
		for (let iz = z0; iz <= z1; iz += 1) for (let iy = y0; iy <= y1; iy += 1) for (let ix = x0; ix <= x1; ix += 1) this.setVoxel(ix, iy, iz, albedo, auto);
	}
	/**
	* Amanatides & Woo DDA. Returns the first occupied voxel along the ray.
	* Face normal is taken from the axis we entered on, so a thin wall still
	* shades with a plausible orientation without storing extra data.
	*/
	trace(origin, dir, maxDistance) {
		const r = this.resolution;
		const cell = this.cell;
		const ox = (origin[0] - this.origin[0]) / cell;
		const oy = (origin[1] - this.origin[1]) / cell;
		const oz = (origin[2] - this.origin[2]) / cell;
		const dx = dir[0];
		const dy = dir[1];
		const dz = dir[2];
		let ix = Math.floor(ox);
		let iy = Math.floor(oy);
		let iz = Math.floor(oz);
		const stepX = dx >= 0 ? 1 : -1;
		const stepY = dy >= 0 ? 1 : -1;
		const stepZ = dz >= 0 ? 1 : -1;
		const tDeltaX = dx === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dx);
		const tDeltaY = dy === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dy);
		const tDeltaZ = dz === 0 ? Number.POSITIVE_INFINITY : Math.abs(1 / dz);
		const nextVoxelX = dx >= 0 ? ix + 1 : ix;
		const nextVoxelY = dy >= 0 ? iy + 1 : iy;
		const nextVoxelZ = dz >= 0 ? iz + 1 : iz;
		let tMaxX = dx === 0 ? Number.POSITIVE_INFINITY : (nextVoxelX - ox) / dx;
		let tMaxY = dy === 0 ? Number.POSITIVE_INFINITY : (nextVoxelY - oy) / dy;
		let tMaxZ = dz === 0 ? Number.POSITIVE_INFINITY : (nextVoxelZ - oz) / dz;
		const tLimit = maxDistance / cell;
		let t = 0;
		let lastAxis = 0;
		const maxSteps = r * 3;
		for (let step = 0; step < maxSteps && t <= tLimit; step += 1) {
			if (ix >= 0 && iy >= 0 && iz >= 0 && ix < r && iy < r && iz < r) {
				const index = this.index(ix, iy, iz);
				if (this.occupancy[index]) {
					const distance = t * cell;
					const n = [
						0,
						0,
						0
					];
					n[lastAxis] = lastAxis === 0 ? -stepX : lastAxis === 1 ? -stepY : -stepZ;
					const stored = [
						this.normal[index * 3],
						this.normal[index * 3 + 1],
						this.normal[index * 3 + 2]
					];
					const normal = Math.abs(stored[0]) + Math.abs(stored[1]) + Math.abs(stored[2]) > .1 && stored[0] * n[0] + stored[1] * n[1] + stored[2] * n[2] >= 0 ? stored : n;
					return {
						position: add3(origin, scale3(dir, Math.max(distance, cell * .01))),
						normal,
						albedo: [
							this.albedo[index * 3],
							this.albedo[index * 3 + 1],
							this.albedo[index * 3 + 2]
						],
						distance,
						ix,
						iy,
						iz
					};
				}
			}
			if (tMaxX < tMaxY && tMaxX < tMaxZ) {
				ix += stepX;
				t = tMaxX;
				tMaxX += tDeltaX;
				lastAxis = 0;
			} else if (tMaxY < tMaxZ) {
				iy += stepY;
				t = tMaxY;
				tMaxY += tDeltaY;
				lastAxis = 1;
			} else {
				iz += stepZ;
				t = tMaxZ;
				tMaxZ += tDeltaZ;
				lastAxis = 2;
			}
		}
		return null;
	}
	occluded(from, to) {
		const delta = [
			to[0] - from[0],
			to[1] - from[1],
			to[2] - from[2]
		];
		const dist = Math.hypot(delta[0], delta[1], delta[2]);
		if (dist < 1e-5) return false;
		const dir = [
			delta[0] / dist,
			delta[1] / dist,
			delta[2] / dist
		];
		return this.trace(from, dir, dist - this.cell * .25) !== null;
	}
	toVisibilityHit(hit, probeIndex, rayIndex) {
		return {
			position: hit.position,
			normal: hit.normal,
			albedo: hit.albedo,
			distance: hit.distance,
			probeIndex,
			rayIndex
		};
	}
};
function voxelizeBoxWalls(grid, innerMin, innerMax, thickness, walls) {
	const t = thickness;
	if (walls.nx) grid.fillBox([
		innerMin[0] - t,
		innerMin[1] - t,
		innerMin[2] - t
	], [
		innerMin[0],
		innerMax[1] + t,
		innerMax[2] + t
	], walls.nx, [
		1,
		0,
		0
	]);
	if (walls.px) grid.fillBox([
		innerMax[0],
		innerMin[1] - t,
		innerMin[2] - t
	], [
		innerMax[0] + t,
		innerMax[1] + t,
		innerMax[2] + t
	], walls.px, [
		-1,
		0,
		0
	]);
	if (walls.ny) grid.fillBox([
		innerMin[0] - t,
		innerMin[1] - t,
		innerMin[2] - t
	], [
		innerMax[0] + t,
		innerMin[1],
		innerMax[2] + t
	], walls.ny, [
		0,
		1,
		0
	]);
	if (walls.py) grid.fillBox([
		innerMin[0] - t,
		innerMax[1],
		innerMin[2] - t
	], [
		innerMax[0] + t,
		innerMax[1] + t,
		innerMax[2] + t
	], walls.py, [
		0,
		-1,
		0
	]);
	if (walls.nz) grid.fillBox([
		innerMin[0] - t,
		innerMin[1] - t,
		innerMin[2] - t
	], [
		innerMax[0] + t,
		innerMax[1] + t,
		innerMin[2]
	], walls.nz, [
		0,
		0,
		1
	]);
	if (walls.pz) grid.fillBox([
		innerMin[0] - t,
		innerMin[1] - t,
		innerMax[2]
	], [
		innerMax[0] + t,
		innerMax[1] + t,
		innerMax[2] + t
	], walls.pz, [
		0,
		0,
		-1
	]);
}
//#endregion
//#region packages/idtech-gi/src/scenes.ts
var SIMPLE_CASCADE = {
	resolution: 8,
	cascadeCount: 3,
	firstSize: 8,
	raysPerProbe: 32,
	cascadesPerFrame: 1
};
var HARD_CASCADE = {
	resolution: 8,
	cascadeCount: 3,
	firstSize: 16,
	raysPerProbe: 24,
	cascadesPerFrame: 1
};
function build(name, voxel, boxes, lights, camera, unlitRegion, extra) {
	return {
		name,
		voxel,
		pipeline: new SousaPipeline(voxel, {
			cascade: extra?.cascade ?? SIMPLE_CASCADE,
			lights,
			sky: extra?.sky ?? [
				0,
				0,
				0
			],
			volumeBlend: .25,
			maxRayDistance: voxel.size * 1.4,
			...extra
		}),
		camera,
		boxes,
		lights,
		unlitRegion
	};
}
/** Closed colored room. Spotlight on the red wall; the green wall is unlit. */
function createSimpleRoom() {
	const voxel = new VoxelGrid(64, [
		-3.5,
		-3.5,
		-3.5
	], 7);
	const boxes = [];
	const push = (min, max, color) => {
		boxes.push({
			min,
			max,
			color
		});
		voxel.fillBox(min, max, color);
	};
	voxelizeBoxWalls(voxel, [
		-2,
		-2,
		-2
	], [
		2,
		2,
		2
	], .18, {
		nx: [
			.82,
			.04,
			.04
		],
		px: [
			.04,
			.72,
			.06
		],
		ny: [
			.82,
			.8,
			.76
		],
		py: [
			.78,
			.78,
			.8
		],
		nz: [
			.8,
			.8,
			.78
		],
		pz: [
			.8,
			.8,
			.78
		]
	});
	boxes.push({
		min: [
			-2.18,
			-2.18,
			-2.18
		],
		max: [
			-2,
			2.18,
			2.18
		],
		color: [
			.82,
			.04,
			.04
		]
	});
	boxes.push({
		min: [
			2,
			-2.18,
			-2.18
		],
		max: [
			2.18,
			2.18,
			2.18
		],
		color: [
			.04,
			.72,
			.06
		]
	});
	boxes.push({
		min: [
			-2.18,
			-2.18,
			-2.18
		],
		max: [
			2.18,
			-2,
			2.18
		],
		color: [
			.82,
			.8,
			.76
		]
	});
	boxes.push({
		min: [
			-2.18,
			2,
			-2.18
		],
		max: [
			2.18,
			2.18,
			2.18
		],
		color: [
			.78,
			.78,
			.8
		]
	});
	boxes.push({
		min: [
			-2.18,
			-2.18,
			-2.18
		],
		max: [
			2.18,
			2.18,
			-2
		],
		color: [
			.8,
			.8,
			.78
		]
	});
	boxes.push({
		min: [
			-2.18,
			-2.18,
			2
		],
		max: [
			2.18,
			2.18,
			2.18
		],
		color: [
			.8,
			.8,
			.78
		]
	});
	push([
		-.5,
		-2,
		-.5
	], [
		.5,
		-.6,
		.5
	], [
		.9,
		.88,
		.8
	]);
	return build("simple-room", voxel, boxes, [{
		position: [
			-1.45,
			.55,
			.1
		],
		color: [
			1,
			.95,
			.85
		],
		intensity: 28,
		direction: [
			-1,
			-.15,
			0
		],
		coneCos: .45
	}], {
		position: [
			.15,
			.05,
			1.45
		],
		target: [
			0,
			-.35,
			-.4
		],
		fovY: 62
	}, [
		88,
		16,
		122,
		64
	], {
		cascade: SIMPLE_CASCADE,
		sky: [
			.004,
			.005,
			.008
		]
	});
}
/**
* Sponza-like atrium: columns, upper galleries, colored banners, sun through
* a roof opening. The floor under the west gallery is in direct shadow.
*/
function createSponzaAtrium() {
	const voxel = new VoxelGrid(96, [
		-10,
		-1.5,
		-16
	], 32);
	const boxes = [];
	const push = (min, max, color) => {
		boxes.push({
			min,
			max,
			color
		});
		voxel.fillBox(min, max, color);
	};
	push([
		-8,
		-.2,
		-12
	], [
		8,
		0,
		12
	], [
		.55,
		.5,
		.42
	]);
	push([
		-8.2,
		0,
		-12
	], [
		-8,
		8,
		12
	], [
		.72,
		.62,
		.5
	]);
	push([
		8,
		0,
		-12
	], [
		8.2,
		8,
		12
	], [
		.72,
		.62,
		.5
	]);
	push([
		-8,
		0,
		-12.2
	], [
		8,
		8,
		-12
	], [
		.68,
		.58,
		.46
	]);
	push([
		-8,
		0,
		12
	], [
		8,
		8,
		12.2
	], [
		.68,
		.58,
		.46
	]);
	push([
		-8.2,
		7.8,
		-12.2
	], [
		-1.4,
		8.2,
		12.2
	], [
		.5,
		.48,
		.45
	]);
	push([
		1.4,
		7.8,
		-12.2
	], [
		8.2,
		8.2,
		12.2
	], [
		.5,
		.48,
		.45
	]);
	push([
		-8,
		4.2,
		-12
	], [
		-5.4,
		4.5,
		12
	], [
		.6,
		.55,
		.45
	]);
	push([
		5.4,
		4.2,
		-12
	], [
		8,
		4.5,
		12
	], [
		.6,
		.55,
		.45
	]);
	for (const z of [
		-8,
		-4,
		0,
		4,
		8
	]) {
		push([
			-6.2,
			0,
			z - .35
		], [
			-5.5,
			7.8,
			z + .35
		], [
			.78,
			.72,
			.62
		]);
		push([
			5.5,
			0,
			z - .35
		], [
			6.2,
			7.8,
			z + .35
		], [
			.78,
			.72,
			.62
		]);
	}
	push([
		-5.35,
		2.2,
		-6
	], [
		-5.15,
		5.6,
		-3.4
	], [
		.85,
		.05,
		.05
	]);
	push([
		-5.35,
		2.2,
		3.2
	], [
		-5.15,
		5.6,
		5.8
	], [
		.05,
		.55,
		.15
	]);
	push([
		5.15,
		2.2,
		-2
	], [
		5.35,
		5.6,
		.8
	], [
		.1,
		.2,
		.75
	]);
	return build("sponza-atrium", voxel, boxes, [{
		position: [
			0,
			10.5,
			0
		],
		color: [
			1,
			.96,
			.88
		],
		intensity: 220,
		direction: [
			.15,
			-1,
			.05
		],
		coneCos: .55
	}], {
		position: [
			.2,
			2.4,
			10.8
		],
		target: [
			0,
			2.2,
			0
		],
		fovY: 58
	}, [
		8,
		48,
		28,
		72
	], {
		cascade: HARD_CASCADE,
		sky: [
			.08,
			.12,
			.2
		]
	});
}
/** Bounded forest stand: trunks + canopy, sun at an angle, floor in shadow. */
function createForestStand() {
	const voxel = new VoxelGrid(80, [
		-12,
		-1,
		-12
	], 24);
	const boxes = [];
	const push = (min, max, color) => {
		boxes.push({
			min,
			max,
			color
		});
		voxel.fillBox(min, max, color);
	};
	push([
		-10,
		-.2,
		-10
	], [
		10,
		0,
		10
	], [
		.22,
		.28,
		.12
	]);
	const trunk = [
		.32,
		.2,
		.1
	];
	const canopy = [
		.12,
		.42,
		.1
	];
	for (const [x, z] of [
		[-3, -2],
		[2.5, -3],
		[-1, 3],
		[4, 2],
		[-5, 4],
		[1, -5],
		[5.5, -1],
		[-4, -5]
	]) {
		push([
			x - .28,
			0,
			z - .28
		], [
			x + .28,
			4.2,
			z + .28
		], trunk);
		push([
			x - 1.6,
			3.6,
			z - 1.6
		], [
			x + 1.6,
			5.4,
			z + 1.6
		], canopy);
	}
	return build("forest-stand", voxel, boxes, [{
		position: [
			8,
			12,
			-6
		],
		color: [
			1,
			.92,
			.7
		],
		intensity: 260,
		direction: [
			-.45,
			-1,
			.35
		],
		coneCos: .4
	}], {
		position: [
			.4,
			1.4,
			9.5
		],
		target: [
			0,
			1.6,
			0
		],
		fovY: 55
	}, [
		48,
		50,
		80,
		74
	], {
		cascade: HARD_CASCADE,
		sky: [
			.35,
			.5,
			.75
		]
	});
}
//#endregion
//#region tools/gi/capture.ts
var SCRATCH = process.env.GI_CAPTURE_DIR ?? "/var/folders/rl/wx0372_n59d9k3spw65qmskw0000gp/T/grok-goal-e82dbea9898e/implementer";
function meanLuma(pixels) {
	let sum = 0;
	const count = pixels.length / 4;
	for (let i = 0; i < pixels.length; i += 4) sum += (pixels[i] ?? 0) + (pixels[i + 1] ?? 0) + (pixels[i + 2] ?? 0);
	return count === 0 ? 0 : sum / count / 3;
}
function regionLuma(pixels, width, height, region) {
	const scaleX = width / 128;
	const scaleY = height / 80;
	const x0 = Math.floor(region[0] * scaleX);
	const y0 = Math.floor(region[1] * scaleY);
	const x1 = Math.min(width - 1, Math.floor(region[2] * scaleX));
	const y1 = Math.min(height - 1, Math.floor(region[3] * scaleY));
	let r = 0;
	let g = 0;
	let b = 0;
	let n = 0;
	for (let y = y0; y <= y1; y += 1) for (let x = x0; x <= x1; x += 1) {
		const i = ((height - 1 - y) * width + x) * 4;
		r += pixels[i] ?? 0;
		g += pixels[i + 1] ?? 0;
		b += pixels[i + 2] ?? 0;
		n += 1;
	}
	const inv = n === 0 ? 0 : 1 / n;
	return {
		luma: (r + g + b) * inv / 3,
		r: r * inv,
		g: g * inv,
		b: b * inv
	};
}
function writePng(path, pixels, width, height) {
	writeFileSync(path, encodePng(flipVertically(pixels, width, height), width, height));
}
async function captureScene(label, giScene, width, height, outDir) {
	const headless = await createHeadlessRenderer(width, height);
	headless.renderer.toneMapping = ACESFilmicToneMapping;
	headless.renderer.toneMappingExposure = 1.05;
	const gi = new IdTechGI(giScene, {
		gpuCompute: true,
		gatherWidth: Math.max(32, Math.floor(width * .5)),
		gatherHeight: Math.max(32, Math.floor(height * .5))
	});
	gi.warm(9);
	const scene = new Scene();
	scene.background = new Color(329482);
	gi.populateThreeScene(scene);
	const camera = new PerspectiveCamera(giScene.camera.fovY, width / height, .05, 200);
	camera.position.set(giScene.camera.position[0], giScene.camera.position[1], giScene.camera.position[2]);
	camera.lookAt(giScene.camera.target[0], giScene.camera.target[1], giScene.camera.target[2]);
	const renderOnce = async () => {
		headless.renderer.render(scene, camera);
	};
	gi.setEnabled(true);
	gi.upload(giScene.camera.position);
	for (let i = 0; i < 4; i += 1) {
		gi.tick(headless.renderer, camera, width, height);
		headless.renderer.render(scene, camera);
	}
	gi.setEnabled(false);
	const off = await headless.capture(renderOnce);
	gi.setEnabled(true);
	const on = await headless.capture(renderOnce);
	const timings = [];
	const started = performance.now();
	const frames = 12;
	const elapsed = await headless.timeFrames(async () => {
		gi.tick(headless.renderer, camera, width, height);
		headless.renderer.render(scene, camera);
	}, frames);
	const per = elapsed / frames;
	timings.push(per);
	const stats = [
		`scene ${label}`,
		`webgpu frames ${frames} totalMs ${elapsed.toFixed(2)} perFrameMs ${per.toFixed(2)}`,
		`pipeline frame ${gi.pipeline.frame} lastCascade ${gi.pipeline.lastStats.cascade} probes ${gi.pipeline.lastStats.probesUpdated} rays ${gi.pipeline.lastStats.raysTraced} cacheInserts ${gi.pipeline.lastStats.cacheInserts} cacheReuses ${gi.pipeline.lastStats.cacheReuses}`,
		`meanLuma off ${meanLuma(off).toFixed(2)} on ${meanLuma(on).toFixed(2)}`,
		`unlitRegion off ${JSON.stringify(regionLuma(off, width, height, giScene.unlitRegion))} on ${JSON.stringify(regionLuma(on, width, height, giScene.unlitRegion))}`,
		`budgeted interleaved cascade updates, not path-tracer accumulation`,
		`startedAt ${started}`
	].join("\n");
	writePng(resolve(outDir, `gi-${label}-off.png`), off, width, height);
	writePng(resolve(outDir, `gi-${label}-on.png`), on, width, height);
	const cpuOff = renderCpuFrame(gi.pipeline, giScene.voxel, giScene.camera, 160, 100, false);
	const cpuOn = renderCpuFrame(gi.pipeline, giScene.voxel, giScene.camera, 160, 100, true);
	writeFileSync(resolve(outDir, `gi-${label}-cpu-off.png`), encodePng(cpuOff.rgba, 160, 100));
	writeFileSync(resolve(outDir, `gi-${label}-cpu-on.png`), encodePng(cpuOn.rgba, 160, 100));
	headless.dispose();
	gi.dispose();
	return {
		on,
		off,
		timings,
		stats
	};
}
async function main() {
	mkdirSync(SCRATCH, { recursive: true });
	const width = alignCaptureWidth(640);
	const height = 400;
	try {
		const simple = await captureScene("simple", createSimpleRoom(), width, height, SCRATCH);
		writeFileSync(resolve(SCRATCH, "gi-simple.log"), simple.stats + "\n");
		const simple2 = await captureScene("simple", createSimpleRoom(), width, height, SCRATCH);
		writeFileSync(resolve(SCRATCH, "gi-simple.log"), simple.stats + "\n--- second launch ---\n" + simple2.stats + "\n");
		const hard = await captureScene("hard", createSponzaAtrium(), width, height, SCRATCH);
		const hard2 = await captureScene("hard", createSponzaAtrium(), width, height, SCRATCH);
		writeFileSync(resolve(SCRATCH, "gi-hard.log"), hard.stats + "\n--- second launch ---\n" + hard2.stats + "\n");
		writeFileSync(resolve(SCRATCH, "gi-hard-on.png"), encodePng(flipVertically(hard.on, width, height), width, height));
		const forest = await captureScene("forest", createForestStand(), width, height, SCRATCH);
		writeFileSync(resolve(SCRATCH, "gi-forest.log"), forest.stats + "\n");
		writeFileSync(resolve(SCRATCH, "gi-timing.log"), [
			simple.stats,
			hard.stats,
			forest.stats,
			"path is per-frame interleaved (1 cascade / frame) with cache reuse and half-res gather, not accumulating samples toward a still."
		].join("\n\n") + "\n");
	} catch (error) {
		const message = error instanceof Error ? `${error.message}\n${error.stack}` : String(error);
		writeFileSync(resolve(SCRATCH, "gi-launch-unavailable.log"), message + "\n");
		console.error(message);
		process.exitCode = 1;
	}
}
await main();
//#endregion
export {};
