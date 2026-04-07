// Chickie Cloudflare Worker
// 功能：
//  1) /proxy?url=...  —— Notion CORS 代理（现有功能）
//  2) scheduled(cron) —— 每分钟轮询 Notion 指令 database，
//     处理"看看 / 状态 / 报告"类查询（读状态快照 entry 生成汇总），
//     其它动作类指令留给游戏前端处理。
//
// 部署：
//   wrangler deploy
//   在 dashboard 为该 worker 配置 Secrets:
//     NOTION_TOKEN   = ntn_xxx
//     NOTION_DB      = 3383f76c0e4f80a6bd7af4a5d1035477
//   并添加 Cron Trigger: * * * * *

const NOTION_VER = "2022-06-28";

export default {
  async fetch(req, env, ctx) {
    // ====== CORS Proxy 兼容 ======
    const url = new URL(req.url);
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: corsHeaders() });
    }
    // 支持 /v1/... 直通
    let target;
    if (url.pathname.startsWith("/v1/")) {
      target = "https://api.notion.com" + url.pathname + url.search;
    } else {
      const t = url.searchParams.get("url");
      if (!t) return new Response("missing url", { status: 400, headers: corsHeaders() });
      target = t;
    }
    const h = new Headers(req.headers);
    h.delete("host"); h.delete("origin"); h.delete("referer");
    const r = await fetch(target, { method: req.method, headers: h, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body });
    const rh = new Headers(r.headers);
    for (const [k, v] of Object.entries(corsHeaders())) rh.set(k, v);
    return new Response(r.body, { status: r.status, headers: rh });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(processInstructions(env));
  }
};

function corsHeaders() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Notion-Version"
  };
}

function notionHeaders(env) {
  return {
    "Authorization": "Bearer " + env.NOTION_TOKEN,
    "Notion-Version": NOTION_VER,
    "Content-Type": "application/json"
  };
}

async function processInstructions(env) {
  if (!env.NOTION_TOKEN || !env.NOTION_DB) return;
  // 1) 拉未执行的指令
  const q = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DB}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: { and: [
        { property: "是指令", checkbox: { equals: true } },
        { property: "已执行", checkbox: { equals: false } }
      ]},
      sorts: [{ timestamp: "created_time", direction: "ascending" }],
      page_size: 20
    })
  });
  if (!q.ok) return;
  const data = await q.json();
  if (!data.results || !data.results.length) return;

  // 2) 拉最新的每只鸡状态快照
  const snap = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DB}/query`, {
    method: "POST",
    headers: notionHeaders(env),
    body: JSON.stringify({
      filter: { property: "类型", select: { equals: "状态快照" } },
      sorts: [{ timestamp: "last_edited_time", direction: "descending" }],
      page_size: 50
    })
  });
  const snapData = snap.ok ? await snap.json() : { results: [] };
  // name -> page
  const byName = {};
  for (const p of snapData.results) {
    const nm = p.properties?.["小鸡"]?.select?.name;
    if (nm && !byName[nm]) byName[nm] = p;
  }

  for (const page of data.results) {
    const cmd = (page.properties?.Name?.title?.[0]?.plain_text || "").trim();
    if (!cmd) continue;

    const report = handleCmd(cmd, byName);
    if (report) {
      // 创建汇报 entry
      await fetch(`https://api.notion.com/v1/pages`, {
        method: "POST",
        headers: notionHeaders(env),
        body: JSON.stringify({
          parent: { database_id: env.NOTION_DB },
          properties: {
            "Name": { title: [{ text: { content: "🤖 [后台] " + cmd } }] },
            "小鸡": { select: { name: report.chicken || "全部" } },
            "类型": { select: { name: "状态" } },
            "时间": { date: { start: new Date().toISOString() } },
            "详情": { rich_text: chunk(report.content) },
            "指令返回": { checkbox: true }
          }
        })
      });
      await markDone(env, page.id);
    } else {
      // 非状态查询：留给前端处理，不动它
    }
  }
}

function chunk(s) {
  const out = [];
  while (s.length > 1900) { out.push({ text: { content: s.slice(0, 1900) } }); s = s.slice(1900); }
  out.push({ text: { content: s } });
  return out;
}

async function markDone(env, pageId) {
  await fetch(`https://api.notion.com/v1/pages/${pageId}`, {
    method: "PATCH",
    headers: notionHeaders(env),
    body: JSON.stringify({ properties: { "已执行": { checkbox: true }, "执行时间": { date: { start: new Date().toISOString() } } } })
  });
}

// 返回 {chicken, content} 或 null
function handleCmd(cmd, byName) {
  const allAliases = ["看看全部","全部状态","状态报告","看看大家","看看所有","查看全部","查看所有","大家状态","所有状态","报告状态","报告","看看","汇报","全家状态"];
  if (allAliases.includes(cmd)) {
    const names = Object.keys(byName);
    if (!names.length) return { chicken: "全部", content: "⚠️ 后台暂无状态快照，请先打开游戏同步一次。" };
    const parts = [`🤖 后台读取 · 共 ${names.length} 家`];
    for (const n of names) {
      parts.push("══════════════════");
      parts.push(snapshotText(byName[n]));
    }
    return { chicken: "全部", content: parts.join("\n\n") };
  }
  // 看看 XX / XX 状态
  let m = cmd.match(/^(?:看看|查看|瞅瞅|瞧瞧)(.+)$/) || cmd.match(/^(.+?)(?:状态|怎么样|咋样|如何|的情况|近况)$/);
  if (m) {
    const who = m[1].trim();
    if (byName[who]) return { chicken: who, content: snapshotText(byName[who]) };
    return { chicken: who, content: `⚠️ 后台暂无 ${who} 的快照。` };
  }
  return null;
}

function snapshotText(page) {
  const p = page.properties || {};
  const name = p["小鸡"]?.select?.name || "?";
  const stage = p["阶段"]?.select?.name || "";
  const stats = ["饱食","快乐","水分","清洁","健康","疲惫"].map(k => `${k}${p[k]?.number ?? "-"}`).join(" ");
  const detail = (p["详情"]?.rich_text || []).map(r => r.plain_text || r.text?.content || "").join("");
  const edited = page.last_edited_time?.slice(11,16) || "";
  return `🏡 ${name} ${stage}  (快照 ${edited})\n${stats}\n${detail}`;
}
