"use strict";

(() => {
  let viewer = null;
  const getViewer = () => (viewer ??= new globalThis.FollowingViewer.Viewer());

  browser.runtime.onMessage.addListener((message) => {
    if (message?.type !== "toggle-viewer") return undefined;
    getViewer().toggle();
    return Promise.resolve(true); // tells the background script a viewer answered
  });

  // The toolbar button opens this hash when it's used away from Pixiv.
  if (location.hash === "#following-viewer") getViewer().open();
})();
