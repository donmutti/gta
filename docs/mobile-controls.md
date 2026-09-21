# Mobile controls

A design for keeping the game playable when somebody opens the deployed link on a phone. Today they get a city they can look at and cannot drive.

## 1. The problem

The game is published at a URL, and the first thing anybody does with a URL is open it on the device in their hand. That device has no keyboard, and every control in the game is a key.

Measured on an emulated iPhone viewport, 390 by 844 at device pixel ratio 3, with touch enabled and an iOS user agent:

| what | value |
|---|---|
| boots | yes |
| touch points reported | 5 |
| `(pointer: coarse)` matches | yes |
| renderer pixel ratio | 1.5, from a device ratio of 3 |
| draw calls per frame | 844 |
| triangles per frame | 8.4 million |
| touch controls present | none |

So the city builds and renders, and nothing can be driven. The player sees a red car on a Luxembourg street, taps the screen, and nothing happens.

> The frame rate in that emulation was 60, and it is not evidence about a phone. Headless Chrome emulating a phone still renders on this laptop's GPU: the viewport, the pixel ratio and the input model are real, the performance is not. Section 6 treats phone performance as an open question rather than a measured result, because it is one.

## 2. What must be true when this is done

- Somebody who opens the link on a phone can drive, steer, brake and stop, without instructions. The mechanism is that the controls are drawn and labelled: the stick is visible at rest with "GO" and "BRAKE" on its base, and "Drift" and "Menu" say what they are. The opening hint names the controls the device actually has, which is a thing it got wrong until a phone screenshot caught it telling touch users to press W A S D.
- The controls do not appear on a desktop, and the keyboard does not stop working anywhere.
- The frame rate on a mid-range phone is playable, or the game says what it has turned down and why.
- Nothing about the simulation changes. Touch produces the same `input` state a keyboard produces, and the physics never learns which one it was.

## 3. What this is not

- Not a redesign of the HUD, and not a repositioning of it either. The speedometer, the wanted stars and the minimap stay exactly where a desktop puts them. If a control overlaps a panel at 390 points, that is a known defect with a line in section 9 rather than something this work fixes quietly.
- Not a separate mobile build, a separate route, or a separate bundle. One page that adapts.
- Not gyroscope steering. It is charming for a minute and unusable in a car chase, and it needs a permission prompt on iOS that a first-time visitor will refuse.
- Not multiplayer, landscape lock, or installability. Each is a separate piece of work.

## 4. The control scheme

The car needs four things: a direction, a speed, an emergency, and a way out of a mistake. Everything else in the game is a mode the player can reach through one button.

### 4.1. One thumbstick carries both axes

The left thumb drives the car. A stick with a base ring and a knob rests visibly in the lower left, and its vertical axis is throttle while its horizontal axis is steering: push up to accelerate, pull down to brake and then reverse, push left or right to steer. Full deflection on an axis is 62 points of travel from the centre.

The stick is drawn at rest rather than appearing on touch, and that is the whole reason it exists. The first design had an invisible pad occupying the left half, and an invisible control is not a control: somebody who opens the link sees a city and a blank half of the screen, with nothing saying that half is the steering. The base ring carries the words "GO" at the top and "BRAKE" at the bottom, so which way is fast needs no instructions.

It also floats. A touch anywhere in the left half re-homes the stick to that point and drives from there, so the ergonomic property of the first design survives: the control comes to the thumb rather than the thumb hunting for the control. Resting visibly and then moving to the thumb is both halves of the argument at once.

> A rendered steering wheel was considered and rejected. It looks like a car and plays worse than a stick: a wheel has a centre the thumb must return to precisely, and the thumb cannot see it.

### 4.2. The axes are normalised independently, and the stick has corners

This is the one non-obvious decision in the scheme, and it is the reason a single stick is acceptable for a driving game at all.

A stick normalised by magnitude — the usual implementation, a knob clamped inside a circle — splits a diagonal between its axes. Holding up-and-left gives roughly 0.7 of throttle and 0.7 of lock, so the car slows down **because** you turned. That is precisely wrong for this game, where flat-out cornering is the thing worth protecting.

So each axis is computed from its own displacement and clamped on its own: full up is full throttle no matter how far left the thumb is. The reachable area is therefore a square rather than a circle, and the knob can sit in a corner. Racing games on phones do exactly this, and what players notice is that holding up keeps the car fast, not the geometry of the region their thumb moves in.

A deadzone of 14 percent of the throw is ignored on each axis so a resting thumb commands nothing, and the remaining throw is **rescaled** rather than truncated: without the rescale, the first responsive millimetre already commands 0.14 and the control starts with a step in it.

### 4.3. The handbrake is a button, because a handbrake has no axis

