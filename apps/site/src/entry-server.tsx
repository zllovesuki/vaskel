import { StrictMode } from "react";
import { renderToString } from "react-dom/server";
import { App } from "./app";

/** Static markup for tools/prerender.mjs; the client hydrates the same tree. */
export function render() {
  return renderToString(
    <StrictMode>
      <App />
    </StrictMode>,
  );
}
