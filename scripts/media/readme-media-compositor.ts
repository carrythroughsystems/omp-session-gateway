export interface DemoCompositorInputs {
  readonly logoDataUrl: string;
  readonly fontDataUrl: string;
  readonly screens: {
    readonly allClear: string;
    readonly discovered: string;
    readonly needsYou: string;
    readonly openRequest: string;
  };
  readonly tapPoint: {
    readonly xFraction: number;
    readonly yFraction: number;
  };
}

export interface FlowCompositorInputs {
  readonly logoDataUrl: string;
  readonly fontDataUrl: string;
  readonly screens: {
    readonly allClear: string;
    readonly needsYou: string;
    readonly openRequest: string;
  };
}

function scriptJson(value: unknown): string {
  return JSON.stringify(value).replaceAll("<", "\\u003c");
}

/**
 * The "Signal" tokens from docs/BRANDING.md, dark only: README media is pinned to one scheme. The
 * text face is the PWA's own Geist subset, embedded so a composite reads no network and renders
 * the same on any capture host.
 */
function sharedTokens(fontDataUrl: string): string {
  return `
  @font-face {
    font-family: "Geist";
    font-style: normal;
    font-weight: 100 900;
    src: url("${fontDataUrl}") format("woff2");
  }
  :root {
    color-scheme: dark;
    --ground: #000;
    --surface-1: #111113;
    --surface-2: #1c1c1f;
    --line: rgba(255, 255, 255, 0.08);
    --line-strong: rgba(255, 255, 255, 0.17);
    --ink: #f5f5f3;
    --ink-2: #c9c9cd;
    --ink-3: #8e8e95;
    --ink-4: #77777e;
    --attention: #ffb224;
    --attention-wash: rgba(255, 178, 36, 0.16);
    --shadow: rgba(0, 0, 0, 0.72);
    --font-sans: "Geist", system-ui, "Segoe UI", Roboto, "Helvetica Neue", sans-serif;
    --radius-phone: 30px;
    --radius-screen: 23px;
  }
  * { box-sizing: border-box; }
  html, body { margin: 0; overflow: hidden; }
  body {
    color: var(--ink);
    background: var(--ground);
    font-family: var(--font-sans);
    font-feature-settings: "ss08";
    font-synthesis: none;
    -webkit-font-smoothing: antialiased;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
  }
  .brand img { display: block; width: 28px; height: 28px; }
  .brand-name {
    color: var(--ink);
    font-size: 15px;
    font-weight: 640;
    letter-spacing: -0.02em;
  }
  .product-proof {
    color: var(--ink-3);
    font-size: 12px;
    font-weight: 500;
  }
  .phone {
    position: relative;
    background: var(--surface-1);
    border: 1px solid var(--line-strong);
    border-radius: var(--radius-phone);
    box-shadow: 0 22px 56px var(--shadow);
  }
  .phone::before {
    position: absolute;
    z-index: 4;
    top: 10px;
    left: 50%;
    width: 42px;
    height: 4px;
    border-radius: 2px;
    background: var(--line-strong);
    content: "";
    transform: translateX(-50%);
  }
  .phone-screen {
    position: absolute;
    overflow: hidden;
    background: var(--ground);
    border-radius: var(--radius-screen);
  }
  .phone-screen > img {
    position: absolute;
    inset: 0;
    display: block;
    width: 100%;
    height: 100%;
    object-fit: fill;
  }
`;
}

