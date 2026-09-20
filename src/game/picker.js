// The laser pointer: what is under the cursor, outlined, and what you can do to it.
//
// A ray is cast from the mouse through the camera every frame. Whatever it hits first is outlined;
// clicking it opens a small floating panel of edits — delete, spin, nudge — that stays open so you
// can tap a rotation five times without re-selecting.
//
// Two kinds of thing can be picked, and the difference runs through the whole file:
//
//   a MESH is one object. Move it by writing its position.
//   an INSTANCE is one slot inside an InstancedMesh — one bench out of four hundred sharing a
//   single draw call. It has no Object3D of its own, so "its position" is a matrix at an index.
//   Everything here therefore works in terms of (object, instanceId) rather than an object alone.
//
// Baked geometry is skipped: the ground, roads, pavements and terraces are merged meshes holding
// thousands of unrelated things, where "the object under the cursor" is not a thing that exists.
// The renderer marks those with userData.baked.

import * as THREE from 'three'

/** How far a single nudge moves, and a single rotation turns. */
const NUDGE = 0.10                    // metres
const SPIN = 10 * Math.PI / 180       // radians

const OUTLINE_COLOUR = 0x4fd2ff
const OUTLINE_HOVER = 0xffd166

export function createPicker(scene, camera, domElement) {
  const ray = new THREE.Raycaster()
  const ndc = new THREE.Vector2(-2, -2)      // off-screen until the mouse moves
  let havePointer = false

  // The outline. A wireframe box that wraps whatever is picked — it reads from any angle, costs one
  // draw call, and works identically for a mesh and for one instance inside an InstancedMesh, which
  // a material tint does not.
  const boxGeo = new THREE.BoxGeometry(1, 1, 1)
  const outline = new THREE.LineSegments(
    new THREE.EdgesGeometry(boxGeo),
    new THREE.LineBasicMaterial({color: OUTLINE_HOVER, depthTest: false, transparent: true, opacity: 0.95}),
  )
  outline.renderOrder = 999
  outline.visible = false
  outline.frustumCulled = false
  scene.add(outline)

  // The parcel layer is picked differently from everything else: it is one merged mesh holding
  // hundreds of parcels, so the hit's FACE index — not the object — says which one you touched.
  const parcels = () => scene.userData.parcels ?? null
  const parcelAt = (hit) => {
    if (!hit.object.userData?.isParcelLayer) return null
    const id = hit.object.userData.faceParcel?.[hit.faceIndex]
    return id === undefined ? null : id
  }

  // A parcel gets its own outline: the polygon itself, traced. A bounding box around a block-sized
  // concave shape tells you nothing about which land you have selected.
  const ring = new THREE.LineLoop(
    new THREE.BufferGeometry(),
    new THREE.LineBasicMaterial({color: OUTLINE_COLOUR, depthTest: false, transparent: true, opacity: 0.95}),
  )
  ring.renderOrder = 999
  ring.visible = false
  ring.frustumCulled = false
  scene.add(ring)

  // OFF at boot, and on only when somebody asks for it with 5 in the feedback dialog.
  //
  // This is a developer tool, and the cost of having it on is paid every frame by everybody: update()
  // raycasts the entire scene graph recursively, and the city is tens of thousands of instanced
  // objects. A player who has just cloned the repository meets a stuttering city and concludes the
  // game is slow, which is not a first impression a later commit can undo. update() already returns
  // immediately when this is false, so off costs nothing at all.
  let enabled = false
  let frames = 0         // how many times the frame loop has driven us
  let hover = null       // {object, instanceId} under the cursor right now
  let selected = null    // {object, instanceId} the panel is editing
  const box = new THREE.Box3()
  const size = new THREE.Vector3()
  const centre = new THREE.Vector3()
  const mat = new THREE.Matrix4()
  const pos = new THREE.Vector3()
  const quat = new THREE.Quaternion()
  const scl = new THREE.Vector3()
  const euler = new THREE.Euler()

  /** Is this hit something the editor may touch? Walks up, because baked is set on the root. */
  function pickable(o) {
    for (let n = o; n; n = n.parent) {
      if (n.userData?.baked) return false
      if (n.userData?.noPick) return false
    }
    return true
  }

  // --- reading and writing a target's transform ------------------------------------------------
  // For a mesh these go straight to the Object3D. For an instance they decompose the matrix at the
  // slot, change it, and recompose — the instance has nowhere else to keep the value.
  function readMatrix(t) {
    if (t.instanceId === undefined || t.instanceId === null) return t.object.matrixWorld.clone()
    t.object.getMatrixAt(t.instanceId, mat)
    return mat.clone().premultiply(t.object.matrixWorld)
  }

  function edit(t, fn) {
    if (t.instanceId === undefined || t.instanceId === null) {
      t.object.position.copy(t.object.position)
      fn(t.object.position, t.object.rotation, t.object.scale)
      t.object.updateMatrixWorld(true)
      return
    }
    t.object.getMatrixAt(t.instanceId, mat)
    mat.decompose(pos, quat, scl)
    euler.setFromQuaternion(quat, 'YXZ')
    fn(pos, euler, scl)
    quat.setFromEuler(euler)
    mat.compose(pos, quat, scl)
    t.object.setMatrixAt(t.instanceId, mat)
    t.object.instanceMatrix.needsUpdate = true
    if (t.object.computeBoundingSphere) t.object.computeBoundingSphere()
  }

  /** World-space bounds of a target, so the outline can wrap it. */
  function boundsOf(t) {
    if (t.instanceId === undefined || t.instanceId === null) {
      box.setFromObject(t.object)
      return box
    }
    const g = t.object.geometry
    if (!g.boundingBox) g.computeBoundingBox()
    box.copy(g.boundingBox)
    box.applyMatrix4(readMatrix(t))
    return box
  }

  function placeOutline(t, colour) {
    const b = boundsOf(t)
    if (b.isEmpty()) { outline.visible = false; return }
    b.getSize(size); b.getCenter(centre)
    // A zero-thickness box (a flat sign) would render as nothing; give every axis a floor.
    outline.scale.set(Math.max(size.x, 0.05), Math.max(size.y, 0.05), Math.max(size.z, 0.05))
    outline.position.copy(centre)
    outline.material.color.setHex(colour)
    outline.visible = true
  }

  /** Trace a parcel's own boundary, lifted clear of the ground so it is not z-fought away. */
  function placeRing(id, colour) {
    const info = parcels()?.info(id)
    if (!info) { ring.visible = false; return }
    const pts = new Float32Array(info.pts.length * 3)
    const y = 0.06 + (info.bevel ?? 0)
    info.pts.forEach(([x, z], i) => { pts[i * 3] = x; pts[i * 3 + 1] = y; pts[i * 3 + 2] = -z })
    ring.geometry.dispose()
    ring.geometry = new THREE.BufferGeometry()
    ring.geometry.setAttribute('position', new THREE.BufferAttribute(pts, 3))
    ring.material.color.setHex(colour)
    ring.visible = true
  }

  // Every edit is applied to the live scene AND written to the journal. The scene is rebuilt from
  // city.json on reload, so without the second half an afternoon of decisions dies with the tab.
  // A failed POST is not an error: in a production build there is no dev server listening.
  function journal(action, target, value) {
    try {
      fetch('/__feedback', {
        method: 'POST', headers: {'Content-Type': 'application/json'},
        body: JSON.stringify({kind: 'edit', action, target, value}),
      }).catch(() => {})
    } catch { /* built copy: nothing is listening, and that is fine */ }
  }

  // --- the floating panel -----------------------------------------------------------------------
  const panel = document.createElement('div')
  Object.assign(panel.style, {
    position: 'fixed', zIndex: '60', display: 'none', minWidth: '210px',
    background: 'rgba(14,18,26,.94)', border: '1px solid rgba(255,255,255,.14)',
    borderRadius: '10px', padding: '10px 12px 12px', color: '#fff',
    font: '600 12px system-ui, -apple-system, sans-serif', letterSpacing: '.2px',
    boxShadow: '0 10px 30px rgba(0,0,0,.5)', userSelect: 'none',
  })
  document.body.appendChild(panel)

  const titleEl = document.createElement('div')
  Object.assign(titleEl.style, {opacity: '.85', fontSize: '12px', letterSpacing: '.3px', marginBottom: '9px', paddingRight: '20px'})
  panel.appendChild(titleEl)

  const closeEl = document.createElement('button')
  closeEl.textContent = '✕'
  Object.assign(closeEl.style, {
    position: 'absolute', top: '6px', right: '7px', width: '20px', height: '20px', lineHeight: '18px',
    background: 'transparent', color: 'rgba(255,255,255,.6)', border: '0', cursor: 'pointer',
    fontSize: '13px', padding: '0',
  })
  closeEl.onclick = () => deselect()
  panel.appendChild(closeEl)

  const btn = (label, onClick, wide = false) => {
    const b = document.createElement('button')
    b.textContent = label
    Object.assign(b.style, {
      background: 'rgba(255,255,255,.08)', color: '#fff', border: '1px solid rgba(255,255,255,.14)',
      borderRadius: '6px', padding: '5px 0', cursor: 'pointer', font: 'inherit',
      flex: wide ? '1 1 100%' : '1 1 0', minWidth: '0',
    })
    b.onmouseenter = () => { b.style.background = 'rgba(255,255,255,.18)' }
    b.onmouseleave = () => { b.style.background = 'rgba(255,255,255,.08)' }
    b.onclick = (e) => { e.stopPropagation(); onClick() }
    return b
  }

  /** One labelled row of controls: a caption, then the buttons. */
  const row = (caption, ...kids) => {
    const wrap = document.createElement('div')
    Object.assign(wrap.style, {marginBottom: '7px'})
    if (caption) {
      const c = document.createElement('div')
      c.textContent = caption
      Object.assign(c.style, {opacity: '.5', fontSize: '10px', letterSpacing: '.8px', marginBottom: '3px'})
      wrap.appendChild(c)
    }
    const line = document.createElement('div')
    Object.assign(line.style, {display: 'flex', gap: '6px', flexWrap: 'wrap'})
    for (const k of kids) line.appendChild(k)
    wrap.appendChild(line)
    panel.appendChild(wrap)
    return wrap
  }

  // Two panels' worth of controls in one panel: an OBJECT can be spun, nudged and deleted; a PARCEL
  // is land and can only be surfaced and raised. Which set is shown is decided by what you clicked.
  //
  // Rotation is about the VERTICAL axis — Three's Y — whatever the panel calls it. Moves are in map
  // coordinates, so +y is north, and Three's z is its negation: that sign lives here and nowhere else.
  const objectRows = []
  const parcelRows = []
  const rowFor = (bag, caption, ...kids) => { const w = row(caption, ...kids); bag.push(w); return w }
  const setMode = (mode) => {
    for (const w of objectRows) w.style.display = mode === 'object' ? '' : 'none'
    for (const w of parcelRows) w.style.display = mode === 'parcel' ? '' : 'none'
  }

  rowFor(objectRows, 'ROTATE  (vertical axis)',
    btn('↺ −10°', () => selected && edit(selected, (_p, r) => { r.y -= SPIN })),
    btn('↻ +10°', () => selected && edit(selected, (_p, r) => { r.y += SPIN })))
  rowFor(objectRows, 'MOVE X',
    btn('−10 cm', () => selected && edit(selected, (p) => { p.x -= NUDGE })),
    btn('+10 cm', () => selected && edit(selected, (p) => { p.x += NUDGE })))
  rowFor(objectRows, 'MOVE Y',
    btn('−10 cm', () => selected && edit(selected, (p) => { p.z += NUDGE })),
    btn('+10 cm', () => selected && edit(selected, (p) => { p.z -= NUDGE })))
  const terrainBtn = (kind, label) => btn(label, () => {
    if (selected?.parcelId === undefined) return
    parcels()?.setTerrain(selected.parcelId, kind)
    journal('terrain', `parcel ${selected.parcelId}`, kind)
    titleEl.textContent = labelFor(selected)
  })
  rowFor(parcelRows, 'TERRAIN',
    terrainBtn('none', 'None'), terrainBtn('grass', 'Grass'), terrainBtn('concrete', 'Concrete'))
  const bevelBtn = (delta, label) => btn(label, () => {
    if (selected?.parcelId === undefined) return
    parcels()?.bevel(selected.parcelId, delta)
    journal('bevel', `parcel ${selected.parcelId}`, parcels()?.info(selected.parcelId)?.bevel)
    titleEl.textContent = labelFor(selected)
  })
  rowFor(parcelRows, 'BEVEL', bevelBtn(-0.10, '−10 cm'), bevelBtn(0.10, '+10 cm'))

  const delBtn = btn('Delete', () => remove(), true)
  delBtn.style.background = 'rgba(200,60,50,.22)'
  delBtn.style.borderColor = 'rgba(255,90,80,.4)'
  delBtn.onmouseenter = () => { delBtn.style.background = 'rgba(200,60,50,.38)' }
  delBtn.onmouseleave = () => { delBtn.style.background = 'rgba(200,60,50,.22)' }
  rowFor(objectRows, '', delBtn)

  // Deleting an instance cannot remove a slot from an InstancedMesh without renumbering every slot
  // after it — and the renderer hands out those indices. Collapsing it to zero scale removes it from
  // sight and from the picker at the cost of one degenerate triangle fan, which is the honest trade.
  function remove() {
    if (!selected || selected.parcelId !== undefined) return   // land cannot be deleted, only surfaced
    if (selected.instanceId === undefined || selected.instanceId === null) selected.object.visible = false
    else edit(selected, (_p, _r, s) => { s.set(0, 0, 0) })
    deselect()
  }

  // Every floater names WHAT it is and WHICH one — "Parcel 123", "Pedestrian 456", "Tree 789" —
  // because a number you can read out is the only way to talk about a thing in a city of thousands.
  // The kind is carried on the geometry by whoever built it (userData.kind); failing that the
  // nearest named ancestor stands in. The number is the instance slot for instanced geometry, and
  // Three's own object id for a lone mesh — stable for the life of the session either way.
  function kindOf(o) {
    for (let n = o; n; n = n.parent) if (n.userData?.kind) return n.userData.kind
    for (let n = o; n; n = n.parent) if (n.name) return n.name[0].toUpperCase() + n.name.slice(1)
    return 'Object'
  }

  function labelFor(t) {
    if (t.parcelId !== undefined) {
      const i = parcels()?.info(t.parcelId)
      if (!i) return `Parcel ${t.parcelId}`
      const bits = [`${Math.round(i.area)} m²`, i.terrain]
      if (i.bevel) bits.push(`${i.bevel > 0 ? '+' : ''}${Math.round(i.bevel * 100)} cm`)
      if (i.thin) bits.push('thin')
      return `Parcel ${t.parcelId} · ${bits.join(' · ')}`
    }
    const n = t.instanceId ?? t.object.id
    return `${kindOf(t.object)} ${n}`
  }

  function select(t, clientX, clientY) {
    selected = t
    setMode(t.parcelId !== undefined ? 'parcel' : 'object')
    titleEl.textContent = labelFor(t)
    panel.style.display = 'block'
    // Keep the panel on screen even when you click something near the right or bottom edge.
    const pad = 12
    panel.style.left = '0px'; panel.style.top = '0px'
    const r = panel.getBoundingClientRect()
    panel.style.left = `${Math.min(clientX + 14, window.innerWidth - r.width - pad)}px`
    panel.style.top = `${Math.min(clientY + 14, window.innerHeight - r.height - pad)}px`
  }

  function deselect() {
    selected = null
    panel.style.display = 'none'
    ring.visible = false
  }

  // --- input -------------------------------------------------------------------------------------
  const onMove = (e) => {
    const r = domElement.getBoundingClientRect()
    ndc.x = ((e.clientX - r.left) / r.width) * 2 - 1
    ndc.y = -((e.clientY - r.top) / r.height) * 2 + 1
    havePointer = true
  }
  let lastDownAt = 0
  const onDown = (e) => {
    if (!enabled) return
    if (panel.contains(e.target)) return          // the panel's own buttons are not the world
    if (e.button !== 0) return
    // pointerdown and mousedown both fire for one real press; take the first and ignore its twin.
    const now = (typeof performance !== 'undefined' ? performance.now() : 0)
    if (now - lastDownAt < 40) return
    lastDownAt = now
    if (hover) select({...hover}, e.clientX, e.clientY)
    else deselect()
  }
  const onKey = (e) => { if (e.code === 'Escape' && selected) { deselect(); e.stopPropagation() } }
  // Both, deliberately: pointer events are the modern path, but synthesised input (a headless
  // harness, some remote-control setups) only ever produces the mouse ones, and a pointer that
  // never reports a position means nothing is ever highlighted.
  domElement.addEventListener('pointermove', onMove)
  domElement.addEventListener('mousemove', onMove)
  domElement.addEventListener('pointerdown', onDown)
  domElement.addEventListener('mousedown', onDown)
  window.addEventListener('keydown', onKey)

  return {
    /** Cast the ray and move the outline. Called every frame, after the world has been stepped. */
    update() {
      frames++
      if (!enabled || !havePointer) return
      ray.setFromCamera(ndc, camera)
      const hits = ray.intersectObjects(scene.children, true)
      let found = null
      for (const h of hits) {
        if (h.object === outline) continue
        const m = Array.isArray(h.object.material) ? h.object.material[0] : h.object.material
        if (!m || m.visible === false) continue
        // The parcel layer is deliberately invisible until something is painted on it, and it must
        // stay clickable the whole time — so it is the one layer whose visibility is not a veto.
        if (!h.object.visible && !h.object.userData?.isParcelLayer) continue
        if (!pickable(h.object)) continue         // baked: the ray passes through it
        const pid = parcelAt(h)
        found = pid === null ? {object: h.object, instanceId: h.instanceId} : {parcelId: pid}
        break
      }
      hover = found
      // The selection wins the outline: while the panel is open you are watching the thing you are
      // editing, not whatever the cursor has drifted over.
      const shown = selected ?? hover
      if (!shown) { outline.visible = false; ring.visible = false; return }
      const colour = selected ? OUTLINE_COLOUR : OUTLINE_HOVER
      if (shown.parcelId !== undefined) { outline.visible = false; placeRing(shown.parcelId, colour) }
      else { ring.visible = false; placeOutline(shown, colour) }
      if (selected) titleEl.textContent = labelFor(selected)
    },
    isEnabled: () => enabled,
    /** Off means off: no ray cast, no outline, no panel, and clicks fall through to the world. */
    setEnabled(v) {
      enabled = !!v
      if (!enabled) { deselect(); hover = null; outline.visible = false; ring.visible = false }
    },
    isOpen: () => selected !== null,
    selection: () => (selected ? {label: labelFor(selected), parcelId: selected.parcelId ?? null} : null),
    /** What the ray is on right now. Exposed because "nothing highlighted" has three causes —
     *  no pointer yet, a ray that hits only baked geometry, or a frame loop not calling update. */
    debug: () => ({havePointer, frames, ndc: {x: +ndc.x.toFixed(3), y: +ndc.y.toFixed(3)},
                   hover: hover ? (hover.parcelId !== undefined ? {parcelId: hover.parcelId}
                                  : {type: hover.object.type, instanceId: hover.instanceId ?? null}) : null}),
    dispose() {
      domElement.removeEventListener('pointermove', onMove)
      domElement.removeEventListener('mousemove', onMove)
      domElement.removeEventListener('pointerdown', onDown)
      domElement.removeEventListener('mousedown', onDown)
      window.removeEventListener('keydown', onKey)
      panel.remove()
      scene.remove(outline)
      scene.remove(ring)
    },
  }
}
