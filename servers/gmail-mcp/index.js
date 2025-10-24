#!/usr/bin/env node
import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import { google } from "googleapis";
import http from "node:http";
import open from "open";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";

const TOKEN_PATH = path.resolve(".tokens/gmail.json");
const SCOPES = [
  "https://www.googleapis.com/auth/gmail.compose",
  "https://www.googleapis.com/auth/gmail.send",
  "https://www.googleapis.com/auth/gmail.readonly",
];

// Load/create OAuth2 client
function getOAuth2Client() {
  const clientId = process.env.GOOGLE_CLIENT_ID || "";
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET || "";
  const redirectUri = process.env.GOOGLE_REDIRECT_URI || "http://127.0.0.1:53682/oauth2callback";
  if (!clientId || !clientSecret) {
    throw new Error("Missing GOOGLE_CLIENT_ID or GOOGLE_CLIENT_SECRET in environment");
  }
  return new google.auth.OAuth2(clientId, clientSecret, redirectUri);
}

async function ensureTokens(oauth2) {
  // Try cached token
  if (fs.existsSync(TOKEN_PATH)) {
    const raw = JSON.parse(fs.readFileSync(TOKEN_PATH, "utf8"));
    oauth2.setCredentials(raw);
    return oauth2;
  }

  // Start a tiny local server to catch the redirect
  const port = Number(new URL(oauth2.redirectUri).port || 53682);
  const authUrl = oauth2.generateAuthUrl({ access_type: "offline", scope: SCOPES, prompt: "consent" });

  const server = http.createServer(async (req, res) => {
    try {
      if (!req.url) return;
      const u = new URL(req.url, `http://127.0.0.1:${port}`);
      if (u.pathname !== "/oauth2callback") return;

      const code = u.searchParams.get("code");
      if (!code) throw new Error("No code in callback");

      const { tokens } = await oauth2.getToken(code);
      oauth2.setCredentials(tokens);
      fs.mkdirSync(path.dirname(TOKEN_PATH), { recursive: true });
      fs.writeFileSync(TOKEN_PATH, JSON.stringify(tokens, null, 2), "utf8");

      res.writeHead(200, { "Content-Type": "text/plain" });
      res.end("Gmail auth complete. You can close this tab.");
      server.close();
    } catch (e) {
      res.writeHead(500, { "Content-Type": "text/plain" });
      res.end("Auth error. Check console.");
      server.close();
    }
  });

  await new Promise((resolve) => server.listen(port, "127.0.0.1", resolve));
  console.error("Opening browser for Google OAuth...");
  await open(authUrl);
  console.error("Waiting for OAuth callback on", oauth2.redirectUri);

  // Wait until server closes (after token saved)
  await new Promise((resolve) => server.on("close", resolve));
  return oauth2;
}

async function getGmail() {
  const oauth2 = getOAuth2Client();
  await ensureTokens(oauth2);
  return google.gmail({ version: "v1", auth: oauth2 });
}

// Build a base64url email body
function buildMessage({ to, subject, body }) {
  const lines = [
    `To: ${to}`,
    `Subject: ${subject}`,
    "Content-Type: text/plain; charset=utf-8",
    "",
    body,
  ].join("\r\n");
  const base64 = Buffer.from(lines, "utf8").toString("base64");
  return base64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

const server = new Server(
  { name: "gmail-mcp", version: "0.1.0", description: "Gmail draft/send tools" },
  { capabilities: { tools: {} } }
);

const tools = [
  {
    name: "gmail_profile",
    description: "Get Gmail profile (email address)",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "gmail_create_draft",
    description: "Create a Gmail draft",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
  {
    name: "gmail_send_message",
    description: "Send a raw email immediately (use with confirmation!)",
    inputSchema: {
      type: "object",
      properties: {
        to: { type: "string" },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["to", "subject", "body"],
    },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params ?? {};

  if (name === "gmail_profile") {
    const gmail = await getGmail();
    const me = await gmail.users.getProfile({ userId: "me" });
    return { content: [{ type: "text", text: JSON.stringify(me.data) }] };
  }

  if (name === "gmail_create_draft") {
    const schema = z.object({ to: z.string().email(), subject: z.string(), body: z.string() });
    const { to, subject, body } = schema.parse(args ?? {});
    const gmail = await getGmail();
    const raw = buildMessage({ to, subject, body });
    const draft = await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw } },
    });
    return { content: [{ type: "text", text: JSON.stringify({ draftId: draft.data.id }) }] };
  }

  if (name === "gmail_send_message") {
    const schema = z.object({ to: z.string().email(), subject: z.string(), body: z.string() });
    const { to, subject, body } = schema.parse(args ?? {});
    const gmail = await getGmail();
    const raw = buildMessage({ to, subject, body });
    const sent = await gmail.users.messages.send({
      userId: "me",
      requestBody: { raw },
    });
    return { content: [{ type: "text", text: JSON.stringify({ id: sent.data.id, labelIds: sent.data.labelIds }) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

const transport = new StdioServerTransport();
await server.connect(transport);
