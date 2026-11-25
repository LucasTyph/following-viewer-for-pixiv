"use strict";

// Run with: node --test tests/
const test = require("node:test");
const assert = require("node:assert/strict");

// api.js expects a pixiv.net page around it; give it just enough of one.
const nextData = (token) =>
  JSON.stringify({ props: { pageProps: { serverSerializedPreloadedState: JSON.stringify({ api: { token } }) } } });
const pageWith = (token) => ({ getElementById: () => (token ? { textContent: nextData(token) } : null) });
globalThis.location = { origin: "https://www.pixiv.net" };
globalThis.document = pageWith("page-token");
globalThis.DOMParser = class {
  parseFromString(html) {
    return pageWith(html);
  }
};
require("../extension/src/api.js");
require("../extension/src/reactions.js");
const { Reactions, PixivError, like, addBookmark, removeBookmark } = globalThis.FollowingViewer;

const deferred = () => {
  const d = {};
  d.promise = new Promise((resolve, reject) => Object.assign(d, { resolve, reject }));
  return d;
};

/** A stand-in for Pixiv that remembers one work's state and every call made. */
function pixiv({ liked = false, bookmarkId = null } = {}) {
  const server = { liked, bookmarkId, calls: [], fail: new Set() };
  const call = (name, effect) => async (arg) => {
    server.calls.push(`${name} ${arg}`);
    if (server.gate) await server.gate;
    if (server.fail.has(name)) throw new PixivError("other", "no");
    return effect(arg);
  };
  server.reactions = new Reactions({
    getDetails: call("details", () => ({ liked: server.liked, bookmarkId: server.bookmarkId })),
    like: call("like", () => { server.liked = true; }),
    addBookmark: call("add", () => (server.bookmarkId = "b1")),
    removeBookmark: call("remove", () => { server.bookmarkId = null; }),
  }, () => {});
  return server;
}
const work = { id: 5, bookmarkId: null };

test("a like shows at once and is sent exactly once, however often it's pressed", async () => {
  const s = pixiv();
  const gate = deferred();
  s.gate = gate.promise;
  const presses = [s.reactions.like(work), s.reactions.like(work), s.reactions.like(work)];
  assert.equal(s.reactions.view(work).liked, true);
  gate.resolve();
  assert.deepEqual(await Promise.all(presses), [true, false, false]);
  assert.equal(await s.reactions.like(work), false);
  assert.deepEqual(s.calls, ["like 5"]);
});

test("a failed like goes back to unliked and can be retried", async () => {
  const s = pixiv();
  s.fail.add("like");
  await assert.rejects(s.reactions.like(work));
  assert.equal(s.reactions.view(work).liked, false);
  s.fail.clear();
  await s.reactions.like(work);
  assert.equal(s.reactions.view(work).liked, true);
});

test("a late 'not liked' answer can't undo a like", async () => {
  const s = pixiv();
  const gate = deferred();
  s.reactions.api.getDetails = async () => { await gate.promise; return { liked: false, bookmarkId: null }; };
  const checking = s.reactions.check(work);
  await s.reactions.like(work);
  gate.resolve();
  await checking;
  assert.equal(s.reactions.view(work).liked, true);
});

test("works already liked or bookmarked on Pixiv show that, and aren't liked again", async () => {
  const s = pixiv({ liked: true, bookmarkId: "b7" });
  await s.reactions.check(work);
  await s.reactions.check(work);
  assert.deepEqual(s.reactions.view(work), { liked: true, bookmarked: true });
  await s.reactions.like(work);
  assert.deepEqual(s.calls, ["details 5"]);
});

test("a bookmark from the feed shows before Pixiv is asked", () => {
  assert.equal(pixiv().reactions.view({ id: 6, bookmarkId: "b9" }).bookmarked, true);
});

test("bookmarking adds, then removes with the id Pixiv gave", async () => {
  const s = pixiv();
  await s.reactions.toggleBookmark(work);
  assert.equal(s.reactions.view(work).bookmarked, true);
  await s.reactions.toggleBookmark(work);
  assert.equal(s.reactions.view(work).bookmarked, false);
  assert.deepEqual(s.calls, ["details 5", "add 5", "details 5", "remove b1"]);
});

