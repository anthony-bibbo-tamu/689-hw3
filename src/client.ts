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
