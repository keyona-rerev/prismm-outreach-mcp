import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { google } from "googleapis";
import express from "express";
import { z } from "zod";

const app = express();
app.use(express.json());

// --- Endpoint auth -----------------------------------------------------------
// /mcp requires ?key=<MCP_AUTH_TOKEN>. /health and /oauth/* stay open.
const MCP_AUTH_TOKEN = process.env.MCP_AUTH_TOKEN;
if (!MCP_AUTH_TOKEN) {
  console.error("FATAL: MCP_AUTH_TOKEN is not set. Refusing to start.");
  process.exit(1);
}

function requireKey(req, res) {
  if (req.query.key !== MCP_AUTH_TOKEN) {
    res.status(403).json({ error: "Forbidden" });
    return false;
  }
  return true;
}

function getOAuthClient() {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const tokens = JSON.parse(process.env.GOOGLE_TOKENS);
  client.setCredentials(tokens);
  return client;
}

app.get("/health", (req, res) => res.send("OK"));

app.get("/oauth/start", (req, res) => {
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const url = client.generateAuthUrl({
    access_type: "offline",
    prompt: "consent",
    scope: [
      "https://www.googleapis.com/auth/gmail.compose",
      "https://www.googleapis.com/auth/gmail.readonly",
    ],
  });
  res.redirect(url);
});

app.get("/oauth/callback", async (req, res) => {
  try {
    const client = new google.auth.OAuth2(
      process.env.GOOGLE_CLIENT_ID,
      process.env.GOOGLE_CLIENT_SECRET,
      process.env.GOOGLE_REDIRECT_URI
    );
    const { tokens } = await client.getToken(req.query.code);
    console.log("GOOGLE_TOKENS:", JSON.stringify(tokens));
    res.send("Auth complete. Copy the token from Railway deploy logs.");
  } catch (err) {
    console.error("OAuth error:", err);
    res.status(500).send("OAuth failed: " + err.message);
  }
});

// Build MCP server once at startup
const mcpServer = new McpServer({ name: "prismm-outreach", version: "1.0.0" });

