"use strict";

// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
require("../extension/src/timeline.js");
const { Timeline, Progress } = globalThis.FollowingViewer;

const range = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => from - i);

/** A feed of `total` works, ids total..1, `size` to a page, with some hidden. */
function feed(total, { size = 60, baseline, saved, hidden = [], fail = () => false } = {}) {
  const state = { total, calls: 0 };
  state.progress = new Progress(saved);
  state.timeline = new Timeline({
    progress: state.progress,
    baseline,
    fetchPage: async (n) => {
      state.calls++;
      if (fail(n)) throw new Error("offline");
      const ids = range(state.total, 1).slice((n - 1) * size, n * size);
      return { works: ids.filter((id) => !hidden.includes(id)).map((id) => ({ id })), isLastPage: n * size >= state.total };
    },
  });
  return state;
}
const unseen = (t) => t.works.filter((w) => !t.progress.isSeen(w.id)).map((w) => w.id);

test("without a choice, exactly the latest 60 are unseen, even when some are hidden", async () => {
  const s = feed(300, { hidden: [250, 260] });
  assert.equal((await s.timeline.start("asc")).id, 239);
  assert.equal(s.timeline.unseenCount, 60);
  assert.equal(s.calls, 2);
});

test("a chosen number loads as many pages as it needs, and no more", async () => {
  for (const [count, first, calls] of [[1, 300, 1], [60, 241, 1], [61, 240, 2], [150, 151, 3]]) {
    const s = feed(300, { baseline: count });
    assert.equal((await s.timeline.start("asc")).id, first);
    assert.equal(s.timeline.unseenCount, count);
    assert.equal(s.calls, calls);
  }
});

test("asking for more than the feed has makes all of it unseen", async () => {
  const s = feed(100, { baseline: 2000 });
  assert.equal((await s.timeline.start("asc")).id, 1);
  assert.equal(s.timeline.unseenCount, 100);
});

test("starting over brings back works that were seen", async () => {
  const s = feed(300);
  s.timeline.visit(await s.timeline.start("asc"));
  s.timeline.markAllSeen();
  assert.equal(s.timeline.unseenCount, 0);

  s.timeline.baseline = 90;
  assert.equal((await s.timeline.start("asc", { startOver: true })).id, 211);
  assert.deepEqual(unseen(s.timeline), range(300, 211).reverse());
});

test("starting over with a smaller number marks the rest seen", async () => {
  const s = feed(300, { baseline: 120 });
  await s.timeline.start("asc");
  s.timeline.baseline = 5;
  assert.equal((await s.timeline.start("asc", { startOver: true })).id, 296);
  assert.equal(s.timeline.unseenCount, 5);
});

test("starting over counts from posts made since the feed was loaded", async () => {
  const s = feed(300, { baseline: 10 });
  await s.timeline.start("asc");
  s.total = 304;
  await s.timeline.start("desc", { startOver: true });
  assert.deepEqual(unseen(s.timeline), range(304, 295).reverse());
});

test("newest first starts over at the newest", async () => {
  const s = feed(300, { baseline: 70 });
  assert.equal((await s.timeline.start("desc", { startOver: true })).id, 300);
  assert.equal(s.timeline.unseenCount, 70);
});

test("if loading fails, the old list is kept and starting over can be retried", async () => {
  let broken = true;
  const s = feed(300, { baseline: 100, saved: { floor: 290, seen: [295] }, fail: (n) => broken && n === 2 });
  await assert.rejects(s.timeline.start("asc", { startOver: true }), /offline/);
  assert.deepEqual(s.progress.toJSON(), { epoch: 0, floor: 290, seen: [295] });
  broken = false;
  assert.equal((await s.timeline.start("asc", { startOver: true })).id, 201);
});

test("if it's no longer wanted by the time it loads, the old list is kept", async () => {
  const s = feed(300, { baseline: 100, saved: { floor: 290, seen: [] } });
  assert.equal(await s.timeline.start("asc", { startOver: true, isCurrent: () => false }), null);
  assert.equal(s.progress.floor, 290);
});

test("an ordinary start never touches an existing list, whatever the number", async () => {
  const s = feed(300, { baseline: 200, saved: { floor: 290, seen: [] } });
  assert.equal((await s.timeline.start("asc")).id, 291);
});

test("a viewer in another tab can't bring the old list back", () => {
  const fresh = new Progress({ epoch: 0, floor: 100, seen: [] });
  const oldTab = new Progress({ epoch: 0, floor: 100, seen: [105] });
  fresh.startOver(50);
  fresh.merge(oldTab.toJSON());
  assert.equal(fresh.floor, 50);
  assert.equal(fresh.isSeen(105), false);

  oldTab.merge(fresh.toJSON());
  assert.deepEqual(oldTab.toJSON(), fresh.toJSON());
  fresh.mark(60);
  oldTab.mark(61);
  oldTab.merge(fresh.toJSON());
  assert.deepEqual([...oldTab.seen].sort(), [60, 61]);
});

test("starting over twice in the same instant still counts as newer", () => {
  const p = new Progress({ epoch: Date.now() + 60_000, floor: 1, seen: [] });
  const before = p.epoch;
  p.startOver(5);
  assert.ok(p.epoch > before);
});
