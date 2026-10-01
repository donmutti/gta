# GTA Luxembourg — backlog

## Further terrain detail

The 8 m ACT LiDAR terrain, named bridge decks, valley rivers, terrain placement and slope-aware driving are implemented. Further fidelity could use OSM bridge tags for unnamed spans, surveyed bridge deck altitudes instead of bank interpolation, and a finer riverbank mesh. The relocated airport deliberately uses a graded platform.

## Measure the frame rate on a phone, and turn the knobs only if it is bad
The mobile controls shipped and the game was played on a real iPhone without anybody complaining about it being slow, so the performance work planned in `docs/mobile-controls.md` section 6 "Performance on a real phone" was never needed and no knob was turned. The number itself was never captured.
- The workload is 844 draw calls and 8.4 million triangles per frame, which is comfortable on a laptop GPU and large for a phone throttling under a browser.
- The knobs, cheapest first: the renderer's pixel-ratio cap (1.5 today, and 1.0 would remove more than half the shaded pixels at arm's length), then fog and tile streaming radius, then crowd and traffic counts (340 people and 120 vehicles) which are visible and should be last.
- Get a number before touching any of them. Guessing about performance is how a game ends up slower and uglier at once, and the one thing known today is that nobody has complained.
Effort: small to measure, unknown to act on. Added on 2026-09-21.
