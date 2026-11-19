---
name: dailies-axi
description: Use when a reviewer needs to annotate a local video edit or HyperFrames composition by exact frame, time range, on-screen region, or whole video.
license: MIT
---

# Dailies AXI

Run `dailies-axi --help` for commands and `dailies-axi doctor` for prerequisites. Work in the private project directory. Keep originals, proxies, transcripts, frame grabs, reviews and feedback off Git and out of uploads. Never share or export a footage review through Lavish, including through its browser menu.

1. For a new footage review, run `dailies-axi open <video> [workspace-dir]`. It creates a private `<video-name>-review/` workspace in the current directory, ingests as `cut`, builds `v1`, and opens it in Lavish. Read `session.url` as soon as it prints and keep the command attached to collect feedback. Use `--no-poll` to hand off the link and wait separately with `dailies-axi poll <review_file>` using the printed path. Use `--asset ID` or `--version vN` to change the defaults. An existing workspace requires the individual commands.
2. For a custom composition, transcription before review, or the bundled animation, use the individual commands from the workspace. Run `dailies-axi init` and `dailies-axi ingest <source-file> <asset-id>` for footage, or `dailies-axi init --sample` for the bundled animation. The first ingest fills `source/index.html`. For speech context, run `dailies-axi transcribe <asset-id>` with a local Whisper model or pass `--srt FILE` for corrected source-time subtitles. Then run `dailies-axi build v1`, `dailies-axi review v1`, and `dailies-axi poll v1`.
3. Ask the reviewer to scrub the timeline, mark areas or time ranges, and choose **Send feedback to agent**. The Dailies poll records the submitted video batch in the version’s `notes.json` and preserves the Lavish receipt. If the reviewer chose **Send & End**, read the final feedback once and stop polling that session.
4. Check the note’s version, selectors, and `edl.json` against the reviewed snapshot before editing. Ranges are half-open. When a note identifies a proxy frame, use its exact `media_frame` with `dailies-axi frame`.
5. From the workspace, edit `source/index.html` and build the next version after the preceding batch is recorded, for example with `dailies-axi build v2 --note "Change summary"`. Optionally add `--outcomes FILE` with a JSON object mapping note IDs to descriptions. Keep earlier versions intact. Open and poll the new version when the reviewer is ready for another round.
