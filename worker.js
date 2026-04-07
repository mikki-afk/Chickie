// Chickie Cloudflare Worker — Level 2
// Functions:
//  - CORS proxy for Notion API (/v1/... or ?url=...)
//  - GET  /state         : read game state from KV
//  - POST /state         : upload game state from frontend (sync)
//  - scheduled (cron 1m) : tick stats + process Notion instructions + write snapshots
//
// Bindings required:
//   KV namespace   STATE  (id = 54e21a8b969b40bf9eb29f5e06d982f6)
//   Secret         NOTION_TOKEN
//   Secret         NOTION_DB

const NOTION_VER = "2022-06-28";
const STATE_KEY = "S";

export default {
  async fetch(req, env, ctx) {
    const url = new URL(req.url);
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors() });

    // State endpoints
    if (url.pathname === "/state") {
      if (req.method === "GET") {
        const s = await env.STATE.get(STATE_KEY);
        return new Response(s || "null", { headers: { ...cors(), "Content-Type": "application/json" } });
      }
      if (req.method === "POST") {
        const body = await req.text();
        await env.STATE.put(STATE_KEY, body);
        return new Response(JSON.stringify({ ok: true }), { headers: { ...cors(), "Content-Type": "application/json" } });
      }
    }

    // CORS proxy for Notion
    let target;
    if (url.pathname.startsWith("/v1/")) {
      target = "https://api.notion.com" + url.pathname + url.search;
    } else {
      const t = url.searchParams.get("url");
      if (!t) return new Response("not found", { status: 404, headers: cors() });
      target = t;
    }
    const h = new Headers(req.headers);
    h.delete("host"); h.delete("origin"); h.delete("referer");
    const r = await fetch(target, { method: req.method, headers: h, body: req.method === "GET" || req.method === "HEAD" ? undefined : req.body });
    const rh = new Headers(r.headers);
    for (const [k, v] of Object.entries(cors())) rh.set(k, v);
    return new Response(r.body, { status: r.status, headers: rh });
  },

  async scheduled(event, env, ctx) {
    ctx.waitUntil(tickAndProcess(env));
  }
};

function cors() {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET,POST,PATCH,DELETE,OPTIONS",
    "Access-Control-Allow-Headers": "Authorization,Content-Type,Notion-Version"
  };
}

function nH(env) {
  return {
    "Authorization": "Bearer " + env.NOTION_TOKEN,
    "Notion-Version": NOTION_VER,
    "Content-Type": "application/json"
  };
}

const cl = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

// ====== GAME TICK ======
function tickState(S) {
  if (!S || !Array.isArray(S.chickens)) return S;
  const now = Date.now();
  const lastTick = S._lastTick || now;
  const mins = Math.min(240, (now - lastTick) / 60000); // cap 4h
  if (mins < 0.5) return S;
  S._lastTick = now;

  for (const c of S.chickens) {
    if (!c.sleeping) {
      c.hunger = cl((c.hunger ?? 100) - 0.8 * mins, 0, 100);
      c.thirst = cl((c.thirst ?? 100) - 1.0 * mins, 0, 100);
      c.clean = cl((c.clean ?? 100) - 0.5 * mins, 0, 100);
      c.happiness = cl((c.happiness ?? 100) - 0.4 * mins, 0, 100);
      c.fatigue = cl((c.fatigue ?? 0) + 0.6 * mins, 0, 100);
    } else {
      c.fatigue = cl((c.fatigue ?? 0) - 1.5 * mins, 0, 100);
      c.hunger = cl((c.hunger ?? 100) - 0.2 * mins, 0, 100);
      c.thirst = cl((c.thirst ?? 100) - 0.2 * mins, 0, 100);
      if (c.fatigue <= 0) c.sleeping = false;
    }
    // Health drift
    const low = (c.hunger < 20) + (c.thirst < 20) + (c.clean < 20);
    if (low >= 2) c.health = cl((c.health ?? 100) - 0.5 * mins, 0, 100);
    else if (c.hunger > 60 && c.thirst > 60 && c.clean > 60) c.health = cl((c.health ?? 100) + 0.2 * mins, 0, 100);
    // Poop
    if (!c.sleeping && Math.random() < 0.05 * mins) {
      S.poops = S.poops || [];
      if (S.poops.length < 20) S.poops.push({ x: Math.random() * 90 + 5, y: Math.random() * 60 + 20, t: now });
    }
  }
  return S;
}

