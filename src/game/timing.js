// The first animation timestamp can precede the end of a long scene build.
// Never integrate a negative step: exponential damping would amplify velocity.
export function simulationDelta(now, previous) {
  return previous === null ? 0 : Math.max(0, Math.min((now - previous) / 1000, 1 / 20))
}
