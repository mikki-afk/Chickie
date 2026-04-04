// Notion CORS Proxy - 小鸡养成系统专用
// 用法: node proxy.js
// 然后在游戏 Notion 设置里把代理地址改成: http://localhost:3456/proxy?url=

const http = require("http");
const https = require("https");
const { URL } = require("url");

const PORT = 3456;

http.createServer((req, res) => {
  // CORS headers
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Notion-Version");

  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  const u = new URL(req.url, `http://localhost:${PORT}`);
  const target = u.searchParams.get("url");
  if (!target || !target.startsWith("https://api.notion.com/")) {
    res.writeHead(400); res.end("Only Notion API allowed"); return;
  }

  const dest = new URL(target);
  let body = [];
  req.on("data", c => body.push(c));
  req.on("end", () => {
    const opts = {
      hostname: dest.hostname, path: dest.pathname + dest.search,
      method: req.method,
      headers: { ...req.headers, host: dest.hostname }
    };
    delete opts.headers["origin"];
    delete opts.headers["referer"];

    const proxy = https.request(opts, pRes => {
      res.writeHead(pRes.statusCode, pRes.headers);
      pRes.pipe(res);
    });
    proxy.on("error", e => { res.writeHead(502); res.end(e.message); });
    if (body.length) proxy.write(Buffer.concat(body));
    proxy.end();
  });
}).listen(PORT, () => console.log(`🐥 Notion proxy running on http://localhost:${PORT}`));