"Drift" sits bottom right, under the right thumb, so throttle and steering stay with the left thumb and the handbrake is stabbed with the other hand. That combination is how the car drifts, and a scheme that makes it awkward removes the best thing in the game.

It is a button in both layouts. "Not separate buttons" cannot be absolute while a handbrake exists.

### 4.3.1. Both layouts ship, and the player picks

The first design put steering on a left-half pad and throttle on "Go" and "Stop" buttons bottom right. It was built and verified before the layout was overruled in favour of a stick, and it is kept rather than deleted, reachable from the menu as "Controls: Stick" / "Controls: Buttons". The stick is the default and the choice is remembered.

Two reasons, and the second is the real one. A working implementation is evidence, and throwing away evidence before the replacement has been felt is expensive. And which of the two plays better is taste — it is settled by a thumb on a phone in ten seconds, and not by reasoning about it.

Switching rebuilds the controls in place rather than reloading. The player is mid-drive, and a reload would dump them at the spawn point to answer a question about where the throttle should live. The teardown zeroes every axis, so a half-switched control cannot leave a throttle held down by a layout that no longer exists.

### 4.4. Everything else is one menu

A single "Menu" control, top right, opens a column of the remaining actions: "Map", "Camera", "Respawn", "Pause". Each is one tap and closes the menu.

These are modes rather than controls. Holding them behind one button keeps four buttons off the driving surface, and none of them is needed in the half second that matters during a chase.

> Respawn is in the menu rather than on the driving surface on purpose. It is the button a frustrated player wants immediately, and the button an accidental touch must never press.

### 4.5. What the screen does not do

Pinch, double-tap and long-press are all browser gestures that fight a game, and `touch-action: none` on the play surface is what stops them. That is the mechanism; the viewport meta tag is not.

`user-scalable=no` goes into the meta tag as well, and it is worth being exact about what it buys: **iOS Safari has ignored it since iOS 10**, deliberately, because disabling zoom breaks the browser for people who need it. It still works in some Android browsers, so it stays, but nothing in this design may depend on it. The existing tag sets width and initial scale and stops there, which is why a two-finger drag zooms the city into a corner today.

## 5. Choosing the control scheme

The controls appear when the device has a coarse pointer and reports touch points, and not otherwise:

```js
const touch = window.matchMedia('(pointer: coarse)').matches && navigator.maxTouchPoints > 0
```

User-agent sniffing is not used. It is wrong about tablets, wrong about desktops with touchscreens, and wrong again every time a vendor changes a string.

**`pointer` rather than `any-pointer`, deliberately.** `pointer` describes the primary input, so a laptop with a touchscreen and a mouse reports fine and gets no controls, which is the right answer: its keyboard works and a steering pad over the view would be clutter. `any-pointer: coarse` would match that laptop and put controls on it. This is written down because it looks like a bug and is a decision.

A device that has both a keyboard and a touchscreen gets both, with neither disabled. The controls are drawn and the keys keep working, because a laptop with a touchscreen is a real machine and somebody who reaches for the keyboard should not have to fight for it.

> The media query is re-evaluated on change rather than read once. A tablet in a keyboard case switches from coarse to fine when docked, and a control scheme decided at boot is wrong for the rest of the session.

## 6. Performance on a real phone

This is the part that is not yet known, and the document does not pretend otherwise.

The workload is 844 draw calls and 8.4 million triangles per frame. That is comfortable on a laptop GPU and is a large number for a phone, particularly one throttling under a browser. The knobs available, in the order they cost the least:

- **Pixel ratio.** Already capped at 1.5 in `src/render/scene.js`. On a device ratio of 3 that is a backing store of 585 by 1266, which is more than a phone needs for a game viewed at arm's length. A mobile cap of 1.0 removes more than half the shaded pixels and is invisible at that distance.
- **Draw distance.** Fog and the tile streaming radius already bound what is drawn. Tightening both on a phone removes geometry rather than pixels, which is the other half of the cost.
- **Crowd and traffic counts.** 340 pedestrians and 120 vehicles are the figures the desktop uses. Halving either is visible, and is the last knob rather than the first.

The honest order of work is to ship the controls, measure on a real phone, then turn knobs against a number. Turning them first would be guessing, and guessing about performance is how a game ends up slower and uglier at once.

> This section is why the document is not finished. See section 9.

## 7. What changes in the code

| file | change |
|---|---|
| `index.html` | viewport meta gains `user-scalable=no`; a root element for the controls |
| `src/game/touch.js` | new. Owns both layouts, the menu, a **map from `pointerId` to the control that touch claimed**, and writes the same `input` state the keyboard writes |
| `src/game/input.js` | unchanged in behaviour. Exposes its state so touch drives it through the same ramp |
| `src/main.js` | creates the touch controls when the device warrants them, disposes them if it stops warranting them, and rebuilds them when the player switches layout |
| `src/game/hud.js` | the opening hint names the live controls; the F3 panel is off on a coarse pointer, because a phone cannot press F3 to dismiss it |
| `src/render/scene.js` | a mobile pixel-ratio cap, behind the same device test |

