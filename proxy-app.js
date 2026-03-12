const express = require("express");
const cors = require("cors");
const path = require("path");
const { isIP } = require("net");
const {
  createProxyMiddleware,
  fixRequestBody,
} = require("http-proxy-middleware");

const DEFAULT_ALLOWED_PROTOCOLS = ["http:", "https:"];
const DEFAULT_TIMEOUT_MS = 15000;
const DEFAULT_METHODS = ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"];
const LOCAL_HOSTNAMES = new Set([
  "localhost",
  "host.docker.internal",
  "gateway.docker.internal",
]);

function parseList(value) {
  if (!value) return [];

  return String(value)
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function parseBoolean(value, fallback = false) {
  if (value === undefined) return fallback;
  return String(value).trim().toLowerCase() === "true";
}

function parseNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function normalizeProtocol(protocol) {
  if (!protocol) return null;
  return protocol.endsWith(":") ? protocol.toLowerCase() : `${protocol.toLowerCase()}:`;
}

function normalizeHostRule(rule) {
  return rule.trim().toLowerCase();
}

function hostMatchesRule(hostname, rule) {
  if (rule.startsWith("*.")) {
    const suffix = rule.slice(2);
    return hostname === suffix || hostname.endsWith(`.${suffix}`);
  }

  return hostname === rule;
}

function ipv4ToInt(ip) {
  return ip
    .split(".")
    .reduce((accumulator, octet) => ((accumulator << 8) + Number(octet)) >>> 0, 0);
}

function isIpv4InCidr(ip, base, prefixLength) {
  const mask =
    prefixLength === 0 ? 0 : ((0xffffffff << (32 - prefixLength)) >>> 0);

  return (ipv4ToInt(ip) & mask) === (ipv4ToInt(base) & mask);
}

function isPrivateIpv4(ip) {
  return [
    ["0.0.0.0", 8],
    ["10.0.0.0", 8],
    ["100.64.0.0", 10],
    ["127.0.0.0", 8],
    ["169.254.0.0", 16],
    ["172.16.0.0", 12],
    ["192.168.0.0", 16],
    ["198.18.0.0", 15],
  ].some(([base, prefixLength]) => isIpv4InCidr(ip, base, prefixLength));
}

function isPrivateIpv6(ip) {
  const normalized = ip.toLowerCase();

  if (normalized === "::1" || normalized === "::") return true;
  if (normalized.startsWith("fc") || normalized.startsWith("fd")) return true;
  if (normalized.startsWith("fe80:")) return true;

  if (normalized.startsWith("::ffff:")) {
    return isPrivateIpv4(normalized.slice(7));
  }

  return false;
}

function isPrivateHostname(hostname) {
  const normalized = hostname.toLowerCase();

  if (
    LOCAL_HOSTNAMES.has(normalized) ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local")
  ) {
    return true;
  }

  const ipVersion = isIP(normalized);
  if (ipVersion === 4) return isPrivateIpv4(normalized);
  if (ipVersion === 6) return isPrivateIpv6(normalized);

  return false;
}

function resolveConfig(overrides = {}) {
  const allowedProtocolsSource =
    overrides.allowedProtocols ||
    parseList(process.env.PROXY_ALLOWED_PROTOCOLS || "").map(normalizeProtocol);
  const allowedProtocols = new Set(
    allowedProtocolsSource.length
      ? allowedProtocolsSource.filter(Boolean)
      : DEFAULT_ALLOWED_PROTOCOLS
  );

  const hostAllowlistSource =
    overrides.hostAllowlist ||
    parseList(process.env.PROXY_HOST_ALLOWLIST || "").map(normalizeHostRule);
  const hostAllowlist = hostAllowlistSource.filter(Boolean);

  const corsOrigins =
    overrides.corsOrigins ||
    parseList(process.env.PROXY_CORS_ORIGINS || "").map((origin) =>
      origin.trim()
    );

  return {
    allowedProtocols,
    allowPrivateNetworks:
      overrides.allowPrivateNetworks ??
      parseBoolean(process.env.PROXY_ALLOW_PRIVATE_NETWORKS, false),
    corsOrigins,
    hostAllowlist,
    timeoutMs:
      overrides.timeoutMs ??
      parseNumber(process.env.PROXY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS),
  };
}

function createCorsMiddleware(config) {
  if (!config.corsOrigins.length || config.corsOrigins.includes("*")) {
    return cors({
      methods: DEFAULT_METHODS,
      origin: true,
      optionsSuccessStatus: 204,
    });
  }

  return cors({
    methods: DEFAULT_METHODS,
    origin(origin, callback) {
      if (!origin || config.corsOrigins.includes(origin)) {
        callback(null, true);
        return;
      }

      callback(null, false);
    },
    optionsSuccessStatus: 204,
  });
}

function validateTargetUrl(config) {
  return (req, res, next) => {
    const rawUrl = Array.isArray(req.query.url) ? req.query.url[0] : req.query.url;

    if (!rawUrl) {
      res.status(400).json({
        error: "Missing required query parameter `url`.",
      });
      return;
    }

    let targetUrl;
    try {
      targetUrl = new URL(rawUrl);
    } catch (error) {
      res.status(400).json({
        error: "Query parameter `url` must be a valid absolute URL.",
      });
      return;
    }

    if (!config.allowedProtocols.has(targetUrl.protocol)) {
      res.status(400).json({
        error: `Unsupported protocol \`${targetUrl.protocol}\`.`,
      });
      return;
    }

    const hostname = targetUrl.hostname.toLowerCase();

    if (
      config.hostAllowlist.length &&
      !config.hostAllowlist.some((rule) => hostMatchesRule(hostname, rule))
    ) {
      res.status(403).json({
        error: "Target host is not permitted by PROXY_HOST_ALLOWLIST.",
        host: hostname,
      });
      return;
    }

    if (!config.allowPrivateNetworks && isPrivateHostname(hostname)) {
      res.status(403).json({
        error:
          "Private network targets are blocked. Set PROXY_ALLOW_PRIVATE_NETWORKS=true for trusted internal targets.",
        host: hostname,
      });
      return;
    }

    req.targetUrl = targetUrl;
    next();
  };
}

function attachSecurityHeaders(req, res, next) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("Cross-Origin-Resource-Policy", "same-origin");
  next();
}

