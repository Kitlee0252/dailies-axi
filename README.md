# Video feedback loop MVP

A local, manual agent loop: watch a version, mark feedback, receive it via Lavish, edit JSON, and render another version. Requires macOS (AppKit/Swift and Arial), Python 3, `/opt/homebrew/bin/ffmpeg`, and `lavish-axi`. No Python packages or server are required. The synthetic clip uses FFmpeg's `testsrc2` with its running frame/time display and a 440 Hz tone.

## Run the loop

From the project root:

```sh
./scripts/sample.sh
# edits/v1.json is the initial example; edit it as needed
./scripts/render.py edits/v1.json
./scripts/build_review.py v1
lavish-axi review/v1.html
lavish-axi poll review/v1.html
```

Play the video; mark a point or mark start and then end, write a note, and add it. The send button queues one `video-review` prompt and immediately calls `sendQueuedPrompts()`; `poll` returns its structured context as part of the prompt. Poll consumes each batch. The reviewer can delete local notes before sending. In a normal interactive loop, leave `poll` in the foreground until feedback arrives; do not use a detached poll. If a session is ended by the reviewer, follow Lavish's reopen rules.

For each returned note, check its `version` and consult `renders/v1.map.json`. Point notes include `segment_id` and `source_time`; ranges include the segment IDs they intersect and start/end locations. Segment boundaries are half-open except the final endpoint. Range end locations at a cut refer to the next segment, while `segment_ids` lists segments actually covered. Output timestamps describe the reviewed version, so do not reuse them blindly after a cut. Interpret the requested change, copy the edit list to `edits/v2.json`, change its version and the relevant cuts, text, position, or volume, then:

```sh
./scripts/render.py edits/v2.json
./scripts/build_review.py v2
lavish-axi review/v2.html
lavish-axi poll review/v2.html
```

Repeat for subsequent versions. Optionally save the returned feedback as a JSON file under ignored `notes/`; never assume it has been saved automatically. The examples demonstrate moving the v1 subtitle from bottom to top in v2.

## Edit list

`edits/v1.json` is the compact example. `version` is alphanumeric and names outputs; `source` is a project-relative file with video and audio. `segments` is an ordered non-empty list of `{id, in, out, volume}`: source times are seconds, `out` is exclusive, IDs must be unique and stable across versions, and `volume` is optional (default 1). Remove or shorten segments to cut, and preserve IDs when their identity survives. The top-level `volume` defaults to 1 and multiplies each segment's volume. `subtitles` and `overlays` are lists of `{start, end, text, position}` in **output seconds**, with position `top`, `center`, or `bottom`. Both are burned-in text in this MVP. Overlaps are rendered in list order. The source should use a constant frame rate; times are subject to frame/audio sample rounding. The renderer concatenates kept segments and writes `renders/vN.mp4` and `renders/vN.map.json`.

The installed FFmpeg lacks `drawtext`, so the renderer uses macOS AppKit through Swift to make local transparent text images, then overlays them with FFmpeg. Source media, generated text images, renders, review pages and optional notes are ignored by Git. The review builder embeds the MP4 as a data URL so each page is self-contained. In the actual Lavish sandbox, Chrome loaded the embedded H.264/AAC MP4, played it, and the mark button read a nonzero `currentTime`; the simulated point note arrived through `poll`. This was tested with `chrome-devtools-axi` using the page's controls. Embedding is intended for small clips and makes large pages unsuitable for long footage. The page uses a small self-contained stylesheet because the MVP explicitly requires a single self-contained HTML file.

## Evidence

The local proof directory contains the Lavish screenshot, received poll output and v1/v2 frames at the feedback time. Both renders were probed as 30-second H.264/AAC files; frame grabs show the subtitle moved from bottom to top. These generated artifacts are not committed.
