import type { FleetSource, SessionCreationOptions, SessionCreationRequest, SessionCreationStatus, SessionCreationUnavailableReason } from "@omp-session-gateway/protocol";
import {
  SessionCreationTransport, CreationTransportError, sourceKey, readCreationPreferences, writeCreationPreferences,
  type SourceKey, type CreationPreference,
} from "./fleet";
import type { Tray, TrayPanel } from "./tray";

type Step = "host" | "project" | "working-copy" | "profile" | "review";
type ReadyBinding = Extract<SessionCreationStatus, { state: "ready" }>["session"];
interface CreationDependencies {
  readonly tray: Tray;
  sources(): readonly FleetSource[];
  scope(): SourceKey | "all";
  epoch(): number;
  authoritative(): boolean;
  discardDraft(): void;
  cancelOpening(): void;
  forbidden(source: FleetSource): void;
  refresh(source: FleetSource): Promise<unknown>;
  openReady(source: FleetSource, binding: ReadyBinding, draft: string, current: () => boolean): Promise<boolean>;
}
interface Intent {
  readonly source: FleetSource;
  readonly request: SessionCreationRequest;
  readonly createdAt: number;
  operationId?: string;
}
const WATCH_MS = 120_000;
const REPLAY_MS = 60 * 60 * 1_000;
const text = (tag: "p" | "dt" | "dd", copy: string): HTMLElement => {
  const node = document.createElement(tag);
  node.textContent = copy;
  return node;
};
const button = (copy: string, action: () => void, primary = false): HTMLButtonElement => {
  const node = document.createElement("button");
  node.type = "button";
  node.className = primary ? "creation-primary" : "tray-choice";
  node.textContent = copy;
  node.addEventListener("click", action);
  return node;
};
export function validInitialPromptDraft(value: string): boolean {
  return [...value].length <= 8_000 && new TextEncoder().encode(value).byteLength <= 32 * 1024;
}

/** Owns choices and one paused intent, never a capability or an OMP process. */
export class SessionCreationController {
  private source: FleetSource | undefined;
  private options: SessionCreationOptions | undefined;
  private projectId = "";
  private workingCopyId = "";
  private profileId = "";
  private draft = "";
  private history: Step[] = [];
  private step: Step = "host";
  private intent: Intent | undefined;
  private preferences = new Map<SourceKey, CreationPreference>();
  private loadedPreferences = false;
  private active = false;
  private serial = 0;
  private epoch = 0;
  private request: AbortController | undefined;
  private timer: number | undefined;
  private deadline: number | undefined;
  private progressState: number | undefined;

  constructor(private readonly deps: CreationDependencies) {}

  get isActive(): boolean { return this.active; }

  open(): void {
    if (document.visibilityState !== "visible") return;
    if (!this.loadedPreferences) {
      this.loadedPreferences = true;
      try { this.preferences = readCreationPreferences(localStorage, this.deps.sources(), this.deps.authoritative()); }
      catch { /* Storage access itself can be refused. */ }
    }
    this.stopRequests();
    this.active = true;
    this.epoch = this.deps.epoch();
    if (this.intent !== undefined && this.deps.sources().includes(this.intent.source)) {
      this.paused();
      return;
    }
    this.startChoices();
  }

  /** Cancellation stops watching only. Background retains unsent text; all other exits clear it. */
  cancel(reason: "background" | "close" | "selection" | "forbidden" | "pagehide" | "competing", key?: SourceKey): void {
    if (key !== undefined && sourceKey(this.intent?.source ?? this.source ?? { id: "", origin: "", label: "" }) !== key) return;
    this.stopRequests();
    if (this.active) this.deps.cancelOpening();
    this.active = false;
    if (reason !== "background") { this.draft = ""; this.deps.discardDraft(); }
    if (this.deps.tray.id?.startsWith("creation-")) this.deps.tray.close(true, true);
  }

  private stopRequests(): void {
    ++this.serial;
    this.request?.abort();
    this.request = undefined;
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    if (this.deadline !== undefined) window.clearTimeout(this.deadline);
    this.timer = undefined;
    this.deadline = undefined;
  }

