// Network tests run entirely offline against a local HTTPS fixture server.
// Hostnames under fixture.ourfaces.net are resolved by an injected resolver,
// never by real DNS. The fixture server is on loopback, which the production
// address policy blocks, so tests inject `onlyLoopback` as the address policy;
// separate tests show that the default policy refuses the same connection.

import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import zlib from "node:zlib";
import {
  FetchError,
  checkUrl,
  createFetcher,
  decodeBody,
  isPublicAddress,
  parseRobots,
  robotsAllows,
} from "../fetch.mjs";
import {
  fixture,
  html,
  loopbackResolver,
  makeCertificate,
  onlyLoopback,
  startServer,
  startSilentServer,
  TEST_DOMAIN,
} from "./helpers.mjs";

// --- pure checks (no network) ------------------------------------------------------

describe("checkUrl", () => {
  const rejects = {
    "plain http": "http://example.com/a",
    ftp: "ftp://example.com/a",
    javascript: "javascript:alert(1)",
    credentials: "https://user:pass@example.com/a",
    "IPv4 literal": "https://93.184.216.34/a",
    "decimal IPv4 literal": "https://2130706433/a",
    "hex IPv4 literal": "https://0x7f.0.0.1/a",
    "IPv6 literal": "https://[::1]/a",
    localhost: "https://localhost/a",
    "single label": "https://intranet/a",
    ".local": "https://printer.local/a",
    ".internal": "https://metadata.google.internal/a",
    ".test": "https://site.test/a",
    "non-default port": "https://example.com:8443/a",
    whitespace: "https://example.com/a b",
    "control character": "https://example.com/a\u0001",
    "too long": `https://example.com/${"a".repeat(2100)}`,
    "not a string": 42,
  };
  for (const [name, url] of Object.entries(rejects)) {
    test(`rejects ${name}`, () =>
      assert.throws(() => checkUrl(url), FetchError));
  }
  test("accepts a normal https URL and strips the fragment and trailing dot", () => {
    assert.equal(
      checkUrl("https://Example.com./news/a?b=1#c").href,
      "https://example.com/news/a?b=1",
    );
    assert.equal(
      checkUrl("https://example.com:443/a").href,
      "https://example.com/a",
    );
  });
});

describe("isPublicAddress", () => {
  const blocked = [
    "127.0.0.1",
    "10.1.2.3",
    "172.16.0.1",
    "172.31.255.255",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "192.0.2.10",
    "198.18.0.1",
    "224.0.0.1",
    "255.255.255.255",
    "::1",
    "::",
    "fe80::1",
    "fd00::1",
    "fc00::1",
    "::ffff:127.0.0.1",
    "::ffff:10.0.0.1",
    "64:ff9b::a00:1",
    "2001:db8::1",
    "2002:c000:0204::1",
    "ff02::1",
    "not-an-ip",
  ];
  const allowed = [
    "93.184.216.34",
    "8.8.8.8",
    "1.1.1.1",
    "172.32.0.1",
    "2606:4700:4700::1111",
    "2a00:1450:4001::200e",
    "::ffff:8.8.8.8",
  ];
  for (const ip of blocked)
    test(`blocks ${ip}`, () => assert.equal(isPublicAddress(ip), false));
  for (const ip of allowed)
    test(`allows ${ip}`, () => assert.equal(isPublicAddress(ip), true));
});

