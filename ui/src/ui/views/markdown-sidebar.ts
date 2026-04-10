import { html, nothing } from "lit";
import { unsafeHTML } from "lit/directives/unsafe-html.js";
import { resolveCanvasIframeUrl } from "../canvas-url.ts";
import { icons } from "../icons.ts";
import { toSanitizedMarkdownHtml } from "../markdown.ts";
import type { SidebarContent } from "../sidebar-content.ts";

function resolveSidebarCanvasSandbox(content: SidebarContent): string {
  return content.kind === "canvas" ? "allow-scripts allow-same-origin" : "allow-scripts";
}

export type MarkdownSidebarProps = {
  content: SidebarContent | null;
  error: string | null;
  onClose: () => void;
  onViewRawText: () => void;
  canvasHostUrl?: string | null;
};

export function renderMarkdownSidebar(props: MarkdownSidebarProps) {
  const content = props.content;
  return html`
    <div class="sidebar-panel">
      <div class="sidebar-header">
        <div class="sidebar-title">
          ${content?.kind === "canvas" ? content.title?.trim() || "Render Preview" : "Tool Details"}
        </div>
        <button @click=${props.onClose} class="btn" title="Close sidebar">${icons.x}</button>
      </div>
      <div class="sidebar-content">
        ${props.error
          ? html`
              <div class="callout danger">${props.error}</div>
              <button @click=${props.onViewRawText} class="btn" style="margin-top: 12px;">
                View Raw Text
              </button>
            `
          : props.content
            ? content.kind === "canvas"
              ? html`
                  <div class="chat-tool-card__preview" data-kind="canvas">
                    <div class="chat-tool-card__preview-panel" data-side="front">
                      <iframe
                        class="chat-tool-card__preview-frame"
                        title=${content.title?.trim() || "Render preview"}
                        sandbox=${resolveSidebarCanvasSandbox(content)}
                        src=${resolveCanvasIframeUrl(content.entryUrl, props.canvasHostUrl) ??
                        nothing}
                        style=${content.preferredHeight
                          ? `height:${content.preferredHeight}px`
                          : ""}
                      ></iframe>
                    </div>
                    ${content.rawText?.trim()
                      ? html`
                          <div style="margin-top: 12px;">
                            <button @click=${props.onViewRawText} class="btn">View Raw Text</button>
                          </div>
                        `
                      : nothing}
                  </div>
                `
              : html`<div class="sidebar-markdown">
                  ${unsafeHTML(
                    toSanitizedMarkdownHtml(content.content, {
                      expandJsonBlocks: true,
                      disableTruncation: true,
                    }),
                  )}
                </div>`
            : html` <div class="muted">No content available</div> `}
      </div>
    </div>
  `;
}
