"use strict";

// Styles for the viewer's shadow root, so Pixiv's CSS and ours can't collide.
globalThis.FollowingViewer.STYLES = `
:host { all: initial; }
* { box-sizing: border-box; }

dialog {
  --bg: #121315;
  --panel: #1b1d20;
  --line: #2e3136;
  --text: #eceef0;
  --dim: #9aa1a9;
  --accent: #4cb4ff;
  position: fixed; inset: 0;
  width: 100vw; height: 100vh; max-width: none; max-height: none;
  margin: 0; padding: 0; border: 0;
  display: grid; grid-template-rows: auto minmax(0, 1fr) auto;
  background: var(--bg); color: var(--text); color-scheme: dark;
  font: 14px/1.4 system-ui, "Segoe UI", "Yu Gothic UI", "Hiragino Sans", "Noto Sans CJK JP", sans-serif;
  outline: none; overflow: hidden;
}
dialog:not([open]) { display: none; }

a { color: inherit; text-decoration: none; }
a:hover { text-decoration: underline; }
button, select { font: inherit; color: inherit; }
:focus-visible { outline: 2px solid var(--accent); outline-offset: 2px; }
[hidden] { display: none !important; }

header {
  position: relative; z-index: 4;
  display: flex; align-items: center; gap: 16px; flex-wrap: wrap;
  padding: 8px 14px; min-height: 56px;
  background: var(--panel); border-bottom: 1px solid var(--line);
}
.work { display: flex; align-items: center; gap: 12px; min-width: 0; flex: 1 1 320px; }
.avatar { width: 38px; height: 38px; border-radius: 50%; object-fit: cover; background: var(--line); flex: none; display: block; }
.text { min-width: 0; }
.title { display: block; font-weight: 600; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.byline { color: var(--dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.byline a { color: var(--text); }
.badge {
  display: inline-block; margin-left: 8px; padding: 0 6px; border-radius: 4px;
  background: var(--line); color: var(--text); font-size: 12px;
}

.controls { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.count { color: var(--dim); font-variant-numeric: tabular-nums; margin-right: 4px; white-space: nowrap; }
.panel {
  position: absolute; top: calc(100% + 8px); right: 14px; max-width: calc(100vw - 28px);
  display: flex; flex-direction: column; gap: 12px; padding: 16px;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0,0,0,.5);
}
.panel p { margin: 0; color: var(--dim); max-width: 40ch; }
.panel div { display: flex; gap: 8px; }
.panel input {
  width: 84px; height: 32px; margin: 0 4px; padding: 0 8px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--bg); color: inherit; font: inherit;
}
.panel input:user-invalid { border-color: #ff5577; }
.panel .primary { background: var(--accent); border-color: var(--accent); color: #06121c; font-weight: 600; }

.panel button, .controls button, .controls select, .notice button, .notice a {
  height: 32px; padding: 0 10px; border-radius: 6px;
  border: 1px solid var(--line); background: var(--bg); cursor: pointer;
  display: inline-flex; align-items: center; white-space: nowrap;
}
.controls select option { background: var(--panel); color: var(--text); }
.controls button:hover, .controls select:hover, .notice button:hover, .notice a:hover { border-color: var(--dim); text-decoration: none; }
.controls button[aria-pressed="true"] { border-color: var(--accent); color: var(--accent); }
.controls .close { width: 32px; padding: 0; justify-content: center; font-size: 18px; }

.stage { position: relative; min-height: 0; overflow: hidden; }
.fit {
  position: absolute; inset: 12px 64px; container-type: size;
  display: grid; place-items: center;
}
.frame {
  --ratio: 1;
  position: relative; overflow: hidden; background: var(--panel);
  width: min(100cqw, 100cqh * var(--ratio)); aspect-ratio: var(--ratio);
}
.frame > * { position: absolute; inset: 0; width: 100%; height: 100%; display: block; }
.placeholder { object-fit: cover; filter: blur(14px) brightness(.75); transform: scale(1.06); }
.art { object-fit: contain; opacity: 0; }
.art.ready { opacity: 1; }
.art.ready ~ .spinner { display: none; }

.spinner {
  inset: auto 12px 12px auto !important; width: 26px !important; height: 26px !important;
  border-radius: 50%; border: 3px solid rgba(255,255,255,.25); border-top-color: #fff;
  animation: spin .8s linear infinite; opacity: 0; animation-delay: .25s;
}
.loading .spinner { opacity: 1; transition: opacity .1s .25s; }
@keyframes spin { to { transform: rotate(1turn); } }
@media (prefers-reduced-motion: reduce) { .spinner { animation-duration: 3s; } }

.nav {
  position: absolute; top: 0; bottom: 0; z-index: 1; padding: 0 14px;
  border: 0; background: none; cursor: pointer;
  display: flex; align-items: center; color: var(--dim);
}
.nav.prev { left: 0; width: 40%; justify-content: flex-start; }
.nav.next { right: 0; width: 60%; justify-content: flex-end; }
.nav svg {
  width: 36px; height: 36px; padding: 6px; border-radius: 50%;
  background: rgba(27,29,32,.85); border: 1px solid var(--line);
}
.nav:hover svg { color: #fff; border-color: var(--accent); }

.reactions {
  position: absolute; right: 10px; bottom: 14px; z-index: 1;
  display: flex; flex-direction: column; gap: 10px;
}
.react {
  display: block; width: 44px; height: 44px; padding: 10px; border-radius: 50%; cursor: pointer;
  background: rgba(27,29,32,.92); border: 1px solid var(--line); color: var(--dim);
}
.react svg { display: block; width: 100%; height: 100%; }
.react:hover { color: #fff; border-color: var(--dim); }
.react[aria-pressed="true"] svg > * { fill: currentColor; }
.like[aria-pressed="true"] { color: var(--accent); }
.bookmark[aria-pressed="true"] { color: #ff5577; }
/* Keep the buttons clear of the next arrow in short windows. */
@media (max-height: 640px) {
  .reactions { gap: 6px; bottom: 10px; }
  .react { width: 36px; height: 36px; padding: 8px; }
}

.notice {
  position: absolute; inset: 0; z-index: 2; background: var(--bg);
  display: flex; flex-direction: column; align-items: center; justify-content: center; gap: 14px;
  padding: 24px; text-align: center;
}
.notice p { margin: 0; max-width: 46ch; }
.notice div { display: flex; gap: 8px; flex-wrap: wrap; justify-content: center; }
.notice.work-error {
  inset: 50% auto auto 50%; transform: translate(-50%, -50%); padding: 14px 20px; max-width: 80%;
  background: var(--panel); border: 1px solid var(--line); border-radius: 10px; pointer-events: none;
}

.pages {
  display: flex; align-items: center; gap: 12px; min-width: 0;
  padding: 8px 14px; background: var(--panel); border-top: 1px solid var(--line);
}
.pages .label { color: var(--dim); font-variant-numeric: tabular-nums; white-space: nowrap; }
.strip { display: flex; gap: 6px; overflow-x: auto; min-width: 0; scrollbar-width: thin; padding: 3px; }
.strip button {
  flex: none; width: 52px; height: 52px; padding: 0; border-radius: 5px; overflow: hidden;
  border: 2px solid transparent; background: var(--line); cursor: pointer;
}
.strip button[aria-current="true"] { border-color: var(--accent); }
.strip img { width: 100%; height: 100%; object-fit: cover; display: block; }

.toast {
  position: absolute; left: 50%; bottom: 24px; transform: translateX(-50%); z-index: 3;
  padding: 8px 14px; border-radius: 8px; pointer-events: none;
  background: rgba(0,0,0,.85); border: 1px solid var(--line);
  opacity: 0; transition: opacity .15s;
}
.toast.show { opacity: 1; }
`;
