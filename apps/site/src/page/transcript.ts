import { INSTALL_PROMPT, INSTALL_URL } from "./install-prompt";

/** One turn of the session, in the shapes a coding agent's transcript takes. */
export type Turn =
  | { kind: "you"; text: string }
  | { kind: "said"; text: string }
  | {
      kind: "tool";
      tool: "Fetch" | "Bash" | "Update";
      input: string;
      output: string[];
      /** Lines the transcript folds, as the terminal does. */
      more?: number;
    };

const ORIGIN = "https://chat.example.org";

/** Abridged: the request, guided setup, build and deploy, then the handoff. */
export const transcript: Turn[] = [
  { kind: "you", text: INSTALL_PROMPT },
  {
    kind: "tool",
    tool: "Fetch",
    input: INSTALL_URL,
    output: ["Received INSTALL.md (200 OK)"],
  },
  {
    kind: "said",
    text: "What address should vaskel. use, and what email should it send from?",
  },
  { kind: "you", text: `${ORIGIN} and vaskel@example.org` },
  {
    kind: "tool",
    tool: "Bash",
    input:
      "pnpm run deploy:production --secrets-file .local/install/secrets.json",
    output: [
      "Built browser assets and application Worker.",
      "Deployed vaskel-production triggers (1.37 sec)",
      `  ${ORIGIN} (custom domain)`,
    ],
    more: 71,
  },
  {
    kind: "said",
    text: `Deployed. Open ${ORIGIN}/bootstrap; your setup key follows separately.`,
  },
];
