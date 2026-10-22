import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.tsx";
import { FleetProvider } from "./fleet.tsx";
import { KeymapProvider } from "./keys/keymap.tsx";
import "./tokens.css";
import "./app.css";

// Makes the app installable; browsers allow service workers only in secure contexts.
if ("serviceWorker" in navigator && window.isSecureContext && import.meta.env.PROD) {
  void navigator.serviceWorker.register("/sw.js");
}

const root = document.getElementById("root");
if (!root) throw new Error("missing #root");
createRoot(root).render(
  <StrictMode>
    <FleetProvider>
      <KeymapProvider>
        <App />
      </KeymapProvider>
    </FleetProvider>
  </StrictMode>,
);
