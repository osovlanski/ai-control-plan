import { useEffect, useState } from "react";

export const APPLICATIONS = [
  { screen: "overview", label: "Overview", icon: "m3 10 9-7 9 7v10h-6v-6H9v6H3Z" },
  { screen: "agents", label: "Agents", icon: "M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M16 3a4 4 0 0 1 0 8M22 21v-2a4 4 0 0 0-3-3.87M13 7a4 4 0 1 1-8 0 4 4 0 0 1 8 0" },
  { screen: "memory", label: "Memory", icon: "M20 6c0 2-4 3-8 3S4 8 4 6s4-3 8-3 8 1 8 3ZM4 6v12c0 2 4 3 8 3s8-1 8-3V6M4 12c0 2 4 3 8 3s8-1 8-3" },
  { screen: "routing", label: "Routing", icon: "M7 7v10M7 12h10V7M10 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0M10 20a3 3 0 1 1-6 0 3 3 0 0 1 6 0M20 4a3 3 0 1 1-6 0 3 3 0 0 1 6 0" },
  { screen: "traces", label: "Traces", icon: "M8 6h13M8 12h13M8 18h13M3 6h.01M3 12h.01M3 18h.01" },
  { screen: "tools", label: "Tools", icon: "m14 6 4 4 4-4a7 7 0 0 1-9 9l-6 6a3 3 0 0 1-4-4l6-6a7 7 0 0 1 9-9Z" },
  { screen: "settings", label: "Settings", icon: "M4 6h16M4 12h16M4 18h16M8 3v6M16 9v6M10 15v6" },
  { screen: "about", label: "About", icon: "M12 8h.01M11 12h1v5m9-5a9 9 0 1 1-18 0 9 9 0 0 1 18 0" },
] as const;
export type Application = typeof APPLICATIONS[number]["screen"];

/** The standalone shell (`#/shell`, alias `#/mission`) as a first-class destination. */
export const MISSIONS = { screen: "shell", label: "Missions", icon: "M21 12a8 8 0 0 1-11.6 7.1L4 20.5l1.4-5.1A8 8 0 1 1 21 12ZM8.5 10.5h7M8.5 14h4.5" } as const;
const app = (screen: Application) => APPLICATIONS.find(a => a.screen === screen)!;
/** Rail grouping: daily work first, system configuration second, About last. Every route keeps its URL. */
export const NAVIGATION = {
  primary: [app("overview"), MISSIONS, app("agents")],
  system: [app("memory"), app("routing"), app("traces"), app("tools"), app("settings"), app("about")],
} as const;
export type NavScreen = Application | "shell";
export type Route = { screen: "shell"; taskId?: string; key: string } | { screen: Application | "unavailable"; key: string } | { screen: "mission"; taskId: string; key: string };

export function readRoute(hash = window.location.hash): Route {
  if (!hash.startsWith("#/")) return { screen: "overview", key: "overview" };
  const path = hash.slice(2).replace(/\/$/, "");
  if (APPLICATIONS.some(a => a.screen === path)) return { screen: path as Application, key: path };
  if (path === "shell") return { screen: "shell", key: path };
  const match = /^(missions|shell)\/([^/]+)$/.exec(path);
  if (match) {
    try {
      const taskId = decodeURIComponent(match[2]!);
      // Task IDs are opaque identifiers, never URL paths.
      if (/^[\w-]+$/.test(taskId)) return { screen: match[1] === "shell" ? "shell" : "mission", taskId, key: path };
    } catch { /* malformed route */ }
  }
  return { screen: "unavailable", key: path };
}

/** The rail destination a route belongs to; a mission's detail and its shell conversation are Missions. */
export function navigationScreen(route: Route): NavScreen | undefined {
  if (route.screen === "shell" || route.screen === "mission") return "shell";
  return route.screen === "unavailable" ? undefined : route.screen;
}

export function useShellRoute() {
  const [route, setRoute] = useState(readRoute);
  useEffect(() => {
    const change = () => {
      if (!window.location.hash || window.location.hash.startsWith("#/")) setRoute(readRoute());
    };
    window.addEventListener("hashchange", change);
    return () => window.removeEventListener("hashchange", change);
  }, []);
  return [route] as const;
}
