import { AttachmentOutcomeSchema } from "../attachments";
import { OperatorInstanceSchema } from "../instance";
import { outcome } from "./outcome";
import type { OwnerScope } from "../owner-scope";

const contentPath = "/api/resources/{kind}/{id}/files/{fileId}/content";
const grantPath = "/api/files/{grant}";
/** Native byte streams and socket upgrades share paths and request meaning with their callers. */
export const rawRoutes = {
  /** The grant token alone admits the read; the route needs no session. */
  fileDownload: {
    path: grantPath,
    authority: "public",
  },
  fileThumbnail: {
    path: `${grantPath}/thumbnail`,
    authority: "public",
  },
  fileUpload: {
    path: contentPath,
    authority: "resource",
    output: outcome(AttachmentOutcomeSchema, "attachment_ready"),
  },
  roomSocket: {
    path: "/api/resources/{kind}/{id}/socket",
    authority: "resource",
  },
  accountSocket: {
    path: "/api/account/events",
    authority: "account",
  },
  instanceIcon: {
    path: "/api/instance/icon",
    authority: "public",
  },
  uploadIcon: {
    path: "/api/operator/instance/icon",
    authority: "capability",
    output: OperatorInstanceSchema,
  },
  rebuildSearch: {
    path: "/api/operator/search-index/rebuild",
    authority: "capability",
  },
} as const;
const ownerPath = (path: string, owner: OwnerScope) =>
  path
    .replace("{kind}", owner.kind)
    .replace("{id}", encodeURIComponent(owner.id));
export const roomSocketPath = (owner: OwnerScope) =>
  ownerPath(rawRoutes.roomSocket.path, owner);
export const fileContentPath = (owner: OwnerScope, fileId: string) =>
  ownerPath(contentPath, owner).replace("{fileId}", encodeURIComponent(fileId));
export const fileGrantPath = (token: string) =>
  grantPath.replace("{grant}", encodeURIComponent(token));
export const fileThumbnailPath = (grantedUrl: string) =>
  `${grantedUrl}/thumbnail`;
