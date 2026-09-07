import type { CSSProperties, ReactNode } from "react";

/** Values mirror `styles/tokens.css` for the few screens that still style inline. */
export const tokens = {
  bg: "#04070b",
  surface: "#0e161f",
  border: "rgba(146, 178, 200, 0.13)",
  text: "#e8eef4",
  muted: "#a3b1be",
  accent: "#7fe3dc",
  ok: "#8fd3a8",
  warn: "#f3b565",
  danger: "#f07c7c",
  mono: "var(--font-mono)",
};

const STATE_TONES: Record<string, string> = {
  CREATED: "neutral",
  ROUTING: "active",
  RUNNING: "active",
  WAITING_INPUT: "human",
  WAITING_RESOURCE: "resource",
  LIMIT_PAUSED: "limit",
  HANDING_OFF: "handoff",
  COMPLETED: "complete",
  FAILED: "failed",
  CANCELLED: "neutral",
};

export function StateBadge({ state }: { state: string }) {
  return <span className={`badge tone-${STATE_TONES[state] ?? "neutral"}`}>{state}</span>;
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div className="card" style={style}>
      {children}
    </div>
  );
}

export function Button({
  children,
  onClick,
  variant = "primary",
  disabled,
}: {
  children: ReactNode;
  onClick?: () => void;
  variant?: "primary" | "secondary" | "danger";
  disabled?: boolean;
}) {
  const cls = { primary: "btn btn-primary", secondary: "btn", danger: "btn btn-danger" }[variant];
  return (
    <button className={cls} onClick={onClick} disabled={disabled}>
      {children}
    </button>
  );
}

export function QuotaBar({ usedPercent, resetsAt }: { usedPercent: number; resetsAt?: string }) {
  const color = usedPercent >= 85 ? tokens.danger : usedPercent >= 60 ? tokens.warn : tokens.ok;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}>
      <div style={{ width: 90, height: 5, background: tokens.border, borderRadius: 999 }}>
        <div
          style={{
            width: `${Math.min(100, usedPercent)}%`,
            height: "100%",
            background: color,
            borderRadius: 999,
          }}
        />
      </div>
      <span style={{ color: tokens.muted }}>
        {usedPercent}% used{resetsAt ? ` · resets ${new Date(resetsAt).toLocaleTimeString()}` : ""}
      </span>
    </div>
  );
}

export function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <label className="field">
      <span>{label}</span>
      {children}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "10px 12px",
  borderRadius: 10,
  border: `1px solid rgba(146, 178, 200, 0.26)`,
  fontSize: "14px",
  fontFamily: "inherit",
  background: "rgba(4, 7, 11, 0.6)",
  color: tokens.text,
};
