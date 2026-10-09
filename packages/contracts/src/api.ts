import { messageApiContract } from "./api/messages";
import { administrationApiContract } from "./api/administration";
import { directoryApiContract } from "./api/directory";
import { accountApiContract } from "./api/account";
import { attachmentApiContract } from "./api/attachments";
import { identityApiContract } from "./api/identity";
import { mediaApiContract } from "./api/media";
import { instanceApiContract } from "./api/instance";
import { invitationApiContract } from "./api/invitations";
export {
  messageApiContract,
  administrationApiContract,
  directoryApiContract,
  accountApiContract,
  attachmentApiContract,
  identityApiContract,
  mediaApiContract,
  instanceApiContract,
  invitationApiContract,
};
export { apiErrors, type ApiErrorCode } from "./api/errors";
export type { ApiMeta, ApiAuthority } from "./api/base";
export const apiContract = {
  ...messageApiContract,
  ...administrationApiContract,
  ...directoryApiContract,
  ...accountApiContract,
  ...attachmentApiContract,
  ...identityApiContract,
  ...mediaApiContract,
  ...instanceApiContract,
  ...invitationApiContract,
};
export {
  rawRoutes,
  fileContentPath,
  fileGrantPath,
  fileThumbnailPath,
  roomSocketPath,
} from "./api/transports";
