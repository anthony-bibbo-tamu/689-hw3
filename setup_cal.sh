#!/usr/bin/env bash
set -euo pipefail

echo "==> Milestone 4 setup starting..."

npm i googleapis date-fns

# Ensure .env.example has Google vars (idempotent)
if ! grep -q "GOOGLE_CLIENT_ID" .env.example 2>/dev/null; then
  cat >> .env.example <<'EOF'
# === Google OAuth (Gmail/Calendar) ===
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=
GOOGLE_REDIRECT_URI=http://127.0.0.1:53682/oauth2callback
EOF
fi

mkdir -p servers/calendar-mcp .tokens

cat > servers/calendar-mcp/index.js <<'EOF'
#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import http from "node:http";
import open from "open";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const TOKEN_PATH = path.resolve(".tokens/calendar.json");
const DEFAULT_TZ = process.env.CALENDAR_DEFAULT_TZ || "America/Chicago";
const SCOPES = [
  "https://www.googleapis.com/auth/calendar.events",
  "https://www.googleapis.com/auth/calendar.readonly",
];

function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://127.0.0.1:53682/oauth2callback";
  if (!clientId || !clientSecret) throw new Error("Missing GOOGLE_CLIENT_ID/SECRET");
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function ensureTokens(oauth2) {
  if (fs.existsSync(TOKEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oauth2.setCredentials(raw);
    return oauth2;
  }
  const port = Number(new URL(oauth2.redirectUri).port || 53682);
  const authUrl = oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) return;
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== "/oauth2callback") return;
      const code = u.searchParams.get("code");
      if (!code) throw new Error("No code");
      const { tokens } = await oauth2.getToken(code);
      oauth2.setCredentials(tokens);
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");
      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Calendar auth complete. You can close this tab.");
      server.close();
    } catch (e) {
      console.error("[calendar-mcp] getToken error:", e?.response?.data || e);
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Auth error. Check console.");
      server.close();
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.error("[calendar-mcp] Opening browser for Google OAuth...");
  await open(authUrl);
  console.error("[calendar-mcp] Waiting for OAuth callback on", oauth2.redirectUri);
  await new Promise((resolve) => server.on("close", resolve));
  return oauth2;
}

async function getCalendar() {
  const oauth2 = getOAuth2Client();
  await ensureTokens(oauth2);
  return google.calendar({ version: "v3", auth: oauth2 });
}

