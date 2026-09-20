// The derived world model: the one place that turns raw OSM into numbers both halves agree on.
//
// Pure by contract — no Three.js, no DOM, no network. The renderer draws what this describes and
// the simulation collides against it, so a disagreement here is a disagreement everywhere. See
// INTERFACES.md; change the table below and you change what the car can drive on AND what gets
// paved, which is the whole reason it lives in one file.

/** Full carriageway width in metres, centred on the OSM polyline. */
export const ROAD_KINDS = {
  primary: {width: 12.0, drivable: true, pedestrianZone: false},
  secondary: {width: 10.0, drivable: true, pedestrianZone: false},
  tertiary: {width: 9.0, drivable: true, pedestrianZone: false},
  residential: {width: 7.0, drivable: true, pedestrianZone: false},
  unclassified: {width: 7.0, drivable: true, pedestrianZone: false},
  living_street: {width: 6.0, drivable: true, pedestrianZone: false},
  service: {width: 4.5, drivable: true, pedestrianZone: false},
  // Drivable on purpose: the game should let you do this and then care that you did.
  pedestrian: {width: 4.0, drivable: true, pedestrianZone: true},
  // The Pfaffenthal lift arrives in the OSM highway list. It is not a road.
  elevator: {width: 0, drivable: false, pedestrianZone: false},
}

/** Two road ends closer than this are the same junction. */
const WELD = 0.5
/** Broad-phase cell size in metres. 6,196 buildings cannot be tested per frame. */
const GRID = 32

const hypot = (ax, ay, bx, by) => Math.hypot(bx - ax, by - ay)

/**
 * Weld road endpoints into shared junctions.
 *
 * Keyed on the coordinate rounded to WELD, which is what makes two ways that share an OSM node
 * become one graph node — the fetcher denormalised that relationship away, so it is reconstructed
 * from geometry rather than from ids we no longer have.
 */
class NodeSet {
  constructor() {
    this.byKey = new Map()
    this.nodes = []
  }

  at(x, y) {
    const key = `${Math.round(x / WELD)}:${Math.round(y / WELD)}`
    const found = this.byKey.get(key)
    if (found !== undefined) return found
    const id = this.nodes.length
    this.nodes.push({id, x, y, edges: []})
    this.byKey.set(key, id)
    return id
  }
}

function polylineLength(pts) {
  let total = 0
  for (let i = 1; i < pts.length; i++) total += hypot(pts[i - 1][0], pts[i - 1][1], pts[i][0], pts[i][1])
  return total
}

function aabbOf(pts) {
  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  return {minX, minY, maxX, maxY}
}

/**
 * Uniform spatial hash over building boxes. A building spanning several cells is listed in each,
 * so `near` can return the same building twice for a wide query — callers that care dedupe, and the
 * physics does not, because testing a box twice is cheaper than a Set allocation every frame.
 */
class Grid {
  constructor(items) {
    this.cells = new Map()
    for (const item of items) {
      const {minX, minY, maxX, maxY} = item.aabb
      for (let cx = Math.floor(minX / GRID); cx <= Math.floor(maxX / GRID); cx++) {
        for (let cy = Math.floor(minY / GRID); cy <= Math.floor(maxY / GRID); cy++) {
          const key = `${cx}:${cy}`
          const bucket = this.cells.get(key)
          if (bucket) bucket.push(item)
          else this.cells.set(key, [item])
        }
      }
    }
  }

  /** Candidates whose cells overlap the square of half-extent r around (x, y). */
  near(x, y, r, out = []) {
    out.length = 0
    for (let cx = Math.floor((x - r) / GRID); cx <= Math.floor((x + r) / GRID); cx++) {
      for (let cy = Math.floor((y - r) / GRID); cy <= Math.floor((y + r) / GRID); cy++) {
        const bucket = this.cells.get(`${cx}:${cy}`)
        if (bucket) for (const item of bucket) out.push(item)
      }
    }
    return out
  }
}

