"use strict";

// On Pixiv the content script opens the viewer in place. Anywhere else (or in a
// Pixiv tab that was open before the extension was installed) there is nobody to
// answer, so open the following feed in a new tab and let the hash start it.
const FEED_URL = "https://www.pixiv.net/bookmark_new_illust.php#following-viewer";

browser.action.onClicked.addListener(async (tab) => {
  try {
    await browser.tabs.sendMessage(tab.id, { type: "toggle-viewer" });
  } catch {
    await browser.tabs.create({ url: FEED_URL, index: tab.index + 1 });
  }
});
