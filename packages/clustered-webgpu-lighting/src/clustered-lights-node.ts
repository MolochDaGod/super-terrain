import {
	ComputeNode,
	DataTexture,
	FloatType,
	Light,
	LightingNode,
	LightsNode,
	NodeBuilder,
	NodeFrame,
	NodeUpdateType,
	PerspectiveCamera,
	PointLight,
	RGBAFormat,
	SpotLight,
	Vector2,
} from 'three/webgpu';
import type { Renderer } from 'three/webgpu';

import {
	attributeArray, nodeProxy, int, float, vec3, ivec2, uniform, Break, Loop, positionView,
	Fn, If, textureLoad, instanceIndex, screenCoordinate, directPointLight,
	renderGroup,
	min, max, pow, log, clamp, dot, smoothstep, select
} from 'three/tsl';

// A spotlight is treated as a point light plus a cone mask. `coneCos` below this
// sentinel can never be produced by a real cone (cos ∈ [-1, 1]); point lights store
// it so the shared shading path multiplies their contribution by an attenuation of 1.
const POINT_LIGHT_CONE_SENTINEL = - 2;

// Rows of the per-light data texture (see create()): position/range, color/decay,
// spot direction/coneCos, penumbraCos.
const LIGHT_TEXTURE_ROWS = 4;

const _size = /*@__PURE__*/ new Vector2();

/**
 * A custom version of `LightsNode` implementing Forward+ clustered shading:
 * the view frustum is subdivided into a 3D grid of clusters (X × Y screen tiles
 * times an exponentially-spaced set of Z depth slices), and each cluster holds
 * only the point lights whose spheres intersect it. At shading time each fragment
 * looks up its cluster and loops over just that cluster's lights. Unlike 2D tiled
 * lighting, clustered shading culls lights that share screen pixels but lie at
 * different depths — suitable for 3D scenes with real depth complexity.
 *
 * @augments LightsNode
 * @three_import import { clusteredLights } from 'three/addons/tsl/lighting/ClusteredLightsNode.js';
 */
class ClusteredLightsNode extends LightsNode {

	static get type() {

		return 'ClusteredLightsNode';

	}

	materialLights: Light[];
	// Both point and spot lights are clustered through the same machinery; the cone
	// data distinguishes them in the shader (point lights carry the sentinel cone).
	clusteredLights: ( PointLight | SpotLight )[];
	maxLights: number;
	tileSize: number;
	zSlices: number;
	maxLightsPerCluster: number;

	_chunksPerCluster: number;
	_bufferSize: Vector2 | null;
	_lightIndexes: any;
	_screenClusterIndex: any;
	_compute: ComputeNode | null;
	_lightsTexture: DataTexture | null;
	_zSliceRangesTexture: DataTexture | null;
	_zSliceRangesData: Float32Array | null;
	_lightViewX: Float32Array;
	_lightViewY: Float32Array;
	_lightViewZ: Float32Array;
	_lightDistance: Float32Array;
	_lightColorR: Float32Array;
	_lightColorG: Float32Array;
	_lightColorB: Float32Array;
	_lightDecay: Float32Array;
	_lightConeCos: Float32Array;
	_lightPenumbraCos: Float32Array;
	_lightSpotDirectionX: Float32Array;
	_lightSpotDirectionY: Float32Array;
	_lightSpotDirectionZ: Float32Array;
	_lightSortOrder: number[];
	_lastLightSortCount: number;
	_zRangeStart: Int32Array;
	_zRangeEnd: Int32Array;
	_clusterDataDirty: boolean;
	_cameraNear: any;
	_cameraFar: any;
	_invFocal: any;
	_gridDimensions: any;
	_lastCameraNear: number;
	_lastCameraFar: number;
	_lastProjection00: number;
	_lastProjection11: number;

