"use strict";

(() => {
  const FV = globalThis.FollowingViewer;
  const { Timeline, Progress, PixivError, Reactions } = FV;

  const DEFAULT_PREFS = { order: "asc", mode: "all", hd: false, baseline: 60 };
  const MAX_BASELINE = 2000;
  const PRELOAD_AHEAD = 3;
  const SKIM_DELAY = 70; // ms to wait before loading, so holding an arrow key doesn't flood Pixiv
  const SAVE_INTERVAL = 250;
  const WHEEL_COOLDOWN = 160;
  const CONFIRM_WITHIN = 3000; // ms to press again before a removal is forgotten

  const HEART = "M12 20.5C5.5 15.8 2.8 12.4 2.8 8.9 2.8 6.2 4.9 4.2 7.4 4.2c1.9 0 3.6 1.1 4.6 2.8 1-1.7 2.7-2.8 4.6-2.8 2.5 0 4.6 2 4.6 4.7 0 3.5-2.7 6.9-9.2 11.6z";
  const NEW_TAB = "M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5";
  const THUMB = "M7.5 10.5 11 3.2c1.6 0 2.7 1.2 2.7 2.8v3.2h4.9c1.3 0 2.3 1.2 2 2.5l-1.4 7c-.2 1-1 1.6-2 1.6H3.8v-9.8h3.7v9.8";

  const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" });
  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const progressKey = (mode) => `seen:${mode}`;
  // Where lists were kept before 1.2.0. Those were only from trying things out, so
  // they are dropped rather than carried over.
  const OLD_PROGRESS_KEYS = ["progress:all", "progress:safe", "progress:r18"];

  /** el("button", { class: "x", onclick }, "text", child) */
  function el(tag, attributes = {}, ...children) {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (name.startsWith("on")) node.addEventListener(name.slice(2), value);
      else if (value === true) node.setAttribute(name, "");
      else if (value !== false && value != null) node.setAttribute(name, value);
    }
    node.append(...children);
    return node;
  }

  function icon(tag, attributes) {
    const ns = "http://www.w3.org/2000/svg";
    const svg = document.createElementNS(ns, "svg");
    svg.setAttribute("viewBox", "0 0 24 24");
    svg.setAttribute("aria-hidden", "true");
    const shape = document.createElementNS(ns, tag);
    for (const [name, value] of Object.entries({
      fill: "none", stroke: "currentColor", "stroke-width": "2",
      "stroke-linecap": "round", "stroke-linejoin": "round", ...attributes,
    })) shape.setAttribute(name, value);
    svg.append(shape);
    return svg;
  }
  const chevron = (points) => icon("polyline", { points, "stroke-width": "2.5" });

  class Viewer {
    constructor() {
      this.isOpen = false;
      this.prefs = { ...DEFAULT_PREFS };
      this.timeline = null;
      this.page = 0;
      this.pages = null; // page data for the current work, once loaded
      this.session = 0; // bumped by every (re)start, so stale async work can bail out
      this.shown = 0; // same, for each work/page shown
      this.playing = null; // AbortController for the running animation
      this.reaching = false;
      this.lastShowAt = 0;
      this.lastWheelAt = 0;
      this.saveTimer = 0;
      this.lastSaveAt = -Infinity;
      this.toastTimer = 0;
      this.preloads = new Map(); // url -> Image, kept alive so they stay cached
      this.reactions = null;
      this.removing = null; // the work whose bookmark the next press will remove
      this.build();
    }

    build() {
      this.ui = {
        avatar: el("img", { class: "avatar", alt: "" }),
        avatarLink: el("a", { target: "_blank", rel: "noopener" }),
        title: el("a", { class: "title", target: "_blank", rel: "noopener" }),
        artist: el("a", { target: "_blank", rel: "noopener" }),
        date: el("time"),
        badges: el("span"),
        count: el("span", { class: "count", role: "status" }),
        order: el("select", { "aria-label": "Reading order", onchange: () => this.setPref("order", this.ui.order.value) },
          el("option", { value: "asc" }, "Oldest first"),
          el("option", { value: "desc" }, "Newest first")),
        mode: el("select", { "aria-label": "Which works to show", onchange: () => this.setPref("mode", this.ui.mode.value) },
          el("option", { value: "all" }, "All works"),
          el("option", { value: "safe" }, "All ages"),
          el("option", { value: "r18" }, "R-18")),
        hd: el("button", { type: "button", title: "Show original-size images (H)", onclick: () => this.setPref("hd", !this.prefs.hd) }, "Original size"),
        markAll: el("button", { type: "button", title: "Treat everything up to the newest work as seen", onclick: () => this.markAllSeen() }, "Mark all seen"),
        startOver: el("button", { type: "button", title: "Choose how many of the latest works count as unseen", "aria-expanded": "false", onclick: () => this.togglePanel() }, "Start over…"),
        baseline: el("input", { type: "number", min: 1, max: MAX_BASELINE, step: 1, required: true, "aria-label": "How many of the latest works count as unseen" }),
        panelScope: el("p"),
        placeholder: el("img", { class: "placeholder", alt: "" }),
        image: el("img", { class: "art", alt: "" }),
        canvas: el("canvas", { class: "art" }),
        spinner: el("span", { class: "spinner" }),
        prev: el("button", { class: "nav prev", type: "button", tabindex: "-1", "aria-label": "Previous illustration", title: "Previous illustration (←)", onclick: () => this.step(-1) }, chevron("15 5 8 12 15 19")),
        next: el("button", { class: "nav next", type: "button", tabindex: "-1", "aria-label": "Next illustration", title: "Next illustration (→)", onclick: () => this.step(1) }, chevron("9 5 16 12 9 19")),
        // A real link, so middle-click and the right-click menu work on it too. Pixiv's
        // image host refuses requests that don't say they come from pixiv.net.
        openImage: el("a", {
          class: "react", target: "_blank", rel: "noopener", referrerpolicy: "strict-origin-when-cross-origin", hidden: true,
          "aria-label": "Open original image in new tab", title: "Open original image in new tab (I)", onclick: (e) => this.onOpenImageClick(e),
        }, icon("path", { d: NEW_TAB })),
        like: el("button", { class: "react like", type: "button", "aria-label": "Like", onclick: () => this.like() }, icon("path", { d: THUMB })),
        bookmark: el("button", { class: "react bookmark", type: "button", "aria-label": "Bookmark", onclick: () => this.toggleBookmark() }, icon("path", { d: HEART })),
        notice: el("div", { class: "notice", role: "alert", hidden: true }),
        pageLabel: el("span", { class: "label" }),
        strip: el("div", { class: "strip" }),
        toast: el("div", { class: "toast", role: "status" }),
      };
      const ui = this.ui;
      ui.avatarLink.append(ui.avatar);
      ui.frame = el("div", { class: "frame" }, ui.placeholder, ui.image, ui.canvas, ui.spinner);
      ui.stage = el("main", { class: "stage" },
        el("div", { class: "fit" }, ui.frame), ui.prev, ui.next,
        el("div", { class: "reactions" }, ui.openImage, ui.like, ui.bookmark), ui.notice, ui.toast);
      ui.footer = el("footer", { class: "pages", hidden: true }, ui.pageLabel, ui.strip);
      ui.work = el("div", { class: "work" }, ui.avatarLink,
        el("div", { class: "text" }, ui.title, el("div", { class: "byline" }, ui.artist, " · ", ui.date, ui.badges)));
      ui.panel = el("form", { class: "panel", "aria-label": "Start over", hidden: true, onsubmit: (e) => { e.preventDefault(); this.startOver(); } },
        el("label", {}, "Count the latest ", ui.baseline, " works as unseen"),
        ui.panelScope,
        el("div", {},
          el("button", { class: "primary", type: "submit" }, "Start over"),
          el("button", { type: "button", onclick: () => this.closePanel() }, "Cancel")));
      ui.dialog = el("dialog", { tabindex: "-1", "aria-label": "Following viewer" },
        el("header", {}, ui.work,
          el("div", { class: "controls" }, ui.count, ui.order, ui.mode, ui.hd, ui.markAll, ui.startOver,
            el("button", { class: "close", type: "button", "aria-label": "Close viewer", title: "Close (Esc)", onclick: () => this.close() }, "×")),
          ui.panel),
        ui.stage, ui.footer);

      // Clicking these must not take focus, or Space would repeat that button.
      for (const button of [ui.prev, ui.next, ui.openImage, ui.like, ui.bookmark]) {
        button.addEventListener("mousedown", (e) => e.preventDefault());
      }
      ui.dialog.addEventListener("cancel", (e) => {
        e.preventDefault();
        if (ui.panel.hidden) this.close();
        else this.closePanel();
      });
      // Browsers may close a dialog without asking if Esc is pressed repeatedly.
      ui.dialog.addEventListener("close", () => { if (!ui.dialog.open) this.close(); });
      ui.stage.addEventListener("mousedown", () => this.closePanel());
      ui.dialog.addEventListener("keydown", (e) => this.onKey(e));
      ui.stage.addEventListener("wheel", (e) => this.onWheel(e), { passive: false });

      this.host = el("div", { id: "following-viewer-host" });
      const style = document.createElement("style");
      style.textContent = FV.STYLES;
      this.host.attachShadow({ mode: "open" }).append(style, ui.dialog);
    }

    // ---- opening and closing ----

    async open() {
      if (this.isOpen) return;
      this.isOpen = true;
      document.documentElement.append(this.host);
      this.savedOverflow = document.documentElement.style.overflow;
      document.documentElement.style.overflow = "hidden";
      this.ui.dialog.showModal();
      this.ui.dialog.focus();

      this.reactions = new Reactions(FV, (work) => {
        if (work.id === this.timeline?.current?.id) this.updateReactions();
      });
      browser.storage.local.remove(OLD_PROGRESS_KEYS).catch(() => {});
      const { prefs } = await browser.storage.local.get("prefs");
      this.prefs = { ...DEFAULT_PREFS, ...prefs };
      await this.restart();
    }

    close() {
      if (!this.isOpen) return;
      this.save();
      this.closePanel();
      this.isOpen = false;
      this.session++;
      this.shown++;
      this.playing?.abort();
      this.preloads.clear();
      this.ui.dialog.close();
      this.host.remove();
      document.documentElement.style.overflow = this.savedOverflow;
      if (location.hash === "#following-viewer") {
        history.replaceState(history.state, "", location.pathname + location.search);
      }
    }

    toggle() {
      if (this.isOpen) this.close();
      else this.open();
    }

    /** Load (or reload) the feed for the current settings and show the starting work. */
    async restart({ startOver = false } = {}) {
      const session = ++this.session;
      const { mode, order, baseline } = this.prefs;
      this.reaching = false;
      this.syncControls();
      this.notify("Loading your feed…");
      try {
        const key = progressKey(mode);
        const stored = await browser.storage.local.get(key);
        if (session !== this.session) return;
        if (this.timeline?.mode === mode) {
          this.timeline.progress.merge(stored[key]);
        } else {
          this.timeline = new Timeline({
            fetchPage: (n) => FV.fetchFeedPage(mode, n),
            progress: new Progress(stored[key]),
          });
          this.timeline.mode = mode;
        }
        const timeline = this.timeline;
        timeline.baseline = baseline;
        const work = await timeline.start(order, {
          startOver,
          isCurrent: () => session === this.session,
          onLoad: (n) => {
            if (session === this.session) this.notify(`Loading your feed… ${n} works so far`);
          },
        });
        if (session !== this.session) return;
        if (!work) {
          this.notify("Nothing here yet. Works from artists you follow will show up once they post.",
            { retry: "Check again" });
          return;
        }
        const unseen = timeline.unseenCount;
        this.hideNotice();
        this.visit(work);
        if (startOver) this.toast(`Started over with ${unseen} unseen.`);
        else if (unseen === 0) this.toast("Nothing new since last time. Showing the latest work.");
      } catch (error) {
        if (session === this.session) this.fail(error, { startOver });
      }
    }

    // ---- starting over ----

    togglePanel() {
      const { ui } = this;
      if (!ui.panel.hidden) return this.closePanel();
      ui.baseline.value = this.prefs.baseline;
      const scope = ui.mode.selectedOptions[0].textContent;
      ui.panelScope.textContent = `This replaces what you've seen in "${scope}". Nothing changes on Pixiv.`;
      ui.panel.hidden = false;
      ui.startOver.setAttribute("aria-expanded", "true");
      ui.baseline.focus();
      ui.baseline.select();
    }

    closePanel() {
      const { ui } = this;
      if (ui.panel.hidden) return;
      ui.panel.hidden = true;
      ui.startOver.setAttribute("aria-expanded", "false");
      ui.dialog.focus();
    }

    /** Only reached with a valid number; the form checks it first. */
    async startOver() {
      this.prefs.baseline = this.ui.baseline.valueAsNumber;
      this.store(() => ({ prefs: this.prefs }));
      this.closePanel();
      await this.restart({ startOver: true });
    }

    // ---- moving around ----

    async step(direction) {
      const { timeline, prefs } = this;
      const { notice } = this.ui;
      const blocked = !notice.hidden && !notice.classList.contains("work-error");
      if (!timeline?.current || this.reaching || blocked) return;

      const ready = timeline.peek(prefs.order, direction);
      if (ready) return this.visit(ready, direction);

      // At the edge of what's loaded: ask Pixiv for more in that direction.
      const session = this.session;
      const towardsNewer = (prefs.order === "asc") === direction > 0;
      this.reaching = true;
      this.toast(towardsNewer ? "Checking for new works…" : "Loading earlier works…");
      try {
        const work = await timeline.reach(prefs.order, direction);
        if (session !== this.session) return;
        if (work) {
          this.hideToast();
          this.visit(work, direction);
        } else {
          this.toast(towardsNewer ? "You're all caught up." : "That's as far back as Pixiv's feed goes.");
        }
      } catch (error) {
        if (session === this.session) this.toast(this.describe(error));
      } finally {
        if (session === this.session) this.reaching = false;
      }
    }

    visit(work, direction = 1) {
      const { timeline, prefs } = this;
      const hadUnseen = timeline.unseenCount > 0;
      const wasSeen = timeline.visit(work);
      this.page = 0;
      this.pages = null;
      this.showWork(work);
      this.updateCount();
      this.scheduleSave();

      if (prefs.order === "desc") {
        if (wasSeen && direction > 0 && !hadUnseen && this.caughtUpIn !== this.session) {
          this.caughtUpIn = this.session;
          this.toast("You've seen everything from here back.");
        }
        // Keep earlier works loaded ahead of the reader.
        if (timeline.index < 5 && !timeline.reachedEnd) {
          timeline.loadOlder().then(() => this.updateCount(), () => {});
        }
      }
    }

    movePage(delta) {
      const work = this.timeline?.current;
      if (!work || work.isUgoira) return;
      const page = this.page + delta;
      if (page < 0 || page >= work.pageCount) return;
      this.goToPage(page);
    }

    goToPage(page) {
      if (page === this.page) return;
      this.page = page;
      this.showImage(this.timeline.current);
      this.updateStrip();
    }

    onKey(event) {
      if (event.ctrlKey || event.altKey || event.metaKey) return;
      // The dialog's own cancel event can't be refused until the page has been clicked.
      if (event.key === "Escape" && !this.ui.panel.hidden) {
        event.preventDefault();
        this.closePanel();
        return;
      }
      const target = event.composedPath()[0];
      if (target instanceof HTMLSelectElement || target instanceof HTMLInputElement) return;
      const onControl = target instanceof HTMLButtonElement || target instanceof HTMLAnchorElement;
      if (onControl && (event.key === " " || event.key === "Enter")) return;

      const actions = {
        ArrowRight: () => this.step(1),
        d: () => this.step(1),
        ArrowLeft: () => this.step(-1),
        a: () => this.step(-1),
        " ": () => this.step(event.shiftKey ? -1 : 1),
        ArrowDown: () => this.movePage(1),
        s: () => this.movePage(1),
        ArrowUp: () => this.movePage(-1),
        w: () => this.movePage(-1),
        h: () => this.setPref("hd", !this.prefs.hd),
        o: () => this.timeline?.current && this.ui.title.click(),
        l: () => event.repeat || this.like(),
        b: () => event.repeat || this.toggleBookmark(),
        i: () => event.repeat || this.openImage(),
      };
      const action = actions[event.key.length === 1 ? event.key.toLowerCase() : event.key];
      if (!action) return;
      event.preventDefault();
      event.stopPropagation();
      action();
    }

    onWheel(event) {
      event.preventDefault();
      if (Math.abs(event.deltaY) < 1 || event.timeStamp - this.lastWheelAt < WHEEL_COOLDOWN) return;
      this.lastWheelAt = event.timeStamp;
      this.movePage(event.deltaY > 0 ? 1 : -1);
    }

    // ---- showing a work ----

    showWork(work) {
      const { ui } = this;
      const workUrl = `https://www.pixiv.net/artworks/${work.id}`;
      const userUrl = `https://www.pixiv.net/users/${work.userId}`;
      ui.title.href = workUrl;
      ui.title.textContent = work.title;
      ui.title.title = `${work.title} (open on Pixiv: O)`;
      ui.artist.href = ui.avatarLink.href = userUrl;
      ui.artist.textContent = work.userName;
      if (work.avatar) ui.avatar.src = work.avatar;
      else ui.avatar.removeAttribute("src");
      ui.date.dateTime = work.date.toISOString();
      ui.date.textContent = dateFormat.format(work.date);

      const badges = [];
      if (work.xRestrict === 1) badges.push("R-18");
      if (work.xRestrict === 2) badges.push("R-18G");
      if (work.isAi) badges.push("AI");
      if (work.isUgoira) badges.push("Animation");
      ui.badges.replaceChildren(...badges.map((b) => el("span", { class: "badge" }, b)));

      this.removing = null;
      this.updateReactions();

      const multi = !work.isUgoira && work.pageCount > 1;
      ui.footer.hidden = !multi;
      ui.strip.replaceChildren();
      if (multi) this.updateStrip();

      this.showImage(work);
    }

    async showImage(work) {
      const token = ++this.shown;
      const isCurrent = () => token === this.shown;
      const { ui, page } = this;

      this.playing?.abort();
      this.hideWorkError();
      this.setImageLink(null);
      for (const art of [ui.image, ui.canvas]) art.classList.remove("ready");
      ui.image.removeAttribute("src");
      ui.stage.classList.add("loading");
      const known = this.pages?.[page] ?? work;
      ui.frame.style.setProperty("--ratio", known.width / known.height);
      const thumb = this.pages?.[page]?.mini ?? (page === 0 ? work.thumb : "");
      if (thumb) ui.placeholder.src = thumb;
      else ui.placeholder.removeAttribute("src");

      // While someone is skimming, only fetch once they pause on a work.
      const now = performance.now();
      const skimming = now - this.lastShowAt < SKIM_DELAY * 2;
      this.lastShowAt = now;
      if (skimming) {
        await sleep(SKIM_DELAY);
        if (!isCurrent()) return;
      }

      // Only to show what's already liked; liking works without the answer.
      this.reactions.check(work).catch(() => {});

      try {
        if (work.isUgoira) await this.showUgoira(work, isCurrent);
        else await this.showStill(work, page, isCurrent);
        if (isCurrent()) this.preload();
      } catch (error) {
        if (isCurrent()) this.showWorkError(this.describe(error));
      } finally {
        if (isCurrent()) ui.stage.classList.remove("loading");
      }
    }

    async showStill(work, page, isCurrent) {
      const { ui } = this;
      const pages = await FV.getPages(work.id);
      if (!isCurrent()) return;
      if (!this.pages) {
        this.pages = pages;
        this.fillStrip(work);
      }
      const data = pages[page] ?? pages[0];
      ui.frame.style.setProperty("--ratio", data.width / data.height);
      ui.image.alt = work.pageCount > 1 ? `${work.title}, page ${page + 1}` : work.title;
      ui.image.src = this.imageUrl(data);
      this.setImageLink(data.original || data.regular); // full size, whatever is on screen
      try {
        await ui.image.decode();
      } catch {
        if (isCurrent()) throw new PixivError("other", "This image didn't load.");
      }
      if (isCurrent()) ui.image.classList.add("ready");
    }

    async showUgoira(work, isCurrent) {
      const { ui } = this;
      const frames = await FV.loadFrames(await FV.getUgoira(work.id), this.prefs.hd);
      if (!isCurrent()) return;
      const playing = (this.playing = new AbortController());
      await new Promise((resolve, reject) => {
        FV.play(ui.canvas, frames, playing.signal, () => {
          if (isCurrent()) ui.canvas.classList.add("ready");
          resolve();
        }).then(resolve, () => {
          const error = new PixivError("other", "This animation couldn't be played.");
          reject(error);
          if (isCurrent()) this.showWorkError(error.message);
        });
      });
    }

    imageUrl(page) {
      return this.prefs.hd ? page.original : page.regular;
    }

    /** Warm up the neighbours so a click shows the next picture straight away. */
    async preload() {
      const { timeline, prefs } = this;
      const token = this.shown;
      const wanted = [];
      for (let n = 1; n <= PRELOAD_AHEAD; n++) wanted.push(timeline.peek(prefs.order, n));
      wanted.push(timeline.peek(prefs.order, -1));

      const nextPage = this.pages?.[this.page + 1];
      if (nextPage) this.preloadImage(this.imageUrl(nextPage));

      for (const work of wanted) {
        if (!work) continue;
        if (token !== this.shown) return;
        try {
          if (work.isUgoira) {
            const meta = await FV.getUgoira(work.id);
            if (token === this.shown && work === wanted[0]) await FV.loadFrames(meta, prefs.hd);
          } else {
            const pages = await FV.getPages(work.id);
            this.preloadImage(this.imageUrl(pages[0]));
          }
        } catch {
          // Reported if and when the reader gets there.
        }
      }
    }

    preloadImage(url) {
      if (this.preloads.has(url)) return;
      const image = new Image();
      image.src = url;
      this.preloads.set(url, image);
      if (this.preloads.size > 12) this.preloads.delete(this.preloads.keys().next().value);
    }

    // ---- opening the image ----

    /** Point the link at an image file, or hide it when there isn't one. */
    setImageLink(url) {
      const { openImage } = this.ui;
      if (url) openImage.href = url;
      else openImage.removeAttribute("href");
      openImage.hidden = !url;
    }

    /**
     * Open the image as Firefox's own "open in new tab" would: in the
     * background or not, as the reader has set Firefox to do. A Ctrl+click on the link
     * is how a page can ask for that, and Firefox allows it right after a click or key.
     */
    openImage() {
      const { openImage } = this.ui;
      if (openImage.href) {
        openImage.dispatchEvent(new MouseEvent("click", { bubbles: true, cancelable: true, composed: true, ctrlKey: true }));
      } else if (this.reactable?.isUgoira) {
        this.toast("Animations aren't a single image. Press O to open the work on Pixiv.");
      } else if (this.reactable) {
        this.toast("Still loading this image.");
      }
    }

    onOpenImageClick(event) {
      if (event.ctrlKey || event.shiftKey || event.altKey || event.metaKey) return;
      event.preventDefault();
      this.openImage();
    }

    // ---- likes and bookmarks ----

    /** The work on screen, unless a message is covering it. */
    get reactable() {
      return this.ui.notice.hidden ? this.timeline?.current ?? null : null;
    }

    async like() {
      const work = this.reactable;
      if (!work) return;
      if (this.reactions.view(work).liked) {
        this.toast("Already liked. Pixiv doesn't let you undo a like.");
        return;
      }
      try {
        await this.reactions.like(work);
      } catch (error) {
        this.toast(`Couldn't like "${work.title}". ${this.describe(error)}`);
      }
    }

    async toggleBookmark() {
      const work = this.reactable;
      if (!work) return;
      // Removing also discards the bookmark's tags, so it takes a second press.
      if (this.reactions.view(work).bookmarked && this.removing !== work) {
        this.removing = work;
        this.toast("Press again to remove this bookmark.");
        clearTimeout(this.removingTimer);
        this.removingTimer = setTimeout(() => { this.removing = null; }, CONFIRM_WITHIN);
        return;
      }
      this.removing = null;
      this.hideToast();
      try {
        await this.reactions.toggleBookmark(work);
      } catch (error) {
        this.toast(`Couldn't change the bookmark for "${work.title}". ${this.describe(error)}`);
      }
    }

    updateReactions() {
      const { ui, timeline, reactions } = this;
      const { liked, bookmarked } = reactions.view(timeline.current);
      ui.like.setAttribute("aria-pressed", String(liked));
      ui.like.title = liked ? "Liked" : "Like (L). Pixiv doesn't let you undo likes.";
      ui.bookmark.setAttribute("aria-pressed", String(bookmarked));
      ui.bookmark.title = bookmarked ? "Remove bookmark (B)" : "Bookmark (B)";
    }

    // ---- page strip ----

    fillStrip(work) {
      if (work.isUgoira || this.pages.length < 2) return;
      this.ui.strip.replaceChildren(...this.pages.map((p, i) =>
        el("button", { type: "button", "aria-label": `Page ${i + 1}`, onclick: () => this.goToPage(i) },
          el("img", { src: p.mini, alt: "", loading: "lazy" }))));
      this.updateStrip();
    }

    updateStrip() {
      const { ui } = this;
      const total = this.pages?.length ?? this.timeline.current.pageCount;
      ui.pageLabel.textContent = `Page ${this.page + 1} of ${total}`;
      [...ui.strip.children].forEach((button, i) => {
        button.setAttribute("aria-current", String(i === this.page));
        if (i === this.page) button.scrollIntoView({ block: "nearest", inline: "nearest" });
      });
    }

    // ---- settings ----

    async setPref(name, value) {
      this.prefs[name] = value;
      this.syncControls();
      this.ui.dialog.focus();
      this.store(() => ({ prefs: this.prefs }));
      if (name === "hd") {
        if (this.timeline?.current) this.showImage(this.timeline.current);
        return;
      }
      if (name === "mode") this.save();
      await this.restart();
    }

    syncControls() {
      const { ui, prefs } = this;
      ui.order.value = prefs.order;
      ui.mode.value = prefs.mode;
      ui.hd.setAttribute("aria-pressed", String(prefs.hd));
    }

    markAllSeen() {
      const { ui, timeline } = this;
      if (!timeline?.newest) return;
      if (ui.markAll.dataset.armed) {
        this.disarmMarkAll();
        timeline.markAllSeen();
        this.updateCount();
        this.save();
        this.toast("Marked everything as seen.");
        ui.dialog.focus();
      } else {
        ui.markAll.dataset.armed = "1";
        ui.markAll.textContent = "Click again to confirm";
        this.disarmTimer = setTimeout(() => this.disarmMarkAll(), 3000);
      }
    }

    disarmMarkAll() {
      clearTimeout(this.disarmTimer);
      delete this.ui.markAll.dataset.armed;
      this.ui.markAll.textContent = "Mark all seen";
    }

    updateCount() {
      const { timeline } = this;
      if (!timeline?.current) return;
      const n = timeline.unseenCount;
      this.ui.count.textContent = n || !timeline.connected ? `${n}${timeline.connected ? "" : "+"} unseen` : "All seen";
    }

    // ---- saving ----

    /**
     * Save right away, then at most every SAVE_INTERVAL while someone is skimming.
     * Saving on page unload isn't an option: Firefox drops storage calls made then.
     */
    scheduleSave() {
      const wait = this.lastSaveAt + SAVE_INTERVAL - performance.now();
      if (wait <= 0) this.save();
      else this.saveTimer ||= setTimeout(() => this.save(), wait);
    }

    async save() {
      clearTimeout(this.saveTimer);
      this.saveTimer = 0;
      this.lastSaveAt = performance.now();
      const { timeline } = this;
      if (!timeline || timeline.progress.floor === null) return;
      const key = progressKey(timeline.mode);
      await this.store(async () => {
        // Merge first, so two open viewers add to each other's progress.
        timeline.progress.merge((await browser.storage.local.get(key))[key]);
        return { [key]: timeline.progress.toJSON() };
      });
    }

    async store(getValues) {
      try {
        await browser.storage.local.set(await getValues());
      } catch (error) {
        // Most likely the extension was updated or removed under this page.
        console.error("[Following Viewer]", error);
        this.toast("Couldn't save your place. Reload the page if this keeps happening.");
      }
    }

    // ---- messages ----

    describe(error) {
      if (error instanceof PixivError) return error.message;
      console.error("[Following Viewer]", error);
      return "Something went wrong in the viewer.";
    }

    fail(error, options) {
      this.notify(this.describe(error), {
        retry: "Try again",
        onRetry: () => this.restart(options),
        signIn: error instanceof PixivError && error.kind === "auth",
      });
    }

    notify(message, { retry = "", onRetry = () => this.restart(), signIn = false } = {}) {
      const { ui } = this;
      const buttons = el("div");
      if (signIn) buttons.append(el("a", { href: "https://www.pixiv.net/login.php" }, "Sign in to Pixiv"));
      if (retry) buttons.append(el("button", { type: "button", onclick: onRetry }, retry));
      ui.notice.className = "notice";
      ui.notice.replaceChildren(el("p", {}, message), buttons);
      ui.notice.hidden = false;
      ui.work.style.visibility = "hidden";
      ui.footer.hidden = true;
      ui.count.textContent = "";
      this.setImageLink(null);
    }

    hideNotice() {
      this.ui.notice.hidden = true;
      this.ui.work.style.visibility = "";
    }

    /** A problem with one work: say so, but leave the arrows working. */
    showWorkError(message) {
      const { ui } = this;
      ui.stage.classList.remove("loading");
      ui.notice.className = "notice work-error";
      ui.notice.replaceChildren(el("p", {}, message));
      ui.notice.hidden = false;
    }

    hideWorkError() {
      if (this.ui.notice.classList.contains("work-error")) this.ui.notice.hidden = true;
    }

    toast(message) {
      const { toast } = this.ui;
      clearTimeout(this.toastTimer);
      toast.textContent = message;
      toast.classList.add("show");
      this.toastTimer = setTimeout(() => this.hideToast(), 2600);
    }

    hideToast() {
      this.ui.toast.classList.remove("show");
    }
  }

  FV.Viewer = Viewer;
})();
