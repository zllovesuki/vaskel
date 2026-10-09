import { fileContentPath, rawRoutes } from "@vaskel/contracts/api";
import type { OwnerScope } from "@vaskel/contracts/messaging";
import type { UploadTransport } from "@/client/features/files/upload-controller";
import { api } from "@/client/api/contract";
import { apiFailure } from "@/client/api/errors";
import { message, UiMessageError } from "@/client/features/i18n/messages";
import { ReserveAttachmentSchema } from "@vaskel/contracts/attachments";

import { requestWithInit } from "@/client/api/client";

export function uploadTransport(
  owner: OwnerScope,
  channelId: string,
): UploadTransport {
  return {
    async reserve(file, signal, command) {
      const input = ReserveAttachmentSchema.safeParse({
        ...command,
        channelId,
        filename: file.name,
        byteLength: file.size,
      });
      if (!input.success)
        throw new UiMessageError(message("files.invalidFilename"));
      return (
        await api.reserveFile({ params: owner, body: input.data }, { signal })
      ).fileId;
    },
    async upload(fileId, file, signal) {
      return (
        await requestWithInit(
          fileContentPath(owner, fileId),
          rawRoutes.fileUpload.output,
          {
            method: "PUT",
            body: file,
            signal,
            headers: { "Content-Type": "application/octet-stream" },
          },
          { ...rawRoutes.fileUpload, owner },
        )
      ).attachment;
    },
    async status(fileId, signal) {
      const result = await api.fileStatus(
        { params: { ...owner, fileId } },
        { signal },
      );
      if (result.state === "ready") return result.attachment;
      if (result.state === "reserved" || result.state === "uploading")
        return null;
      throw new UiMessageError(
        result.state === "claimed"
          ? message("files.alreadySent")
          : message("files.uploadUnavailable"),
      );
    },
    async cancel(fileId, signal) {
      try {
        await api.cancelFile({ params: { ...owner, fileId } }, { signal });
      } catch (error) {
        if (apiFailure(error)?.code === "attachment_claimed")
          throw new UiMessageError(message("files.alreadySent"));
        throw error;
      }
    },
  };
}