	/**
	 * Constructs a new clustered lights node.
	 *
	 * @param {number} [maxLights=1024] - Maximum number of point lights.
	 * @param {number} [tileSize=32] - Screen tile size in pixels (cluster XY size).
	 * @param {number} [zSlices=24] - Number of exponential depth slices.
	 * @param {number} [maxLightsPerCluster=64] - Per-cluster light-list capacity.
	 */
	constructor( maxLights = 1024, tileSize = 32, zSlices = 24, maxLightsPerCluster = 64 ) {

		super();

		this.materialLights = [];
		this.clusteredLights = [];

		this.maxLights = maxLights;
		this.tileSize = tileSize;
		this.zSlices = zSlices;
		this.maxLightsPerCluster = maxLightsPerCluster;

		this._chunksPerCluster = Math.ceil( maxLightsPerCluster / 4 );

		this._bufferSize = null;
		this._lightIndexes = null;
		this._screenClusterIndex = null;
		this._compute = null;
		this._lightsTexture = null;
		this._zSliceRangesTexture = null;
		this._zSliceRangesData = null;
		this._lightViewX = new Float32Array( maxLights );
		this._lightViewY = new Float32Array( maxLights );
		this._lightViewZ = new Float32Array( maxLights );
		this._lightDistance = new Float32Array( maxLights );
		this._lightColorR = new Float32Array( maxLights );
		this._lightColorG = new Float32Array( maxLights );
		this._lightColorB = new Float32Array( maxLights );
		this._lightDecay = new Float32Array( maxLights );
		this._lightConeCos = new Float32Array( maxLights );
		this._lightPenumbraCos = new Float32Array( maxLights );
		this._lightSpotDirectionX = new Float32Array( maxLights );
		this._lightSpotDirectionY = new Float32Array( maxLights );
		this._lightSpotDirectionZ = new Float32Array( maxLights );
		this._lightSortOrder = [];
		this._lastLightSortCount = - 1;
		this._zRangeStart = new Int32Array( zSlices );
		this._zRangeEnd = new Int32Array( zSlices );
		this._clusterDataDirty = true;

		// Render-group uniforms: shared between compute and fragment passes,
		// updated manually each frame in updateBefore (compute lacks a camera context).
		this._cameraNear = uniform( 0 ).setName( 'clusteredCameraNear' ).setGroup( renderGroup );
		this._cameraFar = uniform( 0 ).setName( 'clusteredCameraFar' ).setGroup( renderGroup );
		// Reciprocal focal lengths (1/projMatrix[0][0], 1/projMatrix[1][1]) derived on
		// the CPU each frame; replaces uploading the full projection matrix and the
		// per-thread reciprocal that the compute pass previously did.
		this._invFocal = uniform( new Vector2() ).setName( 'clusteredInvFocal' ).setGroup( renderGroup );

		this._gridDimensions = uniform( new Vector2() );
		this._lastCameraNear = NaN;
		this._lastCameraFar = NaN;
		this._lastProjection00 = NaN;
		this._lastProjection11 = NaN;

		this.updateBeforeType = NodeUpdateType.RENDER;

	}

	customCacheKey() {

		return ( this._compute ? this._compute.getCacheKey() : 0 ) + super.customCacheKey();

	}