  private current(ticket: number, source = this.source): boolean {
    return this.active && this.serial === ticket && this.epoch === this.deps.epoch() &&
      document.visibilityState === "visible" && source !== undefined && this.deps.sources().includes(source);
  }

  private panel(id: string, title: string, body: HTMLElement, back?: () => void): void {
    this.progressState = undefined;
    body.className = `creation-body creation-${id}`;
    const close = button("Close", () => this.deps.tray.close());
    close.className = "creation-close";
    const panel: TrayPanel = {
      id: `creation-${id}`, title, body, tone: "neutral",
      ...(back === undefined ? {} : { onBack: back, leadingLabel: "Back", actions: [close] }),
    };
    if (this.deps.tray.id?.startsWith("creation-") && this.active) this.deps.tray.replace(panel);
    else this.deps.tray.open(panel, { onClose: () => this.cancel("close") });
  }

  private startChoices(): void {
    this.intent = undefined;
    this.draft = "";
    this.deps.discardDraft();
    this.history = [];
    this.options = undefined;
    const configured = this.deps.sources();
    const scope = this.deps.scope();
    const remembered = [...this.preferences.entries()].sort((a, b) => b[1].updatedAt.localeCompare(a[1].updatedAt))
      .find(([key]) => configured.some(source => sourceKey(source) === key))?.[0];
    this.source = configured.length === 1 ? configured[0] : configured.find(source => sourceKey(source) === (scope === "all" ? remembered : scope));
    if (configured.length === 1) void this.loadOptions();
    else this.showStep("host");
  }

  private showStep(step: Step, advance = false): void {
    if (advance) this.history.push(this.step);
    this.step = step;
    const body = document.createElement("div");
    const back = this.history.length === 0 ? undefined : (): void => this.showStep(this.history.pop()!);
    if (step === "host") {
      body.append(text("p", "Choose the execution host. OMP will start in Tern there."));
      for (const source of this.deps.sources()) {
        const choice = button(source.label, () => {
          if (this.source !== source) { this.draft = ""; this.deps.discardDraft(); }
          this.source = source;
          void this.loadOptions(true);
        });
        choice.setAttribute("aria-pressed", String(this.source === source));
        body.append(choice);
      }
      this.panel(step, "Host", body, back);
      return;
    }
    const options = this.options;
    if (options === undefined || !options.available) return;
    if (step === "project") {
      body.append(text("p", `Start on ${this.source!.label} from an approved project.`));
      for (const project of options.projects) {
        const choice = button(project.label, () => {
          this.projectId = project.id;
          if (!project.workingCopies.some(copy => copy.id === this.workingCopyId)) this.workingCopyId = project.workingCopies[0]!.id;
          this.showStep(project.workingCopies.length === 1 ? "profile" : "working-copy", true);
        });
        choice.setAttribute("aria-pressed", String(project.id === this.projectId));
        body.append(choice);
      }
      this.panel(step, "Project", body, back);
    } else if (step === "working-copy") {
      body.append(text("p", "Choose an approved working copy. No directory path is sent by this browser."));
      for (const copy of options.projects.find(project => project.id === this.projectId)!.workingCopies) {
        const choice = button(copy.label, () => { this.workingCopyId = copy.id; this.showStep("profile", true); });
        choice.setAttribute("aria-pressed", String(copy.id === this.workingCopyId));
        body.append(choice);
      }
      this.panel(step, "Working copy", body, back);
    } else if (step === "profile") {
      body.append(text("p", "Choose an approved OMP startup profile. This session will open in Control."));
      for (const profile of options.profiles) {
        const choice = button(profile.label, () => { this.profileId = profile.id; this.showStep("review", true); });
        choice.setAttribute("aria-pressed", String(profile.id === this.profileId));
        body.append(choice);
      }
      this.panel(step, "Profile", body, back);
    } else {
      const summary = document.createElement("dl");
      summary.className = "creation-summary";
      const project = options.projects.find(project => project.id === this.projectId)!;
      for (const [name, value] of [
        ["Host", this.source!.label], ["Project", project.label],
        ["Working copy", project.workingCopies.find(copy => copy.id === this.workingCopyId)!.label],
        ["Profile", options.profiles.find(profile => profile.id === this.profileId)!.label],
      ]) summary.append(text("dt", name!), text("dd", value!));
      const label = document.createElement("label");
      label.className = "creation-draft";
      label.append("First task (optional)");
      const draft = document.createElement("textarea");
      draft.value = this.draft;
      draft.setAttribute("aria-describedby", "creation-draft-note");
      const note = text("p", "Up to 8,000 characters. Kept only in this page; added to the Control composer, never sent automatically.");
      note.id = "creation-draft-note";
      const create = button("Create and open Control", () => void this.create(), true);
      const update = (): void => {
        const valid = validInitialPromptDraft(draft.value);
        create.disabled = !valid;
        draft.setAttribute("aria-invalid", String(!valid));
        note.textContent = valid
          ? "Up to 8,000 characters. Kept only in this page; added to the Control composer, never sent automatically."
          : "First task is too long. Keep it within 8,000 characters and 32 KiB before creating.";
        // Invalid input stays only in its textarea, never in the tracking intent or shell holder.
        this.draft = valid ? draft.value : "";
      };
      draft.addEventListener("input", update);
      label.append(draft);
      body.append(summary, label, note, create);
      this.panel(step, "Create session", body, back);
    }
  }

