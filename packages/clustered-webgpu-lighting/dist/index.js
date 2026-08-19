// src/clustered-lighting.ts
import { Lighting } from "three/webgpu";

// src/clustered-lights-node.ts
import {
  DataTexture,
  FloatType,
  LightsNode,
  NodeUpdateType,
  RGBAFormat,
  Vector2
} from "three/webgpu";
import {
  attributeArray,
  int,
  float,
  vec3,
  ivec2,
  uniform,
  Break,
  Loop,
  positionView,
  Fn,
  If,
  textureLoad,
  instanceIndex,
  screenCoordinate,
  directPointLight,
  renderGroup,
  min,
  max,
  pow,
  log,
  clamp,
  dot,
  smoothstep,
  select
} from "three/tsl";
var POINT_LIGHT_CONE_SENTINEL = -2;
var LIGHT_TEXTURE_ROWS = 4;
var _size = /* @__PURE__ */ new Vector2;

class ClusteredLightsNode extends LightsNode {
  static get type() {
    return "ClusteredLightsNode";
  }
  materialLights;
  clusteredLights;
  maxLights;
  tileSize;
  zSlices;
  maxLightsPerCluster;
  _chunksPerCluster;
  _bufferSize;
  _lightIndexes;
  _screenClusterIndex;
  _compute;
  _lightsTexture;
  _zSliceRangesTexture;
  _zSliceRangesData;
  _lightViewX;
  _lightViewY;
  _lightViewZ;
  _lightDistance;
  _lightColorR;
  _lightColorG;
  _lightColorB;
  _lightDecay;
  _lightConeCos;
  _lightPenumbraCos;
  _lightSpotDirectionX;
  _lightSpotDirectionY;
  _lightSpotDirectionZ;
  _lightSortOrder;
  _lastLightSortCount;
  _zRangeStart;
  _zRangeEnd;
  _clusterDataDirty;
  _cameraNear;
  _cameraFar;
  _invFocal;
  _gridDimensions;
  _lastCameraNear;
  _lastCameraFar;
  _lastProjection00;
  _lastProjection11;
  constructor(maxLights = 1024, tileSize = 32, zSlices = 24, maxLightsPerCluster = 64) {
    super();
    this.materialLights = [];
    this.clusteredLights = [];
    this.maxLights = maxLights;
    this.tileSize = tileSize;
    this.zSlices = zSlices;
    this.maxLightsPerCluster = maxLightsPerCluster;
    this._chunksPerCluster = Math.ceil(maxLightsPerCluster / 4);
    this._bufferSize = null;
    this._lightIndexes = null;
    this._screenClusterIndex = null;
    this._compute = null;
    this._lightsTexture = null;
    this._zSliceRangesTexture = null;
    this._zSliceRangesData = null;
    this._lightViewX = new Float32Array(maxLights);
    this._lightViewY = new Float32Array(maxLights);
    this._lightViewZ = new Float32Array(maxLights);
    this._lightDistance = new Float32Array(maxLights);
    this._lightColorR = new Float32Array(maxLights);
    this._lightColorG = new Float32Array(maxLights);
    this._lightColorB = new Float32Array(maxLights);
    this._lightDecay = new Float32Array(maxLights);
    this._lightConeCos = new Float32Array(maxLights);
    this._lightPenumbraCos = new Float32Array(maxLights);
    this._lightSpotDirectionX = new Float32Array(maxLights);
    this._lightSpotDirectionY = new Float32Array(maxLights);
    this._lightSpotDirectionZ = new Float32Array(maxLights);
    this._lightSortOrder = [];
    this._lastLightSortCount = -1;
    this._zRangeStart = new Int32Array(zSlices);
    this._zRangeEnd = new Int32Array(zSlices);
    this._clusterDataDirty = true;
    this._cameraNear = uniform(0).setName("clusteredCameraNear").setGroup(renderGroup);
    this._cameraFar = uniform(0).setName("clusteredCameraFar").setGroup(renderGroup);
    this._invFocal = uniform(new Vector2).setName("clusteredInvFocal").setGroup(renderGroup);
    this._gridDimensions = uniform(new Vector2);
    this._lastCameraNear = NaN;
    this._lastCameraFar = NaN;
    this._lastProjection00 = NaN;
    this._lastProjection11 = NaN;
    this.updateBeforeType = NodeUpdateType.RENDER;
  }
  customCacheKey() {
    return (this._compute ? this._compute.getCacheKey() : 0) + super.customCacheKey();
  }
  updateLightsTexture(camera) {
    const lightsTexture = this._lightsTexture;
    const { clusteredLights } = this;
    const data = lightsTexture.image.data;
    const lineSize = lightsTexture.image.width * 4;
    const count = clusteredLights.length;
    let lightsChanged = false;
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
    const c0 = cameraView[0], c1 = cameraView[1], c2 = cameraView[2];
    const c4 = cameraView[4], c5 = cameraView[5], c6 = cameraView[6];
    const c8 = cameraView[8], c9 = cameraView[9], c10 = cameraView[10];
    const c12 = cameraView[12], c13 = cameraView[13], c14 = cameraView[14];
    if (sortCountChanged) {
      order.length = count;
      for (let i = 0;i < count; i++)
        order[i] = i;
      this._lastLightSortCount = count;
    }
    for (let i = 0;i < count; i++) {
      const light = clusteredLights[i];
      const lightMatrix = light.matrixWorld.elements;
      const x = lightMatrix[12];
      const y = lightMatrix[13];
      const z = lightMatrix[14];
      viewX[i] = c0 * x + c4 * y + c8 * z + c12;
      viewY[i] = c1 * x + c5 * y + c9 * z + c13;
      viewZ[i] = c2 * x + c6 * y + c10 * z + c14;
      distanceData[i] = light.distance;
      colorRData[i] = light.color.r * light.intensity;
      colorGData[i] = light.color.g * light.intensity;
      colorBData[i] = light.color.b * light.intensity;
      decayData[i] = light.decay;
      if (light.isSpotLight === true) {
        const spot = light;
        const targetMatrix = spot.target.matrixWorld.elements;
        const dx = x - targetMatrix[12];
        const dy = y - targetMatrix[13];
        const dz = z - targetMatrix[14];
        const sx = c0 * dx + c4 * dy + c8 * dz;
        const sy = c1 * dx + c5 * dy + c9 * dz;
        const sz = c2 * dx + c6 * dy + c10 * dz;
        const directionLength = Math.hypot(sx, sy, sz) || 1;
        spotDirectionX[i] = sx / directionLength;
        spotDirectionY[i] = sy / directionLength;
        spotDirectionZ[i] = sz / directionLength;
        coneCosData[i] = Math.cos(spot.angle);
        penumbraCosData[i] = Math.cos(spot.angle * (1 - spot.penumbra));
      } else {
        coneCosData[i] = POINT_LIGHT_CONE_SENTINEL;
        penumbraCosData[i] = -1;
      }
    }
    sortLightOrderByDepth(order, count, viewZ);
    for (let i = 0;i < count; i++) {
      const sourceIndex = order[i];
      const viewDepth = viewZ[sourceIndex];
      const distance = distanceData[sourceIndex];
      const colorR = colorRData[sourceIndex];
      const colorG = colorGData[sourceIndex];
      const colorB = colorBData[sourceIndex];
      const decay = decayData[sourceIndex];
      const offset = i * 4;
      const row2 = lineSize * 2 + offset;
      const row3 = lineSize * 3 + offset;
      lightsChanged = setFloatIfChanged(data, offset + 0, viewX[sourceIndex]) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, offset + 1, viewY[sourceIndex]) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, offset + 2, viewDepth) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, offset + 3, distance) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, lineSize + offset + 0, colorR) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, lineSize + offset + 1, colorG) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, lineSize + offset + 2, colorB) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, lineSize + offset + 3, decay) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, row2 + 0, spotDirectionX[sourceIndex]) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, row2 + 1, spotDirectionY[sourceIndex]) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, row2 + 2, spotDirectionZ[sourceIndex]) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, row2 + 3, coneCosData[sourceIndex]) || lightsChanged;
      lightsChanged = setFloatIfChanged(data, row3 + 0, penumbraCosData[sourceIndex]) || lightsChanged;
    }
    if (lightsChanged)
      lightsTexture.needsUpdate = true;
    const zRanges = this._zSliceRangesData;
    if (zRanges === null)
      return lightsChanged;
    const near = camera.near;
    const far = camera.far;
    const NZ = this.zSlices;
    let zRangesChanged = false;
    const starts = this._zRangeStart;
    const ends = this._zRangeEnd;
    computeZSliceRanges(count, NZ, near, far, viewZ, order, distanceData, starts, ends);
    for (let z = 0;z < NZ; z++) {
      const offset = z * 4;
      zRangesChanged = setFloatIfChanged(zRanges, offset, starts[z]) || zRangesChanged;
      zRangesChanged = setFloatIfChanged(zRanges, offset + 1, ends[z]) || zRangesChanged;
    }
    if (zRangesChanged)
      this._zSliceRangesTexture.needsUpdate = true;
    return lightsChanged || zRangesChanged;
  }
  updateBefore(frame) {
    const renderer = frame.renderer;
    const camera = frame.camera;
    this.updateProgram(renderer);
    const clusterDataChanged = this.updateLightsTexture(camera);
    const projectionChanged = this.updateCameraProjectionState(camera);
    this._cameraNear.value = camera.near;
    this._cameraFar.value = camera.far;
    if (this._clusterDataDirty || clusterDataChanged || projectionChanged) {
      renderer.compute(this._compute);
      this._clusterDataDirty = false;
    }
    return;
  }
  updateCameraProjectionState(camera) {
    const projection = camera.projectionMatrix.elements;
    const near = camera.near;
    const far = camera.far;
    const projection00 = projection[0];
    const projection11 = projection[5];
    const changed = near !== this._lastCameraNear || far !== this._lastCameraFar || projection00 !== this._lastProjection00 || projection11 !== this._lastProjection11;
    if (changed) {
      this._lastCameraNear = near;
      this._lastCameraFar = far;
      this._lastProjection00 = projection00;
      this._lastProjection11 = projection11;
      this._invFocal.value.set(1 / projection00, 1 / projection11);
    }
    return changed;
  }
  setLights(lights) {
    const { clusteredLights, materialLights } = this;
    let materialIndex = 0;
    let clusteredIndex = 0;
    for (const light of lights) {
      if (light.isPointLight === true) {
        const pointLight = light;
        if (shouldClusterPointLight(pointLight) && clusteredIndex < this.maxLights) {
          clusteredLights[clusteredIndex++] = pointLight;
        }
      } else if (light.isSpotLight === true) {
        const spotLight = light;
        if (shouldClusterSpotLight(spotLight) && clusteredIndex < this.maxLights) {
          clusteredLights[clusteredIndex++] = spotLight;
        }
      } else {
        materialLights[materialIndex++] = light;
      }
    }
    materialLights.length = materialIndex;
    clusteredLights.length = clusteredIndex;
    return super.setLights(materialLights);
  }
  getBlock() {
    return this._lightIndexes.element(this._screenClusterIndex.mul(int(this._chunksPerCluster)));
  }
  getTile(element) {
    element = int(element);
    const stride = int(4);
    const chunkOffset = element.div(stride);
    const idx = this._screenClusterIndex.mul(int(this._chunksPerCluster)).add(chunkOffset);
    return this._lightIndexes.element(idx).element(element.mod(stride));
  }
  getChunkBase() {
    return this._screenClusterIndex.mul(int(this._chunksPerCluster));
  }
  getClusterLightCount(zSliceNode) {
    const getCount = Fn(([zSliceNode2]) => {
      const count = int(0).toVar();
      const debugClusterIndex = this._screenClusterIndex.toVar();
      If(zSliceNode2.greaterThanEqual(int(0)), () => {
        const tileSize = int(this.tileSize);
        const screenTile = screenCoordinate.div(tileSize).floor();
        const NX = int(this._gridDimensions.x);
        const NY = int(this._gridDimensions.y);
        debugClusterIndex.assign(int(screenTile.x).add(int(screenTile.y).mul(NX)).add(zSliceNode2.mul(NX.mul(NY))));
      });
      Loop(this.maxLightsPerCluster, ({ i }) => {
        const element = int(i);
        const stride = int(4);
        const chunkOffset = element.div(stride);
        const idx = debugClusterIndex.mul(int(this._chunksPerCluster)).add(chunkOffset);
        const lightIndex = this._lightIndexes.element(idx).element(element.mod(stride));
        If(lightIndex.equal(int(0)), () => {
          Break();
        });
        count.addAssign(int(1));
      });
      return count;
    });
    return getCount(zSliceNode);
  }
  getLightData(index) {
    index = int(index);
    const dataA = textureLoad(this._lightsTexture, ivec2(index, 0));
    const dataB = textureLoad(this._lightsTexture, ivec2(index, 1));
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
  getLightConeData(index) {
    index = int(index);
    const dataC = textureLoad(this._lightsTexture, ivec2(index, 2));
    const dataD = textureLoad(this._lightsTexture, ivec2(index, 3));
    return {
      spotDirection: dataC.xyz,
      coneCos: dataC.w,
      penumbraCos: dataD.x
    };
  }
  getLightBoundsData(index) {
    index = int(index);
    const dataA = textureLoad(this._lightsTexture, ivec2(index, 0));
    return {
      viewPosition: dataA.xyz,
      distance: dataA.w
    };
  }
  setupLights(builder, lightNodes) {
    this.updateProgram(builder.renderer);
    const lightingModel = builder.context.reflectedLight;
    lightingModel.directDiffuse.toStack();
    lightingModel.directSpecular.toStack();
    super.setupLights(builder, lightNodes);
    const shadeLight = (lightIndex) => {
      const dataIndex = lightIndex.sub(1).toVar();
      const { color, decay, viewPosition, distance } = this.getLightData(dataIndex);
      const lightVector = viewPosition.sub(positionView).toVar();
      If(dot(lightVector, lightVector).lessThanEqual(distance.mul(distance)), () => {
        const { spotDirection, coneCos, penumbraCos } = this.getLightConeData(dataIndex);
        const angleCos = dot(lightVector.normalize(), spotDirection);
        const spotMask = select(coneCos.lessThan(float(-1)), float(1), smoothstep(coneCos, penumbraCos, angleCos));
        builder.lightsNode.setupDirectLight(builder, this, directPointLight({
          color: color.mul(spotMask),
          lightVector,
          cutoffDistance: distance,
          decayExponent: decay
        }));
      });
    };
    Fn(() => {
      const chunkBase = this.getChunkBase().toVar();
      const indexes = this._lightIndexes;
      Loop(this._chunksPerCluster, ({ i }) => {
        const chunk = indexes.element(chunkBase.add(int(i))).toVar();
        const lanes = [chunk.x, chunk.y, chunk.z, chunk.w];
        for (const lane of lanes) {
          If(lane.equal(int(0)), () => {
            Break();
          });
          shadeLight(lane);
        }
      });
    }, "void")();
  }
  getBufferFitSize(value) {
    const multiple = this.tileSize;
    return Math.ceil(value / multiple) * multiple;
  }
  setSize(width, height) {
    width = this.getBufferFitSize(width);
    height = this.getBufferFitSize(height);
    if (!this._bufferSize || this._bufferSize.width !== width || this._bufferSize.height !== height) {
      this.create(width, height);
    }
    return this;
  }
  updateProgram(renderer) {
    renderer.getDrawingBufferSize(_size);
    const width = this.getBufferFitSize(_size.width);
    const height = this.getBufferFitSize(_size.height);
    if (this._bufferSize === null) {
      this.create(width, height);
    } else if (this._bufferSize.width !== width || this._bufferSize.height !== height) {
      this.create(width, height);
    }
  }
  create(width, height) {
    const { tileSize, maxLights, zSlices, maxLightsPerCluster, _chunksPerCluster: chunksPerCluster } = this;
    const bufferSize = new Vector2(width, height);
    const NX = Math.floor(bufferSize.width / tileSize);
    const NY = Math.floor(bufferSize.height / tileSize);
    const NZ = zSlices;
    const clusterCount = NX * NY * NZ;
    this._gridDimensions.value.set(NX, NY);
    const lightsData = new Float32Array(maxLights * 4 * LIGHT_TEXTURE_ROWS);
    const lightsTexture = new DataTexture(lightsData, maxLights, LIGHT_TEXTURE_ROWS, RGBAFormat, FloatType);
    const zSliceRangesData = new Float32Array(NZ * 4);
    const zSliceRangesTexture = new DataTexture(zSliceRangesData, NZ, 1, RGBAFormat, FloatType);
    const lightIndexesArray = new Int32Array(clusterCount * chunksPerCluster * 4);
    const lightIndexes = attributeArray(lightIndexesArray, "ivec4").setName("lightIndexes");
    const getClusterSlot = (slotIdx, clusterChunkBase) => {
      const s = int(slotIdx);
      const stride = int(4);
      const chunkOffset = s.div(stride);
      const idx = clusterChunkBase.add(chunkOffset);
      return lightIndexes.element(idx).element(s.mod(stride));
    };
    const compute = Fn(() => {
      const invFocalX = this._invFocal.x;
      const invFocalY = this._invFocal.y;
      const cx = instanceIndex.mod(NX);
      const cy = instanceIndex.div(NX).mod(NY);
      const cz = instanceIndex.div(NX * NY);
      const clusterChunkBase = instanceIndex.mul(int(chunksPerCluster)).toVar();
      const ndcXmin = float(cx).mul(2 / NX).sub(1);
      const ndcXmax = float(cx.add(int(1))).mul(2 / NX).sub(1);
      const ndcYmax = float(1).sub(float(cy).mul(2 / NY));
      const ndcYmin = float(1).sub(float(cy.add(int(1))).mul(2 / NY));
      const farOverNear = this._cameraFar.div(this._cameraNear);
      const zNearCluster = this._cameraNear.mul(pow(farOverNear, float(cz).mul(1 / NZ))).negate();
      const zFarCluster = this._cameraNear.mul(pow(farOverNear, float(cz.add(int(1))).mul(1 / NZ))).negate();
      const scaleNearX = zNearCluster.negate().mul(invFocalX);
      const scaleFarX = zFarCluster.negate().mul(invFocalX);
      const scaleNearY = zNearCluster.negate().mul(invFocalY);
      const scaleFarY = zFarCluster.negate().mul(invFocalY);
      const xMinNear = ndcXmin.mul(scaleNearX);
      const xMaxNear = ndcXmax.mul(scaleNearX);
      const xMinFar = ndcXmin.mul(scaleFarX);
      const xMaxFar = ndcXmax.mul(scaleFarX);
      const yMinNear = ndcYmin.mul(scaleNearY);
      const yMaxNear = ndcYmax.mul(scaleNearY);
      const yMinFar = ndcYmin.mul(scaleFarY);
      const yMaxFar = ndcYmax.mul(scaleFarY);
      const aabbMinX = min(xMinNear, xMinFar);
      const aabbMaxX = max(xMaxNear, xMaxFar);
      const aabbMinY = min(yMinNear, yMinFar);
      const aabbMaxY = max(yMaxNear, yMaxFar);
      const aabbMin = vec3(aabbMinX, aabbMinY, zFarCluster);
      const aabbMax = vec3(aabbMaxX, aabbMaxY, zNearCluster);
      const index = int(0).toVar();
      const zRange = textureLoad(zSliceRangesTexture, ivec2(int(cz), 0));
      const rangeStart = int(zRange.x);
      const rangeEnd = int(zRange.y);
      Loop(this.maxLights, ({ i }) => {
        const lightIdx = rangeStart.add(i);
        If(index.greaterThanEqual(int(maxLightsPerCluster)).or(lightIdx.greaterThanEqual(rangeEnd)), () => {
          Break();
        });
        const { viewPosition, distance } = this.getLightBoundsData(lightIdx);
        const pos = viewPosition.xyz;
        const closest = max(aabbMin, min(pos, aabbMax));
        const diff = pos.sub(closest);
        const distSq = dot(diff, diff);
        If(distSq.lessThanEqual(distance.mul(distance)), () => {
          getClusterSlot(index, clusterChunkBase).assign(lightIdx.add(int(1)));
          index.addAssign(int(1));
        });
      });
      If(index.lessThan(int(maxLightsPerCluster)), () => {
        getClusterSlot(index, clusterChunkBase).assign(int(0));
      });
    })().compute(clusterCount).setName("Update Clustered Lights");
    const getScreenClusterIndex = Fn(() => {
      const screenTile = screenCoordinate.div(tileSize).floor();
      const viewDepth = positionView.z.negate();
      const invLogFarOverNear = float(1).div(log(this._cameraFar.div(this._cameraNear)));
      const sliceFloat = log(viewDepth.div(this._cameraNear)).mul(invLogFarOverNear).mul(float(NZ));
      const zSlice = clamp(sliceFloat.floor(), float(0), float(NZ - 1));
      return int(screenTile.x).add(int(screenTile.y).mul(int(NX))).add(int(zSlice).mul(int(NX * NY)));
    });
    const screenClusterIndex = getScreenClusterIndex().toVar();
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
var clustered_lights_node_default = ClusteredLightsNode;
function shouldClusterPointLight(light) {
  return light.visible !== false && light.intensity > 0.0001 && light.distance > 0.001;
}
function shouldClusterSpotLight(light) {
  return light.visible !== false && light.intensity > 0.0001 && light.distance > 0.001;
}
function setFloatIfChanged(data, index, value) {
  if (data[index] === value)
    return false;
  data[index] = value;
  return true;
}
function sortLightOrderByDepth(order, count, viewZ) {
  for (let i = 1;i < count; i++) {
    const item = order[i];
    const depth = viewZ[item];
    let j = i - 1;
    while (j >= 0 && viewZ[order[j]] > depth) {
      order[j + 1] = order[j];
      j--;
    }
    order[j + 1] = item;
  }
}
function computeZSliceRanges(count, NZ, near, far, viewZ, order, distances, starts, ends) {
  const invLogRatioNZ = NZ / Math.log(far / near);
  const lastSlice = NZ - 1;
  for (let z = 0;z < NZ; z++) {
    starts[z] = count;
    ends[z] = 0;
  }
  for (let i = 0;i < count; i++) {
    const srcIndex = order[i];
    const vz = viewZ[srcIndex];
    const r = distances[srcIndex];
    const radius = r > 0 ? r : far;
    const depthNear = -vz - radius;
    const depthFar = -vz + radius;
    if (depthFar < near || depthNear > far)
      continue;
    let zLo = 0;
    if (depthNear > near) {
      zLo = Math.ceil(Math.log(depthNear / near) * invLogRatioNZ) - 1;
      if (zLo > lastSlice)
        zLo = lastSlice;
    }
    let zHi = Math.log(depthFar / near) * invLogRatioNZ | 0;
    if (zHi > lastSlice)
      zHi = lastSlice;
    const iEnd = i + 1;
    for (let z = zLo;z <= zHi; z++) {
      if (i < starts[z])
        starts[z] = i;
      ends[z] = iEnd;
    }
  }
  for (let z = 0;z < NZ; z++) {
    if (starts[z] >= count) {
      starts[z] = 0;
      ends[z] = 0;
    }
  }
}

// src/clustered-lighting.ts
class ClusteredLighting extends Lighting {
  maxLights;
  tileSize;
  zSlices;
  maxLightsPerCluster;
  constructor(maxLights = 1024, tileSize = 32, zSlices = 24, maxLightsPerCluster = 64) {
    super();
    this.maxLights = maxLights;
    this.tileSize = tileSize;
    this.zSlices = zSlices;
    this.maxLightsPerCluster = maxLightsPerCluster;
  }
  createNode(lights = []) {
    return new clustered_lights_node_default(this.maxLights, this.tileSize, this.zSlices, this.maxLightsPerCluster).setLights(lights);
  }
}

// src/index.ts
var clusteredLightingConfig = {
  maxLights: 1024,
  tileSize: 32,
  zSlices: 24,
  maxLightsPerCluster: 64
};
var clusteredLightingInfo = {
  implementation: "local-forward-plus-clustered-lighting",
  ...clusteredLightingConfig
};
function installClusteredWebgpuLighting(renderer) {
  const target = renderer;
  target.userData ??= {};
  target.lighting = new ClusteredLighting(clusteredLightingConfig.maxLights, clusteredLightingConfig.tileSize, clusteredLightingConfig.zSlices, clusteredLightingConfig.maxLightsPerCluster);
  target.userData.clusteredWebgpuLighting = clusteredLightingInfo;
}
export {
  installClusteredWebgpuLighting,
  clusteredLightingInfo
};
