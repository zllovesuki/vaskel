import { readFileSync, readdirSync } from "node:fs";
import { isBuiltin } from "node:module";
import { dirname, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import js from "@eslint/js";
import babelParser from "@babel/eslint-parser";
import reactHooks from "eslint-plugin-react-hooks";
import { reactRefresh } from "eslint-plugin-react-refresh";

const root = dirname(fileURLToPath(import.meta.url));
const manifest = (directory) =>
  JSON.parse(readFileSync(resolve(directory, "package.json"), "utf8"));
const repository = { directory: root, ...manifest(root) };
const contains = (directory, file) => {
  const path = relative(directory, file);
  return path === "" || (!path.startsWith("../") && path !== "..");
};
const workspaces = ["apps", "packages"].flatMap((group) =>
  readdirSync(resolve(root, group), { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map(({ name }) => {
      const directory = resolve(root, group, name);
      return { directory, ...manifest(directory) };
    }),
);
// Shared packages publish explicit subpath exports; applications never reach
// into their private source paths.
const libraries = workspaces.filter(
  ({ directory, exports }) =>
    contains(resolve(root, "packages"), directory) && exports,
);
const ownerOf = (file) =>
  workspaces.find(({ directory }) => contains(directory, file)) ?? repository;
const packageName = (specifier) =>
  specifier
    .split("/")
    .slice(0, specifier.startsWith("@") ? 2 : 1)
    .join("/");

// Check declared names and normalized paths, not module resolution. TypeScript
// and the runtime bundlers still own whether a permitted import actually exists.
const workspaceImports = {
  meta: { type: "problem", schema: [] },
  create(context) {
    const filename = context.filename;
    const owner = ownerOf(filename);
    const source =
      owner !== repository &&
      contains(resolve(owner.directory, "src"), filename);
    const assembly =
      /^(?:tools\/|tests\/(?:build|e2e)\/|[^/]+\.config\.)/.test(
        relative(root, filename),
      ) || filename === resolve(root, "apps/client/vite.config.ts");
    const dependencies = {
      ...owner.dependencies,
      ...owner.devDependencies,
      ...owner.peerDependencies,
      ...owner.optionalDependencies,
    };
    const report = (node, message) => context.report({ node, message });

    function check(node, typeOnly = false) {
      if (!node) return;
      const specifier =
        node.type === "TemplateLiteral" && node.expressions.length === 0
          ? node.quasis[0].value.cooked
          : node.value;
      if (typeof specifier !== "string") {
        if (source)
          report(
            node,
            "Use a literal import so workspace boundaries can be checked.",
          );
        return;
      }
      const name = packageName(specifier);
      const workspace = workspaces.find((candidate) => candidate.name === name);
      const library = libraries.includes(workspace);
      if (library) {
        const subpath = `.${specifier.slice(name.length)}`;
        if (!Object.hasOwn(workspace.exports, subpath) || subpath === ".") {
          report(
            node,
            `Import an explicit ${name} subpath export; private source paths are not public contracts.`,
          );
        }
      }

      let target;
      if (specifier.startsWith("@tests/")) {
        const shared = specifier.startsWith("@tests/shared/");
        target = resolve(
          shared
            ? resolve(root, "tests/helpers")
            : resolve(owner.directory, "tests"),
          specifier.slice(shared ? "@tests/shared/".length : "@tests/".length),
        );
      } else if (specifier.startsWith("@/")) {
        const alias = /^@\/(client|server|site)\/(.+)$/.exec(specifier);
        if (!alias) {
          report(
            node,
            "Use only the owning application's @/client/, @/server/ or @/site/ prefix, or an explicit @vaskel/contracts export.",
          );
          return;
        }
        target = resolve(root, "apps", alias[1], "src", alias[2]);
      } else if (specifier.startsWith(".")) {
        target = resolve(dirname(filename), specifier);
      } else if (/^\/?(?:apps|packages|tests|tools)\//.test(specifier)) {
        target = resolve(root, specifier.replace(/^\//, ""));
      } else if (specifier.startsWith("/")) {
        target = resolve(specifier);
      } else if (workspace && !library) {
        target = resolve(workspace.directory, specifier.slice(name.length + 1));
      }

      if (target) {
        const targetOwner = ownerOf(target);
        if (libraries.includes(targetOwner) && owner !== targetOwner) {
          report(
            node,
            `Consume ${targetOwner.name} through its explicit subpath exports.`,
          );
        } else if (
          source &&
          !contains(resolve(owner.directory, "src"), target)
        ) {
          report(
            node,
            "Application and contracts source may import only their own source and public contracts; test, build and other application implementations stay outside this boundary.",
          );
        } else if (
          !source &&
          !assembly &&
          targetOwner !== owner &&
          targetOwner !== repository
        ) {
          report(
            node,
            "Cross-workspace source imports belong only in the combined build and explicitly scoped root tooling or assembled-app tests.",
          );
        }
        if (!workspace) return;
      }

      if (isBuiltin(specifier) || specifier === "cloudflare:workers") return;
      const dependency =
        specifier === "cloudflare:test"
          ? "@cloudflare/vitest-plugin"
          : specifier === "virtual:pwa-register"
            ? "vite-plugin-pwa"
            : name;
      const types = `@types/${dependency.replace(/^@/, "").replace("/", "__")}`;
      if (
        !Object.hasOwn(dependencies, dependency) &&
        !(typeOnly && Object.hasOwn(dependencies, types))
      ) {
        report(
          node,
          `${owner.name} must declare its directly imported dependency ${dependency} in its own package.json.`,
        );
      }
    }

    const declaration = (node) =>
      check(
        node.source,
        node.importKind === "type" ||
          node.exportKind === "type" ||
          (node.specifiers?.length > 0 &&
            node.specifiers.every(
              (specifier) =>
                specifier.importKind === "type" ||
                specifier.exportKind === "type",
            )),
      );
    return {
      ImportDeclaration: declaration,
      ExportNamedDeclaration: declaration,
      ExportAllDeclaration: declaration,
      ImportExpression: (node) => check(node.source),
      TSImportType: (node) => check(node.source, true),
      TSExternalModuleReference: (node) => check(node.expression),
      CallExpression(node) {
        if (node.callee.type === "Identifier" && node.callee.name === "require")
          check(node.arguments[0]);
      },
    };
  },
};

export default [
  { ...reactRefresh.configs.vite(), files: ["apps/client/src/**/*.{ts,tsx}"] },
  {
    ignores: [
      "**/node_modules/**",
      "**/dist/**",
      "**/.wrangler/**",
      "**/.worktrees/**",
      "**/.local/**",
      "**/coverage/**",
      "**/playwright-report/**",
      "**/test-results/**",
      "**/worker-configuration.d.ts",
      "apps/client/src/features/i18n/locales/*.ts",
    ],
  },
  {
    files: ["**/*.{js,mjs,ts,tsx}"],
    languageOptions: {
      parser: babelParser,
      parserOptions: {
        requireConfigFile: false,
        babelOptions: {
          babelrc: false,
          configFile: false,
          parserOpts: { plugins: ["typescript", "jsx"] },
        },
      },
    },
    plugins: { vaskel: { rules: { "workspace-imports": workspaceImports } } },
    rules: {
      ...js.configs.recommended.rules,
      // TypeScript 7 checks names and usage; Babel supplies syntax without the old TS API.
      "no-undef": "off",
      "no-unused-vars": "off",
      "vaskel/workspace-imports": "error",
    },
  },
  {
    files: [
      "apps/client/src/**/*.{ts,tsx}",
      "apps/site/src/**/*.{ts,tsx}",
      "packages/ui/src/**/*.{ts,tsx}",
    ],
    plugins: { "react-hooks": reactHooks },
    rules: reactHooks.configs.flat["recommended-latest"].rules,
  },
  {
    // Shared UI modules import from their own folder or below. A parent import
    // means a dependency sits apart from the modules that use it.
    files: ["packages/ui/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              regex: "^\\.\\./",
              message:
                "Import from this folder or below; move the module beside the modules that use it.",
            },
          ],
        },
      ],
    },
  },
];