**Every handler keys on `pointerId`, and this is the bug the design is most likely to ship with.** On the stick, throttle and steering are one finger and "Drift" is a second; on the buttons layout it is three at once. A handler that tracks "the touch" rather than "the touch with this id" lets the second finger steal the first, and the symptom is not an obvious crash. It is steering that sticks when you press a button, or throttle that drops when you turn, which reads as a physics bug and gets debugged in the wrong file. Each control captures the pointer that started on it, follows only that id through move and up, and releases only its own.

The simulation is untouched. `src/game/car.js`, the police, the traffic and the crowd never learn that a phone exists, which is the property that keeps this from becoming a second game to maintain.

## 8. Workflows

### 8.1. Play on a phone

**8.1.1. Open the Game on a Phone**

- User opens the deployed link in a mobile browser.
- Game detects a coarse pointer and available touch points.
- Game draws the thumbstick at rest, the "Drift" button, and the "Menu" button.
- Game suppresses browser zoom and double-tap gestures over the play surface.
- User sees the city and the controls together, with no instructions to read.

**8.1.2. Drive the Car**

- User places a left thumb anywhere in the left half of the screen.
- Game re-homes the stick to that point and grabs the knob.
- User pushes the thumb up and to the left.
- Game reads each axis separately and commands full throttle and full left lock together.
- User lifts the thumb.
- Game returns the knob to the stick centre and zeroes both axes.

**8.1.3. Drift Round a Corner**

- User pushes the stick up and into the corner with the left thumb.
- User taps and holds "Drift" with the right thumb, without moving the left one.
- Game drops lateral grip, exactly as the handbrake key does.
- User releases "Drift".
- Game restores grip and the car catches.

**8.1.4. Reach a Mode**

- User taps "Menu".
- Game opens a column holding "Map", "Camera", "Respawn", "Pause" and "Controls".
- User taps one.
- Game performs it and closes the menu.

**8.1.5. Try the Other Control Layout**

- User taps "Menu".
- User taps "Controls: Stick".
- Game destroys the stick, zeroes every axis, and draws the steering pad with "Go" and "Stop" instead.
- Game remembers the choice for the next visit.
- User drives on from where they were, without a reload.

**8.1.6. Dock a Tablet into a Keyboard**

- User docks a tablet that was being driven by touch.
- Device stops matching `(pointer: coarse)`.
- Game removes the touch controls and leaves the keyboard working.
- User drives on with the keys, without reloading.

## 9. Open questions

**This document is not DONE until a frame rate from a real phone is written into section 6.** An emulator number is not that number and may not be substituted for it. Everything else here can be built and shipped meanwhile; the doc simply stays open.

None of these should be answered by guessing.

1. **What frame rate does a mid-range phone actually get?** Everything in section 6 is a plan rather than a decision until somebody runs the deployed build on real hardware. A real phone is the only instrument that answers it.
2. **Does the pixel-ratio cap need to be adaptive?** A fixed mobile cap of 1.0 is the simple answer. Measuring frame time and adjusting is the better one, and it is worth nothing if the fixed cap already suffices.
3. **Which layout wins?** Both ship and the menu switches between them, which is a way of asking the question rather than an answer to it. When somebody has driven both on a phone, the loser comes out and this line closes.
4. **Portrait, landscape, or both?** The screenshot that prompted this was portrait. Landscape gives a driving game more of what it needs and asks the player to turn the phone, which some will not do. Both is more work than either, and may be the right answer anyway.
5. **Does the on-screen HUD survive a 390-pixel width? Answered, partly, and it found two faults worse than overlap.** One screenshot at 390 points with the controls drawn showed:

   - **The opening hint told a phone player to press W A S D.** Not clutter, false instructions, and the first thing a first-time visitor reads. Fixed: the hint names the controls the device actually has.
   - **The F3 debug panel was on by default and a phone has no F3**, so a developer overlay covering a third of the screen could never be dismissed. Fixed: off on a coarse pointer.
   - **The update toast sat over "Stop" and "Drift".** Fixed: it clears the controls on a touch device.

   What remains, and is knowingly left alone under section 3: the wanted stars run under "Menu" at the top right, and the street-name label sits just under the stick's "BRAKE" word at the bottom left. Neither blocks a control — both controls take the tap — and both are cosmetic on a screen this narrow. They are named here rather than fixed because rebuilding the HUD is a separate piece of work, and the screenshots are at `assets/gta-2026-09-21-mobile-controls.png` (buttons) and `assets/gta-2026-09-21-mobile-stick.png` (stick).
