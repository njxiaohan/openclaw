# Rich Output Protocol

Assistant output can carry a small set of delivery/render directives:

- `MEDIA:` for attachment delivery
- `[[audio_as_voice]]` for audio presentation hints
- `[[reply_to_current]]` / `[[reply_to:<id>]]` for reply metadata
- `[canvas ...]` for Control UI rich rendering

These directives are separate. `MEDIA:` and reply/voice tags remain delivery metadata; `[canvas ...]` is the web-only rich render path.

## `[canvas ...]`

`[canvas ...]` is the only agent-facing rich render syntax for the Control UI.

Self-closing example:

```text
[canvas ref="cv_123" title="Status" /]
```

Rules:

- `[view ...]` is no longer valid for new output.
- Canvas shortcodes render in the assistant message surface only.
- Only URL-backed canvases are rendered. Use `ref="..."` or `url="..."`.
- Block-form inline HTML canvas shortcodes are not rendered.
- The web UI strips the shortcode from visible text and renders the canvas inline.
- `MEDIA:` is not a canvas alias and should not be used for rich canvas rendering.

## Stored Rendering Shape

The normalized/stored assistant content block is a structured `canvas` item:

```json
{
  "type": "canvas",
  "preview": {
    "kind": "canvas",
    "surface": "assistant_message",
    "render": "url",
    "viewId": "cv_123",
    "url": "/__openclaw__/canvas/documents/cv_123/index.html",
    "title": "Status",
    "preferredHeight": 320
  }
}
```

Stored/rendered rich blocks use this `canvas` shape directly. `present_view` is not recognized.