// ====== INSTRUCTION HANDLING ======
function handleInstruction(cmd, S) {
  const names = S.chickens.map(c => c.name);
  const find = n => names.indexOf(n);
  let log = null, matched = false;

  // status queries
  const allAlias = ["看看全部","全部状态","状态报告","看看大家","看看所有","查看全部","查看所有","大家状态","所有状态","报告状态","报告","看看","汇报","全家状态"];
  if (allAlias.includes(cmd)) return { matched: true, log: reportAll(S), type: "状态", chicken: "全部" };
  let m = cmd.match(/^(?:看看|查看|瞅瞅|瞧瞧)(.+)$/) || cmd.match(/^(.+?)(?:状态|怎么样|咋样|如何|的情况|近况)$/);
  if (m) { const i = find(m[1].trim()); if (i >= 0) return { matched: true, log: reportOne(S.chickens[i], S), type: "状态", chicken: S.chickens[i].name }; }

  // 喂XX
  m = cmd.match(/^给(.+?)喂(?!药)(.+)$/);
  if (m) { const i = find(m[1]); if (i >= 0) { const c = S.chickens[i]; c.hunger = cl(c.hunger + 30, 0, 100); S.food = Math.max(0, (S.food || 0) - 1); return { matched: true, log: `📋 [后台] 给${c.name}喂了${m[2]} · 饱食${Math.round(c.hunger)}`, type: "吃饭", chicken: c.name, stats: c }; } }
  // 喂药
  m = cmd.match(/^给(.+?)喂.*药$/);
  if (m) { const i = find(m[1]); if (i >= 0) { const c = S.chickens[i]; c.health = cl(c.health + 30, 0, 100); return { matched: true, log: `📋 [后台] 给${c.name}喂药了 · 健康${Math.round(c.health)}`, type: "喂药", chicken: c.name, stats: c }; } }
  // 喝
  m = cmd.match(/^给(.+?)喝(.+)$/);
  if (m) { const i = find(m[1]); if (i >= 0) { const c = S.chickens[i]; c.thirst = cl(c.thirst + 30, 0, 100); return { matched: true, log: `📋 [后台] 给${c.name}喝了${m[2]} · 水分${Math.round(c.thirst)}`, type: "喝水", chicken: c.name, stats: c }; } }
  // 洗澡
  m = cmd.match(/^给(.+?)洗澡$/);
  if (m) { const i = find(m[1]); if (i >= 0) { const c = S.chickens[i]; c.clean = cl(c.clean + 30, 0, 100); c.happiness = cl(c.happiness + 5, 0, 100); return { matched: true, log: `📋 [后台] ${c.name}洗了个澡 · 清洁${Math.round(c.clean)}`, type: "洗澡", chicken: c.name, stats: c }; } }
  // 让XX玩
  m = cmd.match(/^让(.+?)玩$/);
  if (m) { const i = find(m[1]); if (i >= 0) { const c = S.chickens[i]; c.happiness = cl(c.happiness + 20, 0, 100); c.hunger = cl(c.hunger - 10, 0, 100); return { matched: true, log: `📋 [后台] ${c.name}玩了一会儿 · 快乐${Math.round(c.happiness)}`, type: "玩耍", chicken: c.name, stats: c }; } }
  // 让XX睡觉
  m = cmd.match(/^让(.+?)睡觉$/);
  if (m) { const i = find(m[1]); if (i >= 0) { const c = S.chickens[i]; c.sleeping = true; return { matched: true, log: `📋 [后台] ${c.name}去睡觉了 💤`, type: "睡觉", chicken: c.name, stats: c }; } }
  // 叫醒XX
  m = cmd.match(/^叫醒(.+)$/);
  if (m) { const i = find(m[1]); if (i >= 0) { const c = S.chickens[i]; c.sleeping = false; return { matched: true, log: `📋 [后台] 叫醒了${c.name}`, type: "睡觉", chicken: c.name, stats: c }; } }
  // 全部吃饭/喝水/洗澡/玩/睡觉/叫醒
  if (/^(全部|都|一起)吃饭$/.test(cmd)) { S.chickens.forEach(c => { if (!c.sleeping) { c.hunger = cl(c.hunger + 30, 0, 100); S.food = Math.max(0, (S.food || 0) - 1); } }); return { matched: true, log: `📋 [后台] 全部小鸡都吃饭了`, type: "吃饭", chicken: "全部" }; }
  if (/^(全部|都|一起)喝水$/.test(cmd)) { S.chickens.forEach(c => c.thirst = cl(c.thirst + 30, 0, 100)); return { matched: true, log: `📋 [后台] 全部小鸡都喝水了`, type: "喝水", chicken: "全部" }; }
  if (/^(全部|都|一起)洗澡$/.test(cmd)) { S.chickens.forEach(c => { c.clean = cl(c.clean + 30, 0, 100); c.happiness = cl(c.happiness + 5, 0, 100); }); return { matched: true, log: `📋 [后台] 全部小鸡都洗澡了`, type: "洗澡", chicken: "全部" }; }
  if (/^(全部|都|一起)玩$/.test(cmd)) { S.chickens.forEach(c => { c.happiness = cl(c.happiness + 20, 0, 100); c.hunger = cl(c.hunger - 10, 0, 100); }); return { matched: true, log: `📋 [后台] 全部小鸡都玩了`, type: "玩耍", chicken: "全部" }; }
  if (/^(全部|都|一起)睡觉$/.test(cmd)) { S.chickens.forEach(c => c.sleeping = true); return { matched: true, log: `📋 [后台] 全部小鸡都睡了 💤`, type: "睡觉", chicken: "全部" }; }
  if (/^(全部|都)叫醒$/.test(cmd)) { S.chickens.forEach(c => c.sleeping = false); return { matched: true, log: `📋 [后台] 全部小鸡都被叫醒了`, type: "睡觉", chicken: "全部" }; }
  // 暖气/照灯
  m = cmd.match(/^给(.+?)(?:开|调)暖气(\d*)$/);
  if (m) { const i = find(m[1]); if (i >= 0) { S.chickens[i].heater = cl(parseInt(m[2]) || 3, 0, 5); return { matched: true, log: `📋 [后台] ${S.chickens[i].name}暖气${S.chickens[i].heater}级`, type: "状态", chicken: S.chickens[i].name, stats: S.chickens[i] }; } }
  m = cmd.match(/^给(.+?)关暖气$/);
  if (m) { const i = find(m[1]); if (i >= 0) { S.chickens[i].heater = 0; return { matched: true, log: `📋 [后台] ${S.chickens[i].name}关了暖气`, type: "状态", chicken: S.chickens[i].name, stats: S.chickens[i] }; } }
  // 加食物
  m = cmd.match(/^加食物(\d*)$/);
  if (m) { const a = parseInt(m[1]) || 5; S.food = cl((S.food || 0) + a, 0, 99); return { matched: true, log: `📋 [后台] 加了${a}份食物，现在${S.food}份`, type: "食物", chicken: "全部" }; }
  // 清粑粑
  if (cmd === "清粑粑") { const n = (S.poops || []).length; S.poops = []; return { matched: true, log: `📋 [后台] 清理了${n}坨粑粑`, type: "清粑粑", chicken: "全部" }; }

  return { matched: false };
}

