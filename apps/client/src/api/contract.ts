import { z } from "zod";
import type { ApiMeta } from "@vaskel/contracts/api";
import { instance } from "./client";
import type { ContractRouterClient } from "@orpc/contract";
import { type RequestScope } from "./client";
import { responseFailure } from "./errors";
import { EXPECTED_ACCOUNT_HEADER } from "@vaskel/contracts/identity";
import { createORPCClient } from "@orpc/client";

import { ResponseValidationPlugin } from "@orpc/contract/plugins";
import { OpenAPILink } from "@orpc/openapi-client/fetch";
import { createTanstackQueryUtils } from "@orpc/tanstack-query";
import { apiContract } from "@vaskel/contracts/api";
import { OwnerScopeSchema } from "@vaskel/contracts/messaging";
import { apiFailure, privateResponse } from "./client";

interface Exchange {
  scope: RequestScope;
  response?: Awaited<ReturnType<typeof privateResponse>>;
}
interface LinkContext {
  accountId?: string;
  exchange?: Exchange;
}

const ownerInput = z.object({ params: z.object(OwnerScopeSchema.shape) });
function operationScope(meta: ApiMeta, input: unknown): RequestScope {
  const authority = meta.authority ?? "account";
  const freshness = meta.freshness ?? "account";
  if (authority === "resource" || authority === "message") {
    return {
      authority,
      freshness,
      owner: ownerInput.parse(input).params,
    };
  }
  const owner = ownerInput.safeParse(input);
  if (owner.success) return { authority, freshness, owner: owner.data.params };
  return { authority, freshness };
}

const link = new OpenAPILink<LinkContext>(apiContract, {
  url: `${instance}/api`,
  plugins: [new ResponseValidationPlugin(apiContract)],
  interceptors: [
    async (options) => {
      const { path, input, next, context } = options;
      const operation = apiContract[path[0] as keyof typeof apiContract];
      const exchange: Exchange = {
        scope: operationScope(operation["~orpc"].meta, input),
      };
      try {
        const value = await next({
          ...options,
          context: { ...context, exchange },
        });
        // The response-validation plugin has accepted the native result before freshness.
        exchange.response?.checkCurrent();
        exchange.response?.succeeded();
        return value;
      } catch (error) {
        const received = exchange.response;
        if (!received) throw error;
        received.checkCurrent();
        const failure = responseFailure(received.response, error);
        received.failed(apiFailure(failure)!);
        throw failure;
      }
    },
  ],
  fetch: async (request, init, { context }) => {
    const exchange = context.exchange;
    if (!exchange) throw new Error("Missing API request lifetime");
    const url = new URL(request.url);
    const headers = new Headers(request.headers);
    if (context.accountId)
      headers.set(EXPECTED_ACCOUNT_HEADER, context.accountId);
    exchange.response = await privateResponse(
      `${url.pathname}${url.search}`,
      {
        ...init,
        method: request.method,
        headers,
        signal: request.signal,
      },
      exchange.scope,
      request,
    );
    return exchange.response.response;
  },
});

export const api: ContractRouterClient<typeof apiContract, LinkContext> =
  createORPCClient(link);
export const apiQuery = createTanstackQueryUtils(api);
