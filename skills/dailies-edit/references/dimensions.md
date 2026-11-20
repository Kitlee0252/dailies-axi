# Classify reviewer feedback

Use the locked note's ID and original wording. Classify its intent once. The CLI records the original quote and applies the scoring rules.

| Dimension | Direction | Value when specified | Example |
| --- | --- | --- | --- |
| `pacing.sentence_gap` | `tighter`, `looser` | Maximum pause in seconds | 句子之间的停顿再短一点 |
| `pacing.total_length` | `less`, `more` | Target duration in seconds | 压到 30 秒 |
| `cut.filler` | `avoid`, `use` | — | 保留口语里的嗯啊 |
| `cut.retake` | `avoid`, `use` | — | 口误重说的地方剪掉 |
| `opening.hook` | `less`, `more` | Seconds to the first line | 开头太慢 |
| `ending.outro` | `avoid`, `use` | — | 结尾不用说谢谢观看 |
| `captions.style` | `use`, `avoid` | `karaoke`, `line`, `none` | 字幕逐字跳 |
| `captions.position` | `use`, `avoid` | `lower`, `middle` | 字幕放在中间 |
| `graphics.fullscreen_text` | `avoid`, `use` | — | 不要全屏大字 |
| `graphics.density` | `less`, `more` | — | 画面上的贴片太多 |
| `audio.music_level` | `less`, `more` | dB relative to voice | 音乐比人声低 12 dB |
| `transitions.style` | `use`, `avoid` | `hard`, `effect` | 用硬切，少用特效转场 |
| `reframe.method` | `use`, `avoid` | `zoom`, `blur-pad` | 放大裁切，别加模糊边 |

- Use `other:<slug>` for a project decision outside this vocabulary. Use `skip: true` for an objective error, a message without a preference, or a revocation handled with `learn forget`.
- Mark a specific instruction or exact treatment as `authority: "explicit"`. Mark an aesthetic goal with room for comparison as `authority: "taste"`. Preserve the reviewer's number, unit or category. Leave unspecified values blank.
- Choose `scope: "local"` for the targeted footage or `"global"` for the whole film. Include `scope_reason` if a local note explicitly authorizes a broader treatment. Choose `"long-term"` only for instructions like “以后都这样” from a named reviewer. Confirm the scoped context in the outcome.
- Copy an explicit `reopens` link. If the reviewer refers to an earlier treatment without a link, match the dimension and the same source area or whole film. Supply its previous outcome reference as `reopens` and disclose the inference. Leave uncertain references open for clarification.
- When reviewers conflict, let the brief's `decision_owner` set the main treatment and show the other direction as a candidate. Without an owner, make both directions available and ask. Classify each reviewer's input independently.

A classification file contains the round and each locked note exactly once.

```json
{
  "schema_version": 1,
  "round": "v2",
  "classified_by": "dailies-edit@0.3.0",
  "notes": [
    {
      "note": "N1",
      "dimension": "pacing.sentence_gap",
      "direction": "tighter",
      "authority": "taste",
      "scope": "global"
    }
  ]
}
```

Confirm state changes in the next outcome. For example, “你在两条抖音口播片里选了较短的停顿。现在可作为同场景的默认值。说一句『不按偏好』即可撤销。” Describe inferred reopenings with “我把这条理解为重开 v1:N4。” For an out-of-scope offer, identify the location and ask whether the reviewer wants it changed.