describe("robots.txt parsing (RFC 9309)", () => {
  const groups = parseRobots(
    "# comment\nUser-agent: *\nDisallow: /private/\nDisallow: /*.pdf$\n\nUser-agent: OurFacesTechBrief\nUser-agent: other\nDisallow: /no-bots/\nAllow: /no-bots/ok\n\nUser-agent: Googlebot\nDisallow: /",
  );
  test("our own group overrides the * group", () => {
    assert.equal(
      robotsAllows(groups, "ourfacestechbrief", "/private/page"),
      true,
    );
    assert.equal(
      robotsAllows(groups, "ourfacestechbrief", "/no-bots/page"),
      false,
    );
  });
  test("longest match wins and allow wins ties", () => {
    assert.equal(
      robotsAllows(groups, "ourfacestechbrief", "/no-bots/ok/page"),
      true,
    );
    assert.equal(
      robotsAllows(
        parseRobots("User-agent: *\nDisallow: /a\nAllow: /a"),
        "x",
        "/a",
      ),
      true,
    );
  });
  test("* group applies when no group names us; wildcards and $ anchors work", () => {
    assert.equal(robotsAllows(groups, "somebot", "/private/x"), false);
    assert.equal(robotsAllows(groups, "somebot", "/files/report.pdf"), false);
    assert.equal(
      robotsAllows(groups, "somebot", "/files/report.pdf?x=1"),
      true,
    );
  });
  test("only an exact product-token match selects our group", () => {
    const partial = parseRobots(
      [
        "User-agent: ourfaces",
        "Disallow: /",
        "",
        "User-agent: *",
        "Allow: /",
      ].join("\n"),
    );
    assert.equal(robotsAllows(partial, "ourfacestechbrief", "/a"), true);
    const exact = parseRobots(
      ["User-agent: OURFACESTECHBRIEF", "Disallow: /"].join("\n"),
    );
    assert.equal(robotsAllows(exact, "ourfacestechbrief", "/a"), false);
  });
  test("empty or missing rules allow everything; empty Disallow allows", () => {
    assert.equal(robotsAllows([], "x", "/anything"), true);
    assert.equal(
      robotsAllows(parseRobots("User-agent: *\nDisallow:"), "x", "/a"),
      true,
    );
    assert.equal(
      robotsAllows(parseRobots("User-agent: *\nDisallow: /"), "x", "/a"),
      false,
    );
  });
});

describe("decodeBody", () => {
  test("uses the header charset, then <meta charset>, then UTF-8", () => {
    const latin1 = Buffer.from("<p>Café crème</p>", "latin1");
    assert.equal(
      decodeBody(latin1, "text/html; charset=windows-1252"),
      "<p>Café crème</p>",
    );
    const meta = Buffer.concat([
      Buffer.from('<meta charset="iso-8859-1"><p>', "ascii"),
      Buffer.from("été", "latin1"),
    ]);
    assert.ok(decodeBody(meta, "text/html").endsWith("été"));
    assert.equal(
      decodeBody(Buffer.from("é", "utf8"), "text/html; charset=bogus-charset"),
      "é",
    );
  });
});

// --- network tests against the local fixture server -----------------------------------------

const tls = makeCertificate();
const host = (name) => `${name}.${TEST_DOMAIN}`;

