declare module "*.json?lingui" {
  import type { Messages } from "@lingui/core";
  export const messages: Messages;
}
