import { rawRoutes } from "@vaskel/contracts/api";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { ORPCError } from "@orpc/server";
import { createDirectorySession } from "@/server/directory/database";
import {
  allowApplicationRequest,
  requireApplicationOrigin,
  requireKnownOwner,
  requirePrincipal,
} from "@/server/http/access";
import type { ApplicationEnvironment } from "@/server/http/context";
import { createResourceRouter } from "./resources";
import { createAttachmentRouter } from "./attachments";
import { createAccountEventsRouter } from "./account-events";
import { createOperatorInstanceRouter } from "./instance";

/** Raw byte streams and socket upgrades retain their native transport. */
export function createApplicationRouter() {
  const app = new Hono<ApplicationEnvironment>();
  const paths = [
    rawRoutes.roomSocket,
    rawRoutes.fileUpload,
    rawRoutes.accountSocket,
    rawRoutes.rebuildSearch,
    rawRoutes.uploadIcon,
  ].map((route) => route.path.slice(4).replace(/\{(\w+)\}/g, ":$1"));
  for (const route of paths) {
    app.use(
      route,
      requireApplicationOrigin,
      requirePrincipal,
      async (context, next) => {
        if (
          !(await allowApplicationRequest(
            context.env,
            `application:${context.get("principal").userId}`,
          ))
        )
          throw new ORPCError("CAPACITY", {
            status: 429,
            data: { kind: "capacity" },
          });
        const { session } = createDirectorySession(
          context.env,
          context.req.header("X-Vaskel-D1-Bookmark"),
          context.req.method !== "GET",
        );
        context.set("directorySession", session);
        context.header("Cache-Control", "private, no-store");
        await next();
        const bookmark = session.getBookmark();
        if (bookmark) context.header("X-Vaskel-D1-Bookmark", bookmark);
      },
    );
  }
  app.use(
    rawRoutes.roomSocket.path.slice(4).replace(/\{(\w+)\}/g, ":$1"),
    requireKnownOwner(),
  );
  app.use(
    rawRoutes.fileUpload.path.slice(4).replace(/\{(\w+)\}/g, ":$1"),
    requireKnownOwner(),
  );
  app.use(
    "/operator/*",
    bodyLimit({
      maxSize: 256 * 1024,
      onError: () => {
        throw new ORPCError("PAYLOAD_TOO_LARGE");
      },
    }),
  );
  app.route("/", createOperatorInstanceRouter());
  app.route("/", createResourceRouter());
  app.route("/", createAttachmentRouter());
  app.route("/", createAccountEventsRouter());
  return app;
}