const server = new Server(
  { name: "calendar-mcp", version: "0.1.0", description: "Google Calendar tools" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "calendar_profile",
    description: "Get primary calendar timezone",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "calendar_list_events",
    description: "List events in a time window (ISO times)",
    inputSchema: {
      type: "object",
      properties: {
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        maxResults: { type: "number" },
        q: { type: "string" },
        timeZone: { type: "string" }
      },
      required: ["timeMin", "timeMax"]
    },
  },
  {
    name: "calendar_create_event",
    description: "Create an event on primary calendar",
    inputSchema: {
      type: "object",
      properties: {
        summary: { type: "string" },
        start: { type: "string" },
        end: { type: "string" },
        attendees: { type: "array", items: { type: "string" } },
        location: { type: "string" },
        description: { type: "string" },
        timeZone: { type: "string" }
      },
      required: ["summary", "start", "end"]
    },
  },
  {
    name: "calendar_find_free",
    description: "Find first free slot of given duration within a window",
    inputSchema: {
      type: "object",
      properties: {
        durationMinutes: { type: "number" },
        timeMin: { type: "string" },
        timeMax: { type: "string" },
        timeZone: { type: "string" }
      },
      required: ["durationMinutes", "timeMin", "timeMax"]
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params ?? {};

  if (name === "calendar_profile") {
    const cal = await getCalendar();
    const settings = await cal.settings.get({ setting: "timezone" }).catch(() => null);
    return { content: [{ type: "text", text: JSON.stringify({ timezone: settings?.data?.value || DEFAULT_TZ }) }] };
  }

  if (name === "calendar_list_events") {
    const schema = z.object({
      timeMin: z.string().min(1),
      timeMax: z.string().min(1),
      maxResults: z.number().int().min(1).max(50).optional(),
      q: z.string().optional(),
      timeZone: z.string().optional(),
    });
    const { timeMin, timeMax, maxResults = 10, q, timeZone = DEFAULT_TZ } = schema.parse(args ?? {});
    const cal = await getCalendar();
    const res = await cal.events.list({
      calendarId: "primary",
      timeMin,
      timeMax,
      q: q || undefined,
      singleEvents: true,
      orderBy: "startTime",
      maxResults,
      timeZone,
    });
    return { content: [{ type: "text", text: JSON.stringify({ items: res.data.items || [] }) }] };
  }

  if (name === "calendar_create_event") {
    const schema = z.object({
      summary: z.string(),
      start: z.string(),
      end: z.string(),
      attendees: z.array(z.string().email()).optional(),
      location: z.string().optional(),
      description: z.string().optional(),
      timeZone: z.string().optional(),
    });
    const { summary, start, end, attendees = [], location, description, timeZone = DEFAULT_TZ } = schema.parse(args ?? {});
    const cal = await getCalendar();
    const body = {
      summary,
      location,
      description,
      start: { dateTime: start, timeZone },
      end: { dateTime: end, timeZone },
      attendees: attendees.map(e => ({ email: e })),
    };
    const created = await cal.events.insert({ calendarId: "primary", requestBody: body });
    return { content: [{ type: "text", text: JSON.stringify({ id: created.data.id, htmlLink: created.data.htmlLink }) }] };
  }

  if (name === "calendar_find_free") {
    const schema = z.object({
      durationMinutes: z.number().int().min(1),
      timeMin: z.string(),
      timeMax: z.string(),
      timeZone: z.string().optional(),
    });
    const { durationMinutes, timeMin, timeMax, timeZone = DEFAULT_TZ } = schema.parse(args ?? {});
    const cal = await getCalendar();
    const fb = await cal.freebusy.query({
      requestBody: { timeMin, timeMax, timeZone, items: [{ id: "primary" }] },
    });
    const busy = fb.data.calendars?.primary?.busy || [];
    let cursor = new Date(timeMin).getTime();
    const endWin = new Date(timeMax).getTime();
    const durMs = durationMinutes * 60 * 1000;
    for (const b of busy) {
      const bStart = new Date(b.start).getTime();
      if (bStart - cursor >= durMs) {
        const slotStart = new Date(cursor).toISOString();
        const slotEnd = new Date(cursor + durMs).toISOString();
        return { content: [{ type: "text", text: JSON.stringify({ slotStart, slotEnd, timeZone }) }] };
      }
      const bEnd = new Date(b.end).getTime();
      cursor = Math.max(cursor, bEnd);
    }
    if (endWin - cursor >= durMs) {
      const slotStart = new Date(cursor).toISOString();
      const slotEnd = new Date(cursor + durMs).toISOString();
      return { content: [{ type: "text", text: JSON.stringify({ slotStart, slotEnd, timeZone }) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify({ slotStart: null, slotEnd: null, timeZone }) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
EOF
chmod +x servers/calendar-mcp/index.js

# Wire client commands
cp src/client.ts src/client.ts.bak

cat > src/client.ts <<'EOF'
import "dotenv/config";
import readline from "node:readline";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { ListToolsResultSchema, CallToolResultSchema } from "@modelcontextprotocol/sdk/types.js";
import { generateAnswer } from "./llm.js";

async function spawnServer(command: string, args: string[]) {
  const transport = new StdioClientTransport({ command, args, env: { ...process.env } });
  const client = new Client({ name: "mcp assistant", version: "0.4.0" });
  await client.connect(transport);
  const tools = await client.request({ method: "tools/list" }, ListToolsResultSchema);
  return { client, toolNames: tools.tools.map(t => t.name) };
}

function safeParseContent(res: unknown): any {
  const anyRes = res as any;
  const txt = anyRes?.content?.[0]?.text ?? "";
  try { return JSON.parse(txt); } catch { return null; }
}

async function main() {
  const pdf = await spawnServer("node", ["./servers/pdf-reader-mcp/index.js"]);
  console.log("PDF tools:", pdf.toolNames);

  const web = await spawnServer("node", ["./servers/web-search-mcp/index.js"]);
  console.log("Web tools:", web.toolNames);

  const gmail = await spawnServer("node", ["./servers/gmail-mcp/index.js"]);
  console.log("Gmail tools:", gmail.toolNames);

  const cal = await spawnServer("node", ["./servers/calendar-mcp/index.js"]);
  console.log("Calendar tools:", cal.toolNames);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  console.log(`
Commands:
  load <pathOrUrl>                         — load a PDF
  pages                                    — get page count
  text <page>                              — extract text for a page
  askpdf <question>                        — answer using loaded PDF text (LLM)
  search <query>                           — web search via SerpAPI
  emailme                                  — Gmail profile
  emaildraft to|subject|body               — create draft
  emailsend to|subject|body                — send email
  calme                                    — show next 5 events (today window)
  calsearch 2025-10-25                     — list events on a specific date
  calfree minutes|startISO|endISO          — find a free slot
  calschedule summary|startISO|endISO|att1,att2|location|description
  exit
`);

  rl.on("line", async (line) => {
    const [cmd, ...rest] = line.trim().split(/\s+/);
    const arg = rest.join(" ");

    try {
      if (cmd === "exit") {
        await pdf.client.close();
        await web.client.close();
        await gmail.client.close();
        await cal.client.close();
        process.exit(0);
      }

      if (cmd === "load") {
        const res = await pdf.client.request(
          { method: "tools/call", params: { name: "load_pdf", arguments: { target: arg } } },
          CallToolResultSchema
        );
        console.log(res);
        return;
      }

      if (cmd === "pages") {
        const res = await pdf.client.request(
          { method: "tools/call", params: { name: "page_count", arguments: {} } },
          CallToolResultSchema
        );
        console.log(res);
        return;
      }

      if (cmd === "text") {
        const page = Number(rest[0] ?? 1);
        const res = await pdf.client.request(
          { method: "tools/call", params: { name: "extract_text", arguments: { page } } },
          CallToolResultSchema
        );
        console.log(JSON.stringify(res, null, 2).slice(0, 2000));
        return;
      }

      if (cmd === "askpdf") {
        const pagesRes = await pdf.client.request(
          { method: "tools/call", params: { name: "page_count", arguments: {} } },
          CallToolResultSchema
        );
        const pagesJson = safeParseContent(pagesRes);
        const total = pagesJson?.pages ?? 1;

        let context = "";
        const MAX_PAGES = Math.min(total, 5);
        for (let i = 1; i <= MAX_PAGES; i++) {
          const p = await pdf.client.request(
            { method: "tools/call", params: { name: "extract_text", arguments: { page: i } } },
            CallToolResultSchema
          );
          const j = safeParseContent(p);
          context += `\n\n[Page ${i}]\n${(j?.text || "").slice(0, 4000)}`;
        }

        const prompt = [
          "You are a precise assistant. Answer based ONLY on the provided PDF excerpts.",
          "Cite the page numbers like (p.2). If unsure, ask for more pages.",
          "",
          `Question: ${arg}`,
          "",
          "PDF Excerpts:",
          context
        ].join("\n");

        const answer = await generateAnswer(prompt);
        console.log(answer);
        return;
      }

      if (cmd === "search") {
        const res = await web.client.request(
          { method: "tools/call", params: { name: "web_search", arguments: { query: arg, num: 5 } } },
          CallToolResultSchema
        );
        const data = safeParseContent(res) || {};
        console.log(`\n🔎 ${data.query}`);
        (data.results || []).forEach((r: any, i: number) => {
          console.log(`\n${i + 1}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
        });
        return;
      }

      if (cmd === "emailme") {
        const res = await gmail.client.request(
          { method: "tools/call", params: { name: "gmail_profile", arguments: {} } },
          CallToolResultSchema
        );
        console.log(safeParseContent(res));
        return;
      }

      if (cmd === "emaildraft") {
        const [to, subject, body] = arg.split("|").map(s => (s ?? "").trim());
        if (!to || !subject || !body) return console.log('Usage: emaildraft to|subject|body');
        const res = await gmail.client.request(
          { method: "tools/call", params: { name: "gmail_create_draft", arguments: { to, subject, body } } },
          CallToolResultSchema
        );
        console.log("Draft:", safeParseContent(res));
        return;
      }

      if (cmd === "emailsend") {
        const [to, subject, body] = arg.split("|").map(s => (s ?? "").trim());
        if (!to || !subject || !body) return console.log('Usage: emailsend to|subject|body');
        const res = await gmail.client.request(
          { method: "tools/call", params: { name: "gmail_send_message", arguments: { to, subject, body } } },
          CallToolResultSchema
        );
        console.log("Sent:", safeParseContent(res));
        return;
      }

      if (cmd === "calme") {
        const now = new Date();
        const end = new Date(now); end.setHours(23,59,59,999);
        const res = await cal.client.request(
          { method: "tools/call", params: { name: "calendar_list_events", arguments: {
            timeMin: now.toISOString(), timeMax: end.toISOString(), maxResults: 5
          } } },
          CallToolResultSchema
        );
        const data = safeParseContent(res) || {};
        (data.items || []).forEach((ev: any, i: number) => {
          console.log(`\n${i+1}. ${ev.summary || "(no title)"}\n   ${ev.start?.dateTime || ev.start?.date} → ${ev.end?.dateTime || ev.end?.date}\n   ${ev.location || ""}`);
        });
        return;
      }

      if (cmd === "calsearch") {
        const day = arg.trim();
        if (!day) return console.log("Usage: calsearch YYYY-MM-DD");
        const start = new Date(`${day}T00:00:00`);
        const end = new Date(`${day}T23:59:59`);
        const res = await cal.client.request(
          { method: "tools/call", params: { name: "calendar_list_events", arguments: {
            timeMin: start.toISOString(), timeMax: end.toISOString(), maxResults: 20
          } } },
          CallToolResultSchema
        );
        const data = safeParseContent(res) || {};
        (data.items || []).forEach((ev: any, i: number) => {
          console.log(`\n${i+1}. ${ev.summary || "(no title)"}\n   ${ev.start?.dateTime || ev.start?.date} → ${ev.end?.dateTime || ev.end?.date}\n   ${ev.location || ""}`);
        });
        return;
      }

      if (cmd === "calfree") {
        const [mins, startISO, endISO] = arg.split("|").map(s => (s ?? "").trim());
        const durationMinutes = Number(mins || 30);
        const res = await cal.client.request(
          { method: "tools/call", params: { name: "calendar_find_free", arguments: {
            durationMinutes, timeMin: startISO, timeMax: endISO
          } } },
          CallToolResultSchema
        );
        console.log("Free slot:", safeParseContent(res));
        return;
      }

      if (cmd === "calschedule") {
        const [summary, startISO, endISO, attendeesCSV="", location="", description=""] = arg.split("|").map(s => (s ?? "").trim());
        if (!summary || !startISO || !endISO) return console.log('Usage: calschedule summary|startISO|endISO|att1,att2|location|description');
        const attendees = attendeesCSV ? attendeesCSV.split(",").map(s => s.trim()).filter(Boolean) : [];
        const res = await cal.client.request(
          { method: "tools/call", params: { name: "calendar_create_event", arguments: {
            summary, start: startISO, end: endISO, attendees, location, description
          } } },
          CallToolResultSchema
        );
        console.log("Created:", safeParseContent(res));
        return;
      }

      console.log("Unknown command");
    } catch (err) {
      console.error("Error:", err);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
EOF

echo "==> Milestone 4 setup done."
echo "Next:"
echo "1) Ensure Gmail/Calendar APIs are enabled in your Google Cloud project"
echo "2) cp .env.example .env  (if not already) and set GOOGLE_* vars"
echo "3) npm run dev"
echo "4) In the REPL: run 'calme' or 'calsearch 2025-10-25' to trigger Calendar auth, then try 'calschedule ...'"