	updateLightsTexture( camera: PerspectiveCamera ): boolean {

		const lightsTexture = this._lightsTexture!;
		const { clusteredLights } = this;

		const data = lightsTexture.image.data as Float32Array;
		const lineSize = lightsTexture.image.width * 4;
		const count = clusteredLights.length;
		let lightsChanged = false;

		// Sort lights by view-space depth for Z-culling

		const viewZ = this._lightViewZ;
		const viewX = this._lightViewX;
		const viewY = this._lightViewY;
		const distanceData = this._lightDistance;
		const colorRData = this._lightColorR;
		const colorGData = this._lightColorG;
		const colorBData = this._lightColorB;
		const decayData = this._lightDecay;
		const coneCosData = this._lightConeCos;
		const penumbraCosData = this._lightPenumbraCos;
		const spotDirectionX = this._lightSpotDirectionX;
		const spotDirectionY = this._lightSpotDirectionY;
		const spotDirectionZ = this._lightSpotDirectionZ;
		const order = this._lightSortOrder;
		const sortCountChanged = this._lastLightSortCount !== count;
		const cameraView = camera.matrixWorldInverse.elements;
		const c0 = cameraView[ 0 ], c1 = cameraView[ 1 ], c2 = cameraView[ 2 ];
		const c4 = cameraView[ 4 ], c5 = cameraView[ 5 ], c6 = cameraView[ 6 ];
		const c8 = cameraView[ 8 ], c9 = cameraView[ 9 ], c10 = cameraView[ 10 ];
		const c12 = cameraView[ 12 ], c13 = cameraView[ 13 ], c14 = cameraView[ 14 ];

		if ( sortCountChanged ) {

			order.length = count;
			for ( let i = 0; i < count; i ++ ) order[ i ] = i;
			this._lastLightSortCount = count;

		}

		for ( let i = 0; i < count; i ++ ) {

			const light = clusteredLights[ i ];
			const lightMatrix = light.matrixWorld.elements;
			const x = lightMatrix[ 12 ];
			const y = lightMatrix[ 13 ];
			const z = lightMatrix[ 14 ];

			viewX[ i ] = c0 * x + c4 * y + c8 * z + c12;
			viewY[ i ] = c1 * x + c5 * y + c9 * z + c13;
			viewZ[ i ] = c2 * x + c6 * y + c10 * z + c14;
			distanceData[ i ] = light.distance;
			colorRData[ i ] = light.color.r * light.intensity;
			colorGData[ i ] = light.color.g * light.intensity;
			colorBData[ i ] = light.color.b * light.intensity;
			decayData[ i ] = light.decay;

			if ( ( light as SpotLight ).isSpotLight === true ) {

				const spot = light as SpotLight;
				const targetMatrix = spot.target.matrixWorld.elements;
				const dx = x - targetMatrix[ 12 ];
				const dy = y - targetMatrix[ 13 ];
				const dz = z - targetMatrix[ 14 ];
				const sx = c0 * dx + c4 * dy + c8 * dz;
				const sy = c1 * dx + c5 * dy + c9 * dz;
				const sz = c2 * dx + c6 * dy + c10 * dz;
				const directionLength = Math.hypot( sx, sy, sz ) || 1;

				spotDirectionX[ i ] = sx / directionLength;
				spotDirectionY[ i ] = sy / directionLength;
				spotDirectionZ[ i ] = sz / directionLength;
				coneCosData[ i ] = Math.cos( spot.angle );
				penumbraCosData[ i ] = Math.cos( spot.angle * ( 1 - spot.penumbra ) );

			} else {

				coneCosData[ i ] = POINT_LIGHT_CONE_SENTINEL;
				penumbraCosData[ i ] = - 1;

			}

		}

		sortLightOrderByDepth( order, count, viewZ );

		// Write sorted lights to texture

		for ( let i = 0; i < count; i ++ ) {

			const sourceIndex = order[ i ];
			const viewDepth = viewZ[ sourceIndex ];
			const distance = distanceData[ sourceIndex ];
			const colorR = colorRData[ sourceIndex ];
			const colorG = colorGData[ sourceIndex ];
			const colorB = colorBData[ sourceIndex ];
			const decay = decayData[ sourceIndex ];

			const offset = i * 4;
			const row2 = lineSize * 2 + offset;
			const row3 = lineSize * 3 + offset;

			lightsChanged = setFloatIfChanged( data, offset + 0, viewX[ sourceIndex ] ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, offset + 1, viewY[ sourceIndex ] ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, offset + 2, viewDepth ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, offset + 3, distance ) || lightsChanged;

			lightsChanged = setFloatIfChanged( data, lineSize + offset + 0, colorR ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, lineSize + offset + 1, colorG ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, lineSize + offset + 2, colorB ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, lineSize + offset + 3, decay ) || lightsChanged;

			lightsChanged = setFloatIfChanged( data, row2 + 0, spotDirectionX[ sourceIndex ] ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, row2 + 1, spotDirectionY[ sourceIndex ] ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, row2 + 2, spotDirectionZ[ sourceIndex ] ) || lightsChanged;
			lightsChanged = setFloatIfChanged( data, row2 + 3, coneCosData[ sourceIndex ] ) || lightsChanged;

			lightsChanged = setFloatIfChanged( data, row3 + 0, penumbraCosData[ sourceIndex ] ) || lightsChanged;

		}

		if ( lightsChanged ) lightsTexture.needsUpdate = true;

		// Compute per Z-slice light ranges

		const zRanges = this._zSliceRangesData;

		if ( zRanges === null ) return lightsChanged;

		const near = camera.near;
		const far = camera.far;
		const NZ = this.zSlices;
		let zRangesChanged = false;

		const starts = this._zRangeStart;
		const ends = this._zRangeEnd;

		computeZSliceRanges( count, NZ, near, far, viewZ, order, distanceData, starts, ends );

		for ( let z = 0; z < NZ; z ++ ) {

			const offset = z * 4;
			zRangesChanged = setFloatIfChanged( zRanges, offset, starts[ z ] ) || zRangesChanged;
			zRangesChanged = setFloatIfChanged( zRanges, offset + 1, ends[ z ] ) || zRangesChanged;

		}

		if ( zRangesChanged ) this._zSliceRangesTexture!.needsUpdate = true;

		return lightsChanged || zRangesChanged;

	}

