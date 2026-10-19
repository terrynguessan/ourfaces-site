// F3: provenance key used to match candidate URLs against URLs returned by
// the web search tool. Legitimate variants of the same page match; any change
// to host, port, path or a non-tracking query value does not.

import assert from "node:assert/strict";
import test from "node:test";
import { provenanceKey } from "../research.mjs";

const same = [
  [
    "https://Example.com/a/b/",
    "https://www.example.com/a/b",
    "host case, www, trailing slash",
  ],
  ["http://example.com/a", "https://example.com/a", "http and https forms"],
  [
    "https://example.com/a?utm_source=openai",
    "https://example.com/a",
    "utm_source=openai added by the search tool",
  ],
  [
    "https://example.com/a?fbclid=x&utm_medium=y",
    "https://example.com/a",
    "other known tracking parameters",
  ],
  [
    "https://example.com/a?b=2&a=1",
    "https://example.com/a?a=1&b=2",
    "parameter order",
  ],
  [
    "https://example.com/caf%c3%a9",
    "https://example.com/caf%C3%A9",
    "percent-encoding case",
  ],
  [
    "https://example.com/%7Euser/%41bc",
    "https://example.com/~user/Abc",
    "encoded unreserved characters",
  ],
  ["https://example.com/a#section", "https://example.com/a", "fragment"],
  [
    "https://example.com:443/a",
    "https://example.com/a",
    "explicit default port",
  ],
  [
    "https://example.com/post/index.html",
    "https://example.com/post",
    "index.html",
  ],
];
for (const [a, b, label] of same) {
  test(`matches: ${label}`, () =>
    assert.equal(provenanceKey(a), provenanceKey(b)));
}

const different = [
  ["https://example.com/A", "https://example.com/a", "path case"],
  [
    "https://github.blog/ai-and-ml/github-copilot-app-for-beginners/",
    "https://github.blog/ai-and-ml/github-copilot/github-copilot-app-for-beginners/",
    "a missing path segment (the k12 pattern in run-26e47111)",
  ],
  [
    "https://example.com/a?page=2",
    "https://example.com/a",
    "a non-tracking query parameter",
  ],
  [
    "https://example.com/a?id=1",
    "https://example.com/a?id=2",
    "a different query value",
  ],
  [
    "https://blog.example.com/a",
    "https://example.com/a",
    "a different subdomain",
  ],
  ["https://example.org/a", "https://example.com/a", "a different domain"],
  ["https://example.com:8443/a", "https://example.com/a", "a different port"],
  [
    "http://example.com:8080/a",
    "https://example.com/a",
    "http on a non-default port",
  ],
  [
    "https://example.com/",
    "https://example.com/a",
    "a homepage versus an article",
  ],
];
for (const [a, b, label] of different) {
  test(`does not match: ${label}`, () =>
    assert.notEqual(provenanceKey(a), provenanceKey(b)));
}

test("unsupported or malformed URLs are rejected", () => {
  for (const bad of [
    "javascript:alert(1)",
    "ftp://example.com/a",
    "https://user:pw@example.com/a",
    "not a url",
    "data:text/html,x",
  ]) {
    assert.throws(() => provenanceKey(bad), bad);
  }
});