describe(
  "fetching over HTTPS",
  { skip: tls ? false : "OpenSSL not available to create a test certificate" },
  () => {
    let server;
    let silent;
    const articleHtml = fixture("article-en.html.txt");
    const big = "<p>" + "x".repeat(120_000) + "</p>";

    before(async () => {
      silent = await startSilentServer();
      const base = () => `https://news.${TEST_DOMAIN}:${server.port}`;
      const redirect = (status, location) => (req, res) => {
        res.writeHead(status, {
          location: typeof location === "function" ? location(req) : location,
        });
        res.end();
      };
      server = await startServer(tls, {
        "/robots.txt": (req, res) => {
          res.writeHead(200, { "content-type": "text/plain" });
          res.end(
            "User-agent: *\nDisallow: /private/\n\nUser-agent: OurFacesTechBrief\nDisallow: /no-bots/\nAllow: /no-bots/ok\n",
          );
        },
        [`${host("robots500")} /robots.txt`]: (req, res) => (
          res.writeHead(500),
          res.end()
        ),
        [`${host("robots403")} /robots.txt`]: (req, res) => (
          res.writeHead(403),
          res.end()
        ),
        [`${host("robots404")} /robots.txt`]: (req, res) => (
          res.writeHead(404),
          res.end()
        ),
        "/article": html(articleHtml),
        "/2026/10/22/dated-post/": html(
          articleHtml
            .replace(/<meta property="article:published_time"[^>]*>/, "")
            .replace(/"datePublished"[^,]*,/, "")
            .replace(/<time[^>]*>/, "<time>"),
        ),
        "/private/article": html(articleHtml),
        "/no-bots/article": html(articleHtml),
        "/no-bots/ok/article": html(articleHtml),
        "/article-gzip": (req, res) => {
          res.writeHead(200, {
            "content-type": "text/html",
            "content-encoding": "gzip",
          });
          res.end(zlib.gzipSync(articleHtml));
        },
        "/article-br": (req, res) => {
          res.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "content-encoding": "br",
          });
          res.end(zlib.brotliCompressSync(articleHtml));
        },
        "/redirect-same": redirect(301, () => `${base()}/article`),
        "/redirect-subdomain": redirect(
          302,
          () => `https://www.${TEST_DOMAIN}:${server.port}/article`,
        ),
        "/redirect-relative": redirect(308, "/article"),
        "/redirect-cross": redirect(
          301,
          () => `https://attacker.example.org:${server.port}/article`,
        ),
        "/redirect-http": redirect(
          301,
          () => `http://news.${TEST_DOMAIN}:${server.port}/article`,
        ),
        "/redirect-credentials": redirect(
          301,
          () => `https://u:p@news.${TEST_DOMAIN}:${server.port}/article`,
        ),
        "/redirect-private": redirect(
          302,
          () => `https://internal.${TEST_DOMAIN}:${server.port}/article`,
        ),
        "/redirect-loop": redirect(
          302,
          (req) =>
            `/redirect-loop?n=${Number(new URL(req.url, "https://x").searchParams.get("n") ?? 0) + 1}`,
        ),
        "/redirect-no-location": (req, res) => (res.writeHead(302), res.end()),
        "/pdf": (req, res) => (
          res.writeHead(200, { "content-type": "application/pdf" }),
          res.end("%PDF-1.7")
        ),
        "/no-type": (req, res) => (res.writeHead(200), res.end(articleHtml)),
        "/status-403": html("forbidden", 403),
        "/status-500": html("error", 500),
        "/js-only": html(fixture("js-only.html.txt")),
        "/big-declared": (req, res) => {
          res.writeHead(200, {
            "content-type": "text/html",
            "content-length": "3000000",
          });
          res.write("<p>start</p>");
          setTimeout(() => res.destroy(), 50);
        },
        "/big-chunked": (req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.end(big);
        },
        "/gzip-bomb": (req, res) => {
          res.writeHead(200, {
            "content-type": "text/html",
            "content-encoding": "gzip",
          });
          res.end(zlib.gzipSync(Buffer.alloc(5_000_000, 0x20)));
        },
        "/unknown-encoding": (req, res) => {
          res.writeHead(200, {
            "content-type": "text/html",
            "content-encoding": "compress",
          });
          res.end("x");
        },
        "/slow-headers": (req, res) =>
          setTimeout(() => html(articleHtml)(req, res), 1500),
        "/stall-body": (req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          res.write("<p>first chunk</p>");
        },
        "/trickle": (req, res) => {
          res.writeHead(200, { "content-type": "text/html" });
          const timer = setInterval(
            () =>
              res.destroyed ? clearInterval(timer) : res.write("<p>more</p>"),
            100,
          );
          res.on("close", () => clearInterval(timer));
        },
        "/latin1": (req, res) => {
          res.writeHead(200, {
            "content-type": "text/html; charset=windows-1252",
          });
          res.end(
            Buffer.from(
              articleHtml.replace("<p>Today", "<p>Café crème. Today"),
              "latin1",
            ),
          );
        },
      });
    });

    after(async () => {
      await server.close();
      await silent.close();
    });

    const makeFetcher = (overrides = {}) => {
      const { resolve } =
        overrides.resolver ??
        loopbackResolver({ [host("internal")]: "10.0.0.5" });
      return createFetcher({
        resolve,
        isAllowedAddress: onlyLoopback,
        allowedPorts: [String(server.port), String(silent.port)],
        ca: tls.cert,
        limits: {
          hostIntervalMs: 0,
          maxBytes: 100_000,
          connectTimeoutMs: 800,
          headersTimeoutMs: 1000,
          bodyIdleTimeoutMs: 500,
          totalTimeoutMs: 1500,
          ...overrides.limits,
        },
        ...overrides.options,
      });
    };
    const url = (path, name = "news") =>
      `https://${host(name)}:${server.port}${path}`;

    test("fetches, decodes and extracts a normal article", async () => {
      const result = await makeFetcher().fetchArticle(url("/article"));
      assert.equal(result.ok, true, JSON.stringify(result));
      assert.equal(result.finalUrl, url("/article"));
      assert.equal(
        result.article.ogTitle,
        "Version 5.0 brings incremental type checking to the command line",
      );
      assert.equal(result.hops[0].address, "127.0.0.1");
      assert.ok(result.evidence.paragraphs.length >= 5);
    });

    test("records a /YYYY/MM/DD/ URL path as a weak date source", async () => {
      const result = await makeFetcher().fetchArticle(
        url("/2026/10/22/dated-post/"),
      );
      assert.equal(result.ok, true);
      assert.deepEqual(
        result.article.dateCandidates
          .filter((d) => d.weak)
          .map((d) => d.source),
        ["time.text", "byline.text", "url.path"],
      );
      assert.equal(
        result.article.dateCandidates.filter((d) => !d.weak).length,
        0,
      );
    });

    test("decompresses gzip and brotli and decodes windows-1252", async () => {
      const f = makeFetcher();
      for (const path of ["/article-gzip", "/article-br"])
        assert.equal((await f.fetchArticle(url(path))).ok, true, path);
      const latin = await f.fetchArticle(url("/latin1"));
      assert.ok(latin.article.text.includes("Café crème"));
    });

    test("follows same-site redirects (absolute, subdomain, relative)", async () => {
      const f = makeFetcher();
      for (const path of [
        "/redirect-same",
        "/redirect-subdomain",
        "/redirect-relative",
      ]) {
        const result = await f.fetchArticle(url(path));
        assert.equal(result.ok, true, `${path}: ${result.code}`);
        assert.equal(result.hops.length, 2);
      }
    });

    const failures = {
      "/redirect-cross": "CROSS_SITE_REDIRECT",
      "/redirect-http": "INVALID_URL",
      "/redirect-credentials": "INVALID_URL",
      "/redirect-private": "BLOCKED_ADDRESS",
      "/redirect-loop": "TOO_MANY_REDIRECTS",
      "/redirect-no-location": "HTTP_STATUS",
      "/pdf": "UNSUPPORTED_CONTENT_TYPE",
      "/no-type": "UNSUPPORTED_CONTENT_TYPE",
      "/status-403": "HTTP_STATUS",
      "/status-500": "HTTP_STATUS",
      "/js-only": "INSUFFICIENT_TEXT",
      "/big-declared": "TOO_LARGE",
      "/big-chunked": "TOO_LARGE",
      "/gzip-bomb": "TOO_LARGE",
      "/unknown-encoding": "UNSUPPORTED_ENCODING",
      "/slow-headers": "HEADERS_TIMEOUT",
      "/stall-body": "BODY_TIMEOUT",
      "/trickle": "TOTAL_TIMEOUT",
      "/no-bots/article": "ROBOTS_DISALLOWED",
    };
    for (const [path, code] of Object.entries(failures)) {
      test(`${path} -> ${code}`, async () => {
        const result = await makeFetcher().fetchArticle(url(path));
        assert.equal(result.ok, false);
        assert.equal(result.code, code, result.message);
      });
    }

    test("robots.txt: our group allows /private/ and the longest Allow wins", async () => {
      const f = makeFetcher();
      assert.equal((await f.fetchArticle(url("/private/article"))).ok, true);
      assert.equal((await f.fetchArticle(url("/no-bots/ok/article"))).ok, true);
    });

    test("robots.txt errors: 5xx and 401/403 disallow, 404 allows", async () => {
      const f = makeFetcher();
      assert.equal(
        (await f.fetchArticle(url("/article", "robots500"))).code,
        "ROBOTS_DISALLOWED",
      );
      assert.equal(
        (await f.fetchArticle(url("/article", "robots403"))).code,
        "ROBOTS_DISALLOWED",
      );
      assert.equal(
        (await f.fetchArticle(url("/article", "robots404"))).ok,
        true,
      );
    });

    test("a robots-disallowed article is never requested", async () => {
      const key = `${host("news")}/no-bots/article`;
      const before = server.counts.requests[key] ?? 0;
      await makeFetcher().fetchArticle(url("/no-bots/article"));
      assert.equal(server.counts.requests[key] ?? 0, before);
    });

    test("a cross-site redirect target is never contacted", async () => {
      const resolver = loopbackResolver();
      await makeFetcher({ resolver }).fetchArticle(url("/redirect-cross"));
      assert.ok(!resolver.calls.includes("attacker.example.org"));
    });

    test("connection-time enforcement: a hostname resolving to a blocked address gets no connection", async () => {
      const resolver = loopbackResolver({ [host("internal")]: "10.0.0.5" });
      const before = server.counts.connections;
      const result = await makeFetcher({ resolver })
        .get(url("/article", "internal"), {
          accept: "text/html",
          allowedTypes: ["text/html"],
          maxBytes: 100_000,
          checkRobots: false,
        })
        .catch((e) => e);
      assert.equal(result.code, "BLOCKED_ADDRESS");
      assert.equal(server.counts.connections, before);
    });

    test("the default (production) address policy refuses loopback even when DNS returns it", async () => {
      const before = server.counts.connections;
      const f = createFetcher({
        resolve: loopbackResolver().resolve,
        allowedPorts: [String(server.port)],
        ca: tls.cert,
        limits: { hostIntervalMs: 0 },
      });
      const result = await f.fetchArticle(url("/article"));
      assert.equal(result.ok, false);
      assert.equal(
        result.code,
        "BLOCKED_ADDRESS",
        "the robots.txt connection is already refused",
      );
      const direct = await f
        .get(url("/article"), {
          accept: "text/html",
          allowedTypes: ["text/html"],
          maxBytes: 100_000,
          checkRobots: false,
        })
        .catch((e) => e);
      assert.equal(direct.code, "BLOCKED_ADDRESS");
      assert.equal(
        server.counts.connections,
        before,
        "no TCP connection reached the server",
      );
    });

    test("DNS answers with any blocked address are refused, even if one address is public", async () => {
      const resolver = loopbackResolver({
        [host("mixed")]: ["127.0.0.1", "10.0.0.5"],
      });
      const result = await makeFetcher({ resolver })
        .get(url("/article", "mixed"), {
          accept: "text/html",
          allowedTypes: ["text/html"],
          maxBytes: 100_000,
          checkRobots: false,
        })
        .catch((e) => e);
      assert.equal(result.code, "BLOCKED_ADDRESS");
    });

    test("DNS rebinding: every connection re-resolves and re-validates; a changed answer is refused", async () => {
      // First answer (robots.txt connection) is allowed; the next answer for the
      // article connection points at a private address and must be blocked.
      const resolver = loopbackResolver({
        [host("rebind")]: (n) => (n === 1 ? "127.0.0.1" : "10.0.0.5"),
      });
      const before = server.counts.connections;
      const result = await makeFetcher({ resolver }).fetchArticle(
        url("/article", "rebind"),
      );
      assert.equal(result.ok, false);
      assert.equal(result.code, "BLOCKED_ADDRESS");
      assert.equal(
        resolver.calls.filter((h) => h === host("rebind")).length,
        2,
        "one lookup per connection",
      );
      assert.equal(
        server.counts.connections - before,
        1,
        "only the validated robots.txt connection was made",
      );
    });

    test("the socket connects to exactly the address that passed validation", async () => {
      const resolver = loopbackResolver();
      const f = makeFetcher({ resolver });
      const result = await f.fetchArticle(url("/article"));
      assert.ok(result.hops.every((h) => h.address === "127.0.0.1"));
      assert.equal(
        f.stats.lookups,
        f.stats.connections,
        "each connection performed its own validated lookup",
      );
    });

    test("connect timeout on a server that never completes TLS", async () => {
      const f = makeFetcher();
      const started = Date.now();
      const result = await f
        .get(`https://${host("silent")}:${silent.port}/article`, {
          accept: "text/html",
          allowedTypes: ["text/html"],
          maxBytes: 100_000,
          checkRobots: false,
        })
        .catch((e) => e);
      assert.equal(result.code, "CONNECT_TIMEOUT");
      assert.ok(Date.now() - started < 1400);
      assert.equal(
        (
          await f.fetchArticle(
            `https://${host("silent")}:${silent.port}/article`,
          )
        ).code,
        "ROBOTS_DISALLOWED",
      );
    });

    test("TLS: untrusted certificates and wrong hostnames are rejected", async () => {
      const untrusted = createFetcher({
        resolve: loopbackResolver().resolve,
        isAllowedAddress: onlyLoopback,
        allowedPorts: [String(server.port)],
        limits: { hostIntervalMs: 0 },
      });
      const a = await untrusted
        .get(url("/article"), {
          accept: "text/html",
          allowedTypes: ["text/html"],
          maxBytes: 100_000,
          checkRobots: false,
        })
        .catch((e) => e);
      assert.equal(a.code, "TLS_ERROR");
      const wrongName = await makeFetcher()
        .get("https://wrong-name.example.org:" + server.port + "/article", {
          accept: "text/html",
          allowedTypes: ["text/html"],
          maxBytes: 100_000,
          checkRobots: false,
        })
        .catch((e) => e);
      assert.equal(wrongName.code, "TLS_ERROR");
    });

    test("source policy blocks excluded domains before any connection", async () => {
      const policy = {
        version: 1,
        mode: "denylist",
        preferred: [],
        reviewRequired: [],
        excluded: [{ domain: TEST_DOMAIN, reason: "test exclusion" }],
      };
      const before = server.counts.connections;
      const result = await makeFetcher({
        options: { sourcePolicy: policy },
      }).fetchArticle(url("/article"));
      assert.equal(result.code, "SOURCE_EXCLUDED");
      assert.equal(server.counts.connections, before);
    });

    test("politeness delay spaces requests to the same host", async () => {
      const f = makeFetcher({ limits: { hostIntervalMs: 300 } });
      const started = Date.now();
      const result = await f.fetchArticle(url("/article")); // robots.txt + article
      assert.equal(result.ok, true);
      assert.ok(Date.now() - started >= 290);
    });

    test("sends an identifying User-Agent and no cookies", async () => {
      let seen;
      const s = await startServer(tls, {
        "/robots.txt": (req, res) => (res.writeHead(404), res.end()),
        "/article": (req, res) => {
          seen = req.headers;
          html(articleHtml)(req, res);
        },
      });
      try {
        const f = createFetcher({
          resolve: loopbackResolver().resolve,
          isAllowedAddress: onlyLoopback,
          allowedPorts: [String(s.port)],
          ca: tls.cert,
          limits: { hostIntervalMs: 0 },
        });
        assert.equal((await f.fetchArticle(s.url("/article"))).ok, true);
        assert.match(
          seen["user-agent"],
          /^OurFacesTechBrief\/1\.0 \(\+https:\/\/www\.ourfaces\.net\/insights\)$/,
        );
        assert.equal(seen.cookie, undefined);
      } finally {
        await s.close();
      }
    });
  },
);
