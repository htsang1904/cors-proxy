const express = require("express");
const cors = require("cors");
const { createProxyMiddleware } = require("http-proxy-middleware");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "public")));

app.use(
  "/proxy",
  createProxyMiddleware({
    changeOrigin: true,
    followRedirects: true,
    proxyTimeout: 15000,
    timeout: 15000,

    router: (req) => {
      if (!req.query.url) throw new Error("Missing url param");
      const targetUrl = new URL(req.query.url);
      return targetUrl.origin;
    },

    pathRewrite: (path, req) => {
      const targetUrl = new URL(req.query.url);
      return targetUrl.pathname + targetUrl.search;
    },

    onProxyReq: (proxyReq) => {
      proxyReq.setHeader(
        "User-Agent",
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"
      );
      proxyReq.setHeader("Accept", "*/*");
      proxyReq.setHeader("Accept-Encoding", "gzip, deflate, br");
    },

    onProxyRes: (proxyRes, req) => {
      console.log(
        "[PROXY]",
        proxyRes.statusCode,
        req.method,
        req.query.url
      );
    },

    onError: (err, req, res) => {
      console.error("Proxy error:", err.message);
      res.status(500).json({
        error: "Proxy error",
        detail: err.message,
      });
    },
  })
);

app.listen(PORT, () => {
  console.log(`Server running at http://localhost:${PORT}`);
});
