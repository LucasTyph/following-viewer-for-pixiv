"use strict";

// Likes and bookmarks for the works being viewed. No DOM here, so
// tests/reactions.test.js can run it under plain Node.
(() => {
  class Reactions {
    #states = new Map();

    /**
     * @param api { getDetails, like, addBookmark, removeBookmark }
     * @param onChange (work) => void, called whenever what to show may have changed
     */
    constructor(api, onChange) {
      this.api = api;
      this.onChange = onChange;
    }

    #of(work) {
      let state = this.#states.get(work.id);
      if (!state) {
        state = {
          // What Pixiv has, as far as we know.
          liked: false,
          bookmarkId: work.bookmarkId ?? null,
          // What the reader asked for and we haven't heard back about.
          liking: false,
          bookmarking: null, // true: adding, false: removing
          bookmarkVersion: 0,
          check: null,
        };
        this.#states.set(work.id, state);
      }
      return state;
    }

    /** What to show right now, counting requests still on their way. */
    view(work) {
      const s = this.#of(work);
      return { liked: s.liked || s.liking, bookmarked: s.bookmarking ?? s.bookmarkId !== null };
    }

    /** Ask Pixiv, once per work, what the reader has already done with it. */
    check(work) {
      const s = this.#of(work);
      const version = s.bookmarkVersion;
      s.check ??= this.api.getDetails(work.id).then(
        (details) => {
          // Likes can't be undone, so an older "not liked" answer never wins. A
          // bookmark answer from before the reader changed it is out of date.
          s.liked ||= details.liked;
          if (version === s.bookmarkVersion) s.bookmarkId = details.bookmarkId;
          this.onChange(work);
        },
        (error) => {
          s.check = null;
          throw error;
        },
      );
      return s.check;
    }

    /** Resolves true if a like was sent, false if there was nothing to do. */
    async like(work) {
      const s = this.#of(work);
      if (s.liked || s.liking) return false;
      s.liking = true;
      this.onChange(work);
      try {
        await this.api.like(work.id);
        s.liked = true;
        return true;
      } finally {
        s.liking = false;
        this.onChange(work);
      }
    }

    async toggleBookmark(work) {
      const s = this.#of(work);
      if (s.bookmarking !== null) return;
      const want = !this.view(work).bookmarked;
      s.bookmarking = want;
      s.bookmarkVersion++;
      this.onChange(work);
      try {
        // It may have been bookmarked or removed elsewhere since the feed loaded.
        // Adding over an existing bookmark would wipe its tags, so look first.
        const now = await this.api.getDetails(work.id);
        s.liked ||= now.liked;
        s.bookmarkId = now.bookmarkId;
        if (want && s.bookmarkId === null) {
          s.bookmarkId =
            (await this.api.addBookmark(work.id)) ?? (await this.api.getDetails(work.id)).bookmarkId;
        } else if (!want && s.bookmarkId !== null) {
          await this.api.removeBookmark(s.bookmarkId);
          s.bookmarkId = null;
        }
      } finally {
        s.bookmarking = null;
        this.onChange(work);
      }
    }
  }

  (globalThis.FollowingViewer ??= {}).Reactions = Reactions;
})();
