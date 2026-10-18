// Secure retrieval of source articles for the Tech Brief.
//
// Network safety model (Node built-ins only):
// - URLs: https only, default port, no credentials, no IP literals, no
//   single-label or reserved hostnames.
// - Connection-time address enforcement: DNS resolution happens inside the
//   socket's `lookup` hook. Every resolved address is checked against a
//   blocklist of private/reserved ranges, and the socket connects only to an
//   address that passed the check. There is no separate pre-resolution, so a
//   DNS answer cannot change between validation and connection (rebinding).
//   After the TLS handshake the peer address is asserted again.
// - Redirects are followed manually (max 3), each hop re-validated and kept on
//   the same site. Each hop opens a new connection with its own lookup check.
// - robots.txt is honoured per origin (RFC 9309 matching, conservative on
//   errors). Timeouts cover connect+TLS, response headers, body idle and total.
// - Bodies are size-capped after decompression; only HTML is accepted.
// - Retrieved content is untrusted data. It is parsed as text only.

import dns from "node:dns";
import https from "node:https";
import net from "node:net";
import zlib from "node:zlib";
import { pathToFileURL } from "node:url";
import { buildEvidence, extractArticle } from "./html.mjs";
import {
  evaluateSource,
  loadSourcePolicy,
  sameSite,
  siteOf,
} from "./validate.mjs";

export const USER_AGENT =
  "OurFacesTechBrief/1.0 (+https://www.ourfaces.net/insights)";
export const ROBOTS_TOKEN = "ourfacestechbrief";

export const DEFAULT_LIMITS = Object.freeze({
  connectTimeoutMs: 5_000, // TCP connect + TLS handshake
  headersTimeoutMs: 10_000, // request start -> response headers
  bodyIdleTimeoutMs: 10_000, // max gap between body chunks
  totalTimeoutMs: 20_000, // whole request
  maxBytes: 2_000_000, // decoded (decompressed) HTML
  robotsMaxBytes: 512_000, // RFC 9309: parse at least 500 KiB
  maxRedirects: 3,
  minTextChars: 800, // less extracted text = inaccessible or script-rendered page
  hostIntervalMs: 1_000, // politeness delay between requests to one host
});

const HTML_TYPES = ["text/html", "application/xhtml+xml"];
const BLOCKED_SUFFIXES = [
  ".localhost",
  ".local",
  ".internal",
  ".intranet",
  ".lan",
  ".home",
  ".corp",
  ".home.arpa",
  ".test",
  ".example",
  ".invalid",
  ".onion",
  ".arpa",
];

export class FetchError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

// Private, loopback, link-local, CGNAT, documentation, benchmarking, multicast
// and other special-purpose ranges (IANA special-purpose registries).
const BLOCKED_RANGES = new net.BlockList();
for (const [address, prefix] of [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.31.196.0", 24],
  ["192.52.193.0", 24],
  ["192.88.99.0", 24],
  ["192.168.0.0", 16],
  ["192.175.48.0", 24],
  ["198.18.0.0", 15],
  ["198.51.100.0", 24],
  ["203.0.113.0", 24],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
])
  BLOCKED_RANGES.addSubnet(address, prefix, "ipv4");
for (const [address, prefix] of [
  ["::", 128],
  ["::1", 128],
  ["64:ff9b::", 96],
  ["64:ff9b:1::", 48],
  ["100::", 64],
  ["2001::", 23],
  ["2001:db8::", 32],
  ["2002::", 16],
  ["3fff::", 20],
  ["5f00::", 16],
  ["fc00::", 7],
  ["fe80::", 10],
  ["fec0::", 10],
  ["ff00::", 8],
])
  BLOCKED_RANGES.addSubnet(address, prefix, "ipv6");

/** True for globally routable unicast addresses only. IPv4-mapped IPv6 is checked as IPv4. */
export function isPublicAddress(address) {
  const family = net.isIP(address);
  if (family === 0) return false;
  return !BLOCKED_RANGES.check(address, family === 4 ? "ipv4" : "ipv6");
}

