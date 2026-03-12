const assert = require("assert");
const http = require("http");

const { createApp } = require("../proxy-app");

function listen(server) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      resolve(server.address().port);
    });
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
        return;
      }

      resolve();
    });
  });
}

function request({ body, headers, method = "GET", path, port }) {
  return new Promise((resolve, reject) => {
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path,
        method,
        headers,
      },
      (res) => {
        let raw = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          raw += chunk;
        });
        res.on("end", () => {
          resolve({
            body: raw,
            headers: res.headers,
            status: res.statusCode,
          });
        });
      }
    );

    req.on("error", reject);

    if (body) {
      req.write(body);
    }

    req.end();
  });
}

async function withApp(config, callback) {
  const app = createApp(config);
  const server = http.createServer(app);
  const port = await listen(server);

  try {
    await callback(port);
  } finally {
    await close(server);
  }
}

async function run(name, testFn) {
  try {
    await testFn();
    console.log(`PASS ${name}`);
  } catch (error) {
    console.error(`FAIL ${name}`);
    console.error(error.stack);
    process.exitCode = 1;
  }
}

async function main() {
  await run("health endpoint returns ok", async () => {
    await withApp({}, async (port) => {
      const response = await request({ path: "/health", port });
      assert.strictEqual(response.status, 200);
      assert.deepStrictEqual(JSON.parse(response.body), { status: "ok" });
    });
  });

  await run("missing url returns json validation error", async () => {
    await withApp({}, async (port) => {
      const response = await request({ path: "/proxy", port });
      assert.strictEqual(response.status, 400);
      assert.match(response.headers["content-type"], /application\/json/);
      assert.match(response.body, /Missing required query parameter/);
    });
  });

  await run("proxy reflects browser origin by default", async () => {
    await withApp({}, async (port) => {
      const response = await request({
        headers: {
          Origin: "null",
        },
        path: "/proxy",
        port,
      });

      assert.strictEqual(response.status, 400);
      assert.strictEqual(response.headers["access-control-allow-origin"], "null");
      assert.match(response.headers.vary || "", /Origin/);
    });
  });

  await run("private targets are blocked by default", async () => {
    await withApp({}, async (port) => {
      const response = await request({
        path: "/proxy?url=" + encodeURIComponent("http://127.0.0.1:9999/test"),
        port,
      });

      assert.strictEqual(response.status, 403);
      assert.match(response.body, /Private network targets are blocked/);
    });
  });

  await run("host allowlist blocks non-permitted domains before proxying", async () => {
    await withApp({ hostAllowlist: ["api.example.com"] }, async (port) => {
      const response = await request({
        path: "/proxy?url=" + encodeURIComponent("https://example.com/data"),
        port,
      });

      assert.strictEqual(response.status, 403);
      assert.match(response.body, /PROXY_HOST_ALLOWLIST/);
    });
  });

  await run("proxy forwards request body to upstream", async () => {
    const upstreamMessages = [];
    const upstreamServer = http.createServer((req, res) => {
      let raw = "";

      req.on("data", (chunk) => {
        raw += chunk;
      });

      req.on("end", () => {
        upstreamMessages.push({
          body: raw,
          headers: req.headers,
          method: req.method,
          url: req.url,
        });

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, received: raw.length }));
      });
    });

    const upstreamPort = await listen(upstreamServer);

    try {
      await withApp({ allowPrivateNetworks: true }, async (proxyPort) => {
        const payload = JSON.stringify({ hello: "world" });
        const response = await request({
          body: payload,
          headers: {
            "Content-Length": Buffer.byteLength(payload),
            "Content-Type": "application/json",
          },
          method: "POST",
          path:
            "/proxy?url=" +
            encodeURIComponent(`http://127.0.0.1:${upstreamPort}/echo?x=1`),
          port: proxyPort,
        });

        assert.strictEqual(response.status, 200);
        assert.match(response.headers["content-type"], /application\/json/);
        assert.strictEqual(upstreamMessages.length, 1);
        assert.strictEqual(upstreamMessages[0].method, "POST");
        assert.strictEqual(upstreamMessages[0].url, "/echo?x=1");
        assert.strictEqual(upstreamMessages[0].body, payload);
      });
    } finally {
      await close(upstreamServer);
    }
  });

  await run("proxy forwards multipart form-data body to upstream", async () => {
    const upstreamMessages = [];
    const upstreamServer = http.createServer((req, res) => {
      let raw = "";

      req.on("data", (chunk) => {
        raw += chunk;
      });

      req.on("end", () => {
        upstreamMessages.push({
          body: raw,
          headers: req.headers,
          method: req.method,
          url: req.url,
        });

        res.setHeader("Content-Type", "application/json");
        res.end(JSON.stringify({ ok: true, received: raw.length }));
      });
    });

    const upstreamPort = await listen(upstreamServer);
    const boundary = "----CodexBoundary12345";
    const payload =
      `--${boundary}\r\n` +
      'Content-Disposition: form-data; name="link"\r\n\r\n' +
      "https://example.com/profile\r\n" +
      `--${boundary}--\r\n`;

    try {
      await withApp({ allowPrivateNetworks: true }, async (proxyPort) => {
        const response = await request({
          body: payload,
          headers: {
            "Content-Length": Buffer.byteLength(payload),
            "Content-Type": `multipart/form-data; boundary=${boundary}`,
          },
          method: "POST",
          path:
            "/proxy?url=" +
            encodeURIComponent(`http://127.0.0.1:${upstreamPort}/submit`),
          port: proxyPort,
        });

        assert.strictEqual(response.status, 200);
        assert.strictEqual(upstreamMessages.length, 1);
        assert.strictEqual(upstreamMessages[0].method, "POST");
        assert.strictEqual(upstreamMessages[0].url, "/submit");
        assert.match(
          upstreamMessages[0].headers["content-type"],
          /multipart\/form-data; boundary=----CodexBoundary12345/
        );
        assert.strictEqual(upstreamMessages[0].body, payload);
      });
    } finally {
      await close(upstreamServer);
    }
  });
}

main().catch((error) => {
  console.error(error.stack);
  process.exitCode = 1;
});
