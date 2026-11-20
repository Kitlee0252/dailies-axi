---
name: dailies-edit
description: Use when revising local footage from a locked Dailies AXI review batch, preparing alternative treatments, or explaining verified outcomes to the reviewer.
license: MIT
---

# Dailies Edit

Read `brief.md` before interpreting notes. If the brief was never offered, ask once about the audience, publication channel, intended length and goal. Respect a skipped brief. Keep source media, proxies, evidence, renders, feedback, and candidates inside the private review workspace. Never share or export them through Lavish.

1. **Inspect the moment.** Run `dailies-cut plan vN` against locked feedback. Read the reviewer's exact words, look at the evidence frames, and listen around the boundaries. A click shows where the reviewer noticed the problem. Use the waveform and picture to judge what the note refers to.
2. **Classify and record each note.** Fill the draft's `ops` with the note ID, intent, authority, and scope. Carry out explicit cuts, trims, and overlays. Treat ambiguous direction, pacing, and style as taste. Prepare at least two named candidates with the same explicit changes and distinct taste treatments. Hand the reviewer the private comparison and let them choose. If the ambiguity changes the message, an earlier approval, or permission to edit, use `ask` with the concrete choice. Use `decline` with a reason for unsupported work.
3. **Respect the authorized scope.** Explain an authorized global treatment and state how many places it affected. Flag similar problems outside that scope as suggestions. Preserve previous decisions. If a cut and a caption conflict, show the lost anchor and ask which to keep. For continuous talking-head footage, weigh a preserved breath against the visual jump when offering pacing alternatives.
4. **Check the actual output.** Provide checked expected dialogue for an audible full render. Run `dailies-cut apply` and `dailies-cut verify` for each candidate. Above three minutes, ask whether to render the full film. If the reviewer declines, use the cut-window verification and report its coverage. Review the splice images and listen to the audio. Correct objective failures before sending a candidate for review. After three unsuccessful attempts, report the precise failure and leave the affected note open.
5. **Deliver the selected version.** Run `dailies-cut select`, then open the working composition with the selected candidate's verified `changes.json` as outcomes. Use the reviewer's language, say what changed, and give the clickable frame or range when there is one. Say what still needs their decision. The candidate's change list and later reviewer reactions are evidence for the project decision record.

Use the CLI for coordinates, snapping, ripple, rendering and verification. See `dailies-cut --help` and the Dailies AXI README for the file contracts.
