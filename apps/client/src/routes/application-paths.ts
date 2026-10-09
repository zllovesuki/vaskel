/** Shared by the typed Router and the built shell's navigation allowlist. */
export const applicationPaths = {
  home: "/",
  search: "/search",
  server: "/servers/$serverId",
  channel: "/servers/$serverId/channels/$channelId",
  people: "/servers/$serverId/people",
  circleSettings: "/servers/$serverId/settings",
  conversation: "/conversations/$conversationId",
  account: "/settings/account",
  notifications: "/settings/notifications",
  blocked: "/settings/blocked",
  host: "/settings/host",
} as const;

export const authenticationPaths = [
  "/sign-in",
  "/invite",
  "/bootstrap",
  "/verify-email",
  "/reset-password",
  "/forgot-password",
] as const;

export const notificationPaths = [
  "/notifications/$accountId",
  "/notifications/$accountId/$ownerKind/$ownerId/$channelId",
] as const;

export const applicationRouteTemplates = [
  ...Object.values(applicationPaths),
  ...authenticationPaths,
  ...notificationPaths,
];
