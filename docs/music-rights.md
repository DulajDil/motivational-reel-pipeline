# Music rights

## The rule

This pipeline mixes audio into an MP4 that is then published to two platforms.
That is **synchronisation plus distribution**, and it needs a licence that covers
both. There are exactly two supported modes:

| `MUSIC_MODE` | What happens | When to use it |
|---|---|---|
| `silent` *(default)* | A real, silent AAC track is generated | Always safe. Use it unless you have evidence |
| `owned_licensed` | A track from your private S3 bucket is mixed in | Only with the evidence below recorded |

There is no third mode, and adding one would be a mistake.

## "Royalty-free" is not a licence

This is the single most common way to get this wrong.

"Royalty-free" describes a *pricing model* — you pay once instead of per play. It
says nothing about **what you are allowed to do**. A royalty-free track may still
prohibit:

- social media distribution,
- commercial use,
- use in monetised content,
- use by anyone other than the original purchaser,
- use without an attribution string you are not providing.

The same applies to "free to download", "no copyright", "creative commons"
without a specified variant, and anything sourced from a video with "free music"
in the title.

**If you cannot point at a specific clause that permits commercial social-media
distribution, the answer is `silent`.**

## Accepted evidence

Before setting `MUSIC_MODE=owned_licensed`, you must hold **at least one** of the
following, and be able to produce it years later:

1. **You created it.** You wrote, performed and recorded it, using no samples,
   loops or presets whose own licences restrict redistribution. Keep the project
   files and a dated record of authorship.
2. **A written licence naming you as licensee**, which explicitly permits:
   synchronisation with video, commercial use, distribution on social platforms
   (Instagram and Facebook by name or by clear general grant), and — if relevant
   — monetisation. Keep the PDF and the invoice.
3. **A subscription licence** from a library (Epidemic Sound, Artlist, Musicbed,
   or similar) that is **active**, covers your channels, and whose terms you have
   actually read. Keep the licence certificate and note the renewal date; many
   such licences terminate cover for content published after lapse.
4. **A public-domain work whose recording is also public domain.** Note carefully
   that a composition entering the public domain does *not* place a specific
   recording of it there. You need both cleared.

Whatever you hold, put a stable identifier in `MUSIC_LICENSE_REFERENCE` — an
invoice number, certificate ID or contract reference. The configuration refuses
to start without it, and it is written into every render manifest so any
published video can be traced back to its licence.

## How the system enforces this

- `loadConfig` **refuses to start** if `MUSIC_MODE=owned_licensed` without both
  `MUSIC_S3_URI` and `MUSIC_LICENSE_REFERENCE`.
- `MUSIC_S3_URI` must be an `s3://` URI. A track cannot be pulled from a public
  URL, which stops "found it on the internet" from working by accident.
- The URI must point at the **private assets bucket the renderer is scoped to**.
  A mismatch is a configuration error.
- Music objects are private, KMS-encrypted, and readable only by the renderer
  role. The publisher role cannot read them.
- The licence reference is recorded in the render manifest alongside the FFmpeg
  arguments, font licence and output checksum, and manifests are retained far
  longer than the media itself.

## Meta's in-app music library

**It cannot be used by this system.** Two separate reasons, and either alone is
sufficient:

1. **Technical.** The in-app library is a feature of the Instagram and Facebook
   apps. It is not exposed for programmatic track selection through the Graph
   publishing flow. There is no supported way to attach one of those tracks to a
   Reel this system uploads.
2. **Legal.** Meta's licences with rights holders cover playback and creation
   *within their apps*, under their terms. They do not grant you the right to
   obtain those recordings, mix them into an MP4 you produce elsewhere, and
   distribute it.

Do not attempt to work around this by capturing audio from the apps, using
third-party downloaders, or any similar route. That is straightforward copyright
infringement and it puts the accounts at risk.

If in-app music is essential to your creative goal, publish those specific Reels
by hand from the app. This pipeline is for the automated, silent-or-licensed
stream.

## Silent is a real choice, not a fallback

A silent Reel is legitimate output. The render still contains a proper AAC audio
track at 48 kHz — platforms expect an audio stream to exist — it simply carries
no sound. Many accounts in this genre run silent by design, and viewers commonly
watch with sound off regardless.

Start silent. Add music only once the paperwork is in a folder you could find in
two years.

## Fonts

The same standard applies to typefaces, for the same reason: the font is embedded
in distributed video. `npm run fonts:fetch` installs Caveat under the SIL Open
Font Licence 1.1, which permits this. If you substitute a font, confirm its
licence covers embedding and commercial use, and keep the licence file next to
it. The render manifest records the font's SHA-256 and licence, and marks a
system-font fallback as `UNVERIFIED` — never publish output rendered with one.
See [`renderer/fonts/README.md`](../renderer/fonts/README.md).
