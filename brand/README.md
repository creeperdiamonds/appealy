# Brand

| File | Use |
|---|---|
| `icon.svg` | Discord bot avatar, app icon, anywhere square |
| `wordmark.svg` | README header, dashboard, docs |
| `favicon.svg` | Browser tab |

Colours: `#5865F2` (Discord blurple), `#C7CEFF` (the bar), `#E6E8F0` (text).

## The mark

An open door.

Chosen over an up-arrow, a speech bubble and an undo symbol — all of which
describe a mechanism, and none of which describe this product. A door left open
is the argument itself: Appy's ban message says *"this decision is final and
cannot be appealed"*, and this is the opposite of that sentence in one shape.

The taper is doing the work. The hinge edge is shorter than the leading edge,
which is the only thing making it read as open rather than as a card lying
flat. If you redraw it, keep that.

## Designed at 32px, not 512

A Discord avatar renders around 32px. Everything follows from that:

- **Flat fills, no gradients.** They turn to mud below 48px.
- **Two shapes only.** Detail disappears at small sizes; silhouette survives.
- **Nothing thinner than 40px on the 512 grid**, so no stroke drops below ~3px
  when scaled down.

Three concepts died at this stage, all of which looked fine at 512:

- **Speech bubble + arrow** — read as "send a message" at 32px.
- **Document + undo arrow** — the document vanished, leaving a generic undo.
- **Double chevron** — read as "eject".

The door survived because its silhouette is one shape with a distinctive
outline, which is all that transmits at 16px.

**If you change anything here, render it small before you decide it works.**
That's the only test that matters for an avatar.

## Wordmark letterforms are outlined paths

Not `<text>`. A text element renders in whatever font the viewer has, so on
GitHub it silently falls back and looks different on every machine. Outlines
render identically everywhere and need no font shipped.

## Favicon has no container

Browsers draw favicons on the tab background at 16px, so a rounded square would
eat a third of the area for nothing. The arrow uses `currentColor`, so inlined
it inherits the page's text colour and works on light and dark from one file.

## Not included

Raster exports. Generate what you need:

```bash
# Discord wants 512x512 for the bot avatar
npx svgexport brand/icon.svg avatar.png 512:512
```
