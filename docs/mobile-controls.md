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

- Somebody who opens the link on a phone can drive, steer, brake and stop, without instructions. The mechanism for that is the labels: the buttons say "Go", "Stop" and "Drift", and the steering pad needs no label because a thumb on the left half of a driving game is the one gesture everybody tries first. Nothing appears on first touch to explain anything, and if the labels turn out not to be enough that is a finding rather than a design to add now.
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

### 4.1. Steering is a thumb zone, not a wheel

The left half of the screen is a steering pad. A touch anywhere in it sets an origin, and horizontal displacement from that origin steers: full lock at about a third of the screen width, proportional in between. Lifting returns the wheel to centre at the same rate the keyboard's release does.

The origin is where the thumb lands rather than a fixed point, because a phone is held differently by every hand and a fixed wheel is in the wrong place for most of them. This also removes the need to look at the screen to find the control.

> A rendered steering wheel was considered and rejected. It looks like a car and plays worse than a pad: a wheel has a centre the thumb must return to precisely, and the thumb cannot see it. The pad's centre moves to the thumb, which is the whole advantage.

Steering keeps the existing ramp. `STEER_ON` and `STEER_OFF` in `src/game/input.js` already shape how fast the wheel reaches lock and returns, and touch feeds the same command rather than writing `steer` directly, so the feel is identical on both inputs.

### 4.2. Throttle and brake are two buttons on the right

Two large round controls, bottom right, thumb-reachable: "Go" above "Stop". Holding "Go" is holding `W`. Holding "Stop" is holding `S`, which brakes and then reverses, exactly as the key does.

They are buttons rather than a second pad because throttle is binary in this game already. The keyboard has no analogue accelerator, so a slider would offer a precision the physics cannot use.

### 4.3. The handbrake is the third button, and it is where the thumb already is

"Drift" sits beside "Go", slightly inboard, so the same thumb can hold throttle and stab the handbrake without moving across the screen. That combination is how the car drifts, and a control scheme that makes it awkward removes the best thing in the game.

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
| `src/game/touch.js` | new. Owns the pad, the buttons, the menu, a **map from `pointerId` to the control that touch claimed**, and writes the same `input` state the keyboard writes |
| `src/game/input.js` | unchanged in behaviour. Exposes its state so touch drives it through the same ramp |
| `src/main.js` | creates the touch controls when the device warrants them, and disposes them if it stops warranting them |
| `src/render/scene.js` | a mobile pixel-ratio cap, behind the same device test |

**Every handler keys on `pointerId`, and this is the bug the design is most likely to ship with.** Holding "Go" while steering is two simultaneous touches, and section 4.3 asks for three: throttle held, handbrake stabbed, wheel turned. A handler that tracks "the touch" rather than "the touch with this id" lets the second finger steal the first, and the symptom is not an obvious crash. It is steering that sticks when you press a button, or throttle that drops when you turn, which reads as a physics bug and gets debugged in the wrong file. Each control captures the pointer that started on it, follows only that id through move and up, and releases only its own.

The simulation is untouched. `src/game/car.js`, the police, the traffic and the crowd never learn that a phone exists, which is the property that keeps this from becoming a second game to maintain.

## 8. Workflows

### 8.1. Play on a phone

**8.1.1. Open the Game on a Phone**

- User opens the deployed link in a mobile browser.
- Game detects a coarse pointer and available touch points.
- Game draws the steering pad, the "Go", "Stop" and "Drift" buttons, and the "Menu" button.
- Game suppresses browser zoom and double-tap gestures over the play surface.
- User sees the city and the controls together, with no instructions to read.

**8.1.2. Drive the Car**

- User places a thumb anywhere in the left half of the screen.
- Game records that point as the steering origin.
- User moves the thumb horizontally.
- Game converts the displacement into a steering command and feeds it through the existing ramp.
- User holds "Go" with the other thumb.
- Game applies throttle exactly as it does for the `W` key.
- User lifts the steering thumb.
- Game returns the wheel to centre at the keyboard's release rate.

**8.1.3. Drift Round a Corner**

- User holds "Go" and steers into the corner.
- User taps and holds "Drift" with the same thumb that holds "Go".
- Game drops lateral grip, exactly as the handbrake key does.
- User releases "Drift".
- Game restores grip and the car catches.

**8.1.4. Reach a Mode**

- User taps "Menu".
- Game opens a column holding "Map", "Camera", "Respawn" and "Pause".
- User taps one.
- Game performs it and closes the menu.

**8.1.5. Dock a Tablet into a Keyboard**

- User docks a tablet that was being driven by touch.
- Device stops matching `(pointer: coarse)`.
- Game removes the touch controls and leaves the keyboard working.
- User drives on with the keys, without reloading.

## 9. Open questions

**This document is not DONE until a frame rate from a real phone is written into section 6.** An emulator number is not that number and may not be substituted for it. Everything else here can be built and shipped meanwhile; the doc simply stays open.

None of these should be answered by guessing.

1. **What frame rate does a mid-range phone actually get?** Everything in section 6 is a plan rather than a decision until somebody runs the deployed build on real hardware. Dmitrii's phone is the nearest instrument.
2. **Does the pixel-ratio cap need to be adaptive?** A fixed mobile cap of 1.0 is the simple answer. Measuring frame time and adjusting is the better one, and it is worth nothing if the fixed cap already suffices.
3. **Portrait, landscape, or both?** The screenshot that prompted this was portrait. Landscape gives a driving game more of what it needs and asks the player to turn the phone, which some will not do. Both is more work than either, and may be the right answer anyway.
4. **Does the on-screen HUD survive a 390-pixel width, and do the controls overlap it?** The speedometer, the wanted stars and the minimap were laid out for a desktop window and have never been looked at on a phone. Section 3 refuses to move them in this piece of work, so any overlap is a defect this design knowingly leaves in place. Answering it needs one screenshot of the built page at 390 points with the controls drawn.
