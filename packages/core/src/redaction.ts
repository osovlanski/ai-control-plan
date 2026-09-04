import type { RedactionRule } from "./adapter.js";
import type { NormalizedEvent } from "./events.js";

export const REDACTED = "[REDACTED]";
const redactionLiterals = new Set<string>();
export function registerSecret(value: string): void {
  if (value) redactionLiterals.add(value);
}
export function redactSecrets(text: string): string {
  let result = text;
  for (const literal of redactionLiterals) result = result.split(literal).join(REDACTED);
  return result;
}
export const DEFAULT_REDACTION_RULES: RedactionRule[] = [
  { name: "OpenAI-style API key", pattern: "\\bsk-[A-Za-z0-9_-]{12,}\\b" },
  { name: "Bearer token", pattern: "\\bBearer\\s+[A-Za-z0-9._~+\\/-]+=*" },
  { name: "JWT", pattern: "\\beyJ[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\.[A-Za-z0-9_-]+\\b" },
  { name: "environment secret assignment", pattern: "(^|\\n)([ \\t]*(?:export[ \\t]+)?[A-Za-z_][A-Za-z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL)[A-Za-z0-9_]*[ \\t]*=[ \\t]*)(?:\\\"[^\\\"\\n]*\\\"|'[^'\\n]*'|[^\\n#]*)" },
  { name: "named token", pattern: "\\b(api[_-]?key|access[_-]?token|refresh[_-]?token|secret|password)\\b(\\s*[:=]\\s*)(?!\\[REDACTED\\])[^\\s,;\\\"']+" },
];
const SECRET_KEY = /(?:^|[_-])(api[_-]?key|access[_-]?token|refresh[_-]?token|token|secret|password|passwd|credential)(?:$|[_-])/i;
export function redactText(value: string, rules: RedactionRule[] = DEFAULT_REDACTION_RULES): string {
  let result = redactSecrets(value);
  for (const rule of rules) {
    const regex = new RegExp(rule.pattern, "gim");
    result = result.replace(regex, (_match, ...args: unknown[]) => {
      if (rule.name === "environment secret assignment") return `${String(args[0] ?? "")}${String(args[1] ?? "")}${REDACTED}`;
      if (rule.name === "named token") return `${String(args[0] ?? "secret")}${String(args[1] ?? ": ")}${REDACTED}`;
      return REDACTED;
    });
  }
  return result;
}
export function redactValue<T>(value: T, rules: RedactionRule[] = DEFAULT_REDACTION_RULES): T {
  if (typeof value === "string") return redactText(value, rules) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item, rules)) as T;
  if (value && typeof value === "object") {
    const output: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value)) output[key] = SECRET_KEY.test(key) ? REDACTED : redactValue(item, rules);
    return output as T;
  }
  return value;
}
export function redactEvent(event: NormalizedEvent, rules: RedactionRule[] = DEFAULT_REDACTION_RULES): NormalizedEvent {
  return redactValue(event, rules);
}
