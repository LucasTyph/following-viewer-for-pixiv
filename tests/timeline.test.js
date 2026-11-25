"use strict";

// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");
require("../extension/src/timeline.js");
const { Timeline, Progress } = globalThis.FollowingViewer;

/** A fake feed. `ids` is newest first and can be changed while tests run. */
function feed(ids, { size = 3, baseline = size, saved } = {}) {
  const calls = [];
  const state = { ids: [...ids], calls };
  state.progress = new Progress(saved);
  state.timeline = new Timeline({
    progress: state.progress,
    baseline,
    fetchPage: async (n) => {
      calls.push(n);
      const slice = state.ids.slice((n - 1) * size, n * size);
      return { works: slice.map((id) => ({ id })), isLastPage: n * size >= state.ids.length };
    },
  });
  return state;
}
const range = (from, to) => Array.from({ length: from - to + 1 }, (_, i) => from - i);
const order = (timeline) => timeline.works.map((w) => w.id);

async function walk(timeline, reading, steps, direction = 1) {
  const path = [];
  for (let i = 0; i < steps; i++) {
    const work = await timeline.reach(reading, direction);
    if (!work) break;
    timeline.visit(work);
    path.push(work.id);
  }
  return path;
}

test("first run, oldest first: starts at the oldest of the latest works and moves forward in time", async () => {
  const { timeline, calls } = feed(range(10, 1));
  const first = await timeline.start("asc");
  timeline.visit(first);
  assert.equal(first.id, 8);
  assert.deepEqual(await walk(timeline, "asc", 5), [9, 10]);
  assert.equal(timeline.unseenCount, 0);
  assert.equal(calls[0], 1);
});

test("newest first walks back through every page without gaps or repeats", async () => {
  const { timeline } = feed(range(10, 1));
  timeline.visit(await timeline.start("desc"));
  assert.deepEqual(await walk(timeline, "desc", 50), range(9, 1));
  assert.equal(timeline.reachedEnd, true);
});

test("previous undoes next exactly, in both orders", async () => {
  for (const reading of ["asc", "desc"]) {
    const { timeline } = feed(range(30, 1), { size: 10 });
    timeline.visit(await timeline.start(reading));
    const start = timeline.current.id;
    const there = await walk(timeline, reading, 5);
    const back = await walk(timeline, reading, 5, -1);
    assert.deepEqual(back, [...there.slice(0, -1).reverse(), start]);
  }
});

test("previous at the oldest loaded work loads earlier pages", async () => {
  const { timeline } = feed(range(10, 1));
  timeline.visit(await timeline.start("asc"));
  assert.deepEqual(await walk(timeline, "asc", 4, -1), [7, 6, 5, 4]);
});

test("oldest first resumes at the first unseen work, loading as many pages as needed", async () => {
  const { timeline } = feed(range(20, 1), { saved: { floor: 5, seen: [] } });
  assert.equal((await timeline.start("asc")).id, 6);
  assert.equal(timeline.connected, true);
});

test("works skipped over stay unseen and become the next resume point", async () => {
  const a = feed(range(9, 1), { size: 9, saved: { floor: 3, seen: [] } });
  await a.timeline.start("asc");
  for (const id of [4, 5, 8]) a.timeline.visit(a.timeline.byId.get(id));
  assert.deepEqual(a.progress.toJSON(), { epoch: 0, floor: 5, seen: [8] });

  const b = feed(range(9, 1), { size: 9, saved: a.progress.toJSON() });
  assert.equal((await b.timeline.start("asc")).id, 6);
  assert.equal(b.timeline.unseenCount, 3);
});

test("the floor never jumps over works that haven't been loaded", async () => {
  const { timeline, progress } = feed(range(20, 1), { saved: { floor: 2, seen: [] } });
  timeline.visit(await timeline.start("desc"));
  await walk(timeline, "desc", 4);
  assert.equal(progress.floor, 2);
  await walk(timeline, "desc", 50);
  assert.equal(progress.floor, 20);
  assert.equal(progress.seen.size, 0);
});

test("new posts appear at the newest edge, even more than one page of them", async () => {
  const s = feed(range(10, 1));
  s.timeline.visit(await s.timeline.start("asc"));
  await walk(s.timeline, "asc", 5);
  assert.equal(s.timeline.current.id, 10);
  s.ids = range(18, 1);
  assert.deepEqual(await walk(s.timeline, "asc", 50), [11, 12, 13, 14, 15, 16, 17, 18]);
  assert.deepEqual(order(s.timeline), [...order(s.timeline)].sort((x, y) => x - y));
});

test("posts arriving mid-session shift pages without dropping or repeating works", async () => {
  const s = feed(range(12, 1));
  s.timeline.visit(await s.timeline.start("desc"));
  s.ids = range(14, 1);
  const seen = await walk(s.timeline, "desc", 50);
  assert.deepEqual(seen, range(11, 1));
});

test("an empty feed and a feed of only hidden works both end cleanly", async () => {
  assert.equal(await feed([]).timeline.start("asc"), null);
  const hidden = new Timeline({ progress: new Progress(), fetchPage: async (n) => ({ works: [], isLastPage: n === 3 }) });
  assert.equal(await hidden.start("asc"), null);
});

test("simultaneous loads share one request", async () => {
  const s = feed(range(10, 1));
  await Promise.all([s.timeline.loadOlder(), s.timeline.loadOlder()]);
  assert.deepEqual(s.calls, [1]);
});

test("a failed load can be retried and does not skip a page", async () => {
  const s = feed(range(10, 1));
  const real = s.timeline.fetchPage;
  let failures = 1;
  s.timeline.fetchPage = async (n) => {
    if (n === 2 && failures-- > 0) throw new Error("offline");
    return real(n);
  };
  s.timeline.visit(await s.timeline.start("desc"));
  await walk(s.timeline, "desc", 2);
  await assert.rejects(s.timeline.reach("desc", 1), /offline/);
  assert.deepEqual(await walk(s.timeline, "desc", 50), range(7, 1));
});

test("mark all seen raises the floor to the newest work", async () => {
  const { timeline, progress } = feed(range(10, 1), { saved: { floor: 1, seen: [7] } });
  await timeline.start("asc");
  timeline.markAllSeen();
  assert.deepEqual(progress.toJSON(), { epoch: 0, floor: 10, seen: [] });
});

test("starting again on a loaded timeline picks up posts made since", async () => {
  for (const [reading, expected] of [["asc", 11], ["desc", 12]]) {
    const s = feed(range(10, 1));
    s.timeline.visit(await s.timeline.start("asc"));
    await walk(s.timeline, "asc", 50);
    s.ids = range(12, 1);
    assert.equal((await s.timeline.start(reading)).id, expected);
  }
});

test("merging progress from another tab keeps the furthest of both", () => {
  const p = new Progress({ floor: 10, seen: [14] });
  p.merge({ floor: 12, seen: [13, 20] });
  p.merge(undefined);
  assert.equal(p.floor, 12);
  assert.deepEqual([...p.seen].sort((a, b) => a - b), [13, 14, 20]);
});