/**
 * Point obstacles — the things a car hits that are not buildings.
 *
 * Trees and lamp posts are single coordinates in the source, so they collide as circles rather than
 * polygons. Cheap, and at the radius of a lamp post nobody can tell the difference between a circle
 * and the real fluted column.
 *
 * The grid also holds each prop's STATE, because breakable roadside furniture needs somewhere to
 * keep its remaining health and there is no second structure that knows about every prop in the
 * city. Damage is applied here rather than in the physics or the renderer for the same reason the
 * widths live in this file: both halves have to agree on whether a thing is still standing, and a
 * second copy of that answer is how you get a tree you can see but drive through — the exact fault
 * documented over `inCarriageway` below.
 */
class PointGrid {
  constructor(items = []) {
    this.cells = new Map()
    this.items = []
    /** Breaks that the physics has decided and the renderer has not yet drawn. Drained per frame. */
    this.events = []
    for (const item of items) this.add(item)
  }

  key(x, y) { return `${Math.floor(x / GRID)}:${Math.floor(y / GRID)}` }

  /**
   * Incremental, unlike the building `Grid`, which has to be rebuilt because a footprint spans
   * several cells. A point lives in exactly one cell, so the renderer can hand its props over after
   * placement without paying for a rebuild.
   */
  add(item) {
    this.items.push(item)
    const key = this.key(item.x, item.y)
    const bucket = this.cells.get(key)
    if (bucket) bucket.push(item)
    else this.cells.set(key, [item])
    return item
  }

  /** Take a prop out of the broad phase. It stays in `items` so counts still mean something. */
  drop(item) {
    const bucket = this.cells.get(this.key(item.x, item.y))
    if (!bucket) return
    const at = bucket.indexOf(item)
    if (at > -1) bucket.splice(at, 1)
  }

  /**
   * Hit `item` with an impact of `energy` (the square of the closing speed — see `PROP_KINDS`).
   * Returns true if this is the blow that brought it down.
   *
   * One qualifying hit is one point of damage, and a genuinely violent one is worth more, or the
   * grading reads as an arbitrary hit counter rather than as a tree resisting a car. A hit worth an
   * extra point and a half of the break threshold is worth an extra point of damage, which puts the
   * thickest plane tree (three health, a threshold of 56) at three shunts from 27 km/h, two from 38,
   * and one from fifty. `dirX, dirY` is the direction the blow travelled in, so the renderer can
   * throw the thing that way.
   */
  hit(item, energy, dirX = 0, dirY = 0) {
    if (!item.hp || item.broken || energy < item.breakEnergy) return false
    item.hp -= 1 + Math.floor(energy / (1.5 * item.breakEnergy))
    if (item.hp > 0) {
      // Survived. Still worth reporting: a hit hard enough to count and not hard enough to fell
      // should leave a mark, or the player cannot tell a tree that is nearly down from a fresh one.
      this.events.push({item, energy, dirX, dirY, felled: false})
      return false
    }
    item.hp = 0
    item.broken = true
    this.drop(item)
    this.events.push({item, energy, dirX, dirY, felled: true})
    return true
  }

  /** Drain the queue. The renderer owns what a break LOOKS like; this only says that one happened. */
  takeEvents() {
    if (!this.events.length) return null
    const out = this.events
    this.events = []
    return out
  }

  /** Props still standing — the number that matters when you want to know if destruction works. */
  standing() { return this.items.reduce((n, i) => n + (i.broken ? 0 : 1), 0) }

  /**
   * The register, broken down by kind: `{tree: {total, standing, broken, hp, breakEnergy}, ...}`.
   *
   * Not used by the game. It exists because "destruction works" is a claim and "1,193 shelters, 4 of
   * them flattened" is a measurement, and a screenshot cannot count to 1,193. `hp` is the range of
   * toughness within the kind, which is where you look to see that the thick trees really did get
   * more health than the saplings.
   */
  census() {
    const out = {}
    for (const i of this.items) {
      const c = out[i.kind] ?? (out[i.kind] = {
        total: 0, standing: 0, broken: 0, hp: [Infinity, 0], breakEnergy: i.breakEnergy,
      })
      c.total++
      i.broken ? c.broken++ : c.standing++
      c.hp[0] = Math.min(c.hp[0], i.hp)
      c.hp[1] = Math.max(c.hp[1], i.hp)
    }
    return out
  }

