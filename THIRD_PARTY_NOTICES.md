# Third-party notices

## FrameJam

FrameJam is MIT licensed, copyright 2026 Moritz Kremb. This project uses revision [bc45364aff90ba931d350e931291940fdc6e604c](https://github.com/moritzkremb/framejam/tree/bc45364aff90ba931d350e931291940fdc6e604c). The original license is in [third_party/framejam/LICENSE](third_party/framejam/LICENSE).

| File here | FrameJam source | Use |
| --- | --- | --- |
| `scripts/cut/retakes.mjs` | `playbooks/clean-cut/scripts/find_retakes.py` | Adapted normalized repeat windows to find unused takes of the reviewed dialogue across source transcripts. |
| `scripts/transcript.mjs` | `src/core/transcript.ts` | Copied parser, paragraph detection and bounded overlap quotes. Removed TypeScript types. |
| `scripts/feedback-format.mjs` | `src/core/feedback.ts` | Adapted time and position helpers and the feedback Markdown to composition frames, rectangles and Lavish. |
| `scripts/spoken.mjs` | `src/core/feedback.ts` | Adapted overlap and neighboring speech context to source-time intervals and adjacent sentences. |
| `scripts/extract-frame.mjs` | `src/server/thumbs.ts` | Adapted the FFmpeg helper to select by decoded frame index. |
| `scripts/transcribe.mjs`, `scripts/whisper.mjs` | `src/server/transcribe.ts` | Adapted tool and model lookup, audio extraction and Whisper flags for local source transcription and corrected SRT. |
| `scripts/notes.mjs`, `scripts/build-review.mjs` | `src/server/json-store.ts` | Applied one submitted batch per version and copy-on-write video snapshots to the Lavish directory layout. |

The note kinds and batch shape follow `src/core/types.ts`. The range interaction follows the drag selection in `src/web/components/review/filmstrip.tsx`. The proxy and EDL conventions refer to the Clean Cut and Product Launch playbooks. The CFR mapping, spatial anchors, Lavish UI and version EDL implementation were written for this project.

## HyperFrames

The unmodified runtime from `hyperframes@0.9.69` is inlined in generated review pages. The project also uses the composition format and CLI. [HyperFrames source](https://github.com/heygen-com/hyperframes) · [Apache License 2.0](https://www.apache.org/licenses/LICENSE-2.0)

## GSAP

`gsap@3.15.1` is bundled with the composition and inlined in the review. [GreenSock Standard “no charge” license](https://gsap.com/standard-license/)

## JavaScript libraries

- [TOON](https://github.com/toon-format/toon) (MIT) encodes CLI output and decodes Lavish poll receipts.
- [parse5](https://github.com/inikulin/parse5) (MIT) parses compositions for their edit decision lists.

## Local tool dependencies

- FFmpeg and FFprobe run as external commands. Their licenses depend on the installed build. [FFmpeg legal information](https://ffmpeg.org/legal.html)
- whisper.cpp (MIT, the ggml authors) is an optional external command. Model files are installed separately. [whisper.cpp](https://github.com/ggml-org/whisper.cpp) · [GGML model conversion](https://huggingface.co/ggerganov/whisper.cpp) · [OpenAI Whisper weights, MIT](https://github.com/openai/whisper)
- [Lavish AXI](https://github.com/kunchenguid/lavish-axi) (MIT) is the external review host and feedback transport.

## Editing workflow references

The short audio fade at a new hard splice follows the media-use rule documented by [video-use](https://github.com/browser-use/video-use/tree/43cfc56). Rendering uses HyperFrames' native clip fades.

The edit engine calls the existing FrameJam-derived frame extraction and local Whisper lookup listed above. Its cut table, render checks and operations were written for this project. The review and pacing practices in the edit skill draw on FrameJam's [Clean Cut playbook](https://github.com/moritzkremb/framejam/tree/bc45364aff90ba931d350e931291940fdc6e604c/playbooks/clean-cut), [video-use](https://github.com/browser-use/video-use/tree/43cfc56) (MIT), [take-one](https://github.com/talsiach/take-one/tree/43fd27b) (MIT), and public workflow descriptions in [mrpaidsocial-video-editor-agent](https://github.com/mrpaidsocial/mrpaidsocial-video-editor-agent/tree/81a8eea).

[Auto-Editor’s JSON timeline](https://github.com/WyattBlue/auto-editor) is a schema reference. [OpenTimelineIO](https://github.com/AcademySoftwareFoundation/OpenTimelineIO) is a naming reference. Neither is a dependency.