	updateBefore( frame: NodeFrame ): boolean | undefined {

		const renderer = frame.renderer as Renderer;
		const camera = frame.camera as PerspectiveCamera;

		this.updateProgram( renderer );

		const clusterDataChanged = this.updateLightsTexture( camera );
		const projectionChanged = this.updateCameraProjectionState( camera );

		this._cameraNear.value = camera.near;
		this._cameraFar.value = camera.far;

		if ( this._clusterDataDirty || clusterDataChanged || projectionChanged ) {

			renderer.compute( this._compute! );
			this._clusterDataDirty = false;

		}

		return;

	}

	updateCameraProjectionState( camera: PerspectiveCamera ): boolean {

		const projection = camera.projectionMatrix.elements;
		const near = camera.near;
		const far = camera.far;
		const projection00 = projection[ 0 ];
		const projection11 = projection[ 5 ];
		const changed = near !== this._lastCameraNear
			|| far !== this._lastCameraFar
			|| projection00 !== this._lastProjection00
			|| projection11 !== this._lastProjection11;

		if ( changed ) {

			this._lastCameraNear = near;
			this._lastCameraFar = far;
			this._lastProjection00 = projection00;
			this._lastProjection11 = projection11;

			// Reciprocal focal lengths only change with the projection; recompute here.
			this._invFocal.value.set( 1 / projection00, 1 / projection11 );

		}

		return changed;

	}

	setLights( lights: Light[] ): this {

		const { clusteredLights, materialLights } = this;

		let materialIndex = 0;
		let clusteredIndex = 0;

		for ( const light of lights ) {

			if ( ( light as PointLight ).isPointLight === true ) {

				const pointLight = light as PointLight;
				if ( shouldClusterPointLight( pointLight ) && clusteredIndex < this.maxLights ) {

					clusteredLights[ clusteredIndex ++ ] = pointLight;

				}

			} else if ( ( light as SpotLight ).isSpotLight === true ) {

				const spotLight = light as SpotLight;
				if ( shouldClusterSpotLight( spotLight ) && clusteredIndex < this.maxLights ) {

					clusteredLights[ clusteredIndex ++ ] = spotLight;

				}

			} else {

				materialLights[ materialIndex ++ ] = light;

			}

		}

		materialLights.length = materialIndex;
		clusteredLights.length = clusteredIndex;

		return super.setLights( materialLights );

	}

	getBlock() {

		return this._lightIndexes.element( this._screenClusterIndex.mul( int( this._chunksPerCluster ) ) );

	}

	getTile( element: any ) {

		element = int( element );

		const stride = int( 4 );
		const chunkOffset = element.div( stride );
		const idx = this._screenClusterIndex.mul( int( this._chunksPerCluster ) ).add( chunkOffset );

		return this._lightIndexes.element( idx ).element( element.mod( stride ) );

	}

	getChunkBase() {

		return this._screenClusterIndex.mul( int( this._chunksPerCluster ) );

	}

	getClusterLightCount( zSliceNode: any ) {

		const getCount = Fn( ( [ zSliceNode ]: any[] ) => {

			const count = int( 0 ).toVar();

			const debugClusterIndex = this._screenClusterIndex.toVar();

			If( zSliceNode.greaterThanEqual( int( 0 ) ), () => {

				const tileSize = int( this.tileSize );
				const screenTile = screenCoordinate.div( tileSize ).floor();
				const NX = int( this._gridDimensions.x );
				const NY = int( this._gridDimensions.y );

				debugClusterIndex.assign(
					int( screenTile.x )
						.add( int( screenTile.y ).mul( NX ) )
						.add( zSliceNode.mul( NX.mul( NY ) ) )
				);

			} );

			Loop( this.maxLightsPerCluster, ( { i } ) => {

				const element = int( i );
				const stride = int( 4 );
				const chunkOffset = element.div( stride );
				const idx = debugClusterIndex.mul( int( this._chunksPerCluster ) ).add( chunkOffset );
				const lightIndex = this._lightIndexes.element( idx ).element( element.mod( stride ) );

				If( lightIndex.equal( int( 0 ) ), () => {

					Break();

				} );

				count.addAssign( int( 1 ) );

			} );

			return count;

		} );

		return getCount( zSliceNode );

	}

