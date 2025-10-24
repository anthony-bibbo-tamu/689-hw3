#!/usr/bin/env node
// MCP Web Search server (stdio) using SerpAPI.
// Tools:
//  - web_search { query: string, num?: number } => returns top organic results (title/url/snippet)

import "dotenv/config";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { getJson } from "serpapi";

const server = new Server(
  { name: "web-search-mcp", version: "0.1.0", description: "Real-time web search via SerpAPI" },
  { capabilities: { tools: {} } }
);

import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const tools = [
  {
    name: "web_search",
    description: "Search the web and return top results (title, url, snippet)",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Search query" },
        num: { type: "number", description: "Max results (default 5)" }
      },
      required: ["query"]
    }
  }
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params ?? {};
  if (name !== "web_search") throw new Error(`Unknown tool: ${name}`);

  const schema = z.object({ query: z.string().min(1), num: z.number().int().min(1).max(10).optional() });
  const { query, num = 5 } = schema.parse(args ?? {});
  const apiKey = process.env.SERPAPI_KEY;
  if (!apiKey) throw new Error("Missing SERPAPI_KEY in environment");

  const json = await getJson({
    engine: "google",
    q: query,
    num,
    api_key: apiKey,
  });

  const organic = (json.organic_results || []).slice(0, num).map(r => ({
    title: r.title,
    url: r.link,
    snippet: r.snippet
  }));

  return {
    content: [{ type: "text", text: JSON.stringify({ query, results: organic }) }]
  };
});

const transport = new StdioServerTransport();
await server.connect(transport);