  /**
   * The nearest prop to (x, y), optionally restricted to one kind and to things still standing.
   * A linear scan over every prop in the city, which is fine because nothing in the frame loop calls
   * it — it is how a test says "find me a thick plane tree and drive at it".
   */
  nearest(x, y, {kind = null, standing = true, minHp = 0, within = Infinity} = {}) {
    let best = null, bestD2 = within * within
    for (const i of this.items) {
      if (kind && i.kind !== kind) continue
      if (standing && i.broken) continue
      if (i.hp < minHp) continue
      const d2 = (i.x - x) ** 2 + (i.y - y) ** 2
      if (d2 < bestD2) { bestD2 = d2; best = i }
    }
    return best
  }

  near(x, y, r, out = []) {
    out.length = 0
    for (let cx = Math.floor((x - r) / GRID); cx <= Math.floor((x + r) / GRID); cx++) {
      for (let cy = Math.floor((y - r) / GRID); cy <= Math.floor((y + r) / GRID); cy++) {
        const bucket = this.cells.get(`${cx}:${cy}`)
        if (bucket) for (const item of bucket) out.push(item)
      }
    }
    return out
  }
}

/** Trunk and pole radii in metres. A lamp post is thin and still stops a car. */
const TREE_RADIUS = 0.42
const LAMP_RADIUS = 0.16

/**
 * What it takes to knock a piece of street furniture over.
 *
 * `breakEnergy` is in (metres/second)², i.e. the SQUARE of the speed the car closes on the prop at,
 * which is proportional to the kinetic energy the impact has to find somewhere to put. It is the
 * same measure `main.js` already shakes the camera by, and deliberately so: "energetic hits" is a
 * statement about energy, and energy goes with the square of speed. Linear in speed, a 10 km/h
 * bump and a 50 km/h crash are five apart; squared they are twenty-five apart, which is the gap the
 * player actually feels. Handy conversions: 14 → 13 km/h, 30 → 20 km/h, 56 → 27 km/h, 200 → 51 km/h.
 *
 * `hp` is how many qualifying hits it takes. Only the thick trees get more than one, because only a
 * tree is plausibly stronger than a car — everything else on this list is sheet metal or glass on a
 * thin post, and a car that hits one properly takes it with it.
 *
 * `hp: 0` means it does not break at all, and that is a design statement, not an omission:
 *  - `bollard` and `planter` are street ARMOUR. Their entire job in a real city is to stop a vehicle
 *    and not move, and a bollard you can flatten is worse than no bollard.
 *  - `forest` is the boundary wood (see `buildForest`). It is the wall that closes the world, and a
 *    player who can chew a gate through it can drive off the edge of the map.
 */
export const PROP_KINDS = {
  tree:    {r: TREE_RADIUS, hp: 1, breakEnergy: 56},   // hp is overridden per trunk: thick ones take 3
  lamp:    {r: LAMP_RADIUS, hp: 1, breakEnergy: 36},
  shelter: {r: 1.10, hp: 1, breakEnergy: 42},
  hydrant: {r: 0.22, hp: 1, breakEnergy: 26},
  bin:     {r: 0.22, hp: 1, breakEnergy: 14},
  bench:   {r: 0.55, hp: 1, breakEnergy: 30},
  bike:    {r: 0.45, hp: 1, breakEnergy: 30},
  sign:    {r: 0.06, hp: 1, breakEnergy: 24},
  bollard: {r: 0.11, hp: 0, breakEnergy: Infinity},
  planter: {r: 0.55, hp: 0, breakEnergy: Infinity},
  forest:  {r: TREE_RADIUS, hp: 0, breakEnergy: Infinity},
}

/**
 * The forest that closes the world.
 *
 * The slice has to end somewhere, and an invisible wall that shoves the car back is the worst way
 * to say so — the player feels a rule rather than a place. Luxembourg is surrounded by woodland,
 * so the map ends in trees: you are not stopped by physics, you are stopped by a forest, and the
 * collision that does it is the same point-obstacle test that already handles the 2,467 real trees
 * inside the city.
 *
 * INNER overlaps the built area so the streets thin into woodland rather than meeting it at a line.
 * SPACING is what makes it a wall: the gap must be narrower than the car, which is twice the car
 * radius plus a trunk, about 4.2m — so anything under that is genuinely impassable rather than
 * merely discouraging.
 */
