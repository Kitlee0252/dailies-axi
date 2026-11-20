# Dailies AXI

[Architecture diagram](docs/architecture.html)

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

With the clone on disk and npm’s global bin directory on your `PATH`, `dailies-axi` works from any directory. The same install provides `dailies-cut`. Use `dailies-axi --help` for the review commands and `dailies-axi <command> --help` for options. Doctor exits with status 1 when a required tool is missing. Whisper and its model are optional for collecting feedback and required for independent verification of audible dialogue.

## Footage quick start

**Never use `lavish-axi share` or `lavish-axi export` on footage reviews, including through the Lavish browser menu.** Use a private workspace outside the tool checkout. Keep originals, proxies, frame grabs, transcripts, review builds, and feedback off Git and out of uploads. For machine-local reviews, configure Lavish to listen only on loopback. Lavish can bind a Tailscale address by default. [Lavish network configuration](https://github.com/kunchenguid/lavish-axi#how-it-works)

```sh
dailies-axi open /path/to/rough-cut.mp4 --brief "Audience, destination, target length and goal"
```

From your working directory, this creates `rough-cut-review/`, ingests the video as `cut`, builds `v1`, and opens it in Lavish. Ingest detects shot cuts and transcribes the speech when local Whisper is available. The command prints the review link under `session.url` and the transcript status under `transcript` before waiting in the foreground for feedback. Use `dailies-axi open /path/to/rough-cut.mp4 my-review --no-poll` to return after opening, then run `dailies-axi poll my-review/review/v1/review.html` when ready.

The first interactive open asks for the brief if you omit `--brief`. `brief.md` stores the answer for later rounds. Pass a second path to name the workspace, `--asset ID` to name the proxy, or `--version vN` to choose the initial version number. Use `--language CODE` for speech other than Mandarin, `--srt FILE` for subtitles you already have, or `--no-transcribe` to skip speech. A missing or failed transcription never blocks the review. Later builds follow that number in order and require locked feedback on the preceding version. If the workspace path already exists, `open` refuses. Use the individual commands below to continue in an existing workspace, including after a partial run.

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

The first ingest fills the untouched `source/index.html` with the proxy’s dimensions, frame rate, duration, asset ID and audio setting. It leaves the original in place and writes the proxy and manifest under `media/`. Ingest estimates hard cuts from changes between downscaled RGB frames and stores them as `scene_cuts`. It uses the same picture detector as `dailies-cut analyze`. Existing manifests retain their cached cut marks. Ingest transcribes the asset when local Whisper is available and accepts the same `--language`, `--srt` and `--no-transcribe` options as `open`. Ingest additional clips under distinct asset IDs and use `--fps RATE` to conform them to the composition rate. Place later segments in the working composition with unique HTML IDs, `data-review-clip` set to the manifest asset ID, and a `media/<asset-id>.mp4` reference. Keep starts, durations and media starts on frame boundaries.

The proxy uses H.264 at a constant frame rate, with frequent keyframes and AAC when the source has audio. FFmpeg applies source rotation. The manifest records the source SHA-256, original timestamps, and proxy-to-source frame mapping, including gaps and repeated frames.

### Local transcription

`open` and `ingest` transcribe automatically. Use the `transcribe` command to redo an asset in another language or replace it with corrected subtitles, then build the next version.

```sh
dailies-axi transcribe camera --language en
dailies-axi transcribe camera --srt source/corrected.srt
```

Automatic transcription uses local `whisper-cli` or `whisper-cpp` and defaults to Mandarin. Chinese and Japanese are timed per character or token. Dailies AXI measures audio pauses of at least 0.4 seconds, caches them with the transcript, and uses them to align Whisper's token starts and split cues. Continuous automatic speech also splits into shorter cues. Check cut points against picture and sound because token timings are approximate. Set `DAILIES_WHISPER` and `DAILIES_WHISPER_MODEL` to select the executable and a multilingual GGML model. You can also place the model under `~/.cache/hyperframes/whisper/models`. Dailies AXI never downloads a model. Corrected subtitles use original source times and take precedence over the automatic draft. Each build snapshots its transcripts. Run `dailies-axi transcribe <asset-id>` to align an existing Whisper draft before building the next version.

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

To render a review composition locally with HyperFrames telemetry disabled, run the following from the workspace.

```sh
mkdir -p renders
HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 hyperframes render review/v1/composition -o renders/v1.mp4
```

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

1. In Lavish, click the timeline or a transcript line to jump to that frame and clear the selection. Drag on the timeline to select a range, with edges snapping to yellow shot-cut ticks within a fifth of a second. Shift-click a transcript line to select it, then Shift-click another line to select the continuous span from the original line. Playback and frame steps move the playhead and highlight and scroll to the current transcript line while keeping the selected range. Shift+Left/Right moves the range’s exclusive end by one frame. The range chip shows its bounds and duration. Click it or press Esc to clear the selection. Drag a rectangle over an area or use **Whole video** for a general note, then choose **Send feedback to agent** to submit the batch.

   Burned-in captions are visible as part of the video. **Transcript overlay** shows the current line in the preview with a Transcript label. The toggle starts off and affects only the review preview. The transcript list shows only the speech this version plays.
2. Read the `dailies-axi poll` receipt and the version’s `notes.json`. The poll wrapper persists the first valid batch and locks that version’s review. It keeps the Lavish session and prompts. Its `feedback` section names the notes file, EDL, transcripts and working composition, and its `next_step` replaces Lavish’s advice to edit the generated review page. The review page’s DOM snapshot is omitted. If the batch was already locked, it prints the stored batch and the handoff again.
3. Check the version before editing. A note’s target file and selector locate candidate DOM elements. For footage, use `edl.json` and the note’s source spans to follow the edit across cuts. Each note except a whole-video note lists the `shots` it touches as cut-to-cut frame ranges, and `edl.json` lists every cut under `cuts`. A note’s `spoken` or `spoken_around` quote is what the reviewer heard in that version. Ranges are half-open `[frame, end_frame)`. Source offsets use the original presentation timeline. A spatial anchor includes the exact `media_frame` and a normalized rectangle on the upright source when the placement supports it.
4. For a frame grab, give the extractor the snapshot proxy and the note’s exact zero-based proxy frame.

   ```sh
   mkdir -p renders
   dailies-axi frame review/v1/media/camera.mp4 90 renders/check.jpg
   ```

5. For source footage, follow the verified editing flow below. For independently authored compositions without a managed cut, you can edit the working composition and pass legacy outcomes. From the workspace, run

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

   Frame numbers refer to the **new version’s timeline**. They are zero-based, and `end_frame` is exclusive. In the new review’s previous-round list, clicking a frame jumps to it and clicking a range also highlights that span. The new `version.json` records its parent, summary and outcomes. Opening the new version posts its link and summary in the previous version’s Lavish conversation. Previous-round notes also link to the new version at the outcome’s frame or range. Lavish’s `end` command can close the previous session. If the reviewer chose **Send & End**, stop polling that session after reading its final receipt.

   For separate steps or a custom review output directory, use `build v2 --note ... --outcomes FILE`, then `review` and `poll`. Keep that same output directory across rounds.

`build` defaults to `source/index.html` and writes to `review/vN/`. If no working composition exists, it uses the bundled animation. Use `--composition FILE` for another edit. If you use a custom media directory, pass the same `--media DIR` to ingest, transcribe, and build. If you pass a custom output directory to `build`, give `review` and `poll` its explicit `review.html` path. Paths resolve from the current directory. The runtime, GSAP and review page assets come from the installation.

The original scripts remain available to developers. See the CLI help for the equivalent commands. Set `DAILIES_DEBUG=1` to include stack traces with CLI errors. Run `npm test` from the checkout. On macOS, `test/fixtures/make-rough-cut.sh /path/to/new-private-fixture` makes the synthetic Tingting rough cut for local rendering and browser QA.

## Apply a footage review with dailies-cut

Run the following inside the private review workspace after `dailies-axi poll v1` has locked the batch.

```sh
dailies-cut plan v1
# Inspect cut-plans/v1/evidence and complete ops.json from ops.draft.json.
dailies-cut apply ops.json --candidate balanced
dailies-cut verify balanced
dailies-cut select balanced
dailies-axi open source/index.html --note "Tightened the review cut" \
  --outcomes cut-candidates/balanced/changes.json
```

`analyze [asset]` measures color cuts and quiet intervals with FFmpeg. It caches by proxy hash. `plan` matches the locked note batch to the reviewed EDL and gives you source intervals, candidate cut points, frames, and waveforms. Read and listen to the evidence before choosing an operation. Use `--review-root DIR` on `plan` and `apply` if the workspace uses a custom review output directory.

The edit contracts carry `schema_version: 1`. All intervals are zero-based and half-open. In `cut.json` and `ops.json`, the canonical source coordinate is the ingested asset's frame on its conformed proxy. For variable-frame-rate originals, the manifest maps those frames back to decoded source indexes and presentation timestamps. Composition frames are derived from the ordered source ranges. The engine supports contiguous 1× footage with one active source segment at a time and no reused source interval.

| Operation | Fields beyond `note`, `intent`, `authority`, `scope`, `op` |
| --- | --- |
| `delete` | `asset`, `range: [start, end]`. An explicit local range delete covers the locked selection. |
| `trim` | `clip`, `asset`, `range: [newIn, newOut]`. An extension must use footage outside the current cut and earlier removals. |
| `tighten` | `min_pause` and `keep_pad` in seconds. Use global scope for an authorized whole-film pacing pass. For a local note, an optional `asset` and `range` can narrow the treatment. |
| `overlay` | Unique `element`, `text` or an authored HTML `template` ID, `anchor: {asset, range}`, and normalized `rect: {x, y, width, height}` relative to the composition. Use `replace: true` with explicit authority to re-anchor an existing overlay. |
| `ask`, `decline` | `reason`. The outcome stays pending. |

Choose `explicit`, `inferred`, or `taste` for authority and `local` or `global` for scope. Keep the draft's `from` version and `batch` ID. If a localized note authorizes global work, record why in `scope_reason`. In a full render with audio, use `language` and set `expected_speech` to the checked dialogue after editing, or to an empty string for a film without dialogue. Verification compares a fresh local transcription after normalizing case, spacing, and punctuation. Check script variants such as written numbers against the dialogue.

The engine plans every operation on the reviewed source axis before updating the cut. For a deletion or trim it prefers a quiet visual cut within six frames, then the existing quiet position or a nearby quiet boundary. It reports a boundary with no safe cut and keeps a lost overlay anchor visible in the report. `select` installs the cumulative `cut.json` and regenerates the managed portions of `source/index.html`. Author-controlled graphics and animation stay in the surrounding HTML. A `template` for an overlay can live outside the managed sections within the composition root.

For a taste note, apply two or more named candidates from the same locked batch. Keep explicit changes identical and vary the treatment. Verify each candidate, then compare its private `render/film.mp4` and `changes.json` before selection. Candidates are separate and only the chosen one advances the review version.

`verify` checks conform against the locked EDL, source cut safety, flash shots, overlay placement, and duration. The actual render is checked independently for frame count, flash shots, cut audio, dialogue and visible overlay pixels. Loudness and pause heuristics are warnings. Up to three minutes, the full render is automatic. For a longer edit, ask the reviewer whether to render all of it. Use `--render` if they agree or `--windows` for localized evidence around edited cuts and overlays. HyperFrames 0.9.69 supports window renders at 24, 25, 30 and 60 fps. A diagnostic `--edl-only` run cannot authorize delivery. Telemetry and update checks are disabled for engine renders.

The review consumes verified `changes.json` with the adjacent `verify.json`. It checks the receipt against the composition, proxies and locked inputs before building. The change list preserves each note's status, output frames, affected source ranges and operation details. It and the reviewer's later reactions are the inputs for recording preferences. Keep candidates, transcripts, analysis and render evidence off Git.

## Learn from review feedback

On the first open, pass `--brief-file brief.json`. The file is copied into the private workspace. The optional text brief remains available via `--brief`.

```json
{
  "schema_version": 1,
  "project": "short-demo",
  "context": { "platform": "douyin", "format": "koubo", "target_s": 30 },
  "reviewers": [{ "id": "R1", "role": "editor" }],
  "decision_owner": "R1",
  "learning": { "enabled": true }
}
```

The next review page shows the previous notes and outcomes with frame links, preference disclosures and reactions. Reviewers can accept, reject, choose an offered alternative, or reopen an outcome. Send a note, reaction, or both. `notes.json` schema 3 adds the reviewer, reactions and optional note-level reopen references. The cut engine also reads locked schema 2 batches. Anonymous feedback stays in the workspace's project decisions.

Run these commands from the workspace.

```sh
dailies-cut learn ingest --round v2
dailies-cut learn ingest --round v2 --classified learn.classify.json
dailies-cut learn plan --round v2
dailies-cut plan v2
```

Use the classification schema and vocabulary in [dailies-edit](skills/dailies-edit/references/dimensions.md). `learn ingest` writes a classification list and transition receipt under `learning/`. Read the transition notices before writing the next outcome. `dailies-cut plan` includes matching learning entries in its operation draft. For taste alternatives, apply and verify named candidates from the same locked feedback. Name the choices in `ops.json` under `outcomes.<note>.alternatives`, each with an `id` and optional `direction`, `value`, `label`, or `main: true`. The next round's reaction records the choice for subsequent cuts.

Copy a used learning entry's `basis` into the operation. Set `outcomes.<note>.learned` to the entry's `disclosure` plus its `mode`. Add acknowledgements, transition notices or the explanation of an inferred reopening under `outcomes.<note>.note`. `verify` blocks undisclosed learned applications and conflicts with surviving project decisions. Inspect the verified output before delivery. Existing source-footage protections apply to all candidates, including a subsequent request for an alternative.

Project decisions apply immediately. A reviewer preference becomes a default for the same context with at least 3.0 decayed positive evidence, explicit evidence from at least two projects, a Wilson lower bound of 0.40 and explicit confirmation within 365 days. An express long-term preference takes effect in its stated context. A stale established preference becomes a suggestion and is archived after 730 days. With `auto_apply: false` (the default), a learned preference can only drive a change within the current note's scope. A reviewer can opt in by setting `settings.auto_apply` in their local profile. The plan identifies unrelated defaults as an offer at most once per project and dimension.

```sh
dailies-cut learn status --reviewer R1
dailies-cut learn forget 'R1|pacing.sentence_gap|douyin-koubo|tighter' --quote 'Please stop using this preference'
dailies-cut learn pause                 # add --reviewer R1 for just that profile
dailies-cut learn pause --resume
dailies-cut learn ingest --signoff      # on reviewer signoff of the final locked round
dailies-cut learn propose
```

`DAILIES_LEARN=off` pauses reviewer defaults for a process. The private workspace holds `learning/events.jsonl`, `decisions.json`, `decisions.md` and versioned `params.json`. `${DAILIES_HOME:-~/.dailies}` holds the cross-project ledger, reviewer caches and pending proposals. Leave all these records local. Use `learn status --at ISO --rebuild` to reproduce the reviewer cache at a fixed calculation time. Only cross-project evidence with at least three reviewers, five projects and no objection can produce a general proposal. The CLI announces newly written proposals for human review. A human records a rejection or reversal in the proposal and includes `reviewed_at` for the cooldown. A proposal draws context and role labels from generic vocabulary to protect client and reviewer names.

## Install the agent skills

From the clone, copy the bundled skills into the account-level directory for your agent. Start a new agent session to pick it up.

```sh
# Claude Code
mkdir -p ~/.claude/skills
cp -R skills/dailies-axi skills/dailies-edit ~/.claude/skills/

# Codex
mkdir -p ~/.agents/skills
cp -R skills/dailies-axi skills/dailies-edit ~/.agents/skills/
```

The package also includes a root `plugin.json` for clients that support Agent Plugins. The skills use the installed `dailies-axi` and `dailies-cut` commands.

## License

The project’s own code is [MIT licensed](LICENSE). See [third-party notices](THIRD_PARTY_NOTICES.md) for FrameJam, HyperFrames, GSAP, and the other dependencies.
