// Distance-parameterized lane paths. Position and heading come from the same curve,
// so a stopped vehicle cannot rotate and a turning bus cannot slide sideways.
const wrap = angle => Math.atan2(Math.sin(angle), Math.cos(angle))

function pathFrom(points) {
  const distances = [0]
  for (let i = 1; i < points.length; i++) {
    distances.push(distances[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y))
  }
  return {points, distances, length: distances.at(-1)}
}

export function samplePath(path, distance) {
  const d = Math.max(0, Math.min(path.length, distance))
  let low = 0, high = path.points.length - 1
  while (low + 1 < high) {
    const mid = (low + high) >> 1
    if (path.distances[mid] <= d) low = mid
    else high = mid
  }
  const a = path.points[low], b = path.points[high]
  const length = path.distances[high] - path.distances[low]
  const t = length > 0 ? (d - path.distances[low]) / length : 0
  return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t,
    heading: a.heading + wrap(b.heading - a.heading) * t}
}

export function createLanePath(edge, dir, lane, radius = 7) {
  const raw = dir > 0 ? edge.pts : [...edge.pts].reverse()
  const centres = raw.filter((p, i) => !i || Math.hypot(p[0] - raw[i - 1][0], p[1] - raw[i - 1][1]) > 0.001)
  const offset = edge.oneway && edge.width < 6 ? 0 : edge.width * 0.25 * (edge.oneway ? lane : 1)
  const unit = (a, b) => {
    const length = Math.hypot(b[0] - a[0], b[1] - a[1]) || 1
    return [(b[0] - a[0]) / length, (b[1] - a[1]) / length]
  }
  const lanePoints = centres.map((point, i) => {
    const before = unit(centres[Math.max(0, i - 1)], centres[i === 0 ? 1 : i])
    const after = unit(centres[i === centres.length - 1 ? i - 1 : i], centres[Math.min(centres.length - 1, i + 1)])
    let nx = before[1] + after[1], ny = -before[0] - after[0]
    const length = Math.hypot(nx, ny)
    if (length < 0.001) { nx = before[1]; ny = -before[0] }
    else { nx /= length; ny /= length }
    const miter = offset / Math.max(0.5, nx * before[1] - ny * before[0])
    return [point[0] + nx * miter, point[1] + ny * miter]
  })
  const points = []
  const add = (x, y, heading) => {
    const last = points.at(-1)
    if (last && Math.hypot(last.x - x, last.y - y) < 0.001) { last.heading = heading; return }
    points.push({x, y, heading})
  }
  const first = unit(lanePoints[0], lanePoints[1])
  add(...lanePoints[0], Math.atan2(first[1], first[0]))
  for (let i = 1; i < lanePoints.length - 1; i++) {
    const a = lanePoints[i - 1], b = lanePoints[i], c = lanePoints[i + 1]
    const incoming = unit(a, b), outgoing = unit(b, c)
    const angle = Math.acos(Math.max(-1, Math.min(1, incoming[0] * outgoing[0] + incoming[1] * outgoing[1])))
    const trim = Math.min(radius * Math.tan(angle / 2), Math.hypot(b[0] - a[0], b[1] - a[1]) * 0.4,
      Math.hypot(c[0] - b[0], c[1] - b[1]) * 0.4)
    const start = [b[0] - incoming[0] * trim, b[1] - incoming[1] * trim]
    const end = [b[0] + outgoing[0] * trim, b[1] + outgoing[1] * trim]
    add(...start, Math.atan2(incoming[1], incoming[0]))
    const steps = Math.max(2, Math.ceil(trim * 2 / 0.5))
    for (let j = 1; j <= steps; j++) {
      const t = j / steps, u = 1 - t
      const dx = u * (b[0] - start[0]) + t * (end[0] - b[0])
      const dy = u * (b[1] - start[1]) + t * (end[1] - b[1])
      add(u * u * start[0] + 2 * u * t * b[0] + t * t * end[0],
        u * u * start[1] + 2 * u * t * b[1] + t * t * end[1], Math.atan2(dy, dx))
    }
  }
  const last = unit(lanePoints.at(-2), lanePoints.at(-1))
  add(...lanePoints.at(-1), Math.atan2(last[1], last[0]))
  return pathFrom(points)
}

export function createJunctionPath(from, to, radius = 7) {
  const trimA = Math.min(radius, from.length * 0.4), trimB = Math.min(radius, to.length * 0.4)
  const a = samplePath(from, from.length - trimA), d = samplePath(to, trimB)
  const separation = Math.hypot(d.x - a.x, d.y - a.y)
  const handle = Math.max(1, separation * 0.55)
  const b = {x: a.x + Math.cos(a.heading) * handle, y: a.y + Math.sin(a.heading) * handle}
  const c = {x: d.x - Math.cos(d.heading) * handle, y: d.y - Math.sin(d.heading) * handle}
  const steps = Math.max(12, Math.ceil((separation + handle * 2) / 0.4))
  const points = []
  for (let i = 0; i <= steps; i++) {
    const t = i / steps, u = 1 - t
    const dx = u * u * (b.x - a.x) + 2 * u * t * (c.x - b.x) + t * t * (d.x - c.x)
    const dy = u * u * (b.y - a.y) + 2 * u * t * (c.y - b.y) + t * t * (d.y - c.y)
    points.push({x: u ** 3 * a.x + 3 * u * u * t * b.x + 3 * u * t * t * c.x + t ** 3 * d.x,
      y: u ** 3 * a.y + 3 * u * u * t * b.y + 3 * u * t * t * c.y + t ** 3 * d.y,
      heading: Math.atan2(dy, dx)})
  }
  return {...pathFrom(points), start: from.length - trimA, end: trimB}
}
