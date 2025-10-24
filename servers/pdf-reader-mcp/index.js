#!/usr/bin/env node
// Minimal MCP PDF server (stdio) using pdfjs-dist for per-page text extraction.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import fs from "node:fs";
import path from "node:path";
import * as url from "node:url";
import * as pdfjs from "pdfjs-dist/legacy/build/pdf.mjs";
import {
  ListToolsRequestSchema,
  CallToolRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";


// ---------- In-memory state ----------
let loaded = {
  pages: /** @type {string[]} */ ([]),
  pageCount: 0,
  source: "",
};

// Load a PDF from local path or URL and extract per-page text
async function loadPdfToMemory(target) {
  let data;
  if (/^https?:\/\//i.test(target)) {
    const res = await fetch(target);
    if (!res.ok) throw new Error(`Failed to fetch PDF: ${res.status} ${res.statusText}`);
    data = new Uint8Array(await res.arrayBuffer());
  } else {
    const abs = path.isAbsolute(target) ? target : path.resolve(process.cwd(), target);
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`);
    data = new Uint8Array(fs.readFileSync(abs));
  }

  const doc = await pdfjs.getDocument({ data }).promise;
  const pageCount = doc.numPages;
  const pages = [];

  for (let i = 1; i <= pageCount; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    const text = content.items.map((it) => ("str" in it ? it.str : "")).join(" ");
    pages.push(text);
  }

  loaded = { pages, pageCount, source: target };
  return { pageCount };
}

// ---------- MCP server setup ----------
const server = new Server(
  { name: "pdf-reader-mcp", version: "0.1.0", description: "Loads a PDF and exposes simple per-page text extraction" },
  { capabilities: { tools: {} } }
);

// Declare tool metadata once
const tools = [
  {
    name: "load_pdf",
    description: "Load a PDF from a local path or URL into memory",
    inputSchema: {
      type: "object",
      properties: { target: { type: "string", description: "Path or HTTP(S) URL to a PDF" } },
      required: ["target"],
    },
  },
  {
    name: "page_count",
    description: "Get page count of the loaded PDF",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "extract_text",
    description: "Extract text for a specific page (1-based)",
    inputSchema: {
      type: "object",
      properties: { page: { type: "number", description: "1-based page index" } },
      required: ["page"],
    },
  },
];

// Implement tools/list
server.setRequestHandler(ListToolsRequestSchema, async () => {
  return { tools };
});

// Implement tools/call
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: args } = req.params ?? {};

  if (name === "load_pdf") {
    const schema = z.object({ target: z.string().min(1) });
    const { target } = schema.parse(args ?? {});
    const { pageCount } = await loadPdfToMemory(target);
    return {
      content: [{ type: "text", text: JSON.stringify({ ok: true, pages: pageCount, source: target }) }],
    };
  }

  if (name === "page_count") {
    if (loaded.pageCount === 0) throw new Error("No PDF loaded. Call load_pdf first.");
    return { content: [{ type: "text", text: JSON.stringify({ pages: loaded.pageCount }) }] };
  }

  if (name === "extract_text") {
    const schema = z.object({ page: z.number().int().min(1) });
    const { page } = schema.parse(args ?? {});
    if (loaded.pageCount === 0) throw new Error("No PDF loaded. Call load_pdf first.");
    if (page > loaded.pageCount) throw new Error(`Page out of range (1..${loaded.pageCount})`);
    const text = loaded.pages[page - 1] || "";
    return { content: [{ type: "text", text: JSON.stringify({ page, text }) }] };
  }

  throw new Error(`Unknown tool: ${name}`);
});

// Start stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);