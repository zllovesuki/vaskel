import { OpenAPIGenerator } from "@orpc/openapi";
import { ZodToJsonSchemaConverter } from "@orpc/zod/zod4";
import { apiContract } from "@vaskel/contracts/api";

/** Export the same executable contracts consumed by the Worker and browser. */
export function generateOpenAPI() {
  const generator = new OpenAPIGenerator({
    schemaConverters: [new ZodToJsonSchemaConverter()],
  });
  return generator.generate(apiContract, {
    info: {
      title: "vaskel. HTTP API",
      version: "0.1.1",
      description:
        "Session cookies authenticate requests. Unsafe requests require this instance's Origin. X-Vaskel-Expected-Account is a refusal-only account precondition, not a credential. WebSocket upgrades and native byte/stream transports are described in the synchronization and attachment guides.",
    },
    servers: [{ url: "/api" }],
    components: {
      securitySchemes: {
        sessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "vaskel.session_token",
        },
        secureSessionCookie: {
          type: "apiKey",
          in: "cookie",
          name: "__Secure-vaskel.session_token",
        },
      },
    },
  });
}
