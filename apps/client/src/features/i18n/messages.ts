// Load the augmented module in every TypeScript program that consumes these types.
import type {} from "@lingui/core";
import type english from "./locales/en.json";

export type UiMessageKey = keyof typeof english;

declare module "@lingui/core" {
  interface Register {
    messageIds: UiMessageKey;
  }
}

/** Arguments are a domain contract; Lingui owns their interpolation and grammar. */
type ParameterizedMessages = {
  "notifications.mutedUntil": { date: string };
  "notifications.enabledAt": { date: string };
  "notifications.removeNamed": { name: string };
  "notifications.removeConfirm": { name: string };
  "notifications.deviceLimit": { count: number };
  "api.unknownWithReference": { requestId: string };
  "account.revokeSessionNamed": { name: string };
  "account.revokeConfirm": { name: string };
  "account.sessionStarted": { date: string };
  "search.count": { count: string };
  "auth.invited": { name: string };
  "auth.joinNamedServer": { name: string };
  "auth.checkEmailToJoin": { email: string; name: string };
  "auth.checkEmailToSetUp": { email: string };
  "workspace.personOptions": { name: string };
  "workspace.invitationCapacity": {
    count: number;
    countText: string;
  };
  "workspace.invitationExpiry": { date: string };
  "workspace.days": {
    count: number;
    countText: string;
  };
  "workspace.channels": { name: string };
  "workspace.startHere": { room: string };
  "blocking.retryNamed": { name: string };
  "blocking.unblockNamed": { name: string };
  "blocking.unblockConfirm": { name: string };
  "blocking.blockNamed": { name: string };
  "blocking.retryConfirm": { error: string };
  "blocking.hiddenPerson": { name: string };
  "blocking.blockedPerson": { name: string };
  "blocking.showNamedMedia": { name: string };
  "blocking.hideNamedMedia": { name: string };
  "cached.savedAt": { date: string };
  "workspace.unreadChannels": { count: string };
  "workspace.createRoomTitle": { name: string };
  "workspace.inTheCall": { count: string };
  "workspace.peopleCount": { count: string };
  "workspace.unreadCount": { count: string };
  "workspace.removeConfirm": { name: string };
  "workspace.onlineCount": { count: string };
  "workspace.isSharing": { name: string };
  "workspace.moveRoomUp": { name: string };
  "workspace.moveRoomDown": { name: string };
  "workspace.inviteCreatedBy": {
    name: string;
    date: string;
  };
  "workspace.inviteUses": { used: string; total: string };
  "workspace.inviteExpires": { date: string };
  "workspace.transferConfirm": { name: string };
  "host.iconHint": { size: string };
  "host.iconTooLarge": { size: string };
  "host.accountsCount": { count: string; total: number };
  "host.accountsMore": { count: string; total: number };
  "host.joined": { date: string };
  "host.storageAmount": { used: string; budget: string };
  "host.rebuildProgress": { count: string };
  "host.rebuildComplete": { count: string; total: number };
  "host.rebuildPartial": { rebuilt: string; failed: string };
  "host.rebuildInterrupted": { count: string };
  "workspace.mentionCount": {
    count: string;
    unread: string;
  };
  "workspace.roomMoved": {
    name: string;
    position: string;
    total: string;
  };
  "drafts.number": { number: string };
  "chat.messageActionsFor": {
    name: string;
    preview: string;
  };
  "chat.messageDetails": { name: string; time: string };
  "chat.quotedAttachments": { count: string };
  "files.previewFile": { name: string };
  "files.playFile": { name: string };
  "chat.confirmRemoveAttachment": { name: string };
  "files.imagePreview": { name: string };
  "files.removeAttachmentNamed": { name: string };
  "chat.messageTo": { label: string };
  "chat.resultsFor": { query: string };
  "files.downloadFile": { name: string };
  "files.checkUpload": { name: string };
  "files.uploadFileAgain": { name: string };
  "files.cancelUpload": { name: string };
  "files.removeFile": { name: string };
  "media.moveCallConfirm": { label: string };
  "media.participantCount": { count: string };
  "media.peopleHere": { count: string; total: number };
  "media.yourName": { name: string };
  "media.personCamera": { name: string };
  "media.managePerson": { name: string };
  "media.voiceChannelName": { name: string };
  "files.actionsFor": { name: string };
  "chat.typing": { names: string; count: number };
  "chat.roomIntroTitle": { name: string };
  "chat.conversationIntroTitle": { name: string };
  "chat.reactionTally": { name: string; count: string };
};
export type UiMessageParameters<Key extends UiMessageKey> =
  Key extends keyof ParameterizedMessages ? ParameterizedMessages[Key] : never;
export type UiMessageArgs<Key extends UiMessageKey> =
  Key extends keyof ParameterizedMessages
    ? [key: Key, params: ParameterizedMessages[Key]]
    : [key: Key];
export type UiMessageFor<Key extends UiMessageKey> =
  Key extends keyof ParameterizedMessages
    ? { readonly key: Key; readonly params: ParameterizedMessages[Key] }
    : { readonly key: Key };
export type UiMessage = {
  [Key in UiMessageKey]: UiMessageFor<Key>;
}[UiMessageKey];

/** Controllers retain presentation intent without retaining a language. */
export function message<Key extends UiMessageKey>(
  ...args: UiMessageArgs<Key>
): UiMessageFor<Key> {
  const [key, params] = args;
  return (
    params === undefined ? { key } : { key, params }
  ) as UiMessageFor<Key>;
}

/** Recognized local failures carry a safe descriptor, never arbitrary UI text. */
export class UiMessageError extends Error {
  constructor(readonly uiMessage: UiMessage) {
    super(uiMessage.key);
    this.name = "UiMessageError";
  }
}
