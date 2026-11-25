# Following Viewer for Pixiv

A Firefox extension that shows new works from the Pixiv artists you follow, full
window and in date order. One click goes to the next or previous illustration.

## Install

Release Firefox only keeps extensions that Mozilla has signed, so there are two ways:

**Try it now (lasts until Firefox restarts)**

1. Open `about:debugging#/runtime/this-firefox`.
2. Choose **Load Temporary Add-on…** and pick `extension/manifest.json`.

Your place is kept between restarts, but you need to load the add-on again each time.

**Keep it installed**

1. Sign in at <https://addons.mozilla.org/developers/> (free Mozilla account).
2. Submit `dist/following-viewer-1.3.2.zip`, choosing **On your own** for distribution,
   so it is signed for you but not listed publicly.
3. Download the signed `.xpi` and open it in Firefox.

## Use

Click the toolbar button (or press Alt+Shift+P). You need to be signed in to Pixiv.

| Do this | To |
| --- | --- |
| Click the right side, `→`, `D` or `Space` | Next illustration |
| Click the left side, `←`, `A` or `Shift+Space` | Previous illustration |
| Mouse wheel, `↓` / `↑`, `S` / `W`, or a thumbnail | Change page within a multi-page work |
| `O`, or click the title | Open the work on Pixiv in a new tab |
| `I`, or the arrow button above the thumbs-up | Open the original-size image in a new tab |
| `L`, or the thumbs-up button | Like the work (Pixiv doesn't let you undo a like) |
| `B`, or the heart button | Bookmark the work publicly; press twice to remove the bookmark |
| `H` | Switch between normal and original-size images |
| `Esc` | Close |

- **Oldest first** (the default) starts at the first work you haven't seen and moves
  forward in time. **Newest first** starts at the latest work and moves back.
- The first time, the latest 60 works count as unseen and everything earlier as seen.
  Going to the previous illustration still loads earlier works.
- **Start over…** replaces the seen list for the current filter. Type how many of the
  latest works should count as unseen (1 to 2000, or as far back as Pixiv's feed goes).
  The number is remembered, and also used the first time you open another filter.
- A work counts as seen once you've been on it. Works you skip stay unseen.
- **All works / All ages / R-18** each keep their own place.

## What it accesses

It runs only on `www.pixiv.net` and makes the same requests Pixiv's own site makes, using
your existing sign-in. It likes or bookmarks a work only when you press that button or
key, and changes nothing else on your account. Your place and settings stay in Firefox's
local extension storage.

When you install it, Firefox lists "website activity" as data it uses. That covers the
requests above, which go only to Pixiv. Nothing is sent to the developer or anyone else.

Pixiv has no public API for this, so a change on their side can break it.

## Development

There is no build step. `extension/` is the source. Run the logic tests with:

```
node --test tests/
```