  private transport(source: FleetSource): SessionCreationTransport {
    return new SessionCreationTransport(source, target => {
      this.cancel("forbidden", sourceKey(target));
      this.deps.forbidden(target);
    });
  }

  private async loadOptions(fromHost = false, revisionMismatch = false): Promise<void> {
    const source = this.source;
    if (source === undefined) return;
    this.stopRequests();
    const ticket = this.serial;
    const controller = new AbortController();
    this.request = controller;
    const body = document.createElement("div");
    body.append(text("p", revisionMismatch ? "The host configuration changed. Refreshing choices; review them and choose Create again." : "Loading approved choices…"));
    this.panel("progress", "New session", body);
    try {
      const options = await this.transport(source).options(controller.signal);
      if (!this.current(ticket, source)) return;
      this.options = options;
      if (options === undefined || !options.available) {
        this.unavailable(options?.available === false ? options.reason : undefined);
        return;
      }
      const remembered = this.preferences.get(sourceKey(source));
      if (!revisionMismatch) {
        this.projectId = remembered?.projectId ?? "";
        this.workingCopyId = remembered?.workingCopyId ?? "";
        this.profileId = remembered?.profileId ?? "";
      }
      const project = options.projects.find(project => project.id === this.projectId);
      if (project === undefined) { this.projectId = ""; this.workingCopyId = ""; }
      else if (!project.workingCopies.some(copy => copy.id === this.workingCopyId)) this.workingCopyId = "";
      if (!options.profiles.some(profile => profile.id === this.profileId)) this.profileId = "";
      this.history = fromHost || this.deps.sources().length > 1 ? ["host"] : [];
      this.showStep("project");
      if (revisionMismatch) {
        const message = text("p", "Choices refreshed. Review them and choose Create again.");
        this.deps.tray.heading?.parentElement?.after(message);
        this.deps.tray.refresh();
      }
    } catch {
      if (this.current(ticket, source)) this.unavailable();
    }
  }

  private unavailable(reason?: SessionCreationUnavailableReason): void {
    const body = document.createElement("div");
    const copy = reason === "not_configured" ? "Session creation is not configured on this host. Existing sessions are still available."
      : reason === "ledger_unavailable" ? "Creation tracking is unavailable on this host. Ask the operator to check its private ledger."
        : reason === "configuration_unavailable" ? "The approved startup configuration is unavailable on this host."
          : reason === "tern_unavailable" ? "Tern is unavailable on this host. Open Tern there before trying again."
            : "Session creation is unavailable on this host. It may need a newer gateway or its connection restored.";
    const create = button("Create and open Control", () => {}, true);
    create.disabled = true;
    body.append(text("p", copy), create, button("Retry options", () => void this.loadOptions()));
    this.panel("terminal", "Creation unavailable", body, this.deps.sources().length > 1 ? () => this.showStep("host") : undefined);
  }

