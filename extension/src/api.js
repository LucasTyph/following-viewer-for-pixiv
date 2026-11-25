"use strict";

// Calls to the same endpoints Pixiv's own pages use. They run from a pixiv.net tab,
// so the signed-in session applies. Only likes and bookmarks change anything, and
// only when the reader asks for them.
(() => {
  class PixivError extends Error {
    constructor(kind, message) {
      super(message);
      this.kind = kind; // "auth" | "rate" | "gone" | "network" | "other"
    }
  }

  async function fetchFromPixiv(path, init = {}) {
    try {
      return await fetch(new URL(path, location.origin).href, { credentials: "same-origin", ...init });
    } catch {
      throw new PixivError("network", "Couldn't reach Pixiv. Check your connection and try again.");
    }
  }

  async function getJson(path, { headers, ...init } = {}) {
    const response = await fetchFromPixiv(path, { ...init, headers: { Accept: "application/json", ...headers } });

    let data = null;
    try {
      data = await response.json();
    } catch {
      // Not JSON (an error page); the status below decides what to say.
    }
    if (response.ok && data && !data.error) return data.body;

    switch (response.status) {
      case 400:
      case 401:
      case 403:
        throw new PixivError("auth", "Pixiv refused the request. This usually means you're not signed in.");
      case 404:
        throw new PixivError("gone", "This work is no longer available.");
      case 429:
        throw new PixivError("rate", "Pixiv is asking for fewer requests. Wait a minute, then try again.");
      default:
        throw new PixivError("other", data?.message || `Pixiv returned an error (${response.status}).`);
    }
  }

  function toWork(raw) {
    return {
      id: Number(raw.id),
      title: raw.title || "Untitled",
      isUgoira: Number(raw.illustType) === 2,
      pageCount: Number(raw.pageCount) || 1,
      width: Number(raw.width) || 1,
      height: Number(raw.height) || 1,
      userId: String(raw.userId),
      userName: raw.userName || "",
      avatar: raw.profileImageUrl || "",
      date: new Date(raw.createDate),
      thumb: raw.urls?.["540x540"] || raw.url || "",
      xRestrict: Number(raw.xRestrict) || 0,
      isAi: Number(raw.aiType) === 2,
      bookmarkId: raw.bookmarkData?.id ?? null,
    };
  }

  /** One page (60 works, newest first) of the followed-artists feed. */
  async function fetchFeedPage(mode, page) {
    const body = await getJson(`/ajax/follow_latest/illust?p=${page}&mode=${encodeURIComponent(mode)}`);
    const raw = body?.thumbnails?.illust ?? [];
    return {
      works: raw.filter((r) => Number(r.id) > 0 && r.userId && !r.isMasked).map(toWork),
      isLastPage: Boolean(body?.page?.isLastPage) || raw.length === 0,
    };
  }

  /** Promise cache with a size cap; failures are not kept, so they can be retried. */
  function cached(limit, load) {
    const entries = new Map();
    const get = (key) => {
      const hit = entries.get(key);
      if (hit) {
        entries.delete(key);
        entries.set(key, hit);
        return hit;
      }
      const promise = load(key);
      entries.set(key, promise);
      promise.catch(() => {
        if (entries.get(key) === promise) entries.delete(key);
      });
      if (entries.size > limit) entries.delete(entries.keys().next().value);
      return promise;
    };
    get.has = (key) => entries.has(key);
    return get;
  }

  const getPages = cached(200, async (id) => {
    const body = await getJson(`/ajax/illust/${id}/pages`);
    if (!Array.isArray(body) || !body.length) {
      throw new PixivError("gone", "Pixiv didn't return any images for this work.");
    }
    return body.map((p) => ({
      mini: p.urls.thumb_mini,
      regular: p.urls.regular,
      original: p.urls.original,
      width: p.width,
      height: p.height,
    }));
  });

  const getUgoira = cached(30, (id) => getJson(`/ajax/illust/${id}/ugoira_meta`));

  // ---- likes and bookmarks ----

  async function getDetails(id) {
    const body = await getJson(`/ajax/illust/${id}`);
    return { liked: Boolean(body.likeData), bookmarkId: body.bookmarkData?.id ?? null };
  }

  // Pixiv wants its page's CSRF token with anything that changes the account. It's
  // kept in memory only, and goes nowhere but Pixiv.
  let token = null;

  function readToken(page) {
    try {
      const data = JSON.parse(page.getElementById("__NEXT_DATA__").textContent);
      return JSON.parse(data.props.pageProps.serverSerializedPreloadedState).api.token || null;
    } catch {
      return null; // an older Pixiv page that doesn't carry one
    }
  }

  async function getToken({ fresh = false } = {}) {
    if (!fresh) token ??= readToken(document);
    if (fresh || !token) {
      const response = await fetchFromPixiv("/");
      token = readToken(new DOMParser().parseFromString(await response.text(), "text/html"));
    }
    if (!token) throw new PixivError("other", "Pixiv's page has changed, so this can't be sent from here.");
    return token;
  }

  async function post(path, contentType, body) {
    const send = (csrf) =>
      getJson(path, { method: "POST", headers: { "Content-Type": contentType, "X-CSRF-Token": csrf }, body });
    const first = await getToken();
    try {
      return await send(first);
    } catch (error) {
      if (error.kind !== "auth") throw error;
      // Refused: the token may be from before signing in again. Try once with a new one.
      const second = await getToken({ fresh: true });
      if (second === first) throw error;
      return send(second);
    }
  }

  const JSON_TYPE = "application/json; charset=utf-8";
  const FORM_TYPE = "application/x-www-form-urlencoded; charset=utf-8";

  const like = (id) => post("/ajax/illusts/like", JSON_TYPE, JSON.stringify({ illust_id: String(id) }));

  /** Adds a public bookmark without tags, like clicking the heart on Pixiv. */
  async function addBookmark(id) {
    const details = { illust_id: String(id), restrict: 0, comment: "", tags: [] };
    const body = await post("/ajax/illusts/bookmarks/add", JSON_TYPE, JSON.stringify(details));
    return body?.last_bookmark_id ?? null;
  }

  const removeBookmark = (bookmarkId) =>
    post("/ajax/illusts/bookmarks/delete", FORM_TYPE, new URLSearchParams({ bookmark_id: bookmarkId }).toString());

  Object.assign((globalThis.FollowingViewer ??= {}), {
    PixivError,
    cached,
    fetchFeedPage,
    getPages,
    getUgoira,
    getDetails,
    like,
    addBookmark,
    removeBookmark,
  });
})();
