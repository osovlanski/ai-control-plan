import type { CSSProperties, ReactNode } from "react";

export const tokens = {
  bg: "#f6f7f9",
  surface: "#ffffff",
  border: "#e2e4ea",
  text: "#12131a",
  muted: "#646b7a",
  accent: "#2f5bd7",
  ok: "#0f7b4f",
  warn: "#a2600a",
  danger: "#b3261e",
  mono: "ui-monospace, SFMono-Regular, 'SF Mono', Menlo, monospace",
};

const STATE_COLORS: Record<string, string> = {
  CREATED: tokens.muted,
  ROUTING: tokens.accent,
  RUNNING: tokens.accent,
  WAITING_INPUT: tokens.warn,
  LIMIT_PAUSED: tokens.warn,
  HANDING_OFF: tokens.warn,
  COMPLETED: tokens.ok,
  FAILED: tokens.danger,
  CANCELLED: tokens.muted,
};

export function StateBadge({ state }: { state: string }) {
  const color = STATE_COLORS[state] ?? tokens.muted;
  return (
    <span
      style={{
        display: "inline-block",
        padding: "0.15rem 0.55rem",
        borderRadius: 999,
        fontSize: "0.75rem",
        fontWeight: 600,
        letterSpacing: "0.02em",
        color,
        background: `${color}14`,
        border: `1px solid ${color}33`,
      }}
    >
      {state}
    </span>
  );
}

export function Card({ children, style }: { children: ReactNode; style?: CSSProperties }) {
  return (
    <div
      style={{
        background: tokens.surface,
        border: `1px solid ${tokens.border}`,
        borderRadius: 12,
        padding: "1.1rem 1.25rem",
        ...style,
      }}
    >
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
  const palette = {
    primary: { bg: tokens.accent, fg: "#fff", border: tokens.accent },
    secondary: { bg: "transparent", fg: tokens.text, border: tokens.border },
    danger: { bg: "transparent", fg: tokens.danger, border: `${tokens.danger}55` },
  }[variant];
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "0.45rem 0.9rem",
        borderRadius: 8,
        border: `1px solid ${palette.border}`,
        background: palette.bg,
        color: palette.fg,
        fontSize: "0.9rem",
        fontWeight: 500,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

export function QuotaBar({ usedPercent, resetsAt }: { usedPercent: number; resetsAt?: string }) {
  const color = usedPercent >= 85 ? tokens.danger : usedPercent >= 60 ? tokens.warn : tokens.ok;
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "0.5rem", fontSize: "0.8rem" }}>
      <div style={{ width: 90, height: 6, background: tokens.border, borderRadius: 999 }}>
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
    <label style={{ display: "block", marginBottom: "0.9rem" }}>
      <span
        style={{
          display: "block",
          fontSize: "0.8rem",
          fontWeight: 600,
          color: tokens.muted,
          marginBottom: "0.3rem",
        }}
      >
        {label}
      </span>
      {children}
    </label>
  );
}

export const inputStyle: CSSProperties = {
  width: "100%",
  padding: "0.5rem 0.65rem",
  borderRadius: 8,
  border: `1px solid ${tokens.border}`,
  fontSize: "0.9rem",
  fontFamily: "inherit",
  background: tokens.surface,
  color: tokens.text,
};
