import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { RouterProvider } from "@tanstack/react-router";
import { LucideProvider } from "lucide-react";
import { StrictMode } from "react";
import { iconDefaults } from "@vaskel/ui/components/control-styles";
import { createRoot } from "react-dom/client";

import { router } from "@/client/router-config";
import { registerOfflineShell } from "@/client/shell/register";
import { applyTheme } from "@/client/ui/theme";
import "./styles.css";

applyTheme();

const queryClient = new QueryClient({
  defaultOptions: {
    mutations: {
      networkMode: "always",
      retry: false,
    },
    queries: {
      refetchOnWindowFocus: false,
    },
  },
});

const container = document.getElementById("root");

if (container === null) {
  throw new Error("The application root element is missing.");
}

createRoot(container).render(
  <StrictMode>
    <LucideProvider {...iconDefaults}>
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </LucideProvider>
  </StrictMode>,
);

registerOfflineShell();

void import("@vaskel/ui/fonts.css").catch(() => {
  // Regional system fonts remain available if the optional sheet cannot load.
});