  private async create(): Promise<void> {
    if (!this.active || this.deps.tray.id !== "creation-review" || this.intent !== undefined ||
      this.options?.available !== true || this.source === undefined || !validInitialPromptDraft(this.draft)) return;
    this.intent = {
      source: this.source, createdAt: Date.now(),
      request: { clientOperationId: crypto.randomUUID(), revision: this.options.revision,
        projectId: this.projectId, workingCopyId: this.workingCopyId, profileId: this.profileId },
    };
    await this.watch(true);
  }

  private remember(intent: Intent): void {
    this.preferences.set(sourceKey(intent.source), {
      sourceId: intent.source.id, sourceOrigin: intent.source.origin,
      projectId: intent.request.projectId, workingCopyId: intent.request.workingCopyId,
      profileId: intent.request.profileId, updatedAt: new Date().toISOString(),
    });
    try { writeCreationPreferences(localStorage, this.preferences.values()); } catch { /* Optional storage. */ }
  }

  private progress(state: string): void {
    const active = state === "ready" ? 2 : state === "awaiting_omp" ? 1 : 0;
    if (this.deps.tray.id === "creation-progress" && this.progressState === active) return;
    const body = document.createElement("div");
    const status = document.createElement("div");
    status.setAttribute("role", "status");
    const steps = document.createElement("ol");
    steps.className = "creation-steps";
    steps.setAttribute("aria-label", "Session creation progress");
    for (const [index, label] of ["Starting in Tern", "Waiting for OMP", "Opening Control"].entries()) {
      const step = document.createElement("li");
      step.className = "creation-step";
      step.dataset.state = index < active ? "done" : index === active ? "active" : "future";
      if (index === active) step.setAttribute("aria-current", "step");
      if (index < active) {
        const check = document.createElementNS("http://www.w3.org/2000/svg", "svg");
        check.setAttribute("class", "triage-check creation-step-check");
        check.setAttribute("viewBox", "0 0 20 20");
        check.setAttribute("aria-hidden", "true");
        const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
        path.setAttribute("d", "M4 10l4 4 8-8");
        path.setAttribute("pathLength", "1");
        check.append(path);
        step.append(check);
        step.setAttribute("aria-label", `${label}, completed`);
      } else {
        const dot = document.createElement("span");
        dot.className = "creation-step-dot";
        dot.setAttribute("aria-hidden", "true");
        step.append(dot);
      }
      step.append(label);
      steps.append(step);
    }
    status.append(steps);
    body.append(status, text("p", "Close stops watching here. It does not stop the command on the host."));
    this.panel("progress", "Starting session", body);
    this.progressState = active;
  }

  private paused(copy = "Stopped watching. The command may still be starting on the host."): void {
    const body = document.createElement("div");
    body.append(text("p", `Creation on ${this.intent?.source.label ?? this.source!.label}. ${copy}`), button("Check creation", () => void this.watch(false), true),
      button("Start another session", () => this.startChoices()));
    this.panel("terminal", "Stopped watching", body);
  }