	getLightData( index: any ) {

		index = int( index );

		const dataA = textureLoad( this._lightsTexture!, ivec2( index, 0 ) );
		const dataB = textureLoad( this._lightsTexture!, ivec2( index, 1 ) );

		const viewPosition = dataA.xyz;
		const distance = dataA.w;
		const color = dataB.rgb;
		const decay = dataB.w;

		return {
			viewPosition,
			distance,
			color,
			decay
		};

	}

	getLightConeData( index: any ) {

		index = int( index );

		const dataC = textureLoad( this._lightsTexture!, ivec2( index, 2 ) );
		const dataD = textureLoad( this._lightsTexture!, ivec2( index, 3 ) );

		return {
			spotDirection: dataC.xyz,
			coneCos: dataC.w,
			penumbraCos: dataD.x
		};

	}

	getLightBoundsData( index: any ) {

		index = int( index );

		const dataA = textureLoad( this._lightsTexture!, ivec2( index, 0 ) );

		return {
			viewPosition: dataA.xyz,
			distance: dataA.w
		};

	}

	setupLights( builder: NodeBuilder, lightNodes: LightingNode[] ) {

		this.updateProgram( builder.renderer );

		//

		const lightingModel = ( builder as any ).context.reflectedLight;

		lightingModel.directDiffuse.toStack();
		lightingModel.directSpecular.toStack();

		super.setupLights( builder, lightNodes );

		// Shade one light by its 1-based packed index (0 = empty sentinel → caller breaks).
		// Point and spot lights share this path: the spot cone is folded into the light
		// color as a scalar mask, so the BRDF (directPointLight) stays identical for both.
		const shadeLight = ( lightIndex: any ) => {

			const dataIndex = lightIndex.sub( 1 ).toVar();
			const { color, decay, viewPosition, distance } = this.getLightData( dataIndex );

			const lightVector = viewPosition.sub( positionView ).toVar();

			// Early-out: skip full BRDF if fragment is beyond the light's cutoff.
			// Clustered point/spot lights are finite-distance only.
			If( dot( lightVector, lightVector ).lessThanEqual( distance.mul( distance ) ), () => {

				// Spot cone mask. Point lights carry coneCos < -1 (sentinel), for which
				// the mask is forced to 1 — leaving their color unchanged.
				const { spotDirection, coneCos, penumbraCos } = this.getLightConeData( dataIndex );
				const angleCos = dot( lightVector.normalize(), spotDirection );
				const spotMask = select(
					coneCos.lessThan( float( - 1 ) ),
					float( 1 ),
					smoothstep( coneCos, penumbraCos, angleCos )
				);

				builder.lightsNode.setupDirectLight( builder, this, ( directPointLight as any )( {
					color: color.mul( spotMask ),
					lightVector,
					cutoffDistance: distance,
					decayExponent: decay
				} ) );

			} );

		};

		Fn( () => {

			// Iterate the cluster's light list one ivec4 chunk at a time: a single
			// buffer fetch yields four packed light indices, cutting buffer reads
			// 4× versus a per-scalar fetch and dropping the per-iteration div/mod.
			// The list is densely packed, so the first zero lane terminates it.
			const chunkBase = this.getChunkBase().toVar();
			const indexes = this._lightIndexes;

			Loop( this._chunksPerCluster, ( { i } ) => {

				const chunk = indexes.element( chunkBase.add( int( i ) ) ).toVar();

				const lanes = [ chunk.x, chunk.y, chunk.z, chunk.w ];

				for ( const lane of lanes ) {

					If( lane.equal( int( 0 ) ), () => {

						Break();

					} );

					shadeLight( lane );

				}

			} );

		}, 'void' )();

	}

	getBufferFitSize( value: number ) {

		const multiple = this.tileSize;

		return Math.ceil( value / multiple ) * multiple;

	}

	setSize( width: number, height: number ) {

		width = this.getBufferFitSize( width );
		height = this.getBufferFitSize( height );

		if ( ! this._bufferSize || this._bufferSize.width !== width || this._bufferSize.height !== height ) {

			this.create( width, height );

		}

		return this;

	}

	updateProgram( renderer: Renderer ) {

		renderer.getDrawingBufferSize( _size );

		const width = this.getBufferFitSize( _size.width );
		const height = this.getBufferFitSize( _size.height );

		if ( this._bufferSize === null ) {

			this.create( width, height );

		} else if ( this._bufferSize.width !== width || this._bufferSize.height !== height ) {

			this.create( width, height );

		}

	}

