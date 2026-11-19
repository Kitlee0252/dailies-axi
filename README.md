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

From your working directory, this creates `rough-cut-review/`, ingests the video as `cut`, builds `v1`, and opens it in Lavish. The command prints the review link under `session.url` before waiting in the foreground for feedback. Use `dailies-axi open /path/to/rough-cut.mp4 my-review --no-poll` to return after opening, then run `dailies-axi poll my-review/review/v1/review.html` when ready.

Pass a second path to name the workspace, `--asset ID` to name the proxy, or `--version vN` to choose the initial version number. Later builds follow that number in order and require locked feedback on the preceding version. If the workspace path already exists, `open` refuses. Use the individual commands below to continue in an existing workspace, including after a partial run.

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

The first ingest fills the untouched `source/index.html` with the proxy’s dimensions, frame rate, duration, asset ID and audio setting. It leaves the original in place and writes the proxy and manifest under `media/`. Ingest additional clips under distinct asset IDs and use `--fps RATE` to conform them to the composition rate. Place later segments in the working composition with unique HTML IDs, `data-review-clip` set to the manifest asset ID, and a `media/<asset-id>.mp4` reference. Keep starts, durations and media starts on frame boundaries.

The proxy uses H.264 at a constant frame rate, with frequent keyframes and AAC when the source has audio. FFmpeg applies source rotation. The manifest records the source SHA-256, original timestamps, and proxy-to-source frame mapping, including gaps and repeated frames.

### Optional local transcription

Transcribe with either command after ingest and before the next build.

```sh
dailies-axi transcribe camera --language zh
dailies-axi transcribe camera --srt source/corrected.srt
```

Automatic transcription uses local `whisper-cli` or `whisper-cpp` and defaults to Mandarin. Set `DAILIES_WHISPER` and `DAILIES_WHISPER_MODEL` to select the executable and a multilingual GGML model. You can also place the model under `~/.cache/hyperframes/whisper/models`. Dailies AXI never downloads a model. Corrected subtitles use original source times and take precedence over the automatic draft. Each build snapshots its transcripts.

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

1. In Lavish, scrub or step through frames, drag a rectangle over an area, drag on the timeline to mark a range, or use **Whole video** for a general note. Click transcript text to jump to its frame or Shift-click to select its range. Choose **Send feedback to agent** to submit the batch.
2. Read the `dailies-axi poll` receipt and the version’s `notes.json`. The poll wrapper persists the first valid batch and locks that version’s review. It preserves the original Lavish receipt. If the batch was already locked, it prints the stored JSON.
3. Check the version before editing. A note’s target file and selector locate candidate DOM elements. For footage, use `edl.json` and the note’s source spans to follow the edit across cuts. Ranges are half-open `[frame, end_frame)`. Source offsets use the original presentation timeline. A spatial anchor includes the exact `media_frame` and a normalized rectangle on the upright source when the placement supports it.
4. For a frame grab, give the extractor the snapshot proxy and the note’s exact zero-based proxy frame.

   ```sh
   mkdir -p renders
   dailies-axi frame review/v1/media/camera.mp4 90 renders/check.jpg
   ```

5. Edit the working composition and build the next version after polling the preceding batch. Keep the same review output directory. Optionally supply an outcomes JSON object such as `{"N1":"Trimmed the pause by 12 frames"}`.

   ```sh
   dailies-axi build v2 --note "Shortened the pause" --outcomes notes/v2-outcomes.json
   dailies-axi review v2
   dailies-axi poll v2
   ```

   Omit `--outcomes` if there’s no outcomes file. The new `version.json` records its parent, summary and outcomes. Lavish’s `reply` and `end` commands can close the previous session. If the reviewer chose **Send & End**, stop polling that session after reading its final receipt.

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
