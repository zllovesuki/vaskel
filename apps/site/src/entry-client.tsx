import { StrictMode } from "react";
import { createRoot, hydrateRoot } from "react-dom/client";
import "./styles.css";
import { App } from "./app";

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
const app = (
  <StrictMode>
    <App />
  </StrictMode>
);
if (root.childElementCount > 0) hydrateRoot(root, app);
else createRoot(root).render(app);
// The CJK font maps are heavy; they arrive after the page is interactive.
void import("@vaskel/ui/fonts.css").catch(() => {
  // Regional system fonts remain available if the optional sheet cannot load.
});
