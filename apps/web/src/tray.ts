export interface TrayPanel {
  readonly id: string;
  readonly title: string;
  readonly tone: "neutral" | "attention";
  readonly body: HTMLElement;
  readonly icon?: HTMLElement;
  readonly actions?: readonly HTMLElement[];
  readonly layout?: "expanded";
  readonly leadingLabel?: string;
  /** Logical Back for flows that replace one native panel instead of growing the stack. */
  readonly onBack?: () => void;
  /** Runs only when this panel becomes current, including native Back/pop. */
  readonly onShow?: () => void;
}

interface PanelEntry {
  readonly panel: TrayPanel;
  readonly element: HTMLElement;
  readonly heading: HTMLElement | undefined;
  height: number;
}

export interface Tray {
  open(panel: TrayPanel, options?: { transientMs?: number; onClose?: () => void; parents?: readonly TrayPanel[] }): void;
  push(panel: TrayPanel): void;
  pop(): void;
  replace(panel: TrayPanel): void;
  close(immediate?: boolean, silent?: boolean): void;
  readonly id: string | undefined;
  readonly heading: HTMLElement | undefined;
  refresh(): void;
  promote(done: () => void): void;
}

/** One native top-layer surface. Descriptors and callbacks never contain client capabilities. */
export function createTray(host: HTMLDialogElement): Tray {
  const reduced = window.matchMedia("(prefers-reduced-motion: reduce)");
  const grip = document.createElement("div");
  grip.className = "tray-grip";
  grip.setAttribute("aria-hidden", "true");
  const content = document.createElement("div");
  content.className = "tray-content";
  host.append(grip, content);
  let stack: PanelEntry[] = [];
  let sequence = 0;
  let onClose: (() => void) | undefined;
  let overflow: string | undefined;
  let timeout: number | undefined;
  let remaining = 0;
  let started = 0;
  let hovered = false;
  let focused = false;
  let closing = false;
  let restoreAfterNativeClose = false;
  let expanding = false;
  let promotionCleanup: (() => void) | undefined;
  let pointer: { id: number; y: number; distance: number } | undefined;
  const current = (): PanelEntry | undefined => stack.at(-1);
  const viewportHeight = (): number => window.visualViewport?.height ?? window.innerHeight;
  const clearTimer = (): void => {
    if (timeout !== undefined) window.clearTimeout(timeout);
    timeout = undefined;
  };
  const restoreScroll = (): void => {
    if (overflow === undefined) return;
    document.body.style.overflow = overflow;
    overflow = undefined;
  };
  const resetPromotion = (): void => {
    promotionCleanup?.();
    promotionCleanup = undefined;
    expanding = false;
  };
  const finishClose = (): void => {
    resetPromotion();
    if (host.open) host.close();
    restoreScroll();
    content.replaceChildren();
    stack = [];
    host.className = "tray";
    host.style.height = "";
    host.style.transform = "";
    delete host.dataset.layout;
    closing = false;
    restoreAfterNativeClose = false;
    pointer = undefined;
  };
  const close = (immediate = false, silent = false): void => {
    if (!host.open) return;
    if (closing) {
      if (immediate) { ++sequence; finishClose(); }
      return;
    }
    closing = true;
    resetPromotion();
    clearTimer();
    const ticket = ++sequence;
    const callback = onClose;
    onClose = undefined;
    if (immediate || reduced.matches) finishClose();
    else {
      host.className = "tray tray-closing";
      const done = (): void => {
        host.removeEventListener("transitionend", ended);
        if (sequence === ticket) finishClose();
      };
      const ended = (event: TransitionEvent): void => {
        if (event.target === host && event.propertyName === "transform") done();
      };
      host.addEventListener("transitionend", ended);
      window.setTimeout(done, 350);
    }
    // Disposal is synchronous even when a cosmetic exit is still running.
    if (!silent) callback?.();
  };
  const armTimer = (): void => {
    clearTimer();
    if (remaining <= 0 || hovered || focused || !host.open || closing) return;
    started = performance.now();
    timeout = window.setTimeout(() => close(), remaining);
  };
  const pauseTimer = (): void => {
    if (timeout !== undefined) remaining = Math.max(1, remaining - (performance.now() - started));
    clearTimer();
  };
  const measure = (entry: PanelEntry, adjacent?: PanelEntry): void => {
    if (host.dataset.layout === "expanded" || host.dataset.layout === "full") {
      host.style.height = `${viewportHeight() * (host.dataset.layout === "full" ? 1 : 0.72)}px`;
      return;
    }
    entry.element.style.minHeight = "";
    entry.element.style.maxHeight = "none";
    // Layout height, not the transformed bounding box: an entering panel starts at scale(.96).
    let height = entry.element.offsetHeight;
    if (adjacent !== undefined && Math.abs(height - adjacent.height) < 24) {
      height = adjacent.height + 24;
      entry.element.style.minHeight = `${height}px`;
    }
    entry.height = height;
    entry.element.style.maxHeight = "";
    host.style.height = `${Math.min(viewportHeight() - 16, height + (grip.hidden ? 0 : grip.offsetHeight) + 2)}px`;
  };
  const build = (panel: TrayPanel): PanelEntry => {
    const element = document.createElement("section");
    element.className = "tray-panel";
    element.dataset.panel = panel.id;
    let heading: HTMLElement | undefined;
    if (host.dataset.mode !== "transient") {
      const header = document.createElement("header");
      header.className = "tray-header";
      const leading = document.createElement("button");
      leading.type = "button";
      leading.className = "tray-leading";
      const parent = current();
      leading.setAttribute("aria-label", panel.leadingLabel ?? (parent === undefined ? `Close ${panel.title}` : `Back to ${parent.panel.title}`));
      leading.textContent = parent === undefined && panel.onBack === undefined ? "⌄" : "‹";
      leading.addEventListener("click", () => panel.onBack !== undefined ? panel.onBack() : stack.length > 1 ? pop() : close());
      heading = document.createElement("h2");
      heading.id = `tray-title-${++sequence}`;
      heading.tabIndex = -1;
      heading.textContent = panel.title;
      header.append(leading);
      if (panel.icon !== undefined) header.append(panel.icon);
      header.append(heading, ...(panel.actions ?? []));
      element.append(header);
    }
    const body = document.createElement("div");
    body.className = "tray-body";
    panel.body.hidden = false;
    body.append(panel.body);
    element.append(body);
    return { panel, element, heading, height: 0 };
  };
  const display = (entry: PanelEntry, previous?: PanelEntry): void => {
    resetPromotion();
    ++sequence;
    if (entry.panel.layout === undefined) delete host.dataset.layout;
    else host.dataset.layout = entry.panel.layout;
    content.append(entry.element);
    entry.element.inert = false;
    entry.element.removeAttribute("aria-hidden");
    entry.element.className = "tray-panel";
    host.dataset.panel = entry.panel.id;
    host.dataset.tone = entry.panel.tone;
    if (entry.heading === undefined) host.removeAttribute("aria-labelledby");
    else host.setAttribute("aria-labelledby", entry.heading.id);
    measure(entry, previous);
    if (previous !== undefined && previous !== entry) {
      previous.element.inert = true;
      previous.element.setAttribute("aria-hidden", "true");
      previous.element.className = "tray-panel tray-panel-out";
      if (reduced.matches) previous.element.remove();
      else window.setTimeout(() => {
        if (current() !== previous) previous.element.remove();
      }, 200);
    }
    entry.heading?.focus({ preventScroll: true });
    entry.panel.onShow?.();
  };
  const open = (panel: TrayPanel, options: { transientMs?: number; onClose?: () => void; parents?: readonly TrayPanel[] } = {}): void => {
    if (host.open) close(true);
    if (closing) finishClose();
    stack = [];
    ++sequence;
    remaining = options.transientMs ?? 0;
    hovered = false;
    focused = false;
    onClose = options.onClose;
    host.dataset.mode = remaining > 0 ? "transient" : "modal";
    grip.hidden = remaining > 0;
    host.setAttribute("role", remaining > 0 ? "status" : "dialog");
    if (remaining > 0) {
      host.setAttribute("aria-live", "polite");
      host.setAttribute("aria-atomic", "true");
    } else {
      host.removeAttribute("aria-live");
      host.removeAttribute("aria-atomic");
      overflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    // Resumed flows retain Back destinations without displaying or focusing skipped panels.
    for (const parent of options.parents?.slice(0, 2) ?? []) stack.push(build(parent));
    const entry = build(panel);
    stack.push(entry);
    content.append(entry.element);
    if (remaining > 0) {
      // show() otherwise runs dialog autofocus, even though this is a status announcement.
      // The Hide invoker may already have left the DOM; never steal focus into the Undo timer.
      host.inert = true;
      host.show();
      host.inert = false;
    } else host.showModal();
    display(entry);
    armTimer();
  };
  const push = (panel: TrayPanel): void => {
    if (!host.open || stack.length >= 3 || closing) return;
    const previous = current();
    const entry = build(panel);
    stack.push(entry);
    display(entry, previous);
  };
  const pop = (): void => {
    if (stack.length <= 1) { close(); return; }
    const previous = stack.pop();
    display(current()!, previous);
  };
  const replace = (panel: TrayPanel): void => {
    const previous = stack.pop();
    const entry = build(panel);
    stack.push(entry);
    display(entry, previous);
  };
  host.addEventListener("cancel", event => {
    event.preventDefault();
    const back = current()?.panel.onBack;
    if (back !== undefined) {
      restoreAfterNativeClose = !event.cancelable;
      back();
    } else if (stack.length > 1) {
      // Chromium makes consecutive platform close requests non-cancelable without a new
      // activation. Preserve the popped stack and restore modality after its forced close.
      restoreAfterNativeClose = !event.cancelable;
      pop();
    }
    else close();
  });
  host.addEventListener("close", () => {
    if (restoreAfterNativeClose && !host.open && !closing) {
      restoreAfterNativeClose = false;
      host.showModal();
      display(current()!);
      return;
    }
    // Native/programmatic closure outside this module still releases lock and owned resources.
    if (host.open || closing) return;
    const callback = onClose;
    onClose = undefined;
    clearTimer();
    ++sequence;
    finishClose();
    callback?.();
  });
  host.addEventListener("click", event => {
    if (event.target !== host || stack.length !== 1) return;
    const rect = host.getBoundingClientRect();
    if (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom) close();
  });
  host.addEventListener("pointerenter", () => { hovered = true; pauseTimer(); });
  host.addEventListener("pointerleave", () => { hovered = false; armTimer(); });
  host.addEventListener("focusin", () => { focused = true; pauseTimer(); });
  host.addEventListener("focusout", event => {
    focused = event.relatedTarget !== null && host.contains(event.relatedTarget as Node);
    if (!focused) armTimer();
  });
  grip.addEventListener("pointerdown", event => {
    if (grip.hidden || pointer !== undefined || closing || expanding || event.button !== 0) return;
    pointer = { id: event.pointerId, y: event.clientY, distance: 0 };
    grip.setPointerCapture(event.pointerId);
  });
  grip.addEventListener("pointermove", event => {
    if (pointer?.id !== event.pointerId) return;
    pointer.distance = Math.max(0, event.clientY - pointer.y);
    if (pointer.distance < 4) return;
    host.className = "tray tray-dragging";
    host.style.transform = `translateY(${pointer.distance}px)`;
  });
  const release = (event: PointerEvent): void => {
    if (pointer?.id !== event.pointerId) return;
    const dismiss = event.type === "pointerup" && pointer.distance >= Math.min(96, host.getBoundingClientRect().height * 0.25);
    pointer = undefined;
    host.className = "tray";
    host.style.transform = "";
    if (dismiss) close();
  };
  grip.addEventListener("pointerup", release);
  grip.addEventListener("pointercancel", release);
  const resize = (): void => {
    const entry = current();
    if (entry !== undefined && host.open && !closing) measure(entry);
    host.style.bottom = `${Math.max(0, window.innerHeight - (window.visualViewport?.height ?? window.innerHeight) - (window.visualViewport?.offsetTop ?? 0))}px`;
  };
  window.visualViewport?.addEventListener("resize", resize);
  window.visualViewport?.addEventListener("scroll", resize);
  window.addEventListener("resize", resize);
  return {
    open, push, pop, replace, close,
    get id(): string | undefined { return current()?.panel.id; },
    get heading(): HTMLElement | undefined { return current()?.heading; },
    refresh(): void { const entry = current(); if (entry !== undefined && host.open) measure(entry); },
    promote(done: () => void): void {
      if (expanding || !host.open || closing) return;
      expanding = true;
      const ticket = ++sequence;
      host.dataset.layout = "full";
      resize();
      let fallback: number | undefined;
      const cleanup = (): void => {
        host.removeEventListener("transitionend", ended);
        if (fallback !== undefined) window.clearTimeout(fallback);
      };
      const finish = (): void => {
        cleanup();
        // An invalidated completion must release its own latch, never a newer promotion's.
        if (promotionCleanup !== cleanup) return;
        promotionCleanup = undefined;
        expanding = false;
        if (sequence !== ticket || closing || !host.open) return;
        ++sequence;
        done();
      };
      const ended = (event: TransitionEvent): void => {
        if (event.target === host && event.propertyName === "height") finish();
      };
      promotionCleanup = cleanup;
      if (reduced.matches) finish();
      else {
        host.addEventListener("transitionend", ended);
        fallback = window.setTimeout(finish, 450);
      }
    },
  };
}
