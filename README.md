# Video feedback loop MVP

The goal is to let a reviewer point to *this thing, here, at this moment*, explain the change, and see it in the next version. A timestamp alone leaves the agent guessing which object to edit; a region on the live HyperFrames composition preserves both the visual location and the editable source target.

## Local review loop

Requires Node 26, npm, FFmpeg on `PATH`, a browser supported by HyperFrames, and `lavish-axi`. No account, cloud rendering, or standing watcher is required. Run from the repository root:

```sh
npm ci
npm test
mkdir -p renders notes
node scripts/build-review.mjs v1
DO_NOT_TRACK=1 npx --no-install hyperframes lint review/v1/composition
DO_NOT_TRACK=1 npx --no-install hyperframes render review/v1/composition --fps 24 --output "$PWD/renders/v1.mp4"
lavish-axi review/v1/review.html
set -o pipefail
lavish-axi poll review/v1/review.html --owner video-review | tee -a notes/received.log
```

The 24-second Night Signal sample has a title, caption, animated orbit, and background. You can also use `npx --no-install hyperframes preview review/v1/composition --no-open` to inspect the standalone composition. Rendering is for an export or a frame check; the Lavish review page itself can open without it.

1. Play and pause or scrub to a frame. Drag around an area, or click for a small box. Type in the popup and add the note. Select a note’s frame button to return to its marker, or delete the note before sending.
2. **Send feedback to agent** packages the notes together and sends through `window.lavish.queuePrompt()`. Keep `poll` attached to the agent turn; it consumes the response, which `tee -a` appends to the local notes log. Don’t claim someone is listening just because the review link is live.
3. Read the `video-review` prompt’s JSON context. Verify the version, then use each target’s `file` and `selector` in the source. If `targets` is empty, use the normalized region and frame to locate the requested change. Don’t treat timestamps or rectangles as stable across different edits.
4. Edit `composition/index.html` and keep stable IDs for existing elements. Build `v2`, repeat lint/render with the `v2` paths, check the requested frames, and run `lavish-axi review/v2/review.html`. Reply to the previous Lavish session with the outcome and the new link. Poll the new version when ready for another batch; when handing off without listening, leave the review session open but do not start a detached poll.

## Why a live frame

The builder snapshots the same HTML and pinned GSAP used by the HyperFrames export, then embeds that HTML and the pinned HyperFrames runtime in the Lavish review artifact. No rendered video is embedded. Existing output directories are not overwritten, so a version label keeps pointing to the composition the reviewer actually saw. Pass an optional output directory to `build-review.mjs` to keep artifacts outside the repository.

In Chrome inside Lavish, direct DOM access from the review page to the nested composition iframe failed under Lavish’s opaque-origin sandbox. A private `MessageChannel` worked without granting same-origin access: the review UI sends a frame or selection to the composition, and the composition seeks via the pinned runtime’s `__player` interface before reading its own DOM. The bridge is coupled to this runtime version; recheck playback and targeting when upgrading.

Each note carries the version, zero-based frame number, seconds (`frame / fps`), and `{x, y, width, height}` as fractions of the composition. Targets are visible, intersecting elements tagged `data-review-target` with stable IDs. The center hit ranks first when available; bounds can yield multiple candidates, so a selector is evidence, not proof of reviewer intent. Targets include file, ID, selector, tag, text snippet, and selected computed styles. The background is intentionally not a target, so an unoccupied region still works. Bounds are not pixel masks; frame crops are not included in the payload. Use the version’s rendered MP4 to make a frame grab where needed. The portable builder is scoped to this self-contained HTML/CSS/GSAP sample; external media ingestion is not implemented.