	create( width: number, height: number ) {

		const { tileSize, maxLights, zSlices, maxLightsPerCluster, _chunksPerCluster: chunksPerCluster } = this;

		const bufferSize = new Vector2( width, height );

		const NX = Math.floor( bufferSize.width / tileSize );
		const NY = Math.floor( bufferSize.height / tileSize );
		const NZ = zSlices;
		const clusterCount = NX * NY * NZ;

		this._gridDimensions.value.set( NX, NY );

		// Lights data texture. One column per light, four RGBA rows:
		//   row 0: view position.xyz, range (distance)   — shared cull + shading
		//   row 1: color.rgb (× intensity), decay        — shading
		//   row 2: spot direction.xyz (view space), cos(angle)
		//   row 3: cos(angle·(1−penumbra)), unused, unused, unused
		// Point lights store the sentinel cone in rows 2/3 so the unified shading
		// path applies a cone attenuation of exactly 1 to them.

		const lightsData = new Float32Array( maxLights * 4 * LIGHT_TEXTURE_ROWS );
		const lightsTexture = new DataTexture( lightsData, maxLights, LIGHT_TEXTURE_ROWS, RGBAFormat, FloatType );

		// Per Z-slice light range for Z-culling (CPU-sorted, uploaded each frame)

		const zSliceRangesData = new Float32Array( NZ * 4 );
		const zSliceRangesTexture = new DataTexture( zSliceRangesData, NZ, 1, RGBAFormat, FloatType );

		// Per-cluster light-index storage (ivec4 chunks)

		const lightIndexesArray = new Int32Array( clusterCount * chunksPerCluster * 4 );
		const lightIndexes = attributeArray( lightIndexesArray, 'ivec4' ).setName( 'lightIndexes' );

		// `clusterChunkBase` is the cluster's first ivec4 chunk; loop-invariant per
		// thread, so the caller hoists it once instead of recomputing the multiply.
		const getClusterSlot = ( slotIdx: any, clusterChunkBase: any ) => {

			const s = int( slotIdx );

			const stride = int( 4 );
			const chunkOffset = s.div( stride );
			const idx = clusterChunkBase.add( chunkOffset );

			return lightIndexes.element( idx ).element( s.mod( stride ) );

		};

		// compute: one thread per cluster

		const compute = Fn( () => {

			// view-space scale factors derived from the projection matrix:
			//   view_x = ndc_x * (-view_z) / focal_x = ndc_x * (-view_z) * invFocalX
			//   view_y = ndc_y * (-view_z) / focal_y = ndc_y * (-view_z) * invFocalY
			// where focal_x = projMatrix[0][0] and focal_y = projMatrix[1][1].
			// The reciprocals are identical across every cluster thread, so they are
			// computed once on the CPU and uploaded as a uniform rather than per-thread.
			const invFocalX = this._invFocal.x;
			const invFocalY = this._invFocal.y;

			// 3D cluster coordinates from instanceIndex
			const cx = instanceIndex.mod( NX );
			const cy = instanceIndex.div( NX ).mod( NY );
			const cz = instanceIndex.div( NX * NY );

			// Cluster's first ivec4 chunk in the light-index buffer (loop-invariant).
			const clusterChunkBase = instanceIndex.mul( int( chunksPerCluster ) ).toVar();

			// NDC X/Y bounds of the cluster.
			// Y is flipped: cy=0 is the top screen row (fragment y=0), which is NDC y=+1.
			const ndcXmin = float( cx ).mul( 2.0 / NX ).sub( 1.0 );
			const ndcXmax = float( cx.add( int( 1 ) ) ).mul( 2.0 / NX ).sub( 1.0 );
			const ndcYmax = float( 1 ).sub( float( cy ).mul( 2.0 / NY ) );
			const ndcYmin = float( 1 ).sub( float( cy.add( int( 1 ) ) ).mul( 2.0 / NY ) );

			// View-space Z bounds (negative, exponential slicing)
			const farOverNear = this._cameraFar.div( this._cameraNear );
			const zNearCluster = this._cameraNear.mul( pow( farOverNear, float( cz ).mul( 1.0 / NZ ) ) ).negate();
			const zFarCluster = this._cameraNear.mul( pow( farOverNear, float( cz.add( int( 1 ) ) ).mul( 1.0 / NZ ) ) ).negate();

			const scaleNearX = zNearCluster.negate().mul( invFocalX );
			const scaleFarX = zFarCluster.negate().mul( invFocalX );
			const scaleNearY = zNearCluster.negate().mul( invFocalY );
			const scaleFarY = zFarCluster.negate().mul( invFocalY );

			const xMinNear = ndcXmin.mul( scaleNearX );
			const xMaxNear = ndcXmax.mul( scaleNearX );
			const xMinFar = ndcXmin.mul( scaleFarX );
			const xMaxFar = ndcXmax.mul( scaleFarX );

			const yMinNear = ndcYmin.mul( scaleNearY );
			const yMaxNear = ndcYmax.mul( scaleNearY );
			const yMinFar = ndcYmin.mul( scaleFarY );
			const yMaxFar = ndcYmax.mul( scaleFarY );

			// AABB of the 8 view-space corners (tile boundaries can straddle the view axis)
			const aabbMinX = min( xMinNear, xMinFar );
			const aabbMaxX = max( xMaxNear, xMaxFar );
			const aabbMinY = min( yMinNear, yMinFar );
			const aabbMaxY = max( yMaxNear, yMaxFar );

			const aabbMin = vec3( aabbMinX as any, aabbMinY as any, zFarCluster as any );
			const aabbMax = vec3( aabbMaxX as any, aabbMaxY as any, zNearCluster as any );

			const index = int( 0 ).toVar();

			// Z-culling: only test lights that can reach this cluster's Z-slice
			const zRange = textureLoad( zSliceRangesTexture, ivec2( int( cz ) as any, 0 ) );
			const rangeStart = int( zRange.x );
			const rangeEnd = int( zRange.y );

			Loop( this.maxLights, ( { i } ) => {

				const lightIdx = rangeStart.add( i );

				If( index.greaterThanEqual( int( maxLightsPerCluster ) ).or( lightIdx.greaterThanEqual( rangeEnd ) ), () => {

					Break();

				} );

				const { viewPosition, distance } = this.getLightBoundsData( lightIdx );

				// sphere-AABB intersection in view space
				const pos = viewPosition.xyz;
				const closest = max( aabbMin, min( pos, aabbMax ) );
				const diff = pos.sub( closest );
				const distSq = dot( diff, diff );

				If( distSq.lessThanEqual( distance.mul( distance ) ), () => {

					getClusterSlot( index, clusterChunkBase ).assign( lightIdx.add( int( 1 ) ) );
					index.addAssign( int( 1 ) );

				} );

			} );

			If( index.lessThan( int( maxLightsPerCluster ) ), () => {

				getClusterSlot( index, clusterChunkBase ).assign( int( 0 ) );

			} );

		} )().compute( clusterCount ).setName( 'Update Clustered Lights' );

		// shading-side: fragment → cluster index

		const getScreenClusterIndex = Fn( () => {

			const screenTile = screenCoordinate.div( tileSize ).floor();

			// view-space depth from positionView (negative in front); take magnitude
			const viewDepth = positionView.z.negate();

			// exponential Z slice: tz = floor( log(depth/near) / log(far/near) * NZ )
			const invLogFarOverNear = float( 1 ).div( log( this._cameraFar.div( this._cameraNear ) ) );
			const sliceFloat = log( viewDepth.div( this._cameraNear ) ).mul( invLogFarOverNear ).mul( float( NZ ) );
			const zSlice = clamp( sliceFloat.floor(), float( 0 ), float( NZ - 1 ) );

			return int( screenTile.x )
				.add( int( screenTile.y ).mul( int( NX ) ) )
				.add( int( zSlice ).mul( int( NX * NY ) ) );

		} );

		const screenClusterIndex = getScreenClusterIndex().toVar();

		// assigns

		this._bufferSize = bufferSize;
		this._lightIndexes = lightIndexes;
		this._screenClusterIndex = screenClusterIndex;
		this._compute = compute;
		this._lightsTexture = lightsTexture;
		this._zSliceRangesTexture = zSliceRangesTexture;
		this._zSliceRangesData = zSliceRangesData;
		this._clusterDataDirty = true;

	}

