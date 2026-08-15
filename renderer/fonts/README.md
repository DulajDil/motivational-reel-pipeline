# Fonts

**No font binary is committed to this repository.** Fonts carry their own
licences, and silently vendoring one is exactly the kind of rights problem this
project is built to avoid.

## Getting a font

```bash
npm run fonts:fetch
```

That downloads **Caveat** (SIL Open Font Licence 1.1) plus its `OFL.txt` into
this directory. The OFL permits embedding in rendered video, including
commercial use.

## Using a different font

Drop any `.ttf` or `.otf` into this directory **together with its licence text**,
and the renderer will pick it up. Resolution order:

1. `QUOTE_FONT_PATH` — explicit override
2. `renderer/fonts/*.ttf|*.otf` — this directory (baked into the container image)
3. a system font — **local development only**

If the renderer falls back to a system font, the render manifest records the
licence as `UNVERIFIED`. Do not publish output rendered with an unverified font:
most system fonts are not licensed for embedding or redistribution.

## Before you choose a font

Confirm the licence explicitly permits:

- embedding in a video file,
- commercial use,
- distribution on social platforms.

"Free to download" is not a licence grant. The same standard applies here as to
music — see [`docs/music-rights.md`](../../docs/music-rights.md).
