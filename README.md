# Local video review

Review a live HyperFrames composition in Lavish. Drag a rectangle to point to an editable element or part of a shot, select a time range for a cut, or leave a whole-video note. The agent receives one batch per version through the existing Lavish poll.

## Run the animation sample

Requires Node 26, npm, FFmpeg and FFprobe on `PATH`, a HyperFrames-compatible browser, and `lavish-axi`. Run from the repository root.

```sh
npm ci
npm test
node scripts/build-review.mjs v1
lavish-axi review/v1/review.html
node scripts/poll-review.mjs review/v1/review.html
```

The 24-second Night Signal sample has a title, caption, animated orbit and background. For an optional render check, run:

```sh
mkdir -p renders
DO_NOT_TRACK=1 npx --no-install hyperframes lint review/v1/composition
DO_NOT_TRACK=1 npx --no-install hyperframes render review/v1/composition --fps 24 --output "$PWD/renders/v1.mp4"
```

## Ingest and review footage locally

**Never run `lavish-axi share` or `lavish-axi export` on footage review pages.** The same rule applies to the Lavish browser menu. Keep originals, proxies, frame grabs, transcripts, review builds and feedback logs off Git and out of uploads. Put them under the ignored `source/`, `media/`, `renders/`, `review/`, or `notes/` directories, or use a private directory outside the repository.

```sh
mkdir -p source
node scripts/ingest.mjs /path/to/local-original.mov camera
cp composition/footage.html source/index.html
```

Use the dimensions, fps and duration printed by ingest in `source/index.html`. Set the CSS canvas dimensions, the root's `data-width`, `data-height`, `data-fps`, and both `data-duration` values. The template uses a `video.clip` with a stable HTML `id`, `data-review-clip="camera"` for the manifest asset, and a relative `media/camera.mp4` reference. Keep clip starts, durations, and media starts on frame boundaries at the composition rate. Use a separate ID for each segment, including segments that reference the same proxy. Keep `data-has-audio="true"` for clips with sound. For silent clips, replace it with `muted`. Set `--fps RATE` during ingest if another asset needs conforming to the composition rate. The manifest records the resampling and original timestamps.

The proxy is H.264 8-bit 4:2:0 CFR with frequent keyframes and AAC audio when present. FFmpeg applies the source rotation during ingest. The manifest maps every zero-based proxy frame to its decoded source frame in presentation order and records gaps, repeated frames and the source SHA-256. Place a new source or conform under a new asset ID.

```sh
# Optional source-time transcript, with a local multilingual whisper.cpp model installed.
node scripts/transcribe.mjs camera

# Optional corrected subtitles. Time these against the original source.
node scripts/transcribe.mjs camera --srt source/corrected.srt

node scripts/build-review.mjs v1 review/footage --composition source/index.html
lavish-axi review/footage/v1/review.html
node scripts/poll-review.mjs review/footage/v1/review.html
```

Transcription uses local `whisper-cli` or `whisper-cpp`. Set `DAILIES_WHISPER` and `DAILIES_WHISPER_MODEL` to select the executable and multilingual model, or install the model under `~/.cache/hyperframes/whisper/models`. The script never downloads models. It defaults to Mandarin (`--language zh`). Automatic transcripts are drafts. The SRT override takes precedence in later builds, and older builds retain their own transcript snapshots.

## Review and revise

1. Scrub or use the frame buttons. Click for a small box, or drag around an area. Drag on the timeline to select a range, or adjust its two frame fields. Draw a rectangle on a frame within that range to include a spatial reference. Use **Whole video** or **W** for a note on the full edit. A transcript line jumps to its frame, and Shift-click selects its range.
2. **Send feedback to agent** submits a single batch via `window.lavish.queuePrompt()`. Keep `scripts/poll-review.mjs` attached while waiting for feedback. The wrapper runs `lavish-axi poll` and writes the first valid video batch to the version's immutable `notes.json`. Its companion script serves this snapshot to the Lavish iframe. Keep the poll output if you also need the surrounding Lavish conversation.
3. Read the version in the payload before editing. Use each target's `file` and `selector` to locate DOM elements. Rectangles are normalized to the composition, and selectors and footage intersections are candidates. The EDL and note `source` spans describe output, proxy and original source frames. Ranges use `[frame, end_frame)`. `last_source_frame` is inclusive. `footage` gives the proxy and original frame for a rectangle and its normalized `rect_in_source` in the upright image. Source rectangles support axis-aligned placement and scale, including `object-fit` cropping. The same note can carry both footage and DOM targets.
4. For a proxy frame grab, pass its snapshot and exact `media_frame` to the extractor. For a range, use the first, middle and last in-range frames as needed, following the EDL across cuts. Whole-video notes do not depend on a playhead thumbnail.

   ```sh
   mkdir -p renders
   node scripts/extract-frame.mjs review/footage/v1/media/camera.mp4 90 renders/check.jpg
   ```

5. Edit the working composition. A cut is a change to clip timing and order. Use the prior EDL to identify the original shot and source frame before changing the edit. Build the next version in the same output directory, optionally supplying a JSON object mapping preceding note IDs to outcome descriptions.

   ```sh
   node scripts/build-review.mjs v2 review/footage --composition source/index.html \
     --note "Shortened the pause" --outcomes notes/v2-outcomes.json
   lavish-axi review/footage/v2/review.html
   ```

   The new `version.json` records its parent, summary and outcomes. Open the old version to read its notes and see where each recorded outcome was handled. Reply to the previous Lavish session with the outcome and new local link, then end it with `lavish-axi end` when finished. Open and poll the new version for the next round.

The live preview uses the pinned HyperFrames runtime inside a sandboxed `srcdoc` iframe. The bridge resolves geometry inside the iframe and sends frame and region metadata over a `MessageChannel`. Recheck playback and targeting when upgrading the runtime. Footage review supports frame-aligned cuts and composition overlays. Pixel-level effects such as stabilization, grading and blur are outside this workflow.

## Credits

See [Third-party notices](THIRD_PARTY_NOTICES.md) for FrameJam, HyperFrames, GSAP and the local tool dependencies.