  private async watch(first: boolean): Promise<void> {
    const intent = this.intent;
    if (intent === undefined || !this.deps.sources().includes(intent.source)) return;
    this.stopRequests();
    this.source = intent.source;
    this.active = true;
    this.epoch = this.deps.epoch();
    const ticket = this.serial;
    const single = Date.now() - intent.createdAt >= WATCH_MS;
    if (!single) this.deadline = window.setTimeout(() => {
      if (!this.current(ticket)) return;
      this.stopRequests();
      this.paused();
    }, Math.max(0, WATCH_MS - (Date.now() - intent.createdAt)));
    this.progress("accepted");
    const poll = async (): Promise<void> => {
      if (!this.current(ticket)) return;
      const controller = new AbortController();
      this.request = controller;
      try {
        const transport = this.transport(intent.source);
        if (intent.operationId === undefined) {
          const age = Date.now() - intent.createdAt;
          if (!first && (age < 0 || age >= REPLAY_MS)) {
            // Do not replay beyond the browser's conservative bound, even if the daemon forgot it.
            await this.deps.refresh(intent.source).catch(() => undefined);
            if (this.current(ticket)) {
              this.stopRequests();
              this.paused("The acknowledgement was lost and the session may already exist. This request is too old to replay safely. Check Tern and the directory before creating another.");
            }
            return;
          }
          // Explicit Check may replay only a recent lost acknowledgement; payload identity is frozen.
          const receipt = await transport.create(intent.request, controller.signal);
          if (!this.current(ticket)) return;
          intent.operationId = receipt.operationId;
          this.remember(intent);
        }
        const status = await transport.status(intent.operationId, controller.signal);
        if (!this.current(ticket)) return;
        if (status.operationId !== intent.operationId) throw new CreationTransportError("unavailable");
        if (["accepted", "launching", "awaiting_omp"].includes(status.state)) {
          this.progress(status.state);
          if (single) { this.stopRequests(); this.paused(); }
          else this.timer = window.setTimeout(() => { this.timer = undefined; void poll(); }, 1_000);
          return;
        }
        if (this.deadline !== undefined) window.clearTimeout(this.deadline);
        this.deadline = undefined;
        if (status.state === "ready" && status.session !== undefined) {
          this.progress("ready");
          const opened = await this.deps.openReady(intent.source, status.session, this.draft,
            () => this.current(ticket));
          if (!this.current(ticket)) return;
          if (opened) { this.intent = undefined; this.draft = ""; this.active = false; this.stopRequests(); }
          else this.paused("OMP is ready, but its exact Control session could not be opened here. Check creation to try opening that same session again.");
        } else {
          this.stopRequests();
          this.draft = "";
          this.deps.discardDraft();
          this.terminal(status.state);
        }
      } catch (error) {
        if (!this.current(ticket)) return;
        this.stopRequests();
        if (error instanceof CreationTransportError && error.code === "revision_mismatch") {
          this.intent = undefined;
          await this.loadOptions(false, true);
        } else if (error instanceof CreationTransportError && error.code !== "unavailable" && first && intent.operationId === undefined) {
          this.intent = undefined;
          this.admissionFailure(error.code);
        } else this.paused(error instanceof CreationTransportError && error.code === "not_found"
          ? "This creation is no longer available to this identity. Check Tern and the directory before creating another."
          : "The host response was lost. Check creation looks up an acknowledged operation or replays the same request only during its first hour. After that, a lost acknowledgement can only be checked in the directory.");
      }
    };
    await poll();
  }

  private admissionFailure(code: string): void {
    const body = document.createElement("div");
    const copy = code === "creation_busy" ? "Another session is starting on this host. No new command was requested."
      : code === "rate_limited" ? "Too many creation requests. Wait before choosing Create again."
        : code === "creation_capacity" ? "Creation tracking is full on this host. No new command was requested."
          : code === "operation_conflict" ? "This operation could not be matched safely. Check Tern and the directory before creating another."
            : "The host could not accept this creation. Check Tern and the host configuration before trying again.";
    body.append(text("p", copy), button("Review choices", () => void this.loadOptions(false, true)));
    this.panel("terminal", "Creation not accepted", body);
  }

  private terminal(state: string): void {
    const body = document.createElement("div");
    const copy = state === "started_unavailable" ? "Tern started the command, but OMP could not be opened here."
      : state === "outcome_unknown" ? "It may have started. Check Tern and the directory before creating another."
        : "The operation did not start a command. A new attempt needs another explicit Create action.";
    body.append(text("p", copy), button("Refresh directory", () => { void this.deps.refresh(this.source!); this.cancel("close"); }),
      button("Start another session", () => this.startChoices()));
    this.panel("terminal", state === "failed" ? "Session did not start" : state === "outcome_unknown" ? "Outcome unknown" : "Started in Tern", body);
  }
}
