import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { google } from "googleapis";
import express from "express";
import { z } from "zod";

const app = express();
app.use(express.json());

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
    scope: ["https://www.googleapis.com/auth/gmail.compose"],
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
      headers.push(`Content-Type: text/plain; charset=utf-8`);
      messageBody = body;
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

// GET /mcp - discovery ping from Claude.ai
app.get("/mcp", (req, res) => {
  res.status(200).json({ status: "ok", name: "prismm-outreach" });
});

// POST /mcp - actual MCP protocol handler
app.post("/mcp", async (req, res) => {
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await mcpServer.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log(`Prismm Outreach MCP running on port ${PORT}`));