	get hasLights() {

		return super.hasLights || this.clusteredLights.length > 0;

	}

}

export default ClusteredLightsNode;

function shouldClusterPointLight( light: PointLight ): boolean {

	return light.visible !== false && light.intensity > 0.0001 && light.distance > 0.001;

}

function shouldClusterSpotLight( light: SpotLight ): boolean {

	// Spotlights cull by their bounding sphere, which requires a finite range; an
	// infinite-distance spot can't be clustered, so leave it to the material path.
	return light.visible !== false && light.intensity > 0.0001 && light.distance > 0.001;

}

function setFloatIfChanged( data: Float32Array, index: number, value: number ): boolean {

	if ( data[ index ] === value ) return false;
	data[ index ] = value;
	return true;

}

function sortLightOrderByDepth( order: number[], count: number, viewZ: Float32Array ): void {

	for ( let i = 1; i < count; i ++ ) {

		const item = order[ i ];
		const depth = viewZ[ item ];
		let j = i - 1;

		while ( j >= 0 && viewZ[ order[ j ] ] > depth ) {

			order[ j + 1 ] = order[ j ];
			j --;

		}

		order[ j + 1 ] = item;

	}

}

/**
 * Fills `starts[z]`/`ends[z]` with the half-open span [rangeStart, rangeEnd) of
 * sorted-light indices whose bounding sphere overlaps exponential Z-slice `z`.
 * Lights are given in `order` (ascending view-space depth) with view-space Z in
 * `viewZ` and radii from `lights[idx].distance` (0 → treated as `far`).
 *
 * Runs in O(lights + NZ): each light's depth extent is mapped directly to a
 * contiguous slice span by inverting the exponential slice function
 *
 *   slice(d) = floor( log(d/near) / log(far/near) * NZ )   (d = positive depth)
 *
 * rather than testing every light against every slice. Overlap with slice z
 * requires depthNear ≤ dFar(z) and depthFar ≥ dNear(z), which invert to
 * zLo = ceil(log(depthNear/near)*k) - 1 and zHi = floor(log(depthFar/near)*k),
 * with k = NZ/log(far/near). Empty slices are written as [0, 0).
 *
 * @internal Exported for testing against the brute-force reference.
 */