test("a bookmark made in another tab is never overwritten", async () => {
  const s = pixiv();
  await s.reactions.check(work);
  s.bookmarkId = "with-tags";
  await s.reactions.toggleBookmark(work);
  assert.equal(s.reactions.view(work).bookmarked, true);
  assert.ok(!s.calls.some((c) => c.startsWith("add")));
});

test("if Pixiv can't be asked first, nothing is added or removed", async () => {
  const s = pixiv();
  s.fail.add("details");
  await assert.rejects(s.reactions.toggleBookmark(work));
  assert.deepEqual(s.calls, ["details 5"]);
  assert.equal(s.reactions.view(work).bookmarked, false);
});

test("a check that started before a bookmark change doesn't undo it on screen", async () => {
  const s = pixiv();
  const gate = deferred();
  const real = s.reactions.api.getDetails;
  s.reactions.api.getDetails = async () => { await gate.promise; return { liked: false, bookmarkId: null }; };
  const checking = s.reactions.check(work);
  s.reactions.api.getDetails = real;
  await s.reactions.toggleBookmark(work);
  gate.resolve();
  await checking;
  assert.equal(s.reactions.view(work).bookmarked, true);
});

// ---- the requests themselves ----

function fakeFetch(answers) {
  const sent = [];
  globalThis.fetch = async (url, init = {}) => {
    sent.push({ url, ...init });
    const answer = answers(url, init);
    return {
      ok: (answer.status ?? 200) < 400,
      status: answer.status ?? 200,
      json: async () => answer.json,
      text: async () => answer.text,
    };
  };
  return sent;
}
const okay = (body) => ({ json: { error: false, body } });

test("requests match what Pixiv's own site sends", async () => {
  const sent = fakeFetch(() => okay({ last_bookmark_id: "77" }));
  await like(5);
  assert.equal(await addBookmark(5), "77");
  await removeBookmark("77");
  assert.deepEqual(sent.map((r) => [r.method, r.url, r.headers["X-CSRF-Token"], r.credentials]), [
    ["POST", "https://www.pixiv.net/ajax/illusts/like", "page-token", "same-origin"],
    ["POST", "https://www.pixiv.net/ajax/illusts/bookmarks/add", "page-token", "same-origin"],
    ["POST", "https://www.pixiv.net/ajax/illusts/bookmarks/delete", "page-token", "same-origin"],
  ]);
  assert.deepEqual(JSON.parse(sent[0].body), { illust_id: "5" });
  assert.deepEqual(JSON.parse(sent[1].body), { illust_id: "5", restrict: 0, comment: "", tags: [] });
  assert.equal(sent[2].body, "bookmark_id=77");
  assert.match(sent[2].headers["Content-Type"], /x-www-form-urlencoded/);
});

test("an out-of-date token is replaced and the request sent once more", async () => {
  const sent = fakeFetch((url, init) => {
    if (init.method !== "POST") return { text: "new-token" };
    return init.headers["X-CSRF-Token"] === "new-token" ? okay({}) : { status: 400, json: { error: true } };
  });
  await like(5);
  assert.deepEqual(sent.map((r) => r.headers?.["X-CSRF-Token"] ?? r.url), ["page-token", "https://www.pixiv.net/", "new-token"]);
});

test("being refused with a good token is reported, not retried forever", async () => {
  const sent = fakeFetch((url, init) => (init.method === "POST" ? { status: 403, json: { error: true } } : { text: "new-token" }));
  await assert.rejects(like(5), (e) => e.kind === "auth");
  assert.equal(sent.filter((r) => r.method === "POST").length, 1);
});

test("rate limits and server errors are never resent automatically", async () => {
  for (const status of [429, 500]) {
    const sent = fakeFetch(() => ({ status, json: { error: true } }));
    await assert.rejects(like(5));
    assert.equal(sent.length, 1);
  }
});
