#!/usr/bin/env node
// Fetches the game's slice of Luxembourg from Overpass, once, at build time.
// The output is committed: the game never touches the network at play time.
//
// Slice: Ville-Haute + Kirchberg + the Pont Rouge across the Pfaffenthal gorge.
const BBOX = "49.600,6.115,49.625,6.145"; // south,west,north,east
const UA = "gta-lux-build/0.1 (personal project)";

const query = `
[out:json][timeout:90];
(
  way["highway"~"^(motorway|trunk|primary|secondary|tertiary|residential|unclassified|living_street|pedestrian|service)$"](${BBOX});
  way["building"](${BBOX});
  node["natural"="tree"](${BBOX});
  node["highway"="street_lamp"](${BBOX});
  node["highway"="traffic_signals"](${BBOX});
  node["highway"="crossing"](${BBOX});
  node["amenity"~"^(cafe|restaurant|bar)$"](${BBOX});
  node["amenity"="post_box"](${BBOX});
  node["historic"~"^(monument|memorial|statue)$"](${BBOX});
  node["amenity"="fountain"](${BBOX});
  way["amenity"="fountain"](${BBOX});
  way["highway"="steps"](${BBOX});
  way["natural"="water"](${BBOX});
  way["waterway"="river"](${BBOX});
  way["leisure"~"^(park|garden)$"](${BBOX});
  way["place"="square"](${BBOX});
  way["highway"="pedestrian"]["area"="yes"](${BBOX});
  way["landuse"~"^(grass|forest)$"](${BBOX});
);
out body; >; out skel qt;`;

const res = await fetch("https://overpass-api.de/api/interpreter", {
  method: "POST",
  headers: { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded" },
  body: "data=" + encodeURIComponent(query),
});
if (!res.ok) { console.error("Overpass answered", res.status); process.exit(1); }
const raw = await res.json();

// Index nodes, then denormalize ways into coordinate arrays. Local meters via an
// equirectangular projection centred on the slice — fine at city scale, and it keeps
// the game in a flat XY world with +Y = north.
const nodes = new Map();
for (const el of raw.elements) if (el.type === "node") nodes.set(el.id, el);
const [S, W, N, E] = BBOX.split(",").map(Number);
const lat0 = (S + N) / 2, lon0 = (W + E) / 2;
const R = 6378137, DEG = Math.PI / 180;
const toXY = (lat, lon) => [ (lon - lon0) * DEG * R * Math.cos(lat0 * DEG), (lat - lat0) * DEG * R ];

const out = { roads: [], buildings: [], trees: [], lamps: [], water: [], green: [], signals: [], crossings: [], cafes: [], postboxes: [], monuments: [], steps: [], fountains: [], squares: [] };

// Centroid of a closed ring, and its rough radius, so a square can host a fountain at its middle
// and we know how far its edge is for bush-lining. Simple average-of-vertices — good enough for
// the compact, roughly-convex plazas Luxembourg actually has.
const centroid = (pts) => {
  let x = 0, y = 0;
  for (const [px, py] of pts) { x += px; y += py; }
  return [x / pts.length, y / pts.length];
};
const radiusOf = (pts, c) => {
  let r = 0;
  for (const [px, py] of pts) r = Math.max(r, Math.hypot(px - c[0], py - c[1]));
  return r;
};
for (const el of raw.elements) {
  if (el.type === "node") {
    if (el.tags?.natural === "tree") out.trees.push(toXY(el.lat, el.lon));
    if (el.tags?.highway === "street_lamp") out.lamps.push(toXY(el.lat, el.lon));
    if (el.tags?.highway === "traffic_signals") out.signals.push(toXY(el.lat, el.lon));
    if (el.tags?.highway === "crossing") out.crossings.push(toXY(el.lat, el.lon));
    if (/^(cafe|restaurant|bar)$/.test(el.tags?.amenity ?? "")) out.cafes.push(toXY(el.lat, el.lon));
    if (el.tags?.amenity === "post_box") out.postboxes.push(toXY(el.lat, el.lon));
    if (/^(monument|memorial|statue)$/.test(el.tags?.historic ?? "")) out.monuments.push(toXY(el.lat, el.lon));
    if (el.tags?.amenity === "fountain") out.fountains.push(toXY(el.lat, el.lon));
    continue;
  }
  if (el.type !== "way" || !el.nodes) continue;
  const pts = el.nodes.map(id => nodes.get(id)).filter(Boolean).map(n => toXY(n.lat, n.lon));
  if (pts.length < 2) continue;
  const t = el.tags ?? {};
  if (t.highway === "steps") {
    out.steps.push(pts);
  } else if (t.amenity === "fountain") {
    out.fountains.push(centroid(pts));            // a mapped fountain footprint -> its middle
  } else if (t.place === "square" || (t.highway === "pedestrian" && t.area === "yes")) {
    const c = centroid(pts);
    out.squares.push({ c, r: radiusOf(pts, c), pts });
  } else if (t.highway) {
    out.roads.push({ pts, kind: t.highway, name: t.name ?? null, oneway: t.oneway === "yes" });
  } else if (t.building) {
    // levels -> meters; OSM height wins where present. Default 3 levels: Luxembourg is low-rise.
    const h = t.height ? parseFloat(t.height) : (parseInt(t["building:levels"] ?? "3", 10) || 3) * 3.2;
    out.buildings.push({ pts, h: Math.min(Math.max(h, 4), 120) });
  } else if (t.natural === "water" || t.waterway === "river") {
    out.water.push(pts);
  } else if (t.leisure === "park" || t.leisure === "garden" || t.landuse === "grass" || t.landuse === "forest") {
    out.green.push(pts);
  }
}
const meta = { bbox: BBOX, origin: [lat0, lon0], fetched: new Date().toISOString(),
  counts: Object.fromEntries(Object.entries(out).map(([k, v]) => [k, v.length])) };
await import("node:fs").then(fs => {
  fs.writeFileSync("public/data/city.json", JSON.stringify({ meta, ...out }));
});
console.log(JSON.stringify(meta.counts), "->", "public/data/city.json");
