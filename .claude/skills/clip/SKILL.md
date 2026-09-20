---
name: clip
description: Record a GIF or MP4 of the running game, with the game's own sound. Use when asked to show an event rather than a layout — a hit and run, a prop breaking, a drive down a street — or whenever "what does this look like in motion" is the actual question. Stills cannot answer it.
---

# Recording a clip of the city

`tools/clip.mjs` drives the running game, photographs it frame by frame through its own camera, optionally records the game's real audio, and encodes a GIF or an MP4.

The dev server must already be up on `:5199` (`npm run dev`). Do not start a second one.

```bash
node tools/clip.mjs --scene hitrun --mp4 /tmp/hit.mp4 --sound
node tools/clip.mjs --scene break  --gif /tmp/tree.gif
node tools/clip.mjs --scene drive  --at 139,203 --frames 60 --mp4 /tmp/street.mp4 --sound
```

| flag | meaning |
|---|---|
| `--scene` | `hitrun` (drive at a pedestrian and keep going), `break` (drive at the nearest destructible prop), `drive` (no collision) |
| `--speed` | metres per second at the moment of contact. 22 ≈ 80 km/h. Low speeds are a different event, not a slower one: at 6 m/s a body folds and a tree survives |
| `--frames --every` | frame count and the sleep between frames in ms |
| `--back --camh` | how far beyond the subject the camera stands, and how high |
| `--at` | `x,y` in map metres, for `--scene drive` |
| `--sound` | record the game's audio. MP4 only — a GIF has no audio track |
| `--gif --mp4 --keep` | outputs; `--keep <dir>` leaves the PNG frames |

## Choosing between GIF and MP4

MP4 for anything you are sending to Dmitrii: the same three seconds was 3.1 MB as a GIF and 234 KB as an MP4, and only the MP4 can carry sound. GIF when it must play inline somewhere that will not take a video, and note that many previewers show only the first frame of a GIF and look broken — say so when you send one.

## Four things this gets right, each of which cost real time to learn

**The camera stands in the carriageway.** Every side-on placement from a pavement put a street tree in the sight line. No query can predict that: a tree filter sees only the 2,467 surveyed trees in `city.json`, while nearly everything drawn is synthetic and invented at scene-build time. The middle of the road is the one sight line clear **by construction**, because nothing is allowed to stand in a carriageway — see `src/render/clearance.js`. If you write a new camera placement, this is the constraint to keep.

**The framerate is measured, never chosen.** Each frame costs a CDP round trip plus the sleep, so 42 frames takes about five seconds of wall clock rather than the three that 14 fps implies. The game and its audio run in real time throughout, so the video framerate is derived from elapsed time and then interpolated up to 24 fps for smoothness without changing the duration. Hard-code a framerate and the sound drifts out of the picture.

**The clock needs both `window.__forceHours` and `game.setHours`.** `setHours` alone is overwritten by the frame loop within a frame. `__forceHours` alone is honoured only in the loop's un-paused branch, so a headless page that never took focus sits at the start hour. Two agents shot entire sequences in blue-hour light before this was understood, and one concluded a mid-grey car was nearly black.

**The audio is teed out of the game, not reconstructed.** `src/game/audio.js` exposes only `resume/silence/update` — no context, no master gain. The tool wraps `AudioContext` before the game builds it and patches `connect()` so anything reaching `ctx.destination` also reaches a `MediaStreamDestination`. The game is unchanged and unaware. Headless Chrome also needs `--autoplay-policy=no-user-gesture-required` to start audio at all, and `--mute-audio` so it does not try to open a real output device.

## Verify before you send

An encoder that succeeds is not a clip that shows anything.

```bash
ffprobe -v error -show_entries stream=codec_type,duration -of default=nw=1 out.mp4
ffmpeg -hide_banner -i out.mp4 -af volumedetect -f null - 2>&1 | grep volume
```

Video and audio durations should match within a tenth of a second. Mean volume around −20 dB is the game playing; silence reads as roughly −91 dB and means the tap failed. Then **look at a frame** — `--keep` a directory and Read the middle one. A clip where the event happens off-camera encodes perfectly.

One harmless warning to expect: `Error parsing Opus packet header` from ffmpeg on the recorded webm. It is one malformed packet at the recording boundary and the audio is intact; check the volume rather than trusting or fearing the warning.

## Where to put the output

Not in the repo — images and video do not belong in git, and `.gitignore` refuses them. Not only in a job temp directory either, because those vanish when the job is deleted. Somewhere outside the repository that survives the session.
