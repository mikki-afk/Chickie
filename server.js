// 🐥 期期的小鸡养成系统 - 一键启动
// 用法: node server.js
// 然后浏览器打开 http://localhost:3000

const http = require("http");
const https = require("https");
const fs = require("fs");
const path = require("path");
const { URL } = require("url");

const PORT = 3000;

http.createServer((req, res) => {
  const u = new URL(req.url, `http://localhost:${PORT}`);

  // CORS headers for all responses
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PATCH, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, Notion-Version");

  // Preflight
  if (req.method === "OPTIONS") { res.writeHead(204); res.end(); return; }

  // Notion proxy
  if (u.pathname === "/notion") {
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
      delete opts.headers["connection"];

      const proxy = https.request(opts, pRes => {
        const h = { ...pRes.headers };
        h["access-control-allow-origin"] = "*";
        res.writeHead(pRes.statusCode, h);
        pRes.pipe(res);
      });
      proxy.on("error", e => { res.writeHead(502); res.end(e.message); });
      if (body.length) proxy.write(Buffer.concat(body));
      proxy.end();
    });
    return;
  }

  // Serve game files
  let filePath = u.pathname === "/" ? "/index.html" : u.pathname;
  filePath = path.join(__dirname, filePath);

  const ext = path.extname(filePath);
  const types = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css" };

  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end("Not found"); return; }
    res.writeHead(200, { "Content-Type": (types[ext] || "text/plain") + "; charset=utf-8" });
    res.end(data);
  });
}).listen(PORT, () => {
  console.log(`🐥 小鸡养成系统已启动！`);
  console.log(`🌐 打开浏览器访问: http://localhost:${PORT}`);
  console.log(`📝 Notion代理地址: http://localhost:${PORT}/notion?url=`);
});
