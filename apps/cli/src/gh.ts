/**
 * The `gh` boundary. Every GitHub call in the driver goes through here, as an ARGV ARRAY — never a shell
 * string — so issue text, branch names and label values can't be reinterpreted by a shell. The exec
 * function is injected, which is what lets the board/queue logic be tested without touching GitHub.
 */
import { run } from "@hamsterwheel/runners";

export type ExecResult = { stdout: string; stderr: string; exitCode: number };
export type GhExec = (args: string[]) => Promise<ExecResult>;

export const systemGhExec: GhExec = async (args) => run("gh", args);

export class Gh {
  constructor(private readonly exec: GhExec = systemGhExec) {}

  /** stdout, or throw with stderr attached — the loop turns the throw into a Blocked reason. */
  async text(args: string[]): Promise<string> {
    const r = await this.exec(args);
    if (r.exitCode !== 0)
      throw new Error(
        `gh ${args.slice(0, 3).join(" ")} failed (${r.exitCode}): ${r.stderr.trim().slice(0, 300)}`,
      );
    return r.stdout;
  }

  async json<T>(args: string[]): Promise<T> {
    return JSON.parse(await this.text(args)) as T;
  }

  /**
   * stdout or null on ANY failure. Used only where a failed lookup must stay DISTINGUISHABLE from a
   * negative answer (prune's safety checks) — never to paper over a mutation failing.
   */
  async tryText(args: string[]): Promise<string | null> {
    const r = await this.exec(args).catch(() => null);
    return r && r.exitCode === 0 ? r.stdout : null;
  }

  async tryJson<T>(args: string[]): Promise<T | null> {
    const raw = await this.tryText(args);
    if (raw === null) return null;
    try {
      return JSON.parse(raw) as T;
    } catch {
      return null;
    }
  }
}
