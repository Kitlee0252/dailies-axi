---
name: dailies-axi
description: Use when a reviewer needs to annotate a local video edit or HyperFrames composition by exact frame, time range, on-screen region, or whole video.
license: MIT
---

# Dailies AXI

Run `dailies-axi --help` for commands and `dailies-axi doctor` for prerequisites. Work in the private project directory. Keep originals, proxies, transcripts, frame grabs, reviews and feedback off Git and out of uploads. Never share or export a footage review through Lavish, including through its browser menu.

1. Run `dailies-axi init` and `dailies-axi ingest <source-file> <asset-id>`. The first ingest fills the starter at `source/index.html`. If speech context matters, use `dailies-axi transcribe <asset-id>` with a local Whisper model or pass `--srt FILE` for a corrected source-time transcript. Use `init --sample` when demonstrating the workflow with the bundled animation.
2. Run `dailies-axi build v1` and `dailies-axi review v1`. Ask the reviewer to scrub the timeline, mark areas or time ranges, and choose **Send feedback to agent**.
3. Keep `dailies-axi poll v1` attached while waiting. It records the submitted video batch in the version’s `notes.json` and preserves the Lavish receipt. Use the Dailies wrapper to persist the batch. If the reviewer chose **Send & End**, read the final feedback once and stop polling that session.
4. Check the note’s version, selectors, and `edl.json` against the reviewed snapshot before editing. Ranges are half-open. When a note identifies a proxy frame, use its exact `media_frame` with `dailies-axi frame`.
5. Edit `source/index.html` and run `dailies-axi build v2 --note "Change summary"` after v1’s batch is recorded. Optionally add `--outcomes FILE` with a JSON object mapping note IDs to descriptions. Keep earlier versions intact. Open and poll the new version when the reviewer is ready for another round.