/** Validates a source URL before any network activity. Throws FetchError. */
export function checkUrl(raw, { allowedPorts = [""] } = {}) {
  if (
    typeof raw !== "string" ||
    raw.length > 2048 ||
    /[\s\u0000-\u001f\u007f]/.test(raw)
  ) {
    throw new FetchError(
      "INVALID_URL",
      "URL is missing, too long or contains whitespace/control characters",
    );
  }
  let url;
  try {
    url = new URL(raw);
  } catch {
    throw new FetchError("INVALID_URL", "URL does not parse");
  }
  if (url.protocol !== "https:")
    throw new FetchError(
      "INVALID_URL",
      `Only https: is allowed (got ${url.protocol})`,
    );
  if (url.username || url.password)
    throw new FetchError("INVALID_URL", "URL must not contain credentials");
  if (!allowedPorts.includes(url.port))
    throw new FetchError("INVALID_URL", `Port ${url.port} is not allowed`);
  const host = url.hostname.replace(/\.$/, "").toLowerCase();
  if (net.isIP(host.replace(/^\[|\]$/g, "")))
    throw new FetchError("BLOCKED_HOST", "IP-address URLs are not allowed");
  if (
    !host.includes(".") ||
    host === "localhost" ||
    BLOCKED_SUFFIXES.some((s) => host.endsWith(s))
  ) {
    throw new FetchError(
      "BLOCKED_HOST",
      `Host ${host} is not a public internet name`,
    );
  }
  url.hostname = host;
  url.hash = "";
  return url;
}

// --- robots.txt (RFC 9309) ---------------------------------------------------

