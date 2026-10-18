// Drives the MCP server over stdio like Claude Desktop does. Usage: node test/client.mjs <tool> '<json args>' [server path]
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import fs from "node:fs";
const [, , name, json = "{}", serverPath = "server/index.js"] = process.argv;
const transport = new StdioClientTransport({ command: "node", args: [serverPath], env: { ...process.env } });
const client = new Client({ name: "test", version: "1" });
await client.connect(transport);
if (name === "--list") {
  const { tools } = await client.listTools();
  for (const t of tools) console.log(t.name, "-", t.description.split("\n")[0].slice(0, 90));
  console.log("instructions:", (client.getInstructions() || "").slice(0, 80), "…");
} else {
  const r = await client.callTool({ name, arguments: JSON.parse(json) });
  for (const c of r.content) {
    if (c.type === "text") console.log(c.text);
    else if (c.type === "image") { const f = `test/${name}-${Date.now()}.png`; fs.writeFileSync(f, Buffer.from(c.data, "base64")); console.log("[image saved to " + f + "]"); }
  }
  if (r.isError) console.log("(isError)");
}
await client.close();
