/**
 * Minimal DOM plus a React client-render harness.
 *
 * `bun test` provides no DOM and this package takes no test-only dependencies,
 * so these classes implement exactly the surface `react-dom/client` touches:
 * node insertion and removal, attributes, `innerHTML` for rendered markdown,
 * container-level event listeners, and the scroll metrics the transcript's
 * bottom lock reads. Every element is {@link ROW_PX} tall, so `scrollHeight` is
 * an exact function of the mounted children and scroll assertions are exact.
 */
import type { ReactNode } from "react";
import { act } from "react";
import type { Root, createRoot as createRootFn } from "react-dom/client";

/** Height every mounted child contributes to its parent's `scrollHeight`. */
export const ROW_PX = 40;
/** Fixed `clientHeight` of every harness element. */
export const VIEWPORT_PX = 400;

type Listener = (event: unknown) => void;

export class MiniNode {
  nodeType = 1;
  parentNode: MiniNode | null = null;
  readonly childNodes: MiniNode[] = [];
  nodeValue: string | null = null;
  ownerDocument: MiniDocument;

  constructor(ownerDocument: MiniDocument) {
    this.ownerDocument = ownerDocument;
  }

  get firstChild(): MiniNode | null {
    return this.childNodes[0] ?? null;
  }

  get lastChild(): MiniNode | null {
    return this.childNodes[this.childNodes.length - 1] ?? null;
  }

  get nextSibling(): MiniNode | null {
    const parent = this.parentNode;
    if (parent === null) return null;
    return parent.childNodes[parent.childNodes.indexOf(this) + 1] ?? null;
  }

  get previousSibling(): MiniNode | null {
    const parent = this.parentNode;
    if (parent === null) return null;
    const index = parent.childNodes.indexOf(this);
    return index <= 0 ? null : (parent.childNodes[index - 1] ?? null);
  }

  /** Total height of the mounted children — what the transcript scrolls over. */
  get scrollHeight(): number {
    return this.childNodes.length * ROW_PX;
  }

  get clientHeight(): number {
    return VIEWPORT_PX;
  }

  appendChild<T extends MiniNode>(child: T): T {
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.push(child);
    return child;
  }

  insertBefore<T extends MiniNode>(child: T, before: MiniNode | null): T {
    if (before === null) return this.appendChild(child);
    child.parentNode?.removeChild(child);
    child.parentNode = this;
    this.childNodes.splice(this.childNodes.indexOf(before), 0, child);
    return child;
  }

  removeChild<T extends MiniNode>(child: T): T {
    const index = this.childNodes.indexOf(child);
    if (index >= 0) this.childNodes.splice(index, 1);
    child.parentNode = null;
    return child;
  }

  contains(other: MiniNode | null): boolean {
    for (let node = other; node !== null; node = node.parentNode) {
      if (node === this) return true;
    }
    return false;
  }

  /** Document-level listeners (`selectionchange`) are never dispatched here. */
  addEventListener(_type: string, _listener: Listener): void {}

  removeEventListener(_type: string, _listener: Listener): void {}
}

export class MiniText extends MiniNode {
  override nodeType = 3;
  readonly nodeName = "#text";

  constructor(ownerDocument: MiniDocument, text: string) {
    super(ownerDocument);
    this.nodeValue = text;
  }
}

export class MiniComment extends MiniNode {
  override nodeType = 8;
  readonly nodeName = "#comment";

  constructor(ownerDocument: MiniDocument, text: string) {
    super(ownerDocument);
    this.nodeValue = text;
  }
}

export class MiniElement extends MiniNode {
  readonly tagName: string;
  readonly nodeName: string;
  readonly attributes: Record<string, string> = {};
  readonly dataset: Record<string, string> = {};
  readonly style: Record<string, string> = {};
  readonly listeners = new Map<string, Set<Listener>>();
  namespaceURI = "http://www.w3.org/1999/xhtml";
  /** Markdown arrives through `dangerouslySetInnerHTML`. */
  markup = "";
  scrollTop = 0;
  type = "";
  value = "";
  oninput = null;
  selectionStart = 0;
  selectionEnd = 0;

  setSelectionRange(start: number, end: number): void {
    this.selectionStart = start;
    this.selectionEnd = end;
  }

