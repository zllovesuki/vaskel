import { rawRoutes } from "@vaskel/contracts/api";
import { Hono } from "hono";
import { serveAttachment } from "@/server/files/download";
import { verifyAttachmentGrant } from "@/server/files/grant";
import { serveThumbnail } from "@/server/files/thumbnail";
import { requireApplicationOrigin } from "@/server/http/access";
import { outcomeResponse } from "@/server/http/orpc";

/**
 * Granted byte URLs. The token alone admits the read: no session, directory
 * lookup or actor call runs here, so an issued URL stays usable until its
 * expiry. The origin check keeps cross-site embedding of a leaked URL out.
 */
export function createFileRouter() {
  const app = new Hono<{ Bindings: Env }>();
  app.on(
    ["GET", "HEAD"],
    [rawRoutes.fileDownload.path, rawRoutes.fileThumbnail.path].map((path) =>
      path.slice(4).replace(/\{(\w+)\}/g, ":$1"),
    ),
    requireApplicationOrigin,
    async (context) => {
      const grant = await verifyAttachmentGrant(
        context.env,
        context.req.param("grant") ?? "",
      );
      if (!grant) return outcomeResponse({ kind: "unauthenticated" });
      return context.req.path.endsWith("/thumbnail")
        ? serveThumbnail(context.req.raw, context.env.ATTACHMENTS, grant)
        : serveAttachment(context.req.raw, context.env.ATTACHMENTS, grant);
    },
  );
  return app;
}
