import "@fontsource-variable/ibm-plex-sans";
import "@fontsource/ibm-plex-mono/400.css";
import "@fontsource/ibm-plex-mono/500.css";
import "./styles/tokens.css";
import "./styles/shell.css";
import "./styles/orbital.css";
import "./styles/inspector.css";
import "./styles/command-center.css";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App.js";
import { AuthGate } from "./auth/AuthGate.js";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthGate>
      <App />
    </AuthGate>
  </StrictMode>,
);

import "./styles/applications.css";
import "./styles/mission-shell.css";

import "./styles/standalone-shell.css";
import "./styles/composition.css";
import "./styles/shell-view.css";
import "./styles/calm-overview.css";
import "./styles/navigation.css";
