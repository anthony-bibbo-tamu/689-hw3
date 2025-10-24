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
