import { App } from "@/App";
import { ToastProvider } from "@/components/ui";
import { queryClient } from "@/lib/queryClient";
import { loadViewPrefs } from "@/stores/viewPrefs";
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter } from "react-router-dom";
import "@/index.css";
// Applies the theme to <html> before the first render.
import "@/theme/theme";

// The stored theme and landing choice load first, ahead of every other request.
loadViewPrefs();

const container = document.getElementById("root");
if (!container) {
  throw new Error("Root element #root not found");
}

createRoot(container).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <App />
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);
