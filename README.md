# Dailies AXI

Dailies AXI builds local video review pages for Lavish. A reviewer can mark an on-screen region, select a frame range, or leave a whole-video note. The agent receives one feedback batch per version, with references to the composition and exact source frames.

## Install from a clone

You need Node.js 26 or later with npm, Git, FFmpeg with the `libx264` encoder, FFprobe, and a modern browser with H.264 support. Install the external review host with `npm install -g lavish-axi`. Make sure `node`, `ffmpeg`, `ffprobe`, and `lavish-axi` are on your `PATH`.

```sh
git clone https://github.com/Kitlee0252/dailies-axi.git
cd dailies-axi
npm ci
npm link
dailies-axi doctor
```

With the clone on disk and npm’s global bin directory on your `PATH`, `dailies-axi` works from any directory. Use `dailies-axi --help` for the command list and `dailies-axi <command> --help` for options. Doctor exits with status 1 when a required tool is missing. Whisper and its model are optional.

## Footage quick start

**Never use `lavish-axi share` or `lavish-axi export` on footage reviews, including through the Lavish browser menu.** Use a private workspace outside the tool checkout. Keep originals, proxies, frame grabs, transcripts, review builds, and feedback off Git and out of uploads. For machine-local reviews, configure Lavish to listen only on loopback. Lavish can bind a Tailscale address by default. [Lavish network configuration](https://github.com/kunchenguid/lavish-axi#how-it-works)

```sh
dailies-axi open /path/to/rough-cut.mp4
```

From your working directory, this creates `rough-cut-review/`, ingests the video as `cut`, builds `v1`, and opens it in Lavish. Ingest detects shot cuts and transcribes the speech when local Whisper is available. The command prints the review link under `session.url` and the transcript status under `transcript` before waiting in the foreground for feedback. Use `dailies-axi open /path/to/rough-cut.mp4 my-review --no-poll` to return after opening, then run `dailies-axi poll my-review/review/v1/review.html` when ready.

Pass a second path to name the workspace, `--asset ID` to name the proxy, or `--version vN` to choose the initial version number. Use `--language CODE` for speech other than Mandarin, `--srt FILE` for subtitles you already have, or `--no-transcribe` to skip speech. A missing or failed transcription never blocks the review. Later builds follow that number in order and require locked feedback on the preceding version. If the workspace path already exists, `open` refuses. Use the individual commands below to continue in an existing workspace, including after a partial run.

### Run the steps individually

```sh
dailies-axi init my-review
cd my-review
# Put a local original at source/original.mov or pass its existing path.
dailies-axi ingest source/original.mov camera
dailies-axi build v1
dailies-axi review v1
dailies-axi poll v1
```

The first ingest fills the untouched `source/index.html` with the proxy’s dimensions, frame rate, duration, asset ID and audio setting. It leaves the original in place and writes the proxy and manifest under `media/`. Every ingest records hard cuts in the proxy as `scene_cuts` and transcribes the asset when local Whisper is available. It accepts the same `--language`, `--srt` and `--no-transcribe` options as `open`. Ingest additional clips under distinct asset IDs and use `--fps RATE` to conform them to the composition rate. Place later segments in the working composition with unique HTML IDs, `data-review-clip` set to the manifest asset ID, and a `media/<asset-id>.mp4` reference. Keep starts, durations and media starts on frame boundaries.

The proxy uses H.264 at a constant frame rate, with frequent keyframes and AAC when the source has audio. FFmpeg applies source rotation. The manifest records the source SHA-256, original timestamps, and proxy-to-source frame mapping, including gaps and repeated frames.

### Local transcription

`open` and `ingest` transcribe automatically. Use the `transcribe` command to redo an asset in another language or replace it with corrected subtitles, then build the next version.

```sh
dailies-axi transcribe camera --language en
dailies-axi transcribe camera --srt source/corrected.srt
```

Automatic transcription uses local `whisper-cli` or `whisper-cpp` and defaults to Mandarin. Chinese and Japanese are timed per character or token, so transcript lines split at sentence punctuation and range quotes cover only the words inside the range. Whisper's word times can be off by a few tenths of a second, so check cut points against the picture and sound. Set `DAILIES_WHISPER` and `DAILIES_WHISPER_MODEL` to select the executable and a multilingual GGML model. You can also place the model under `~/.cache/hyperframes/whisper/models`. Dailies AXI never downloads a model. Corrected subtitles use original source times and take precedence over the automatic draft. Each build snapshots its transcripts.

## HyperFrames composition quick start

```sh
dailies-axi open /path/to/edit.html
```

For each video segment, give the element a unique HTML `id` and set `data-review-clip` to its asset ID. Point `src` at a local original, or use `src="media/<asset-id>.mp4"` with `data-review-source` pointing at the original. Original paths are relative to the authoring HTML or absolute. Segments that reuse an asset ID share its original. Give replacement footage a new asset ID. For an already ingested asset, `src="media/<asset-id>.mp4"` is sufficient.

```html
<main data-composition-id="edit" data-width="1920" data-height="1080"
      data-fps="30" data-start-frame="0" data-duration-frame="248">
  <video id="take-1" class="clip" data-review-clip="camera-a"
         src="originals/take-a.mov" data-track-index="0" data-has-audio="true"
         data-start-frame="0" data-duration-frame="188"></video>
  <video id="take-2" class="clip" data-review-clip="camera-b"
         src="media/camera-b.mp4" data-review-source="originals/take-b.mov"
         data-track-index="0" muted
         data-start-frame="188" data-media-start-frame="12" data-duration-frame="60"></video>
</main>
```

Include the normal HyperFrames styles and scripts in your composition. Starting from a standalone HTML file, `open` copies it to `<file-stem>-review/source/index.html`. Use that working copy for later rounds. If you open a workspace’s `source/index.html`, the command uses that workspace directly. It ingests missing originals at the composition’s frame rate, builds the next version, prints the link, and waits for feedback. It reuses existing assets and requires the previous round to be locked. Use `--no-poll` to stop after getting the link. Transcription options apply to newly ingested assets. For a composition with one asset, you can also pass `--srt FILE`.

Use zero-based integer `data-start-frame`, `data-duration-frame`, and `data-media-start-frame` for start, length, and proxy offset. Their seconds counterparts `data-start`, `data-duration`, and `data-media-start` still work. If you provide both forms, they must identify the same frame. The build rejects off-grid seconds and reports the nearest frame. It writes exact timing and proxy references into the snapshot for HyperFrames and leaves the working HTML as authored. The receipt reports the composition frame count and each clip’s frame bounds and proxy offsets. `edl.json` also records the corresponding original source frames.

## Animation quick start

```sh
dailies-axi init night-signal --sample
cd night-signal
dailies-axi build v1
dailies-axi review v1
dailies-axi poll v1
```

This opens the 24-second Night Signal composition in Lavish. Keep the poll attached while the reviewer marks the page and submits feedback.

## Review and revise

1. In Lavish, scrub or step through frames, drag a rectangle over an area, drag on the timeline to mark a range, or use **Whole video** for a general note. Yellow ticks on the timeline mark shot cuts, and a dragged range snaps to a cut within a fifth of a second. Click transcript text to jump to its frame or Shift-click to select its range. The transcript shows only the speech this version plays. Choose **Send feedback to agent** to submit the batch.
2. Read the `dailies-axi poll` receipt and the version’s `notes.json`. The poll wrapper persists the first valid batch and locks that version’s review. It keeps the Lavish session and prompts. Its `feedback` section names the notes file, EDL, transcripts and working composition, and its `next_step` replaces Lavish’s advice to edit the generated review page. The review page’s DOM snapshot is omitted. If the batch was already locked, it prints the stored JSON.
3. Check the version before editing. A note’s target file and selector locate candidate DOM elements. For footage, use `edl.json` and the note’s source spans to follow the edit across cuts. Each note except a whole-video note lists the `shots` it touches as cut-to-cut frame ranges, and `edl.json` lists every cut under `cuts`. A note’s `spoken` or `spoken_around` quote is what the reviewer heard in that version. Ranges are half-open `[frame, end_frame)`. Source offsets use the original presentation timeline. A spatial anchor includes the exact `media_frame` and a normalized rectangle on the upright source when the placement supports it.
4. For a frame grab, give the extractor the snapshot proxy and the note’s exact zero-based proxy frame.

   ```sh
   mkdir -p renders
   dailies-axi frame review/v1/media/camera.mp4 90 renders/check.jpg
   ```

5. Edit the working composition and open the next version after polling the preceding batch. From the workspace, run

   ```sh
   dailies-axi open source/index.html --note "Shortened the pause" --outcomes notes/v2-outcomes.json
   ```

   The optional outcomes JSON maps each previous note ID to an explanation. Use a string for text only, `{ "note": "...", "frame": 188 }` for a single frame, or add `"end_frame"` for a range.

   ```json
   {
     "N1": "Removed the duplicate shot",
     "N2": { "note": "Moved the title to the cut", "frame": 188 },
     "N3": { "note": "Shortened the fade", "frame": 220, "end_frame": 248 }
   }
   ```

   Frame numbers refer to the **new version’s timeline**. They are zero-based, and `end_frame` is exclusive. In the new review’s previous-round list, clicking a frame jumps to it and clicking a range also highlights that span. The new `version.json` records its parent, summary and outcomes. Opening the new version posts its link and summary in the previous version’s Lavish conversation. Lavish’s `end` command can close the previous session. If the reviewer chose **Send & End**, stop polling that session after reading its final receipt.

   For separate steps or a custom review output directory, use `build v2 --note ... --outcomes FILE`, then `review` and `poll`. Keep that same output directory across rounds.

`build` defaults to `source/index.html` and writes to `review/vN/`. If no working composition exists, it uses the bundled animation. Use `--composition FILE` for another edit. If you use a custom media directory, pass the same `--media DIR` to ingest, transcribe, and build. If you pass a custom output directory to `build`, give `review` and `poll` its explicit `review.html` path. Paths resolve from the current directory. The runtime, GSAP and review page assets come from the installation.

The original scripts remain available to developers. See the CLI help for the equivalent commands. Run `npm test` from the checkout.

## Install the agent skill

From the clone, copy the bundled skill into the account-level directory for your agent. Start a new agent session to pick it up.

```sh
# Claude Code
mkdir -p ~/.claude/skills
cp -R skills/dailies-axi ~/.claude/skills/

# Codex
mkdir -p ~/.agents/skills
cp -R skills/dailies-axi ~/.agents/skills/
```

The package also includes a root `plugin.json` for clients that support Agent Plugins. The skill uses the installed `dailies-axi` command and adds no server of its own.

## License

The project’s own code is [MIT licensed](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for FrameJam, HyperFrames, GSAP, and the other dependencies.
