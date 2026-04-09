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

app.post("/mcp", async (req, res) => {
  const server = new McpServer({ name: "prismm-outreach", version: "1.0.0" });

  server.tool(
    "create_draft",
    "Create a Gmail draft in the Prismm Outreach account",
    {
      to: z.string().describe("Recipient email address"),
      subject: z.string().describe("Email subject"),
      body: z.string().describe("Email body in plain text"),
    },
    async ({ to, subject, body }) => {
      const auth = getOAuthClient();
      const gmail = google.gmail({ version: "v1", auth });

      const message = [
        `From: Keyona Meeks <keyona@getprismm.com>`,
        `To: ${to}`,
        `Subject: ${subject}`,
        `Content-Type: text/plain; charset=utf-8`,
        ``,
        body,
      ].join("\n");

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

  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => transport.close());
  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

const PORT = process.env.PORT || 8080;
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
  const client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );
  const { tokens } = await client.getToken(req.query.code);
  console.log("GOOGLE_TOKENS:", JSON.stringify(tokens));
  res.send("Auth complete. Copy the token from Railway deploy logs.");
});
app.listen(PORT, () => console.log(`Prismm Outreach MCP running on port ${PORT}`));