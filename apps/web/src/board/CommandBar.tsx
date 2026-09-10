import { useState } from "react";

/** Prefill goals — they route to intake exactly like a typed goal, no new
 *  behaviour. The router still previews its choice before anything runs. */
const SUGGESTIONS = [
  "Build a new agent",
  "Analyze my codebase",
  "Create a research report",
  "Run a multi-agent task",
];

/** The one obvious way to issue work, and the page's primary command surface.
 * Submits to the intake screen, where the router previews its choice before
 * anything executes. */
export function CommandBar({ onSubmit }: { onSubmit: (goal: string) => void }) {
  const [goal, setGoal] = useState("");
  return (
    <div className="command-surface">
      <form
        className="command-bar"
        aria-label="Command"
        aria-describedby="command-help"
        onSubmit={(e) => {
          e.preventDefault();
          if (goal.trim()) onSubmit(goal.trim());
        }}
      >
        <span className="cb-mark" aria-hidden="true" />
        <input
          aria-describedby="command-help"
          aria-label="What should Agentic OS do?"
          placeholder="What do you want Agentic OS to do?"
          value={goal}
          onChange={(e) => setGoal(e.target.value)}
        />
        <kbd>↵ route</kbd>
        <button className="btn btn-primary cb-run" type="submit" disabled={!goal.trim()}>
          Route mission
        </button>
      </form>
      <div className="command-suggestions" aria-label="Suggested missions">
        {SUGGESTIONS.map((s) => (
          <button key={s} type="button" className="cb-chip" onClick={() => onSubmit(s)}>
            {s}
          </button>
        ))}
      </div>
      <p id="command-help" className="command-help">
        Preview the assistant and routing reason in Intake. You choose when to run.
      </p>
    </div>
  );
}
