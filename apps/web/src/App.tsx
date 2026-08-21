import { useEffect, useState } from "react";

interface Health {
  status: string;
  workspace: string;
  migrations: number;
  now: string;
}

const styles: Record<string, React.CSSProperties> = {
  page: {
    fontFamily: "system-ui, -apple-system, sans-serif",
    maxWidth: 720,
    margin: "4rem auto",
    padding: "0 1.5rem",
    color: "#1a1a2e",
  },
  badge: {
    display: "inline-block",
    padding: "0.2rem 0.7rem",
    borderRadius: 999,
    fontSize: "0.8rem",
    fontWeight: 600,
    background: "#e8f0fe",
    color: "#1a56db",
    marginLeft: "0.75rem",
    verticalAlign: "middle",
  },
  card: {
    border: "1px solid #e2e4ea",
    borderRadius: 12,
    padding: "1.25rem 1.5rem",
    marginTop: "1.5rem",
  },
  muted: { color: "#6b7280", fontSize: "0.9rem" },
};

export function App() {
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch("/api/health")
      .then((r) => (r.ok ? r.json() : Promise.reject(new Error(`API returned ${r.status}`))))
      .then(setHealth)
      .catch((e: Error) => setError(e.message));
  }, []);

  return (
    <main style={styles.page}>
      <h1>
        Agent Control Plane
        {health && <span style={styles.badge}>{health.workspace}</span>}
      </h1>
      <p style={styles.muted}>
        Routes tasks across complete assistant environments — Phase 0 skeleton.
      </p>

      <div style={styles.card}>
        {error && <p style={{ color: "#b91c1c" }}>API unreachable: {error}</p>}
        {!error && !health && <p style={styles.muted}>Connecting to API…</p>}
        {health && (
          <>
            <p>
              API status: <strong>{health.status}</strong> · schema migrations applied:{" "}
              <strong>{health.migrations}</strong>
            </p>
            <p style={styles.muted}>
              Task board, routing recommendations, and the assistant catalog arrive in Phase 1.
            </p>
          </>
        )}
      </div>
    </main>
  );
}