function configureApp(app, overrides = {}) {
  const config = resolveConfig(overrides);
  const corsMiddleware = createCorsMiddleware(config);

  app.disable("x-powered-by");
  app.use(attachSecurityHeaders);

  app.get("/health", (req, res) => {
    res.json({ status: "ok" });
  });

  app.get("/api/config", (req, res) => {
    res.json({
      allowPrivateNetworks: config.allowPrivateNetworks,
      corsMode:
        !config.corsOrigins.length || config.corsOrigins.includes("*")
          ? "reflect-origin"
          : "allowlist",
      corsOrigins: config.corsOrigins,
      hostAllowlist: config.hostAllowlist,
      timeoutMs: config.timeoutMs,
      allowedProtocols: Array.from(config.allowedProtocols),
    });
  });

  app.use(express.static(path.join(__dirname, "public")));

  app.options("/proxy", corsMiddleware);
  app.use(
    "/proxy",
    corsMiddleware,
    validateTargetUrl(config),
    createProxyMiddleware({
      changeOrigin: true,
      followRedirects: true,
      proxyTimeout: config.timeoutMs,
      timeout: config.timeoutMs,
      xfwd: true,
      router(req) {
        return req.targetUrl.origin;
      },
      pathRewrite(pathname, req) {
        return `${req.targetUrl.pathname}${req.targetUrl.search}`;
      },
      on: {
        error(err, req, res) {
          console.error("Proxy error:", err.message);

          if (res.headersSent) {
            return;
          }

          const statusCode = err.code === "ECONNRESET" ? 504 : 502;
          res.status(statusCode).json({
            error: "Upstream request failed.",
            detail: err.message,
          });
        },
        proxyReq(proxyReq, req) {
          fixRequestBody(proxyReq, req);
          proxyReq.removeHeader("origin");
          proxyReq.removeHeader("referer");

          if (!proxyReq.getHeader("user-agent")) {
            proxyReq.setHeader("user-agent", "cors-proxy/1.0");
          }
        },
        proxyRes(proxyRes, req) {
          const statusCode = proxyRes.statusCode || "-";
          const targetPath = `${req.targetUrl.hostname}${req.targetUrl.pathname}`;
          console.log(`[PROXY] ${statusCode} ${req.method} ${targetPath}`);
        },
      },
    })
  );

  app.use((err, req, res, next) => {
    console.error("Unhandled error:", err.message);

    if (res.headersSent) {
      next(err);
      return;
    }

    res.status(500).json({
      error: "Unexpected server error.",
    });
  });

  return app;
}

function createApp(overrides = {}) {
  const app = express();
  return configureApp(app, overrides);
}

module.exports = {
  configureApp,
  createApp,
  isPrivateHostname,
  resolveConfig,
};
