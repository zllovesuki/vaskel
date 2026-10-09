export type SessionDescription = { type: "offer" | "answer"; sdp: string };

export type TrackResult = {
  mid?: string | undefined;
  trackName?: string | undefined;
  sessionId?: string | undefined;
  location?: "local" | "remote" | undefined;
  kind?: "audio" | "video" | undefined;
  errorCode?: string | undefined;
  errorDescription?: string | undefined;
};

export type TracksResponse = {
  tracks: TrackResult[];
  sessionDescription?: SessionDescription | undefined;
  requiresImmediateRenegotiation: boolean;
};

export type SessionStateResponse = {
  tracks: (TrackResult & {
    status?: "active" | "inactive" | "waiting" | undefined;
  })[];
};

export type TracksRequest = {
  sessionDescription?: SessionDescription;
  tracks: Array<{
    location: "local" | "remote";
    mid?: string;
    sessionId?: string;
    trackName: string;
    kind?: "audio" | "video";
  }>;
};
