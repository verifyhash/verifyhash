"use strict";
// Guards the verifyhash.com landing (public/index.html) against two regressions:
//  1. dead in-page anchors — every href="#x" must resolve to a matching id="x";
//  2. the mobile nav must expose an accessible, framework-free toggle control
//     (a <details>/<summary> disclosure OR an element carrying
//     aria-controls / aria-expanded) so nav is never a display:none dead-end.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const HTML = fs.readFileSync(
  path.join(__dirname, "..", "public", "index.html"),
  "utf8"
);

test("every in-page #anchor resolves to a matching element id", () => {
  const ids = new Set();
  for (const m of HTML.matchAll(/\bid="([^"]+)"/g)) ids.add(m[1]);

  const anchors = new Set();
  for (const m of HTML.matchAll(/href="#([^"]+)"/g)) anchors.add(m[1]);

  assert.ok(anchors.size > 0, "expected at least one in-page anchor link");

  const dead = [...anchors].filter((a) => !ids.has(a));
  assert.deepEqual(
    dead,
    [],
    `dead in-page anchors (no matching id): ${dead.join(", ")}`
  );
});

test("page carries an accessible framework-free mobile-nav toggle", () => {
  const hasDetails = /<details[\s>]/i.test(HTML) && /<summary[\s>]/i.test(HTML);
  const hasAriaToggle =
    /aria-controls\s*=/.test(HTML) && /aria-expanded\s*=/.test(HTML);

  assert.ok(
    hasDetails || hasAriaToggle,
    "expected a <details>/<summary> disclosure or an aria-controls/aria-expanded toggle for the mobile nav"
  );
});

test("the ≤720px breakpoint no longer hides nav with a bare display:none dead-end", () => {
  // The original defect was `@media(max-width:720px){.bar nav{display:none}}`
  // with no replacement control. Ensure that exact dead-end is gone.
  assert.ok(
    !/@media\(max-width:720px\)\{\.bar nav\{display:none\}\}/.test(HTML),
    "the bare `.bar nav{display:none}` dead-end must be replaced by a working toggle"
  );
});