export function computeZSliceRanges(
	count: number,
	NZ: number,
	near: number,
	far: number,
	viewZ: Float32Array | number[],
	order: ArrayLike<number>,
	distances: ArrayLike<number>,
	starts: Int32Array,
	ends: Int32Array,
): void {

	const invLogRatioNZ = NZ / Math.log( far / near );
	const lastSlice = NZ - 1;

	for ( let z = 0; z < NZ; z ++ ) {

		starts[ z ] = count;
		ends[ z ] = 0;

	}

	for ( let i = 0; i < count; i ++ ) {

		const srcIndex = order[ i ];
		const vz = viewZ[ srcIndex ];
		const r = distances[ srcIndex ];
		const radius = r > 0 ? r : far;

		// Sphere depth extent (positive, near→far): [depthNear, depthFar].
		const depthNear = - vz - radius;
		const depthFar = - vz + radius;

		// Skip lights entirely outside the [near, far] depth band. Clamping a span
		// that lies wholly beyond far onto the last slice would wrongly include it,
		// so both out-of-band cases are rejected (mirrors the reference's bounds).
		if ( depthFar < near || depthNear > far ) continue;

		let zLo = 0;
		if ( depthNear > near ) {

			zLo = Math.ceil( Math.log( depthNear / near ) * invLogRatioNZ ) - 1;
			if ( zLo > lastSlice ) zLo = lastSlice;

		}

		let zHi = ( Math.log( depthFar / near ) * invLogRatioNZ ) | 0;
		if ( zHi > lastSlice ) zHi = lastSlice;

		const iEnd = i + 1;

		for ( let z = zLo; z <= zHi; z ++ ) {

			// First light to touch a slice sets the min start; iteration order is
			// ascending i, so the last to touch sets the max end.
			if ( i < starts[ z ] ) starts[ z ] = i;
			ends[ z ] = iEnd;

		}

	}

	for ( let z = 0; z < NZ; z ++ ) {

		if ( starts[ z ] >= count ) {

			starts[ z ] = 0;
			ends[ z ] = 0;

		}

	}

}

/**
 * TSL function that creates a clustered lights node.
 *
 * @tsl
 * @function
 * @param {number} [maxLights=1024] - Maximum number of point lights.
 * @param {number} [tileSize=32] - Screen tile size in pixels.
 * @param {number} [zSlices=24] - Depth slice count.
 * @param {number} [maxLightsPerCluster=64] - Per-cluster light-list capacity.
 * @return {ClusteredLightsNode} The clustered lights node.
 */
export const clusteredLights = /*@__PURE__*/ nodeProxy( ClusteredLightsNode );
