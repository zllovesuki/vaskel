import { rawRoutes } from "@vaskel/contracts/api";
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { RebuildSearchIndexesRequestSchema } from "@vaskel/contracts/search";
import {
  applicationRead,
  applicationPrimary,
  contract,
  freshPrincipal,
  operator,
} from "@/server/http/procedures";
import { expectedOutcome, failOutcome } from "@/server/http/orpc";
import { applicationJson } from "@/server/http/validation";
import type { ApplicationEnvironment } from "@/server/http/context";
import { getPrincipal } from "@/server/auth/principal";
import { setServerCreationGrant } from "@/server/directory/grants";
import { instanceView, updateInstance } from "@/server/instance/settings";
import { publishInstancePolicyHints } from "@/server/instance/policy-notices";
import {
  downloadInstanceIcon,
  uploadInstanceIcon,
} from "@/server/instance/icons";
import {
  operatorAccounts,
  operatorUsage,
} from "@/server/instance/administration";
import { rebuildSearchIndexes } from "@/server/instance/search-index";
import { logEvent } from "@/server/telemetry";
const adminRead = applicationRead.use(operator);
const adminPrimary = applicationPrimary.use(operator);
export const instanceProcedures = {
  health: contract.health.handler(({ context }) => ({
    status: "ok" as const,
    tag: context.env.CF_VERSION_METADATA.tag || null,
  })),
  instance: contract.instance.handler(async ({ context }) => {
    const view = await instanceView(context.env);
    return { name: view.name, hasIcon: view.hasIcon };
  }),
  operatorInstance: adminRead.operatorInstance.handler(({ context }) =>
    instanceView(context.env),
  ),
  updateInstance: adminPrimary.updateInstance.handler(
    async ({ context, input }) => {
      const result = expectedOutcome(
        await updateInstance(context.env, context.principal, input.body),
        "instance",
      );
      context.executionCtx.waitUntil(
        publishInstancePolicyHints(context.env).catch((error) =>
          logEvent(
            "warn",
            "instance_policy_hints_failed",
            { requestId: context.requestId },
            error,
          ),
        ),
      );
      return result;
    },
  ),
  serverCreationGrant: adminPrimary.serverCreationGrant.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await setServerCreationGrant(
          context.principal,
          input.body.userId,
          input.body.allowed,
          context.directorySession,
        ),
        "granted",
      ),
  ),
  operatorAccounts: adminRead.operatorAccounts.handler(
    async ({ context, input }) =>
      expectedOutcome(
        await operatorAccounts(
          context.env,
          await freshPrincipal(context),
          input.query.after,
        ),
        "accounts",
      ),
  ),
  operatorUsage: adminRead.operatorUsage.handler(async ({ context, input }) =>
    expectedOutcome(
      await operatorUsage(
        context.env,
        await freshPrincipal(context),
        input.query.after,
      ),
      "usage",
    ),
  ),
};
export function createPublicInstanceRouter() {
  const app = new Hono<{ Bindings: Env }>();
  app.get(rawRoutes.instanceIcon.path.slice(4), (context) =>
    downloadInstanceIcon(context.env),
  );
  return app;
}
export function createOperatorInstanceRouter() {
  const app = new Hono<ApplicationEnvironment>();
  app.use("/operator/*", async (context, next) => {
    if (!context.get("principal").isOperator)
      return failOutcome({ kind: "forbidden" });
    await next();
  });
  app.post(
    rawRoutes.rebuildSearch.path.slice(4),
    applicationJson(RebuildSearchIndexesRequestSchema),
    (context) => {
      const original = context.get("principal");
      const response = streamSSE(context, async (stream) => {
        // Hono's stream errors bypass app.onError and may expose error.message.
        // Handle every application failure here, before it reaches that fallback.
        try {
          for await (const event of rebuildSearchIndexes(
            context.env,
            original,
            () => getPrincipal(context.req.raw, context.env),
            () => stream.aborted,
          )) {
            if (stream.aborted) return;
            await stream.writeSSE({
              event: "rebuild",
              data: JSON.stringify(event),
            });
          }
        } catch (error) {
          logEvent(
            "error",
            "search_index_rebuild_failed",
            {
              requestId: context.get("requestId"),
              route: context.req.routePath,
            },
            error,
          );
          if (!stream.aborted)
            await stream.writeSSE({
              event: "rebuild",
              data: JSON.stringify({ type: "error", kind: "unavailable" }),
            });
        }
      });
      // streamSSE sets no-cache; operator responses retain their no-store policy.
      response.headers.set("Cache-Control", "private, no-store");
      return response;
    },
  );
  app.post(rawRoutes.uploadIcon.path.slice(4), async (context) => {
    const outcome = expectedOutcome(
      await uploadInstanceIcon(
        context.env,
        context.get("principal"),
        context.req.raw,
      ),
      "instance",
    );
    return context.json(outcome);
  });
  return app;
}