// Master draws the visible boundary as a hedge-wall ON world.bounds, not as instanced trunks. The
// collision must therefore sit where that wall is: with the treeline 70m inside, the car stopped
// against nothing while the wood it could see stood hundreds of metres further out — the invisible
// wall again, wearing a nicer backdrop. Aligned to the face the player actually sees.
const FOREST_INNER = 6           // metres INSIDE the bounds where the treeline starts
const FOREST_OUTER = 130         // metres outside the bounds where it ends
const FOREST_SPACING = 3.6       // grid pitch before jitter
const FOREST_JITTER = 1.15       // so it is a wood and not an orchard

/** Deterministic, so the forest is the same place on every reload. */
function forestRand(seed) {
  return () => {
    seed |= 0; seed = (seed + 0x6D2B79F5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function buildForest(bounds) {
  const rand = forestRand(0x5c0de)
  const {minX, minY, maxX, maxY} = bounds
  const inner = {minX: minX + FOREST_INNER, minY: minY + FOREST_INNER,
                 maxX: maxX - FOREST_INNER, maxY: maxY - FOREST_INNER}
  const outer = {minX: minX - FOREST_OUTER, minY: minY - FOREST_OUTER,
                 maxX: maxX + FOREST_OUTER, maxY: maxY + FOREST_OUTER}
  const trees = []
  for (let x = outer.minX; x <= outer.maxX; x += FOREST_SPACING) {
    for (let y = outer.minY; y <= outer.maxY; y += FOREST_SPACING) {
      // Only the ring: everything strictly inside the inner rectangle is city, and stays city.
      if (x > inner.minX && x < inner.maxX && y > inner.minY && y < inner.maxY) continue
      // Thin the innermost rows so the treeline fades in rather than starting as a hedge.
      const intoX = Math.min(inner.minX - x, x - inner.maxX)
      const intoY = Math.min(inner.minY - y, y - inner.maxY)
      const depth = Math.max(intoX, intoY)                 // <0 inside the ring's inner lip
      if (depth < 20 && rand() > 0.25 + Math.max(0, depth) / 26) continue
      trees.push([
        x + (rand() - 0.5) * 2 * FOREST_JITTER,
        y + (rand() - 0.5) * 2 * FOREST_JITTER,
      ])
    }
  }
  return trees
}

const weldKey = (x, y) => `${Math.round(x / WELD)}:${Math.round(y / WELD)}`

export function buildWorld(city, findel = null) {
  const drivable = city.roads.filter(r => ROAD_KINDS[r.kind]?.drivable && r.pts.length >= 2)

  // Junctions are NOT just polyline ends. In OSM a side road habitually meets a main road at a
  // vertex in the MIDDLE of the main road's geometry, so welding endpoints alone leaves every
  // T-junction in the city invisible and the graph in disconnected stubs. A vertex shared by two
  // or more distinct ways is a junction wherever it falls, and roads are split there.
  const sharedBy = new Map()
  drivable.forEach((road, roadIndex) => {
    for (const [x, y] of road.pts) {
      const key = weldKey(x, y)
      const owners = sharedBy.get(key)
      if (owners) owners.add(roadIndex)
      else sharedBy.set(key, new Set([roadIndex]))
    }
  })
  const isJunction = (x, y) => (sharedBy.get(weldKey(x, y))?.size ?? 0) > 1

  const nodeSet = new NodeSet()
  const edges = []

  const addEdge = (pts, road) => {
    if (pts.length < 2) return
    const spec = ROAD_KINDS[road.kind]
    const a = nodeSet.at(pts[0][0], pts[0][1])
    const b = nodeSet.at(pts[pts.length - 1][0], pts[pts.length - 1][1])
    const edge = {
      id: edges.length,
      a, b, pts,
      kind: road.kind,
      name: road.name ?? null,
      // A per-road width baked into city.json WINS over the class default. tools/unblock-roads.mjs
      // narrows specific streets where a real building stands inside our invented carriageway and
      // cannot be moved out of it; without honouring that here those 141 narrowings were dead data
      // and the game went on painting — and colliding with — the full twelve metres.
      width: road.width ?? spec.width,
      oneway: !!road.oneway,
      pedestrianZone: spec.pedestrianZone,
      length: polylineLength(pts),
    }
    edges.push(edge)
    nodeSet.nodes[a].edges.push(edge.id)
    if (b !== a) nodeSet.nodes[b].edges.push(edge.id)
  }

  // An unknown kind was already dropped above rather than guessed: a road nobody can name is a
  // road neither of us can agree on the width of, which is what this table exists to prevent.
  for (const road of drivable) {
    let run = [road.pts[0]]
    for (let i = 1; i < road.pts.length; i++) {
      const pt = road.pts[i]
      run.push(pt)
      const last = i === road.pts.length - 1
      if (!last && isJunction(pt[0], pt[1])) {
        addEdge(run, road)
        run = [pt]
      }
    }
    addEdge(run, road)
  }

  // Trees standing in the middle of a road are an OSM artifact — a tree mapped against a way that
  // has since been widened, or a row recorded on the centreline. The renderer drops them so no tree
  // is drawn in the tarmac; the collision has to drop the SAME ones, or the player hits a trunk
  // that is not there. A render-side filter alone is how you get invisible obstacles in a road.
  const roadCells = new Map()
  for (const e of edges) {
    for (let i = 1; i < e.pts.length; i++) {
      const [ax, ay] = e.pts[i - 1], [bx, by] = e.pts[i]
      const seg = {ax, ay, bx, by, half: e.width * 0.5}
      const cx0 = Math.floor(Math.min(ax, bx) / GRID), cx1 = Math.floor(Math.max(ax, bx) / GRID)
      const cy0 = Math.floor(Math.min(ay, by) / GRID), cy1 = Math.floor(Math.max(ay, by) / GRID)
      for (let cx = cx0; cx <= cx1; cx++) {
        for (let cy = cy0; cy <= cy1; cy++) {
          const key = `${cx}:${cy}`
          const bucket = roadCells.get(key)
          if (bucket) bucket.push(seg)
          else roadCells.set(key, [seg])
        }
      }
    }
  }

  /**
   * Is (x, y) on a road surface? `margin` widens the test beyond the kerb, which is what the
   * dressing passes want: a bush should not merely miss the tarmac, it should sit clear of it.
   */
  function inCarriageway(x, y, margin = 0) {
    const cx = Math.floor(x / GRID), cy = Math.floor(y / GRID)
    for (let i = cx - 1; i <= cx + 1; i++) {
      for (let j = cy - 1; j <= cy + 1; j++) {
        const bucket = roadCells.get(`${i}:${j}`)
        if (!bucket) continue
        for (const s of bucket) {
          const dx = s.bx - s.ax, dy = s.by - s.ay
          const len2 = dx * dx + dy * dy
          const t = len2 > 0 ? Math.max(0, Math.min(1, ((x - s.ax) * dx + (y - s.ay) * dy) / len2)) : 0
          const px = s.ax + dx * t, py = s.ay + dy * t
          const reach = s.half + margin
          if ((x - px) ** 2 + (y - py) ** 2 < reach * reach) return true
        }
      }
    }
    return false
  }

  // Trees and lamps are NOT turned into obstacles here, and that is the fix for a long-standing
  // divergence rather than an oversight. This file used to filter the surveyed points against
  // `inCarriageway` and collide against what survived, on the assumption that the renderer dropped
  // exactly the same ones. It no longer does: a mapped tree standing in one of our invented
  // carriageways is now MOVED to the kerb and drawn there (`shoveClear`, src/render/clearance.js),
  // 540 trees and 51 lamps of them, so the filter deleted the collision for hundreds of trees that
  // are plainly visible a couple of metres away. And the renderer INVENTS far more than it moves —
  // ~10,000 street and park trees, ~4,900 synthetic lamps, 1,328 pieces of furniture — none of which
  // this file has ever heard of.
  //
  // So the renderer registers the final drawn positions through `registerProps` below, the same way
  // it already hands back its synthetic townhouse footprints through `registerBuildings`. One source
  // of truth: what is drawn is what is collided with.

  const buildings = city.buildings.map((b, id) => ({id, pts: b.pts, h: b.h, aabb: aabbOf(b.pts)}))

  let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity
  const stretch = (box) => {
    if (box.minX < minX) minX = box.minX
    if (box.minY < minY) minY = box.minY
    if (box.maxX > maxX) maxX = box.maxX
    if (box.maxY > maxY) maxY = box.maxY
  }
  for (const b of buildings) stretch(b.aabb)
  for (const e of edges) stretch(aabbOf(e.pts))

  // Findel sits east of the OSM slice, so unless its field is folded in here the airport falls
  // OUTSIDE the drivable world: the boundary hedge would close between the city and the terminal,
  // and driving out there would read as leaving the map. Stretch to contain it, plus a margin so
  // the treeline shuts beyond the apron rather than across it.
  if (findel) {
    const grow = (pts) => { if (pts?.length) stretch(aabbOf(pts)) }
    for (const r of (findel.runways ?? [])) grow(r)
    for (const b of (findel.buildings ?? [])) grow(b.pts)
    for (const a of (findel.aprons ?? [])) grow(a)
    for (const t of (findel.taxiways ?? [])) grow(t)
    maxX += 140; minY -= 140; maxY += 140
  }

  const bounds = {minX, minY, maxX, maxY}
  const forest = buildForest(bounds)

  // The boundary wood is the one point-obstacle set this file still owns outright: it is derived
  // here, from the bounds, and the renderer draws a hedge wall on the same line rather than these
  // trunks — so there is no drawn position for it to register back. Everything else arrives later.
  const obstacles = new PointGrid(forest.map(([x, y]) => ({
    x, y, r: TREE_RADIUS, kind: 'forest', hp: 0, breakEnergy: Infinity, broken: false, ref: null,
  })))

  return {
    bounds,
    /**
     * Register footprints that were invented by the renderer — the synthetic townhouses — so the
     * physics collides with them too. Without this they are scenery you drive straight through,
     * because the collision grid is built once, here, from the surveyed OSM footprints only.
     * `pts` are map coordinates, same as every other building.
     */
    registerBuildings(extra) {
      for (const b of extra) {
        buildings.push({id: buildings.length, pts: b.pts, h: b.h ?? 12, aabb: aabbOf(b.pts)})
      }
      this.grid = new Grid(buildings)     // one rebuild, at load; near() reads it every frame after
      return buildings.length
    },
    /**
     * Register the point obstacles the renderer actually DREW — the trees after they were shoved
     * clear of the tarmac and augmented, the synthetic lamps, the street furniture. The point-shaped
     * twin of `registerBuildings`, and the answer to the divergence described over `inCarriageway`:
     * placement is the renderer's business, so placement is where the collision has to come from.
     *
     * Each entry is `{x, y, kind, hp?, r?, ref?}` in MAP coordinates. `kind` keys `PROP_KINDS` for
     * the radius and the break threshold; `hp` overrides it (a thick tree); `ref` is an opaque
     * handle this file never opens — it is how the renderer finds the instance again when the
     * physics reports the thing broken.
     */
    registerProps(props) {
      for (const p of props) {
        const spec = PROP_KINDS[p.kind] ?? {}
        obstacles.add({
          x: p.x, y: p.y,
          r: p.r ?? spec.r ?? 0.3,
          kind: p.kind,
          hp: p.hp ?? spec.hp ?? 0,
          breakEnergy: p.breakEnergy ?? spec.breakEnergy ?? Infinity,
          broken: false,
          ref: p.ref ?? null,
        })
      }
      return obstacles.items.length
    },
    // Shared with every dressing pass so nothing gets planted on the tarmac. It was already used
    // here to keep surveyed trees and lamps off the carriageway; the bushes, plaza grass and park
    // scatter need exactly the same test, and a second implementation would drift from this one.
    onRoad: inCarriageway,
    nodes: nodeSet.nodes,
    edges,
    buildings,
    grid: new Grid(buildings),
    obstacles,
    /** The boundary wood, for the renderer to instance. Same shape as `trees`. */
    forest,
    /** Where the treeline begins, so the simulation can turn a car back at the kerb of the wood. */
    forestInner: FOREST_INNER,
    trees: city.trees,
    lamps: city.lamps,
    water: city.water,
    green: city.green,
    // Positional data the model does not derive anything from, carried through so both halves can
    // read it. Explicitly listed rather than spread: this object is the contract, and a silent
    // passthrough is how a consumer ends up depending on a key nobody documented.
    signals: city.signals ?? [],
    crossings: city.crossings ?? [],
    cafes: city.cafes ?? [],
    postboxes: city.postboxes ?? [],
    monuments: city.monuments ?? [],
    steps: city.steps ?? [],
    fountains: city.fountains ?? [],
    squares: city.squares ?? [],
  }
}
