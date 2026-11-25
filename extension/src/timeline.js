"use strict";

// Feed ordering and "what have I already seen" logic. No DOM or network here, so
// tests/timeline.test.js can run it under plain Node.
(() => {
  const MAX_SEEN = 5000;

  /**
   * Seen state: everything with id <= floor counts as seen, plus a set of ids
   * above it. Pixiv ids grow with posting date, so the floor is also a date.
   */
  class Progress {
    constructor(saved) {
      this.epoch = Number.isFinite(saved?.epoch) ? saved.epoch : 0; // when it was last started over
      this.floor = Number.isFinite(saved?.floor) ? saved.floor : null;
      this.seen = new Set(Array.isArray(saved?.seen) ? saved.seen : []);
    }

    isSeen(id) {
      return (this.floor !== null && id <= this.floor) || this.seen.has(id);
    }

    mark(id) {
      if (this.isSeen(id)) return;
      this.seen.add(id);
      if (this.seen.size > MAX_SEEN) this.raiseFloor(Math.min(...this.seen));
    }

    raiseFloor(id) {
      if (this.floor === null || id > this.floor) this.floor = id;
      for (const s of this.seen) if (s <= this.floor) this.seen.delete(s);
    }

    /** Move the floor up through an unbroken run of seen works (oldest first). */
    compact(works) {
      let floor = this.floor;
      for (const work of works) {
        if (!this.isSeen(work.id)) break;
        if (floor === null || work.id > floor) floor = work.id;
      }
      if (floor !== null) this.raiseFloor(floor);
    }

    /** Take in progress saved elsewhere, such as by a viewer in another tab. */
    merge(saved) {
      const other = new Progress(saved);
      if (other.epoch < this.epoch) return; // from before this list was started over
      if (other.epoch > this.epoch) {
        Object.assign(this, { epoch: other.epoch, floor: other.floor, seen: other.seen });
        return;
      }
      for (const id of other.seen) this.mark(id);
      if (other.floor !== null) this.raiseFloor(other.floor);
    }

    /** Forget what was seen: every work above `floor` becomes unseen. */
    startOver(floor) {
      this.epoch = Math.max(Date.now(), this.epoch + 1);
      this.floor = floor;
      this.seen.clear();
    }

    toJSON() {
      return { epoch: this.epoch, floor: this.floor, seen: [...this.seen] };
    }
  }

  /** The followed-artists feed, held oldest to newest. */
  class Timeline {
    #olderInFlight = null;
    #newerInFlight = null;

    /**
     * @param fetchPage (n) => Promise<{works, isLastPage}>; page 1 is the newest.
     * @param baseline how many of the latest works count as unseen on a fresh start
     */
    constructor({ fetchPage, progress, baseline = 60, maxPages = 40 }) {
      this.fetchPage = fetchPage;
      this.progress = progress;
      this.baseline = baseline;
      this.maxPages = maxPages;
      this.works = [];
      this.byId = new Map();
      this.current = null;
      this.nextPage = 1;
      this.reachedEnd = false;
    }

    get index() {
      return this.current ? this.works.indexOf(this.current) : -1;
    }

    get newest() {
      return this.works[this.works.length - 1] ?? null;
    }

    /** True when no unloaded work can sit between the floor and what is loaded. */
    get connected() {
      if (this.reachedEnd) return true;
      if (!this.works.length || this.progress.floor === null) return false;
      return this.works[0].id <= this.progress.floor + 1;
    }

    get unseenCount() {
      let n = 0;
      for (const work of this.works) if (!this.progress.isSeen(work.id)) n++;
      return n;
    }

    #merge(works) {
      let added = 0;
      for (const work of works) {
        if (this.byId.has(work.id)) continue;
        this.byId.set(work.id, work);
        this.works.push(work);
        added++;
      }
      if (added) this.works.sort((a, b) => a.id - b.id);
      return added;
    }

    loadOlder() {
      this.#olderInFlight ??= this.#loadOlder().finally(() => {
        this.#olderInFlight = null;
      });
      return this.#olderInFlight;
    }

    async #loadOlder() {
      // A page can hold nothing new (hidden works, or posts shifting between
      // pages), so keep going a little before giving up on this attempt.
      let added = 0;
      for (let tries = 0; tries < 5 && !added && !this.reachedEnd; tries++) {
        const page = await this.fetchPage(this.nextPage);
        this.nextPage++;
        if (page.isLastPage) this.reachedEnd = true;
        added += this.#merge(page.works);
      }
      return added;
    }

    loadNewer() {
      this.#newerInFlight ??= this.#loadNewer().finally(() => {
        this.#newerInFlight = null;
      });
      return this.#newerInFlight;
    }

    async #loadNewer() {
      if (!this.works.length) return this.loadOlder();
      const newestBefore = this.newest.id;
      const found = [];
      for (let n = 1; n <= this.maxPages; n++) {
        const page = await this.fetchPage(n);
        found.push(...page.works);
        const oldest = page.works.length ? Math.min(...page.works.map((w) => w.id)) : Infinity;
        if (page.isLastPage || oldest <= newestBefore) break;
      }
      return this.#merge(found);
    }

    /**
     * Pick the starting work for a reading order. Returns it, or null if the feed is
     * empty or isCurrent() says the answer is no longer wanted. With startOver, the
     * seen list is replaced, but only once everything needed has loaded.
     */
    async start(order, { startOver = false, onLoad = () => {}, isCurrent = () => true } = {}) {
      if (this.works.length) await this.loadNewer();
      else await this.loadOlder();
      if (!this.works.length) return null;

      // Fresh start: the latest works count as unseen and everything before them as seen.
      if (startOver || this.progress.floor === null) {
        for (let n = 1; n < this.maxPages && this.works.length < this.baseline && !this.reachedEnd; n++) {
          onLoad(this.works.length);
          await this.loadOlder();
        }
        if (!isCurrent()) return null;
        const oldestUnseen = this.works[Math.max(0, this.works.length - this.baseline)];
        if (startOver) this.progress.startOver(oldestUnseen.id - 1);
        else this.progress.raiseFloor(oldestUnseen.id - 1);
      }

      if (order === "desc") {
        this.current = this.newest;
        return this.current;
      }
      for (let n = 1; n < this.maxPages && !this.connected; n++) {
        onLoad(this.works.length);
        await this.loadOlder();
      }
      this.current = this.works.find((w) => !this.progress.isSeen(w.id)) ?? this.newest;
      return this.current;
    }

    /** The work `steps` away in reading order, or null if it is not loaded. */
    peek(order, steps) {
      const direction = order === "asc" ? 1 : -1;
      return this.works[this.index + steps * direction] ?? null;
    }

    /** Like peek(±1), but loads more of the feed when at an edge. */
    async reach(order, step) {
      const ready = this.peek(order, step);
      if (ready) return ready;
      const towardsNewer = (order === "asc") === step > 0;
      if (towardsNewer) await this.loadNewer();
      else await this.loadOlder();
      return this.peek(order, step);
    }

    /** Make a work current and record it as seen. Returns whether it was seen before. */
    visit(work) {
      const wasSeen = this.progress.isSeen(work.id);
      this.current = work;
      this.progress.mark(work.id);
      if (this.connected) this.progress.compact(this.works);
      return wasSeen;
    }

    markAllSeen() {
      if (this.newest) this.progress.raiseFloor(this.newest.id);
    }
  }

  Object.assign((globalThis.FollowingViewer ??= {}), { Progress, Timeline });
})();
