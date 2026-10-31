# FDE Council · 3D house

Three.js versions of the council as a haunted house. Single-file HTML, open directly in Chrome.

| File | What it is |
|---|---|
| `house.html` | **Main 3D version.** House built from Kenney CC0 kits (graveyard, fantasy-town, mini-characters), all models embedded as base64 so it works offline. Five lit windows with animated ghost actors, FDE on the balcony with a lantern, a trick-or-treater who walks up and knocks, seminar fire, candy delivery, graveyard yard, fog, moon, bloom. Cinematic scripted camera. |
| `haunted3d.html` | Earlier three.js version built from primitives (cutaway house, relay shaft, cauldron). |

## Controls

- `Space` run · `R` reset · `W` test the privacy wall · `C` free camera · `1`–`6` camera shots · `M` sound.
- Type a constraint in the "Shout from the balcony" box when it pulses, or press Enter for the suggested one.

## Live mode

Open with `?ws=ws://host:port` to drive the scene from the bridge. Events use the same contract as the
2D frontend (`status`, `message`, `await-fde`, `plan`), plus scene cues `arrive` and `deliver`.
`window.FDE.push(event)` is also exposed for testing from the console.

Assets: Kenney (kenney.nl), CC0. Loaded via the shorepine/kenney mirror when not embedded.
