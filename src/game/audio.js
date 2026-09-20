// Sound, synthesised. No audio files anywhere — every voice here is oscillators and filtered
// noise, which keeps the repository weightless and means nothing to load before the first frame.
//
// Browsers refuse to start audio before a gesture, so the context is created suspended and resumed
// on the first key the player presses. Until then the game is silent and nothing throws.

/** Engine note at idle, and how much the pitch climbs with speed. */
const IDLE_HZ = 46
const HZ_PER_MS = 2.6
/** The gearbox: the note drops back as each ratio catches, which is most of what sells an engine. */
const GEARS = [0, 11, 19, 27, 36]

export function createAudio() {
  let ctx = null
  let started = false
  const nodes = {}

  function build() {
    ctx = new (window.AudioContext || window.webkitAudioContext)()

    const master = ctx.createGain()
    master.gain.value = 0.55
    master.connect(ctx.destination)

    // --- engine: two detuned saws through a lowpass, which reads as an engine where one does not.
    const engineGain = ctx.createGain()
    engineGain.gain.value = 0
    const engineFilter = ctx.createBiquadFilter()
    engineFilter.type = 'lowpass'
    engineFilter.frequency.value = 600
    engineFilter.Q.value = 3
    const oscA = ctx.createOscillator()
    const oscB = ctx.createOscillator()
    oscA.type = 'sawtooth'
    oscB.type = 'sawtooth'
    oscB.detune.value = 14
    oscA.connect(engineFilter)
    oscB.connect(engineFilter)
    engineFilter.connect(engineGain)
    engineGain.connect(master)
    oscA.start()
    oscB.start()

    // --- tyres: filtered white noise, opened only when the car is actually sliding.
    const noiseBuffer = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate)
    const data = noiseBuffer.getChannelData(0)
    for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1
    const noise = ctx.createBufferSource()
    noise.buffer = noiseBuffer
    noise.loop = true
    const tyreFilter = ctx.createBiquadFilter()
    tyreFilter.type = 'bandpass'
    tyreFilter.frequency.value = 1800
    tyreFilter.Q.value = 1.2
    const tyreGain = ctx.createGain()
    tyreGain.gain.value = 0
    noise.connect(tyreFilter)
    tyreFilter.connect(tyreGain)
    tyreGain.connect(master)
    noise.start()

    // --- siren: a square tone swept between two pitches, gated by the wanted level.
    const sirenOsc = ctx.createOscillator()
    sirenOsc.type = 'square'
    sirenOsc.frequency.value = 660
    const sirenFilter = ctx.createBiquadFilter()
    sirenFilter.type = 'lowpass'
    sirenFilter.frequency.value = 1400
    const sirenGain = ctx.createGain()
    sirenGain.gain.value = 0
    sirenOsc.connect(sirenFilter)
    sirenFilter.connect(sirenGain)
    sirenGain.connect(master)
    sirenOsc.start()

    // --- impacts: a one-shot noise burst through a lowpass, pitched by how hard you hit. Built
    // from the same noise buffer, so a crash costs one BufferSource and nothing is preloaded.
    nodes.thud = (force) => {
      const src = ctx.createBufferSource()
      src.buffer = noiseBuffer
      src.loop = false
      const f = ctx.createBiquadFilter()
      f.type = 'lowpass'
      // A light scrape is dull and quiet; a heavy hit opens up and cracks.
      f.frequency.value = 220 + force * 130
      const g = ctx.createGain()
      const now2 = ctx.currentTime
      const peak = Math.min(0.5, 0.06 + force * 0.05)
      g.gain.setValueAtTime(0, now2)
      g.gain.linearRampToValueAtTime(peak, now2 + 0.006)
      g.gain.exponentialRampToValueAtTime(0.0008, now2 + 0.16 + force * 0.02)
      src.connect(f); f.connect(g); g.connect(master)
      src.start(now2, Math.random() * 1.5, 0.25)
      src.stop(now2 + 0.3)
    }

    Object.assign(nodes, {master, engineGain, engineFilter, oscA, oscB, tyreGain, tyreFilter, sirenOsc, sirenGain})
    started = true
  }

  let sirenPhase = 0
  // Impacts are rate-limited: sustained wall contact fires every frame, and sixty thuds a second
  // is a buzz, not a crash.
  let lastThud = -1
  let wasContact = false

  return {
    /** Call from any real input event; browsers will not start audio without one. */
    resume() {
      if (!started) {
        try { build() } catch { return }
      }
      if (ctx.state === 'suspended') ctx.resume()
    },

    get running() { return started && ctx?.state === 'running' },

    /** Fade everything out. Called while paused, where the loop stops calling update entirely and
     *  the oscillators would otherwise hang on the last note they were given. */
    silence() {
      if (!started || ctx.state !== 'running') return
      const now = ctx.currentTime
      nodes.engineGain.gain.setTargetAtTime(0, now, 0.08)
      nodes.tyreGain.gain.setTargetAtTime(0, now, 0.05)
      nodes.sirenGain.gain.setTargetAtTime(0, now, 0.08)
    },

    update(dt, car, police) {
      if (!started || ctx.state !== 'running') return
      const now = ctx.currentTime
      const speed = Math.abs(car.speed)

      // One thud per fresh contact, and at most a few a second while scraping along something.
      if (car.contact) {
        const fresh = !wasContact
        if ((fresh || now - lastThud > 0.22) && speed > 1.5) {
          lastThud = now
          nodes.thud(Math.min(10, fresh ? speed * 0.5 : speed * 0.12))
        }
      }
      wasContact = car.contact

      // Pick a gear from speed, then set the pitch from where we are within it. The note falling
      // back at each change is the thing an ear recognises; a single rising ramp sounds like a siren.
      let gear = 0
      for (let i = GEARS.length - 1; i >= 0; i--) if (speed >= GEARS[i]) { gear = i; break }
      const withinGear = speed - GEARS[gear]
      const hz = IDLE_HZ + withinGear * HZ_PER_MS + gear * 4

      nodes.oscA.frequency.setTargetAtTime(hz, now, 0.05)
      nodes.oscB.frequency.setTargetAtTime(hz * 1.5, now, 0.05)
      // Open the filter as revs rise, so it brightens under load rather than just getting louder.
      nodes.engineFilter.frequency.setTargetAtTime(420 + withinGear * 70, now, 0.08)
      nodes.engineGain.gain.setTargetAtTime(0.08 + Math.min(0.16, speed * 0.006), now, 0.1)

      // Tyres only when genuinely sliding — the same slip figure the HUD calls DRIFT.
      const slip = Math.abs(car.lateral)
      const scrub = Math.min(1, Math.max(0, (slip - 2.2) / 7))
      nodes.tyreGain.gain.setTargetAtTime(scrub * 0.16, now, 0.05)
      nodes.tyreFilter.frequency.setTargetAtTime(1500 + scrub * 900, now, 0.06)

      // Siren: present only while wanted, and its volume tracks the nearest cop, so it arrives
      // before they do and fades as they lose you. That is the whole tension of a chase.
      const stars = police?.state.stars ?? 0
      if (stars > 0 && police.cops.length) {
        let nearest = Infinity
        for (const cop of police.cops) {
          const d = Math.hypot(cop.car.x - car.x, cop.car.y - car.y)
          if (d < nearest) nearest = d
        }
        sirenPhase += dt * 1.6
        const two = Math.sin(sirenPhase * Math.PI * 2) > 0
        nodes.sirenOsc.frequency.setTargetAtTime(two ? 740 : 560, now, 0.02)
        const close = Math.max(0, 1 - nearest / 130)
        nodes.sirenGain.gain.setTargetAtTime(close * 0.10, now, 0.15)
      } else {
        nodes.sirenGain.gain.setTargetAtTime(0, now, 0.25)
      }
    },
  }
}
