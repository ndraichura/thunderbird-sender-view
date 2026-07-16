/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

"use strict";

// Register the "Sender View" space in the left spaces rail. Spaces do not
// persist across sessions, so this runs on every startup of the event page.
async function registerSpace() {
  try {
    await browser.spaces.create("sender_view", "/senderview/senderview.html", {
      title: "Sender View",
      defaultIcons: "icons/senderview.svg",
    });
  } catch (e) {
    // A space with this name may already exist after an extension reload
    // during development; that is fine.
    console.warn("Sender View: spaces.create failed:", e.message);
  }
}

registerSpace();