function reportOne(c, S) {
  const stage = c.stage || "?";
  const loc = c.location === "inside" ? "🏠室内" : "🌳院子";
  return `🏡 ${c.name} ${stage} ${loc}\n❤️${Math.round(c.hunger)} 😊${Math.round(c.happiness)} 💧${Math.round(c.thirst)} 🛁${Math.round(c.clean)} 💚${Math.round(c.health)} 😴${Math.round(c.fatigue)}\n${c.sleeping ? "💤 睡眠中" : ""}`;
}
function reportAll(S) {
  return `🤖 后台 · 共 ${S.chickens.length} 家 · 🌾食物${S.food || 0} 💩${(S.poops || []).length}\n\n` + S.chickens.map(c => reportOne(c, S)).join("\n\n══════════\n\n");
}

async function tickAndProcess(env) {
  if (!env.STATE || !env.NOTION_TOKEN || !env.NOTION_DB) return;
  const raw = await env.STATE.get(STATE_KEY);
  if (!raw) return; // no state yet — frontend hasn't uploaded
  let S;
  try { S = JSON.parse(raw); } catch (e) { return; }

  // 1) Tick
  tickState(S);

  // 2) Pull unexecuted instructions
  const q = await fetch(`https://api.notion.com/v1/databases/${env.NOTION_DB}/query`, {
    method: "POST", headers: nH(env),
    body: JSON.stringify({
      filter: { and: [{ property: "是指令", checkbox: { equals: true } }, { property: "已执行", checkbox: { equals: false } }] },
      sorts: [{ timestamp: "created_time", direction: "ascending" }], page_size: 20
    })
  });
  if (q.ok) {
    const data = await q.json();
    for (const page of data.results || []) {
      const cmd = (page.properties?.Name?.title?.[0]?.plain_text || "").trim();
      if (!cmd) continue;
      const r = handleInstruction(cmd, S);
      if (r.matched) {
        // Create reply entry
        await fetch(`https://api.notion.com/v1/pages`, {
          method: "POST", headers: nH(env),
          body: JSON.stringify({
            parent: { database_id: env.NOTION_DB },
            properties: {
              "Name": { title: [{ text: { content: "🤖 " + (r.log || cmd) } }] },
              "小鸡": { select: { name: r.chicken || "全部" } },
              "类型": { select: { name: r.type || "状态" } },
              "时间": { date: { start: new Date().toISOString() } },
              "详情": { rich_text: chunk(r.log || "") },
              "指令返回": { checkbox: true },
              ...(r.stats ? statProps(r.stats) : {})
            }
          })
        });
      } else {
        await fetch(`https://api.notion.com/v1/pages`, {
          method: "POST", headers: nH(env),
          body: JSON.stringify({
            parent: { database_id: env.NOTION_DB },
            properties: {
              "Name": { title: [{ text: { content: "🤖 [后台] 无法理解: " + cmd } }] },
              "类型": { select: { name: "状态" } },
              "时间": { date: { start: new Date().toISOString() } },
              "指令返回": { checkbox: true }
            }
          })
        });
      }
      // mark done
      await fetch(`https://api.notion.com/v1/pages/${page.id}`, {
        method: "PATCH", headers: nH(env),
        body: JSON.stringify({ properties: { "已执行": { checkbox: true }, "执行时间": { date: { start: new Date().toISOString() } } } })
      });
    }
  }

  // 3) Save state
  await env.STATE.put(STATE_KEY, JSON.stringify(S));
}

function statProps(c) {
  return {
    "饱食": { number: Math.round(c.hunger) },
    "快乐": { number: Math.round(c.happiness) },
    "水分": { number: Math.round(c.thirst) },
    "清洁": { number: Math.round(c.clean) },
    "健康": { number: Math.round(c.health) },
    "疲惫": { number: Math.round(c.fatigue) }
  };
}

function chunk(s) {
  if (!s) return [{ text: { content: "" } }];
  const out = [];
  while (s.length > 1900) { out.push({ text: { content: s.slice(0, 1900) } }); s = s.slice(1900); }
  out.push({ text: { content: s } });
  return out;
}
