export class NotImplementedYetError extends Error {
  constructor(adapter: string, method: string, phase: string) {
    super(`${adapter}.${method}() lands in ${phase} (see plans/implementation-plan.md)`);
    this.name = "NotImplementedYetError";
  }
}
