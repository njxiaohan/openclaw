const A2UI_PATH = "/__openclaw__/a2ui";
const CANVAS_HOST_PATH = "/__openclaw__/canvas";
const CANVAS_CAPABILITY_PATH_PREFIX = "/__openclaw__/cap";

function isCanvasHttpPath(pathname: string): boolean {
  return (
    pathname === CANVAS_HOST_PATH ||
    pathname.startsWith(`${CANVAS_HOST_PATH}/`) ||
    pathname === A2UI_PATH ||
    pathname.startsWith(`${A2UI_PATH}/`)
  );
}

export function resolveCanvasIframeUrl(
  entryUrl: string | undefined,
  canvasHostUrl?: string | null,
): string | undefined {
  const rawEntryUrl = entryUrl?.trim();
  if (!rawEntryUrl) {
    return undefined;
  }
  if (!canvasHostUrl?.trim()) {
    return rawEntryUrl;
  }
  try {
    const scopedHostUrl = new URL(canvasHostUrl);
    const scopedPrefix = scopedHostUrl.pathname.replace(/\/+$/, "");
    if (!scopedPrefix.startsWith(CANVAS_CAPABILITY_PATH_PREFIX)) {
      return rawEntryUrl;
    }
    const entry = new URL(rawEntryUrl, scopedHostUrl.origin);
    if (!isCanvasHttpPath(entry.pathname)) {
      return rawEntryUrl;
    }
    entry.protocol = scopedHostUrl.protocol;
    entry.username = scopedHostUrl.username;
    entry.password = scopedHostUrl.password;
    entry.host = scopedHostUrl.host;
    entry.pathname = `${scopedPrefix}${entry.pathname}`;
    return entry.toString();
  } catch {
    return rawEntryUrl;
  }
}