  get children(): MiniElement[] {
    return this.childNodes.filter((node): node is MiniElement => node instanceof MiniElement);
  }

  get classList(): { contains(name: string): boolean } {
    return { contains: name => (this.attributes.class ?? "").split(" ").includes(name) };
  }

  get isConnected(): boolean {
    return this.ownerDocument.contains(this);
  }

  getBoundingClientRect(): { top: number; bottom: number } {
    const parent = this.parentNode;
    const top = parent instanceof MiniElement
      ? parent.getBoundingClientRect().top + parent.childNodes.indexOf(this) * ROW_PX - parent.scrollTop
      : 0;
    return { top, bottom: top + ROW_PX };
  }

  constructor(ownerDocument: MiniDocument, tagName: string) {
    super(ownerDocument);
    this.tagName = tagName.toUpperCase();
    this.nodeName = this.tagName;
  }

  set innerHTML(markup: string) {
    this.markup = markup;
    this.childNodes.length = 0;
  }

  get innerHTML(): string {
    return this.markup;
  }

  set textContent(text: string) {
    this.childNodes.length = 0;
    this.markup = "";
    if (text !== "") this.appendChild(new MiniText(this.ownerDocument, text));
  }

  get textContent(): string {
    return textOf(this);
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = String(value);
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  hasAttribute(name: string): boolean {
    return name in this.attributes;
  }

  removeAttribute(name: string): void {
    Reflect.deleteProperty(this.attributes, name);
  }

  override addEventListener(type: string, listener: Listener): void {
    let listeners = this.listeners.get(type);
    if (listeners === undefined) {
      listeners = new Set();
      this.listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  override removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  focus(): void {
    this.ownerDocument.activeElement = this;
  }

  blur(): void {}
}

export class MiniDocument extends MiniNode {
  override nodeType = 9;
  readonly nodeName = "#document";
  readonly compatMode = "CSS1Compat";
  readonly documentElement: MiniElement;
  readonly body: MiniElement;
  activeElement: MiniElement | null;
  defaultView: unknown = null;
  visibilityState = "visible";
  oninput = null;
  readonly events = new EventTarget();

  override addEventListener(type: string, listener: Listener): void {
    this.events.addEventListener(type, listener);
  }

  override removeEventListener(type: string, listener: Listener): void {
    this.events.removeEventListener(type, listener);
  }

  dispatchEvent(event: Event): boolean {
    return this.events.dispatchEvent(event);
  }

  constructor() {
    super(undefined as unknown as MiniDocument);
    this.ownerDocument = this;
    this.documentElement = new MiniElement(this, "html");
    this.body = new MiniElement(this, "body");
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
    this.activeElement = this.body;
  }

  createElement(tagName: string): MiniElement {
    return new MiniElement(this, tagName);
  }

  createElementNS(_namespace: string, tagName: string): MiniElement {
    return new MiniElement(this, tagName);
  }

  createTextNode(text: string): MiniText {
    return new MiniText(this, text);
  }

  createComment(text: string): MiniComment {
    return new MiniComment(this, text);
  }
}

/** Text of a subtree, with markdown `innerHTML` reduced to its text. */
export function textOf(node: MiniNode): string {
  if (node.nodeType === 3) return node.nodeValue ?? "";
  if (node instanceof MiniElement && node.markup !== "") {
    return node.markup.replaceAll(/<[^>]*>/g, "");
  }
  let text = "";
  for (const child of node.childNodes) text += textOf(child);
  return text;
}

/** Every element in `node`'s subtree carrying `className`, document order. */
export function queryAll(node: MiniNode, className: string): MiniElement[] {
  const found: MiniElement[] = [];
  const visit = (current: MiniNode): void => {
    if (current instanceof MiniElement && (current.attributes.class ?? "").split(" ").includes(className)) {
      found.push(current);
    }
    for (const child of current.childNodes) visit(child);
  };
  visit(node);
  return found;
}

/** The single element carrying `className`, or `null` when absent. */
export function query(node: MiniNode, className: string): MiniElement | null {
  const found = queryAll(node, className);
  if (found.length > 1) throw new Error(`${found.length} elements match .${className}`);
  return found[0] ?? null;
}

const document = new MiniDocument();
const window = Object.assign(new EventTarget(), {
  document,
  navigator: { userAgent: "collab-client-tests" },
  HTMLIFrameElement: class extends MiniElement {},
  // The theme store reads the color-scheme query while its module initializes.
  matchMedia: (): { matches: boolean; addEventListener(): void; removeEventListener(): void } => ({
    matches: false,
    addEventListener(): void {},
    removeEventListener(): void {},
  }),
  setTimeout: globalThis.setTimeout.bind(globalThis),
  clearTimeout: globalThis.clearTimeout.bind(globalThis),
});
document.defaultView = window;

const INSTALLED: Record<string, unknown> = {
  window,
  document,
  navigator: window.navigator,
  HTMLElement: MiniElement,
  Element: MiniElement,
  Node: MiniNode,
  IS_REACT_ACT_ENVIRONMENT: true,
};
const nativeGlobals = new Map<string, PropertyDescriptor | undefined>();
for (const name of Object.keys(INSTALLED)) {
  nativeGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
}

/** Reinstall after another test file restores its globals; the same document owns every tree. */
export function installDomGlobals(): void {
  for (const name of Object.keys(INSTALLED)) {
    Object.defineProperty(globalThis, name, { configurable: true, value: INSTALLED[name] });
  }
}
installDomGlobals();

/** Hands the process back its own globals; call from `afterAll`. */
export function restoreDomGlobals(): void {
  for (const [name, descriptor] of nativeGlobals) {
    if (descriptor === undefined) Reflect.deleteProperty(globalThis, name);
    else Object.defineProperty(globalThis, name, descriptor);
  }
}

// `react-dom/client` samples `window`/`document` while it initializes, so it can
// only be loaded once the globals above exist. A lazy cached import (instead of a
// top-level await) keeps this module free of TLA: Bun 1.3.14's coverage
// instrumentation mis-orders TLA module evaluation and leaves the post-await
// bindings in their temporal dead zone when the test file calls in.
let createRootLazy: typeof createRootFn | undefined;

async function loadCreateRoot(): Promise<typeof createRootFn> {
  // Dynamic import by necessity: a static import would evaluate react-dom before
  // the globals above are installed.
  if (createRootLazy === undefined) createRootLazy = (await import("react-dom/client")).createRoot;
  return createRootLazy;
}

export interface MountedTree {
  /** Root container React renders into. */
  readonly container: MiniElement;
  render(node: ReactNode): Promise<void>;
  unmount(): Promise<void>;
}

const mounted: Root[] = [];

export async function mount(node: ReactNode): Promise<MountedTree> {
  installDomGlobals();
  const container = document.createElement("div");
  document.body.appendChild(container);
  const createRoot = await loadCreateRoot();
  const root = createRoot(container as unknown as Element);
  mounted.push(root);
  const tree: MountedTree = {
    container,
    async render(next: ReactNode): Promise<void> {
      await act(async () => {
        root.render(next);
      });
    },
    async unmount(): Promise<void> {
      await act(async () => {
        root.unmount();
      });
      container.parentNode?.removeChild(container);
    },
  };
  await tree.render(node);
  return tree;
}

/** Unmounts every tree this harness created; call from `afterEach`. */
export async function unmountAll(): Promise<void> {
  const roots = mounted.splice(0, mounted.length);
  await act(async () => {
    for (const root of roots) root.unmount();
  });
  document.body.childNodes.length = 0;
}

/** Dispatches a click the way the browser would: capture then bubble listeners. */
export async function dispatch(node: MiniElement, type: string, properties: Record<string, unknown> = {}): Promise<{ defaultPrevented: boolean }> {
  const event = {
    type,
    target: node,
    bubbles: true,
    cancelable: true,
    defaultPrevented: false,
    isTrusted: true,
    timeStamp: 0,
    detail: 1,
    button: 0,
    buttons: 0,
    preventDefault(): void { this.defaultPrevented = true; },
    stopPropagation(): void {},
    ...properties,
  };
  await act(async () => {
    for (let current: MiniNode | null = node; current !== null; current = current.parentNode) {
      const listeners = current instanceof MiniElement ? current.listeners.get(type) : undefined;
      if (listeners === undefined) continue;
      for (const listener of [...listeners]) listener(event);
    }
  });
  return event;
}

export async function click(node: MiniElement): Promise<void> {
  await dispatch(node, "click");
}