mcpServer.tool(
  "create_draft",
  "Create a Gmail draft in the Prismm Outreach account",
  {
    to: z.string().describe("Recipient email address"),
    subject: z.string().describe("Email subject"),
    body: z.string().describe("Plain text email body (fallback when htmlBody is also provided)"),
    htmlBody: z.string().optional().describe("HTML email body — if provided, email renders as HTML with plain text fallback"),
    bcc: z.string().optional().describe("BCC email address (e.g. prismm@pipedrivemail.com for Pipedrive logging)"),
  },
  async ({ to, subject, body, htmlBody, bcc }) => {
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });

    const headers = [
      `From: Keyona Meeks <keyona@getprismm.com>`,
      `To: ${to}`,
      `Subject: ${subject}`,
    ];

    if (bcc) headers.push(`Bcc: ${bcc}`);

    let messageBody;

    if (htmlBody) {
      const boundary = `----=_Part_${Date.now()}`;
      headers.push(`MIME-Version: 1.0`);
      headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
      messageBody = [
        `--${boundary}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        body,
        ``,
        `--${boundary}`,
        `Content-Type: text/html; charset=utf-8`,
        ``,
        htmlBody,
        ``,
        `--${boundary}--`,
      ].join("\n");
  } else {
  const autoHtml = body.split('\n\n').map(p => `<p>${p.replace(/\n/g, '<br>')}</p>`).join('');
  const boundary = `----=_Part_${Date.now()}`;
  headers.push(`MIME-Version: 1.0`);
  headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
  messageBody = [
    `--${boundary}`,
    `Content-Type: text/plain; charset=utf-8`,
    ``,
    body,
    ``,
    `--${boundary}`,
    `Content-Type: text/html; charset=utf-8`,
    ``,
    autoHtml,
    ``,
    `--${boundary}--`,
  ].join("\n");
}
    const message = [...headers, ``, messageBody].join("\n");

    const encoded = Buffer.from(message)
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");

    await gmail.users.drafts.create({
      userId: "me",
      requestBody: { message: { raw: encoded } },
    });

    return {
      content: [{ type: "text", text: `Draft created in Prismm Outreach for ${to}` }],
    };
  }
);

// --- Read helpers ------------------------------------------------------------

function decodeBody(data) {
  return Buffer.from(data, "base64").toString("utf-8");
}

function header(payload, name) {
  const list = payload.headers || [];
  const found = list.find((h) => h.name.toLowerCase() === name.toLowerCase());
  return found ? found.value : "";
}

function findPart(payload, mimeType) {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body && payload.body.data) return payload;
  for (const part of payload.parts || []) {
    const found = findPart(part, mimeType);
    if (found) return found;
  }
  return null;
}

function extractText(payload) {
  const plain = findPart(payload, "text/plain");
  if (plain) return decodeBody(plain.body.data).trim();

  const html = findPart(payload, "text/html");
  if (html) {
    return decodeBody(html.body.data)
      .replace(/<style[\s\S]*?<\/style>/gi, "")
      .replace(/<script[\s\S]*?<\/script>/gi, "")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/p>/gi, "\n\n")
      .replace(/<[^>]+>/g, " ")
      .replace(/&nbsp;/g, " ")
      .replace(/&amp;/g, "&")
      .replace(/[ \t]+/g, " ")
      .trim();
  }

  return "(no readable body)";
}

function formatMessage(msg) {
  const payload = msg.payload || {};
  return [
    `Message ID: ${msg.id}`,
    `Thread ID: ${msg.threadId}`,
    `Date: ${header(payload, "Date")}`,
    `From: ${header(payload, "From")}`,
    `To: ${header(payload, "To")}`,
    `Subject: ${header(payload, "Subject")}`,
    ``,
    extractText(payload),
  ].join("\n");
}

mcpServer.tool(
  "search_messages",
  "Search the Prismm Outreach mailbox with Gmail query syntax. Returns sender, subject, date, and snippet for each match. Use get_message or get_thread to read full bodies. Examples: 'from:angela@creditunion.com', 'is:unread newer_than:7d', 'subject:inheritance'.",
  {
    query: z.string().describe("Gmail search query, e.g. 'from:someone@bank.com newer_than:30d'"),
    maxResults: z.number().optional().describe("Maximum messages to return. Default 10, maximum 25."),
  },
  async ({ query, maxResults }) => {
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });
    const limit = Math.min(maxResults || 10, 25);

    const list = await gmail.users.messages.list({
      userId: "me",
      q: query,
      maxResults: limit,
    });

    const hits = list.data.messages || [];
    if (hits.length === 0) {
      return { content: [{ type: "text", text: `No messages match: ${query}` }] };
    }

    const rows = [];
    for (const hit of hits) {
      const msg = await gmail.users.messages.get({
        userId: "me",
        id: hit.id,
        format: "metadata",
        metadataHeaders: ["From", "To", "Subject", "Date"],
      });
      const payload = msg.data.payload || {};
      rows.push(
        [
          `[${msg.data.id}] thread ${msg.data.threadId}`,
          `  Date: ${header(payload, "Date")}`,
          `  From: ${header(payload, "From")}`,
          `  Subject: ${header(payload, "Subject")}`,
          `  ${msg.data.snippet || ""}`,
        ].join("\n")
      );
    }

    return {
      content: [
        {
          type: "text",
          text: `${rows.length} result(s) for "${query}":\n\n${rows.join("\n\n")}`,
        },
      ],
    };
  }
);

mcpServer.tool(
  "get_message",
  "Read one full message from the Prismm Outreach mailbox. Get the message ID from search_messages.",
  {
    messageId: z.string().describe("Gmail message ID returned by search_messages"),
  },
  async ({ messageId }) => {
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });
    const msg = await gmail.users.messages.get({
      userId: "me",
      id: messageId,
      format: "full",
    });
    return { content: [{ type: "text", text: formatMessage(msg.data) }] };
  }
);

mcpServer.tool(
  "get_thread",
  "Read a full conversation thread from the Prismm Outreach mailbox, oldest message first. Get the thread ID from search_messages.",
  {
    threadId: z.string().describe("Gmail thread ID returned by search_messages"),
  },
  async ({ threadId }) => {
    const auth = getOAuthClient();
    const gmail = google.gmail({ version: "v1", auth });
    const thread = await gmail.users.threads.get({
      userId: "me",
      id: threadId,
      format: "full",
    });
    const messages = thread.data.messages || [];
    return {
      content: [
        {
          type: "text",
          text: `Thread ${threadId} — ${messages.length} message(s)\n\n${messages
            .map(formatMessage)
            .join("\n\n---\n\n")}`,
        },
      ],
    };
  }
);

// GET /mcp - discovery ping from Claude.ai
app.get("/mcp", (req, res) => {
  if (!requireKey(req, res)) return;
  res.status(200).json({ status: "ok", name: "prismm-outreach" });
});

// POST /mcp - actual MCP protocol handler
app.post("/mcp", async (req, res) => {
  if (!requireKey(req, res)) return;
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Prismm Outreach MCP running on port ${PORT}`));
