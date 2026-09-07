import { useState } from "react";

/** The one obvious way to issue work. Submits to the intake screen, where
 * the router previews its choice before anything executes. */
export function CommandBar({ onSubmit }: { onSubmit: (goal: string) => void }) {
  const [goal, setGoal] = useState("");
  return (
    <div>
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
        placeholder="What should Agentic OS do? Describe the mission…"
        value={goal}
        onChange={(e) => setGoal(e.target.value)}
      />
      <kbd>↵ route</kbd>
      <button className="btn btn-primary" type="submit" disabled={!goal.trim()}>
        Route mission
      </button>
    </form>
    <p id="command-help" className="command-help">Preview the assistant and routing reason in Intake. You choose when to run.</p>
    </div>
  );
}
