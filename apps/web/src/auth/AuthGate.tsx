import { useEffect, useState, type ReactNode } from "react";
import { onAuthExpired } from "../auth.js";
import { loadAuthMode, noteActivity, signOut, startSignIn, type AuthMode } from "./remote.js";

/**
 * Wraps the app. Local mode renders the app exactly as before. Remote mode (the private Web link)
 * renders the sign-in screen until a remote session exists, and again when it expires or is
 * revoked; the app is never shown without one.
 */
export function AuthGate({ children }: { children: ReactNode }) {
  const [mode, setMode] = useState<AuthMode | "loading">("loading");
  const [why, setWhy] = useState<"signin" | "expired" | "signedout">("signin");
  useEffect(() => { let live = true; void loadAuthMode().then((m) => { if (live) setMode(m); }); return () => { live = false; }; }, []);
  useEffect(() => onAuthExpired(() => setMode((m) => { if (m === "remote") { setWhy("expired"); return "signin"; } return m; })), []);
  useEffect(() => {
    if (mode !== "remote") return;
    const onInput = () => noteActivity();
    window.addEventListener("pointerdown", onInput, { passive: true });
    window.addEventListener("keydown", onInput);
    return () => { window.removeEventListener("pointerdown", onInput); window.removeEventListener("keydown", onInput); };
  }, [mode]);
  if (mode === "loading") return null;
  if (mode === "signin") return <SignIn reason={why} />;
  if (mode === "local") return <>{children}</>;
  return <>
    {children}
    <button type="button" className="remote-signout" onClick={() => { void signOut().then(() => { setWhy("signedout"); setMode("signin"); }); }}>Sign out</button>
  </>;
}

export function SignIn({ reason }: { reason: "signin" | "expired" | "signedout" }) {
  const lead = reason === "expired" ? "Your session ended. Sign in again to continue." : reason === "signedout" ? "You are signed out." : "This private link needs the owner's sign-in.";
  return <main className="remote-signin">
    <div className="remote-signin-card">
      <div className="os-mark" aria-hidden="true" />
      <h1>Agentic OS</h1>
      <p>{lead}</p>
      <button type="button" className="remote-signin-button" onClick={startSignIn}>Sign in with Google</button>
      <p className="remote-signin-note">Only the owner's account is accepted.</p>
    </div>
  </main>;
}
