import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  logLevel: "error",
  server: { middlewareMode: true },
});
try {
  const { generateOpenAPI } = await server.ssrLoadModule(
    "/apps/server/src/http/openapi.ts",
  );
  process.stdout.write(`${JSON.stringify(await generateOpenAPI(), null, 2)}\n`);
} finally {
  await server.close();
}
