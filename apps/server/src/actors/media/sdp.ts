import type { MediaSource } from "@vaskel/contracts/media";
/** Bound by the shared SDP byte limit; check only m-section kinds and their mids. */
export function offeredSourcesMatch(
  sdp: string,
  tracks: readonly { source: MediaSource; mid: string }[],
): boolean {
  const sections = new Map<string, string>();
  let kind: string | undefined;
  let mid: string | undefined;
  function commit() {
    if (mid && kind) {
      if (sections.has(mid)) return false;
      sections.set(mid, kind);
    }
    return true;
  }
  for (const line of sdp.split(/\r?\n/)) {
    if (line.startsWith("m=")) {
      if (!commit()) return false;
      kind = line.slice(2).split(/\s+/)[0];
      mid = undefined;
    } else if (line.startsWith("a=mid:")) {
      if (mid !== undefined) return false;
      mid = line.slice(6).trim();
    }
  }
  if (!commit()) return false;
  return tracks.every(
    (track) =>
      sections.get(track.mid) ===
      (track.source === "microphone" || track.source === "screen_audio"
        ? "audio"
        : "video"),
  );
}
