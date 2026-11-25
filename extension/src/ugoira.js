"use strict";

// Ugoira (Pixiv animations) are a zip of still frames plus a delay for each one.
(() => {
  const { cached, PixivError } = globalThis.FollowingViewer;

  const END_OF_DIRECTORY = 0x06054b50;
  const DIRECTORY_ENTRY = 0x02014b50;

  async function inflate(bytes) {
    const stream = new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate-raw"));
    return new Uint8Array(await new Response(stream).arrayBuffer());
  }

  /** Minimal zip reader: name -> bytes. Frames are normally stored uncompressed. */
  async function unzip(buffer) {
    const view = new DataView(buffer);
    let end = buffer.byteLength - 22;
    while (end >= 0 && view.getUint32(end, true) !== END_OF_DIRECTORY) end--;
    if (end < 0) throw new Error("not a zip file");

    const files = new Map();
    const count = view.getUint16(end + 10, true);
    let at = view.getUint32(end + 16, true);
    for (let i = 0; i < count; i++) {
      if (view.getUint32(at, true) !== DIRECTORY_ENTRY) throw new Error("damaged zip directory");
      const method = view.getUint16(at + 10, true);
      const size = view.getUint32(at + 20, true);
      const nameLength = view.getUint16(at + 28, true);
      const skip = nameLength + view.getUint16(at + 30, true) + view.getUint16(at + 32, true);
      const local = view.getUint32(at + 42, true);
      const name = new TextDecoder().decode(new Uint8Array(buffer, at + 46, nameLength));
      const start = local + 30 + view.getUint16(local + 26, true) + view.getUint16(local + 28, true);
      const bytes = new Uint8Array(buffer, start, size);
      if (method === 0) files.set(name, bytes);
      else if (method === 8) files.set(name, await inflate(bytes));
      else throw new Error(`unsupported zip method ${method}`);
      at += 46 + skip;
    }
    return files;
  }

  // Compressed frames only; two or three animations is plenty to keep around.
  const getZip = cached(3, async (url) => {
    const response = await fetch(url, { credentials: "omit" });
    if (!response.ok) throw new PixivError("other", `Couldn't load the animation (${response.status}).`);
    return unzip(await response.arrayBuffer());
  });

  /** Load frames as blobs: [{blob, delay}]. */
  async function loadFrames(meta, hd) {
    const files = await getZip(hd ? meta.originalSrc : meta.src);
    return meta.frames.map(({ file, delay }) => {
      const bytes = files.get(file);
      if (!bytes) throw new PixivError("other", "The animation is missing a frame.");
      return { blob: new Blob([bytes], { type: meta.mime_type }), delay };
    });
  }

  const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

  /**
   * Loop frames on a canvas until the signal aborts. Frames are decoded one ahead
   * rather than all up front, so long animations don't hold hundreds of bitmaps.
   */
  async function play(canvas, frames, signal, onFirstFrame) {
    const context = canvas.getContext("2d");
    let upcoming = createImageBitmap(frames[0].blob);
    for (let i = 0; !signal.aborted; i = (i + 1) % frames.length) {
      const bitmap = await upcoming;
      if (signal.aborted) return bitmap.close();
      if (canvas.width !== bitmap.width || canvas.height !== bitmap.height) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
      }
      context.drawImage(bitmap, 0, 0);
      bitmap.close();
      onFirstFrame?.();
      onFirstFrame = null;
      const shownAt = performance.now();
      upcoming = createImageBitmap(frames[(i + 1) % frames.length].blob);
      upcoming.catch(() => {}); // reported when awaited above
      await upcoming.then(
        () => sleep(Math.max(0, frames[i].delay - (performance.now() - shownAt))),
        () => {},
      );
    }
  }

  Object.assign(globalThis.FollowingViewer, { unzip, loadFrames, play });
})();