export function createDemoCompositorHtml(inputs: DemoCompositorInputs): string {
  const { fontDataUrl, ...scriptInputs } = inputs;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=960,height=540,initial-scale=1">
<style>
${sharedTokens(fontDataUrl)}
  html, body, main { width: 960px; height: 540px; }
  main { position: relative; isolation: isolate; }
  .topline { position: absolute; top: 32px; left: 48px; }
  .product-proof { position: absolute; top: 39px; right: 48px; }
  .copy {
    position: absolute;
    top: 150px;
    left: 48px;
    width: 558px;
  }
  .eyebrow {
    margin-bottom: 14px;
    color: var(--ink-3);
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .claim {
    min-height: 112px;
    margin: 0;
    max-width: 548px;
    color: var(--ink);
    font-size: 46px;
    font-weight: 680;
    letter-spacing: -0.04em;
    line-height: 1.03;
  }
  .support {
    margin: 22px 0 0;
    max-width: 500px;
    color: var(--ink-2);
    font-size: 17px;
    line-height: 1.5;
  }
  .trust {
    position: absolute;
    bottom: 36px;
    left: 48px;
    display: grid;
    gap: 6px;
    width: 566px;
  }
  .trust-line {
    margin: 0;
    color: var(--ink-3);
    font-size: 12.5px;
    font-weight: 500;
  }
  .disclaimer {
    margin: 0;
    color: var(--ink-4);
    font-size: 11px;
  }
  .demo-phone {
    --screen-width: 207px;
    --screen-height: 447.969px;
    position: absolute;
    top: 27px;
    right: 48px;
    width: 223px;
    height: 484px;
  }
  .demo-phone .phone-screen {
    top: 23px;
    left: 7px;
    width: var(--screen-width);
    height: var(--screen-height);
  }
  .runtime-screen { opacity: 0; }
  .toast {
    position: absolute;
    z-index: 5;
    top: 12px;
    left: 9px;
    width: 189px;
    padding: 10px 12px 11px;
    border-radius: 14px;
    color: var(--ink);
    background: var(--surface-2);
    box-shadow: 0 0 0 1px var(--line), 0 12px 28px var(--shadow);
    opacity: 0;
  }
  .toast-kicker {
    margin: 0 0 4px;
    color: var(--ink-3);
    font-size: 8px;
    font-weight: 600;
  }
  .toast-title {
    margin: 0;
    font-size: 10.5px;
    font-weight: 650;
    letter-spacing: -0.01em;
    line-height: 1.3;
  }
  .toast-body {
    margin: 3px 0 0;
    color: var(--ink-2);
    font-size: 8.5px;
    line-height: 1.4;
  }
  .tap-ring {
    position: absolute;
    z-index: 6;
    left: calc(var(--tap-x) * 1%);
    top: calc(var(--tap-y) * 1%);
    width: 36px;
    height: 36px;
    border: 2px solid var(--ink);
    border-radius: 50%;
    background: rgba(245, 245, 243, 0.18);
    box-shadow: 0 0 0 5px rgba(0, 0, 0, 0.28);
    opacity: 0;
    transform: translate(-50%, -50%) scale(0.72);
  }
  .tap-ring::after {
    position: absolute;
    inset: 50% auto auto 50%;
    width: 5px;
    height: 5px;
    border-radius: 50%;
    background: var(--ink);
    content: "";
    transform: translate(-50%, -50%);
  }
  .phone-caption {
    position: absolute;
    right: 54px;
    bottom: 10px;
    color: var(--ink-4);
    font-size: 9px;
    font-weight: 500;
    font-variant-numeric: tabular-nums;
  }
</style>
</head>
<body>
<main aria-label="OMP Session Gateway presentation composite">
  <div class="topline brand">
    <img id="brand-logo" alt="">
    <span class="brand-name">OMP Session Gateway</span>
  </div>
  <span class="product-proof">Actual built PWA pixels</span>
  <section class="copy">
    <div class="eyebrow" id="stage-kicker"></div>
    <h1 class="claim" id="stage-claim"></h1>
    <p class="support" id="stage-support"></p>
  </section>
  <section class="trust">
    <p class="trust-line">Loopback-only gateway · memory-only capabilities · no transcript storage</p>
    <p class="disclaimer">Community project; not affiliated with OMP.</p>
  </section>
  <div class="phone demo-phone" aria-hidden="true">
    <div class="phone-screen" id="phone-screen">
      <img class="runtime-screen" data-screen="allClear" alt="">
      <img class="runtime-screen" data-screen="discovered" alt="">
      <img class="runtime-screen" data-screen="needsYou" alt="">
      <img class="runtime-screen" data-screen="openRequest" alt="">
      <aside class="toast" id="toast">
        <p class="toast-kicker">Android alert · capture-only</p>
        <p class="toast-title">OMP session needs attention</p>
        <p class="toast-body">Gateway auth hardening · omp-session-gateway</p>
      </aside>
      <div class="tap-ring" id="tap-ring"></div>
    </div>
  </div>
  <div class="phone-caption">390 × 844 · DPR 2 source</div>
</main>
<script>
  const input = ${scriptJson(scriptInputs)};
  document.querySelector("#brand-logo").src = input.logoDataUrl;
  for (const image of document.querySelectorAll("[data-screen]")) image.src = input.screens[image.dataset.screen];
  const screen = document.querySelector("#phone-screen");
  screen.style.setProperty("--tap-x", String(input.tapPoint.xFraction * 100));
  screen.style.setProperty("--tap-y", String(input.tapPoint.yFraction * 100));
  const images = Object.fromEntries([...document.querySelectorAll("[data-screen]")].map(image => [image.dataset.screen, image]));
  const kicker = document.querySelector("#stage-kicker");
  const claim = document.querySelector("#stage-claim");
  const support = document.querySelector("#stage-support");
  const toast = document.querySelector("#toast");
  const tapRing = document.querySelector("#tap-ring");

  function ease(value) {
    const clamped = Math.max(0, Math.min(1, value));
    return clamped * clamped * (3 - 2 * clamped);
  }

  function mix(from, to, progress) {
    for (const image of Object.values(images)) image.style.opacity = "0";
    const eased = ease(progress);
    images[from].style.opacity = String(1 - eased);
    images[to].style.opacity = String(eased);
  }

  function hold(name) {
    for (const image of Object.values(images)) image.style.opacity = image === images[name] ? "1" : "0";
  }

  function copyForFrame(frame) {
    if (frame <= 17 || frame >= 127) return ["01 · Discover", "Every live OMP session.", "One private mobile page."];
    if (frame <= 38) return ["01 · Discover", "Sessions appear automatically.", "No per-session command, QR scan, or copied link."];
    if (frame <= 66) return ["02 · Triage", "Only interrupt when input is needed.", "Oldest waiting ask first. Re-checked before Control."];
    if (frame <= 83) return ["03 · Control", "One tap to the real OMP request.", "The request is answered in OMP’s own pinned, encrypted client."];
    if (frame <= 107) return ["03 · Control", "The exact live request.", "Actual pinned OMP collaboration UI — no replacement agent client."];
    if (frame <= 123) return ["Private by construction", "Leave the terminal. Keep the session.", "No QR codes · no copied links · no public dashboard"];
    return ["01 · Discover", "Every live OMP session.", "One private mobile page."];
  }

  globalThis.renderMediaFrame = frame => {
    if (!Number.isInteger(frame) || frame < 0 || frame > 129) throw new Error("frame outside canonical timeline");
    if (frame <= 17) hold("allClear");
    else if (frame <= 22) mix("allClear", "discovered", (frame - 18) / 4);
    else if (frame <= 38) hold("discovered");
    else if (frame <= 42) mix("discovered", "needsYou", (frame - 39) / 3);
    else if (frame <= 79) hold("needsYou");
    else if (frame <= 83) mix("needsYou", "openRequest", (frame - 80) / 3);
    else if (frame <= 123) hold("openRequest");
    else if (frame <= 126) mix("openRequest", "allClear", (frame - 124) / 2);
    else hold("allClear");

    const copy = copyForFrame(frame);
    kicker.textContent = copy[0];
    claim.textContent = copy[1];
    support.textContent = copy[2];

    let toastOpacity = 0;
    if (frame >= 43 && frame <= 56) {
      if (frame <= 45) toastOpacity = ease((frame - 43) / 2);
      else if (frame >= 54) toastOpacity = 1 - ease((frame - 54) / 2);
      else toastOpacity = 1;
    }
    toast.style.opacity = String(toastOpacity);

    let tapOpacity = 0;
    let tapScale = 0.72;
    if (frame >= 67 && frame <= 72) {
      const progress = (frame - 67) / 5;
      tapOpacity = Math.sin(progress * Math.PI);
      tapScale = 0.72 + 0.28 * ease(Math.min(progress * 2, 1));
    }
    tapRing.style.opacity = String(tapOpacity);
    tapRing.style.transform = "translate(-50%, -50%) scale(" + tapScale + ")";
    document.body.dataset.frame = String(frame);
  };
  globalThis.renderMediaFrame(0);
</script>
</body>
</html>`;
}

export function createFlowCompositorHtml(inputs: FlowCompositorInputs): string {
  const { fontDataUrl, ...scriptInputs } = inputs;
  const steps = [
    {
      screen: "allClear",
      number: "01",
      label: "Discover",
      headline: "Every live session, automatically.",
      body: "After one-time setup, the terminal stays the source of truth and the phone gets one private directory.",
    },
    {
      screen: "needsYou",
      number: "02",
      label: "Triage",
      headline: "The oldest waiting ask rises first.",
      body: "The directory shows bounded metadata; the request itself stays in OMP.",
    },
    {
      screen: "openRequest",
      number: "03",
      label: "Control",
      headline: "Open the exact live request.",
      body: "Control opens only after the gateway re-checks that the request is still live; View transcript instead stays read-only.",
    },
  ] as const;
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=1600,height=980,initial-scale=1">
<style>
${sharedTokens(fontDataUrl)}
  html, body, main { width: 1600px; height: 980px; }
  main { position: relative; isolation: isolate; }
  .flow-brand { position: absolute; top: 48px; left: 64px; }
  .flow-proof { position: absolute; top: 55px; right: 64px; font-size: 13px; }
  .flow-title {
    position: absolute;
    top: 100px;
    left: 64px;
    margin: 0;
    color: var(--ink);
    font-size: 52px;
    font-weight: 680;
    letter-spacing: -0.04em;
  }
  .flow-subtitle {
    position: absolute;
    top: 172px;
    left: 65px;
    margin: 0;
    color: var(--ink-2);
    font-size: 18px;
  }
  .steps {
    position: absolute;
    top: 226px;
    right: 64px;
    left: 64px;
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 64px;
  }
  .step { position: relative; min-width: 0; }
  .step + .step::before {
    position: absolute;
    top: 407px;
    left: -46px;
    width: 28px;
    height: 1.5px;
    border-radius: 1px;
    background: var(--ink-4);
    content: "";
  }
  .step + .step::after {
    position: absolute;
    top: 403.5px;
    left: -26px;
    width: 7px;
    height: 7px;
    border-top: 1.5px solid var(--ink-4);
    border-right: 1.5px solid var(--ink-4);
    content: "";
    transform: rotate(45deg);
  }
  .step-label {
    display: flex;
    align-items: baseline;
    gap: 8px;
    color: var(--ink-2);
    font-size: 14px;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
  }
  .step-number { color: var(--ink-4); }
  .step h2 {
    min-height: 32px;
    margin: 12px 0 8px;
    color: var(--ink);
    font-size: 27px;
    font-weight: 660;
    letter-spacing: -0.03em;
    line-height: 1.13;
  }
  .step-copy {
    min-height: 46px;
    margin: 0;
    max-width: 430px;
    color: var(--ink-2);
    font-size: 15px;
    line-height: 1.5;
  }
  .flow-phone {
    --screen-width: 226px;
    --screen-height: 489.169px;
    width: 242px;
    height: 526px;
    margin: 22px auto 0;
  }
  .flow-phone .phone-screen {
    top: 23px;
    left: 7px;
    width: var(--screen-width);
    height: var(--screen-height);
  }
  .flow-phone img { object-fit: fill; }
  .flow-footer {
    position: absolute;
    right: 64px;
    bottom: 40px;
    left: 64px;
    display: flex;
    align-items: flex-end;
    justify-content: space-between;
    gap: 32px;
    padding-top: 16px;
    border-top: 1px solid var(--line);
  }
  .flow-trust {
    margin: 0;
    color: var(--ink-3);
    font-size: 13px;
    font-weight: 500;
  }
  .flow-disclaimer { margin: 0; color: var(--ink-4); font-size: 12px; }
</style>
</head>
<body>
<main aria-label="Discover, triage, and control product flow">
  <div class="flow-brand brand">
    <img id="brand-logo" alt="">
    <span class="brand-name">OMP Session Gateway</span>
  </div>
  <span class="flow-proof product-proof">Actual built PWA + pinned client pixels</span>
  <h1 class="flow-title">From running session to exact request.</h1>
  <p class="flow-subtitle">A metadata-only directory hands off to OMP’s own encrypted client.</p>
  <section class="steps">
    ${steps.map(step => `<article class="step">
      <div class="step-label"><span class="step-number">${step.number}</span><span>${step.label}</span></div>
      <h2>${step.headline}</h2>
      <p class="step-copy">${step.body}</p>
      <div class="phone flow-phone" aria-hidden="true">
        <div class="phone-screen"><img data-screen="${step.screen}" alt=""></div>
      </div>
    </article>`).join("")}
  </section>
  <footer class="flow-footer">
    <p class="flow-trust">Loopback-only gateway · memory-only capabilities · no transcript storage</p>
    <p class="flow-disclaimer">Community project; not affiliated with OMP.</p>
  </footer>
</main>
<script>
  const flowInput = ${scriptJson(scriptInputs)};
  document.querySelector("#brand-logo").src = flowInput.logoDataUrl;
  for (const image of document.querySelectorAll("[data-screen]")) image.src = flowInput.screens[image.dataset.screen];
</script>
</body>
</html>`;
}
