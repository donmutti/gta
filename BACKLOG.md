# GTA Luxembourg — backlog

## Real terrain (altitudes)
The world is currently dead flat (y=0 everywhere). Luxembourg is famously hilly — the Pfaffenthal gorge, the plateau escarpments, the drop the Pont Rouge spans. Add real elevation:
- Source a DEM (SRTM 30m, or Copernicus / IGN Luxembourg LiDAR for finer detail).
- Sample elevation per road/building/tree vertex during the fetch; carry a `z`/height per point.
- Raise the ground to a heightfield mesh; sit buildings on their footprint's ground height; ramp roads along the terrain.
- Physics: the car currently drives on a plane — stepCar/collision would need to read ground height (slopes affect speed, the camera pitches). This is the big ripple, not the rendering.
- The Pont Rouge and Pfaffenthal lift only make literal sense once the gorge has depth.
Effort: large (touches fetch, world model, renderer, and physics). Deferred to the backlog on 2026-09-19.

## Fullscreen button (mobile and desktop)
A control that takes the game fullscreen, wanted on both. On a phone it matters most: the browser chrome eats a strip at the top and a home indicator strip at the bottom, and on iOS the address bar reappears on any upward scroll gesture, so a portrait game is playing in noticeably less than the screen it was told it had.
- Desktop: a control near the HUD, or a key alongside the existing ones. `requestFullscreen()` on the canvas container, `exitFullscreen()` to leave, and Esc already leaves by browser default — which collides with Esc closing the map, so one of the two has to give.
- Mobile: a menu item rather than a button on the driving surface. It must be behind a real tap, because `requestFullscreen()` throws outside a user gesture.
- **iOS Safari does not implement the Fullscreen API on iPhone at all** (iPad does). So on the device this was asked for, the button either does nothing or must not be drawn, and the honest alternative there is `apple-mobile-web-app-capable` plus Add to Home Screen — a different feature with a different prompt. Find out which before building either.
- Fullscreen changes the viewport, so the touch stick's resting position and the HUD both need the existing resize path to fire. It already listens; verify rather than assume.
Effort: small on desktop, unknown on iOS until the capability question above is answered. Added on 2026-09-21.