export function parseRobots(text) {
  const groups = [];
  let current = null;
  let lastWasAgent = false;
  for (const rawLine of String(text).split(/\r?\n|\r/)) {
    const line = rawLine.replace(/#.*$/, "").trim();
    const m = line.match(/^([A-Za-z-]+)\s*:\s*(.*)$/);
    if (!m) continue;
    const key = m[1].toLowerCase();
    const value = m[2].trim();
    if (key === "user-agent") {
      if (!lastWasAgent || !current) {
        current = { agents: [], rules: [] };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastWasAgent = true;
    } else if ((key === "allow" || key === "disallow") && current) {
      current.rules.push({ allow: key === "allow", pattern: value });
      lastWasAgent = false;
    } else {
      lastWasAgent = false;
    }
  }
  return groups;
}

function robotsPatternMatches(pattern, path) {
  if (pattern === "") return false;
  const anchored = pattern.endsWith("$");
  const body = anchored ? pattern.slice(0, -1) : pattern;
  const re = new RegExp(
    `^${body
      .split("*")
      .map((s) => s.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}${anchored ? "$" : ""}`,
  );
  return re.test(path);
}

/** RFC 9309: groups naming our product token (case-insensitive) apply, else "*";
 *  the most specific (longest) matching rule wins and allow wins ties. */
export function robotsAllows(groups, token, pathWithQuery) {
  const own = groups.filter((g) =>
    g.agents.some((a) => a === token.toLowerCase()),
  );
  const applicable = own.length
    ? own
    : groups.filter((g) => g.agents.includes("*"));
  let best = null;
  for (const rule of applicable.flatMap((g) => g.rules)) {
    if (!robotsPatternMatches(rule.pattern, pathWithQuery)) continue;
    const length = rule.pattern.replace(/\$$/, "").length;
    if (
      !best ||
      length > best.length ||
      (length === best.length && rule.allow && !best.allow)
    )
      best = { ...rule, length };
  }
  return best ? best.allow : true;
}

// --- fetcher -------------------------------------------------------------------

async function defaultResolve(hostname) {
  return dns.promises.lookup(hostname, { all: true, verbatim: true });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Creates a fetcher. Production code uses the defaults. Tests inject `resolve`,
 * `isAllowedAddress`, `allowedPorts` and `ca` to exercise the same code paths
 * against local HTTPS fixtures; they never weaken the defaults.
 */
export function createFetcher(options = {}) {
  const {
    resolve = defaultResolve,
    isAllowedAddress = isPublicAddress,
    allowedPorts = [""],
    ca,
    limits: limitOverrides = {},
    userAgent = USER_AGENT,
    robotsToken = ROBOTS_TOKEN,
    sourcePolicy = null,
  } = options;
  const limits = { ...DEFAULT_LIMITS, ...limitOverrides };
  const robotsCache = new Map();
  const nextSlot = new Map();
  const stats = { connections: 0, lookups: 0 };

  function lookupFor(validated) {
    return (hostname, opts, callback) => {
      if (typeof opts === "function") [callback, opts] = [opts, {}];
      stats.lookups++;
      resolve(hostname)
        .then((answers) => {
          const list = (answers ?? []).filter((a) => a && net.isIP(a.address));
          if (list.length === 0)
            throw new FetchError("DNS_FAILURE", `No addresses for ${hostname}`);
          // Any non-public answer blocks the host, even if others are public.
          const blocked = list.filter((a) => !isAllowedAddress(a.address));
          if (blocked.length) {
            throw new FetchError(
              "BLOCKED_ADDRESS",
              `${hostname} resolves to a non-public address`,
              { addresses: blocked.map((a) => a.address) },
            );
          }
          let usable = opts.family
            ? list.filter((a) => a.family === opts.family)
            : list;
          if (usable.length === 0) usable = list;
          usable.forEach((a) => validated.add(a.address));
          if (opts.all)
            callback(
              null,
              usable.map((a) => ({
                address: a.address,
                family: a.family || net.isIP(a.address),
              })),
            );
          else
            callback(
              null,
              usable[0].address,
              usable[0].family || net.isIP(usable[0].address),
            );
        })
        .catch((error) =>
          callback(
            error.code ? error : new FetchError("DNS_FAILURE", error.message),
          ),
        );
    };
  }

  async function politeWait(host) {
    const now = Date.now();
    const slot = Math.max(now, nextSlot.get(host) ?? 0);
    nextSlot.set(host, slot + limits.hostIntervalMs);
    if (slot > now) await sleep(slot - now);
  }

  /** One HTTPS GET without following redirects. */
  function requestOnce(
    url,
    { accept, allowedTypes, maxBytes, truncate = false },
  ) {
    return new Promise((resolvePromise, reject) => {
      const validated = new Set();
      const agent = new https.Agent({ keepAlive: false, maxCachedSessions: 0 });
      let settled = false;
      const timers = [];
      const finish = (error, value) => {
        if (settled) return;
        settled = true;
        timers.forEach(clearTimeout);
        agent.destroy();
        if (error) reject(error);
        else resolvePromise(value);
      };
      const fail = (error) => {
        req.destroy();
        finish(error);
      };

      const req = https.request(url, {
        method: "GET",
        agent,
        lookup: lookupFor(validated),
        servername: url.hostname,
        rejectUnauthorized: true,
        ca,
        headers: {
          "user-agent": userAgent,
          accept,
          "accept-encoding": "gzip, deflate, br",
          "accept-language": "en, fr;q=0.8",
        },
      });

      timers.push(
        setTimeout(
          () =>
            fail(
              new FetchError(
                "TOTAL_TIMEOUT",
                `No complete response within ${limits.totalTimeoutMs} ms`,
              ),
            ),
          limits.totalTimeoutMs,
        ),
      );
      timers.push(
        setTimeout(
          () =>
            fail(
              new FetchError(
                "HEADERS_TIMEOUT",
                `No response headers within ${limits.headersTimeoutMs} ms`,
              ),
            ),
          limits.headersTimeoutMs,
        ),
      );
      const headersTimer = timers[1];

      req.on("socket", (socket) => {
        const connectTimer = setTimeout(
          () =>
            fail(
              new FetchError(
                "CONNECT_TIMEOUT",
                `Connection/TLS not established within ${limits.connectTimeoutMs} ms`,
              ),
            ),
          limits.connectTimeoutMs,
        );
        timers.push(connectTimer);
        socket.once("secureConnect", () => {
          clearTimeout(connectTimer);
          stats.connections++;
          // Defence in depth: the peer must be an address that passed the lookup check.
          if (!validated.has(socket.remoteAddress)) {
            fail(
              new FetchError(
                "BLOCKED_ADDRESS",
                `Connected to unvalidated address ${socket.remoteAddress}`,
              ),
            );
          }
        });
      });

      req.on("error", (error) => {
        if (error instanceof FetchError) return finish(error);
        if (
          /CERT|SSL|TLS|self.signed|altnames|UNABLE_TO|DEPTH_ZERO/i.test(
            `${error.code} ${error.message}`,
          )
        ) {
          return finish(new FetchError("TLS_ERROR", error.message));
        }
        finish(
          new FetchError(
            "NETWORK_ERROR",
            `${error.code ?? ""} ${error.message}`.trim(),
          ),
        );
      });

      req.on("response", async (res) => {
        clearTimeout(headersTimer);
        const status = res.statusCode ?? 0;
        const remoteAddress = res.socket?.remoteAddress ?? "";
        if ([301, 302, 303, 307, 308].includes(status)) {
          res.resume();
          const location = res.headers.location;
          if (!location)
            return fail(
              new FetchError(
                "HTTP_STATUS",
                `Redirect ${status} without Location`,
              ),
            );
          return finish(null, {
            status,
            redirect: new URL(location, url).href,
            remoteAddress,
          });
        }
        if (status !== 200) {
          res.resume();
          return fail(
            new FetchError("HTTP_STATUS", `HTTP ${status}`, { status }),
          );
        }
        const contentType = String(
          res.headers["content-type"] ?? "",
        ).toLowerCase();
        const mime = contentType.split(";")[0].trim();
        if (allowedTypes && !allowedTypes.includes(mime)) {
          res.resume();
          return fail(
            new FetchError(
              "UNSUPPORTED_CONTENT_TYPE",
              `Content type "${mime || "missing"}" is not accepted`,
            ),
          );
        }
        const declared = Number(res.headers["content-length"]);
        if (!truncate && Number.isFinite(declared) && declared > maxBytes) {
          res.resume();
          return fail(
            new FetchError(
              "TOO_LARGE",
              `Declared size ${declared} exceeds ${maxBytes} bytes`,
            ),
          );
        }
        const encoding = String(res.headers["content-encoding"] ?? "identity")
          .toLowerCase()
          .trim();
        const decoders = {
          gzip: zlib.createGunzip,
          "x-gzip": zlib.createGunzip,
          deflate: zlib.createInflate,
          br: zlib.createBrotliDecompress,
        };
        let stream = res;
        if (encoding !== "identity" && encoding !== "") {
          if (!decoders[encoding]) {
            res.resume();
            return fail(
              new FetchError(
                "UNSUPPORTED_ENCODING",
                `Content-Encoding "${encoding}" is not supported`,
              ),
            );
          }
          stream = decoders[encoding]();
          res.pipe(stream);
          res.on("error", (e) => stream.destroy(e));
        }
        let idle = setTimeout(
          () =>
            fail(
              new FetchError(
                "BODY_TIMEOUT",
                `Body stalled for ${limits.bodyIdleTimeoutMs} ms`,
              ),
            ),
          limits.bodyIdleTimeoutMs,
        );
        timers.push(idle);
        const chunks = [];
        let total = 0;
        let truncated = false;
        try {
          for await (const chunk of stream) {
            clearTimeout(idle);
            idle = setTimeout(
              () =>
                fail(
                  new FetchError(
                    "BODY_TIMEOUT",
                    `Body stalled for ${limits.bodyIdleTimeoutMs} ms`,
                  ),
                ),
              limits.bodyIdleTimeoutMs,
            );
            timers.push(idle);
            if (settled) return;
            total += chunk.length;
            if (total > maxBytes) {
              if (!truncate)
                return fail(
                  new FetchError(
                    "TOO_LARGE",
                    `Body exceeds ${maxBytes} bytes after decoding`,
                  ),
                );
              chunks.push(chunk.subarray(0, chunk.length - (total - maxBytes)));
              total = maxBytes;
              truncated = true;
              break;
            }
            chunks.push(chunk);
          }
        } catch (error) {
          return fail(
            error instanceof FetchError
              ? error
              : new FetchError(
                  "NETWORK_ERROR",
                  `Body read failed: ${error.message}`,
                ),
          );
        }
        if (settled) return;
        if (truncated) req.destroy();
        finish(null, {
          status,
          contentType,
          body: Buffer.concat(chunks),
          bytes: total,
          truncated,
          remoteAddress,
        });
      });

      req.end();
    });
  }

  /** GET with manual, re-validated, same-site redirects and robots checks per hop. */
  async function get(
    rawUrl,
    { accept, allowedTypes, maxBytes, truncate, checkRobots = true },
  ) {
    const start = checkUrl(rawUrl, { allowedPorts });
    const hops = [];
    let current = start;
    for (let hop = 0; ; hop++) {
      if (sourcePolicy) {
        const verdict = evaluateSource(current.href, sourcePolicy);
        if (verdict.status === "excluded")
          throw new FetchError(
            "SOURCE_EXCLUDED",
            `${current.hostname} is excluded by source policy: ${verdict.reason}`,
          );
      }
      if (checkRobots && !(await isAllowedByRobots(current))) {
        throw new FetchError(
          "ROBOTS_DISALLOWED",
          `robots.txt disallows ${current.pathname}`,
          { url: current.href },
        );
      }
      await politeWait(current.hostname);
      const response = await requestOnce(current, {
        accept,
        allowedTypes,
        maxBytes,
        truncate,
      });
      hops.push({
        url: current.href,
        status: response.status,
        address: response.remoteAddress,
      });
      if (!response.redirect)
        return { ...response, finalUrl: current.href, hops };
      if (hop >= limits.maxRedirects)
        throw new FetchError(
          "TOO_MANY_REDIRECTS",
          `More than ${limits.maxRedirects} redirects`,
          { hops },
        );
      const next = checkUrl(response.redirect, { allowedPorts });
      if (!sameSite(start.href, next.href)) {
        throw new FetchError(
          "CROSS_SITE_REDIRECT",
          `Redirect leaves ${siteOf(start.hostname)} for ${next.hostname}`,
          { hops },
        );
      }
      current = next;
    }
  }

  /** robots.txt per origin. 2xx: rules apply. 404/410/other 4xx: allowed.
   *  401/403, 5xx, timeouts or network errors: disallowed (conservative). */
  async function isAllowedByRobots(url) {
    const origin = url.origin;
    if (!robotsCache.has(origin)) {
      robotsCache.set(
        origin,
        (async () => {
          try {
            const response = await get(`${origin}/robots.txt`, {
              accept: "text/plain",
              allowedTypes: null,
              maxBytes: limits.robotsMaxBytes,
              truncate: true,
              checkRobots: false,
            });
            return { groups: parseRobots(response.body.toString("utf8")) };
          } catch (error) {
            const status = error.details?.status;
            if (
              error.code === "HTTP_STATUS" &&
              status >= 400 &&
              status < 500 &&
              status !== 401 &&
              status !== 403
            )
              return { groups: [] };
            // Problems with the host itself are reported as such, not as a robots decision.
            if (
              [
                "BLOCKED_ADDRESS",
                "BLOCKED_HOST",
                "DNS_FAILURE",
                "TLS_ERROR",
                "SOURCE_EXCLUDED",
              ].includes(error.code)
            )
              return { error };
            return { disallowAll: true, reason: error.code };
          }
        })(),
      );
    }
    const robots = await robotsCache.get(origin);
    if (robots.error) throw robots.error;
    if (robots.disallowAll) return false;
    return robotsAllows(robots.groups, robotsToken, url.pathname + url.search);
  }

  /**
   * Fetches an article and extracts metadata, text and an evidence package.
   * Returns { ok: true, ... } or { ok: false, code, message } — never throws.
   */
  async function fetchArticle(rawUrl) {
    const fetchedAt = new Date().toISOString();
    try {
      const response = await get(rawUrl, {
        accept: "text/html,application/xhtml+xml;q=0.9",
        allowedTypes: HTML_TYPES,
        maxBytes: limits.maxBytes,
      });
      const html = decodeBody(response.body, response.contentType);
      const article = extractArticle(html);
      // A /YYYY/MM/DD/ path is a common blog convention; recorded as a weak date source.
      const pathDate = new URL(response.finalUrl).pathname.match(
        /\/(20\d{2})\/(\d{2})\/(\d{2})(?:\/|$)/,
      );
      if (pathDate)
        article.dateCandidates.push({
          source: "url.path",
          value: `${pathDate[1]}-${pathDate[2]}-${pathDate[3]}`,
          weak: true,
        });
      if (article.text.length < limits.minTextChars) {
        return {
          ok: false,
          code: "INSUFFICIENT_TEXT",
          message: `Only ${article.text.length} characters of article text; page may be paywalled or script-rendered`,
          finalUrl: response.finalUrl,
          fetchedAt,
        };
      }
      return {
        ok: true,
        requestedUrl: rawUrl,
        finalUrl: response.finalUrl,
        hops: response.hops,
        contentType: response.contentType,
        bytes: response.bytes,
        fetchedAt,
        article,
        evidence: buildEvidence(article),
      };
    } catch (error) {
      if (error instanceof FetchError)
        return {
          ok: false,
          code: error.code,
          message: error.message,
          details: error.details,
          fetchedAt,
        };
      return {
        ok: false,
        code: "NETWORK_ERROR",
        message: error.message,
        fetchedAt,
      };
    }
  }

  return { fetchArticle, get, isAllowedByRobots, stats, limits };
}

/** Decodes HTML bytes using the declared or <meta> charset (default UTF-8). */
export function decodeBody(buffer, contentType = "") {
  let label = /charset\s*=\s*["']?([\w-]+)/i.exec(contentType)?.[1];
  if (!label) {
    const head = buffer.subarray(0, 2048).toString("latin1");
    label = /<meta[^>]+charset\s*=\s*["']?([\w-]+)/i.exec(head)?.[1];
  }
  try {
    return new TextDecoder(label ?? "utf-8").decode(buffer);
  } catch {
    return new TextDecoder("utf-8").decode(buffer);
  }
}

// CLI: node scripts/tech-brief/fetch.mjs <url> [--policy path] [--text]
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const args = process.argv.slice(2);
  const url = args.find((a) => !a.startsWith("--"));
  const policyIndex = args.indexOf("--policy");
  const policyPath =
    policyIndex >= 0
      ? args[policyIndex + 1]
      : new URL("./sources.json", import.meta.url);
  if (!url) {
    console.error(
      "Usage: node scripts/tech-brief/fetch.mjs <https-url> [--policy sources.json] [--text]",
    );
    process.exit(2);
  }
  const fetcher = createFetcher({
    sourcePolicy: await loadSourcePolicy(policyPath),
  });
  const result = await fetcher.fetchArticle(url);
  if (result.ok && !args.includes("--text")) {
    result.article = {
      ...result.article,
      paragraphs: `${result.article.paragraphs.length} paragraphs`,
      text: `${result.article.text.length} chars`,
    };
    result.evidence = {
      ...result.evidence,
      paragraphs: result.evidence.paragraphs.slice(0, 3),
    };
  }
  console.log(JSON.stringify(result, null, 2));
  process.exit(result.ok ? 0 : 1);
}
