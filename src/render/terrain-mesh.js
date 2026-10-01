import * as THREE from 'three'
import {terrainField, groundHeight} from '../world/terrain.js'

// Rendering and placement share the same SW-to-NE grid diagonal. Large road and
// park triangles are cut on those boundaries, so the earth cannot poke through.
export function groundGeometry() {
  const f = terrainField()
  if (!f) return new THREE.PlaneGeometry(10000, 10000).rotateX(-Math.PI / 2)
  const positions = [], indices = []
  for (let j = 0; j < f.ny; j++) for (let i = 0; i < f.nx; i++) {
    const x = f.minX + i * (f.maxX - f.minX) / (f.nx - 1)
    const y = f.minY + j * (f.maxY - f.minY) / (f.ny - 1)
    positions.push(x, groundHeight(x, -y) - 0.05, -y)
    if (i < f.nx - 1 && j < f.ny - 1) {
      const a = j * f.nx + i, b = a + 1, d = a + f.nx, c = d + 1
      indices.push(a, b, c, a, c, d)
    }
  }
  const g = new THREE.BufferGeometry()
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3))
  g.setIndex(indices)
  g.computeVertexNormals()
  return g
}

function clip(poly, distance) {
  const out = []
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b = poly[(i + 1) % poly.length], da = distance(a), db = distance(b)
    if (da >= -1e-8) out.push(a)
    if ((da < -1e-8 && db > 1e-8) || (da > 1e-8 && db < -1e-8)) {
      const t = da / (da - db)
      out.push(a.map((v, k) => v + (b[k] - v) * t))
    }
  }
  return out
}

// offset=null preserves each input vertex's height above terrain (including kerbs).
export function drapeGeometry(geometry, offset = null) {
  const f = terrainField()
  if (!f) return geometry
  const p = geometry.attributes.position, index = geometry.index
  const attrs = Object.entries(geometry.attributes).filter(([name]) => name !== 'position' && name !== 'normal')
  const output = [], other = attrs.map(() => [])
  const sx = (f.maxX - f.minX) / (f.nx - 1), sy = (f.maxY - f.minY) / (f.ny - 1)
  const vertex = i => {
    const x = p.getX(i), y = -p.getZ(i)
    const values = [x, y, offset ?? p.getY(i) - groundHeight(x, -y)]
    for (const [, a] of attrs) for (let k = 0; k < a.itemSize; k++) values.push(a.array[i * a.itemSize + k])
    return values
  }
  const emit = poly => {
    for (let j = 1; j < poly.length - 1; j++) for (const v of [poly[0], poly[j], poly[j + 1]]) {
      output.push(v[0], groundHeight(v[0], -v[1]) + v[2], -v[1])
      let k = 3
      attrs.forEach(([, a], n) => { for (let m = 0; m < a.itemSize; m++) other[n].push(v[k++]) })
    }
  }
  const count = index ? index.count : p.count
  for (let n = 0; n < count; n += 3) {
    const tri = [0, 1, 2].map(k => vertex(index ? index.getX(n + k) : n + k))
    const [a, b, c] = tri
    if (Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) < 1e-7) { emit(tri); continue }
    const x0 = Math.max(0, Math.floor((Math.min(...tri.map(v => v[0])) - f.minX) / sx))
    const x1 = Math.min(f.nx - 2, Math.floor((Math.max(...tri.map(v => v[0])) - f.minX) / sx))
    const y0 = Math.max(0, Math.floor((Math.min(...tri.map(v => v[1])) - f.minY) / sy))
    const y1 = Math.min(f.ny - 2, Math.floor((Math.max(...tri.map(v => v[1])) - f.minY) / sy))
    for (let y = y0; y <= y1; y++) for (let x = x0; x <= x1; x++) {
      const left = f.minX + x * sx, bottom = f.minY + y * sy
      let poly = clip(tri, v => v[0] - left)
      poly = clip(poly, v => left + sx - v[0])
      poly = clip(poly, v => v[1] - bottom)
      poly = clip(poly, v => bottom + sy - v[1])
      if (poly.length < 3) continue
      const diagonal = v => (v[0] - left) / sx - (v[1] - bottom) / sy
      emit(clip(poly, diagonal))
      emit(clip(poly, v => -diagonal(v)))
    }
  }
  geometry.setIndex(null)
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(output, 3))
  attrs.forEach(([name, a], n) => geometry.setAttribute(name, new THREE.Float32BufferAttribute(other[n], a.itemSize)))
  geometry.deleteAttribute('normal')
  geometry.computeVertexNormals()
  geometry.computeBoundingBox()
  geometry.computeBoundingSphere()
  return geometry
}
