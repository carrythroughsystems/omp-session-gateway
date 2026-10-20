import type { FullResult, Reporter, TestCase, TestResult } from "@playwright/test/reporter";

export const VISUAL_STATES = [
  "directory-empty", "directory-all-clear", "directory-needs-you", "settings-enabled-session", "collab-view", "collab-control-ask",
] as const;
export type VisualState = typeof VISUAL_STATES[number];
export const VISUAL_PROJECTS = ["visual-phone-390x844", "visual-tablet-810x1080", "visual-desktop-1280x800"] as const;
const PHASES: Readonly<Record<string, true>> = {
  fixture: true, directory: true, alerts: true, state: true, geometry: true, guard: true, submit: true, cleanup: true,
  "negative-hidden-attribute": true, "negative-form-value": true, "negative-inline-style": true,
  "negative-text": true, "negative-textual-resource": true, "negative-surface": true,
  "source-overflow": true, "source-network": true, "source-transcript": true, "source-header": true,
  "parity-directory": true, "parity-column": true, "parity-transcript": true, "parity-header": true,
  "parity-ask": true, "parity-triage": true, "parity-settings": true, "parity-overflow": true,
  "parity-directory-x": true, "parity-directory-y": true, "parity-directory-width": true, "parity-directory-height": true,
};

/** No raw errors, attachments, browser console, child stdout/stderr, or DOM excerpts. */
export default class SafeVisualReporter implements Reporter {
  private passed = new Set<string>();
  private submitted = new Set<string>();
  private failed = false;

  onTestEnd(test: TestCase, result: TestResult): void {
    const state = VISUAL_STATES.find(value => value === test.title);
    const project = VISUAL_PROJECTS.find(value => value === test.parent.project()?.name);
    if (state === undefined || project === undefined) {
      this.failed = true;
      return;
    }
    const identity = `${state} / ${project}`;
    const phase = test.annotations.filter(value => value.type === "visual-phase" && PHASES[value.description ?? ""]).at(-1)?.description ?? "fixture";
    if (result.status === "passed" && !this.passed.has(identity)) {
      this.passed.add(identity);
      if (test.annotations.some(value => value.type === "visual-submitted" && value.description === "accepted")) this.submitted.add(identity);
      process.stdout.write(`visual: ${identity}: passed\n`);
    } else {
      this.failed = true;
      process.stdout.write(`visual: ${identity}: failed phase=${phase}\n`);
    }
  }

  onError(): void { this.failed = true; }
  onStdOut(): void {}
  onStdErr(): void {}

  async onEnd(result: FullResult): Promise<{ status: "passed" | "failed" }> {
    const upload = process.env.OMP_VISUAL_MODE === "upload";
    const success = result.status === "passed" && !this.failed && this.passed.size === 18 && this.submitted.size === (upload ? 18 : 0);
    process.stdout.write(`visual: validated=${this.passed.size} submitted=${this.submitted.size} outcome=${success ? "passed" : "failed"}\n`);
    return { status: success ? "passed" : "failed" };
  }
}
