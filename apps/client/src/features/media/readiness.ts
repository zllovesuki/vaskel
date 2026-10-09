import {
  message,
  UiMessageError,
  type UiMessage,
} from "@/client/features/i18n/messages";
import { ReplacedGeneration } from "./protocol";

const ICE_GATHERING_TIMEOUT_MS = 10_000;
const CONNECTION_TIMEOUT_MS = 5_000;
const NEGOTIATION_RESERVE_MS = 1_000;

function localCandidateCounts(peer: RTCPeerConnection) {
  const counts = { host: 0, srflx: 0, prflx: 0, relay: 0, other: 0 };
  for (const line of peer.localDescription?.sdp.split(/\r?\n/) ?? []) {
    if (!line.startsWith("a=candidate:")) continue;
    const type = line.split(/\s+/)[7];
    if (
      type === "host" ||
      type === "srflx" ||
      type === "prflx" ||
      type === "relay"
    )
      counts[type]++;
    else counts.other++;
  }
  return counts;
}

function waitForPeer(
  peer: RTCPeerConnection,
  signal: AbortSignal,
  stage: "gathering" | "connecting",
  ready: () => boolean,
  notice: UiMessage,
  deadline?: number,
) {
  return new Promise<void>((resolve, reject) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let settled = false;
    const started = Date.now();
    const hardExpires =
      deadline === undefined ? Infinity : deadline - NEGOTIATION_RESERVE_MS;
    const expires = Math.min(
      started +
        (stage === "gathering"
          ? ICE_GATHERING_TIMEOUT_MS
          : CONNECTION_TIMEOUT_MS),
      hardExpires,
    );
    const settle = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      peer.removeEventListener("icecandidate", check);
      peer.removeEventListener("icegatheringstatechange", check);
      peer.removeEventListener("connectionstatechange", check);
      signal.removeEventListener("abort", check);
      if (error) reject(error);
      else resolve();
    };
    const timedOut = () => {
      if (settled) return;
      const candidateCounts = localCandidateCounts(peer);
      // A slow STUN interface need not block signaling with candidates already
      // gathered. The owner's negotiation deadline remains a hard boundary.
      if (
        stage === "gathering" &&
        peer.iceGatheringState !== "new" &&
        Date.now() < hardExpires &&
        Object.values(candidateCounts).some((count) => count > 0)
      ) {
        settle();
        return;
      }
      if (import.meta.env.DEV)
        console.warn("Media readiness timed out.", {
          stage,
          elapsedMs: Math.max(0, Date.now() - started),
          iceGatheringState: peer.iceGatheringState,
          iceConnectionState: peer.iceConnectionState,
          connectionState: peer.connectionState,
          // Only counts leave this helper; SDP and candidate addresses stay private.
          candidateCounts,
        });
      settle(new UiMessageError(notice));
    };
    const check = () => {
      if (signal.aborted) settle(new ReplacedGeneration());
      else if (
        peer.connectionState === "failed" ||
        peer.connectionState === "closed"
      )
        settle(new UiMessageError(message("media.connectionEnded")));
      else if (Date.now() >= expires) timedOut();
      else if (ready()) settle();
    };
    peer.addEventListener("icecandidate", check);
    peer.addEventListener("icegatheringstatechange", check);
    peer.addEventListener("connectionstatechange", check);
    signal.addEventListener("abort", check);
    timer = setTimeout(check, Math.max(0, expires - Date.now()));
    // Also handles an already completed gather, connected peer, or aborted generation.
    check();
  });
}

/** vaskel. sends SDP without trickle ICE, so each exchange must include gathered candidates. */
export async function gatheredLocalDescription(
  peer: RTCPeerConnection,
  signal: AbortSignal,
  deadline?: number,
) {
  await waitForPeer(
    peer,
    signal,
    "gathering",
    () =>
      peer.iceGatheringState === "complete" ||
      (peer.iceGatheringState !== "new" &&
        Object.values(localCandidateCounts(peer)).some((count) => count > 0)),
    message("media.captureTimeout"),
    deadline,
  );
  if (!peer.localDescription?.sdp)
    throw new UiMessageError(message("media.descriptionMissing"));
  return peer.localDescription;
}

export function waitForConnected(
  peer: RTCPeerConnection,
  signal: AbortSignal,
  deadline: number,
) {
  return waitForPeer(
    peer,
    signal,
    "connecting",
    () => peer.connectionState === "connected",
    message("media.connectionTimeout"),
    deadline,
  );
}
