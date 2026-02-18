import { routeAgentRequest, type Schedule } from "agents";

import { AIChatAgent } from "@cloudflare/ai-chat";
import {
  generateId,
  streamText,
  type StreamTextOnFinishCallback,
  stepCountIs,
  createUIMessageStream,
  convertToModelMessages,
  createUIMessageStreamResponse,
  type ToolSet,
  generateObject
} from "ai";
import { openai } from "@ai-sdk/openai";
import { processToolCalls, cleanupMessages } from "./utils";
import { tools, executions } from "./tools";
import { z } from "zod";
// import { env } from "cloudflare:workers";

const model = openai("gpt-4o-2024-11-20");
// Cloudflare AI Gateway
// const openai = createOpenAI({
//   apiKey: env.OPENAI_API_KEY,
//   baseURL: env.GATEWAY_BASE_URL,
// });

/**
 * Chat Agent implementation that handles real-time AI chat interactions
 */
export class Chat extends AIChatAgent<Env> {
  /**
   * Handles incoming chat messages and manages the response stream
   */
  async onChatMessage(
    onFinish: StreamTextOnFinishCallback<ToolSet>,
    options?: { abortSignal?: AbortSignal }
  ) {
    // Ensure the MCP client's jsonSchema helper is loaded before we read tools
    // this prevents `jsonSchema not initialized` errors when getAITools() is called
    await this.mcp.ensureJsonSchema();

    // const mcpConnection = await this.mcp.connect(
    //   "https://path-to-mcp-server/sse"
    // );

    // Collect all tools, including MCP tools
    const allTools = {
      ...tools,
      ...this.mcp.getAITools()
    };

    const stream = createUIMessageStream({
      execute: async ({ writer }) => {
        // Clean up incomplete tool calls to prevent API errors
        const cleanedMessages = cleanupMessages(this.messages);

        // Process any pending tool calls from previous messages
        // This handles human-in-the-loop confirmations for tools
        const processedMessages = await processToolCalls({
          messages: cleanedMessages,
          dataStream: writer,
          tools: allTools,
          executions
        });

        const result = streamText({
          system: `You are a helpful assistant that can do various tasks. When the user provides or refers to todo tasks, always include a machine-readable JSON representation in your reply wrapped in a triple-backtick json code block so the frontend can parse it. The JSON must be an array of objects with these fields: title (string), due (ISO date string, optional), priority ("low"|"medium"|"high", optional), estimatedMinutes (number, optional), done (boolean). Example:\n\n\treply example:\n\n\tI can help — here's a summary:\n\t- ...human friendly text...\n\n\t\`\`\`json\n\t[\n\t  { "title": "Write report", "due": "2026-02-12", "priority": "high", "estimatedMinutes": 120, "done": false },\n\t  { "title": "Buy groceries", "due": "2026-02-13", "priority": "medium", "estimatedMinutes": 30, "done": false }\n\t]\n\t\`\`\`\n\nIf there are no tasks to extract, do not emit an empty JSON array. Keep the human-friendly text, but only include JSON when tasks are present. Make the JSON valid and parsable.`,

          messages: await convertToModelMessages(processedMessages),
          model,
          tools: allTools,
          // Type boundary: streamText expects specific tool types, but base class uses ToolSet
          // This is safe because our tools satisfy ToolSet interface (verified by 'satisfies' in tools.ts)
          onFinish: onFinish as unknown as StreamTextOnFinishCallback<
            typeof allTools
          >,
          stopWhen: stepCountIs(10),
          abortSignal: options?.abortSignal
        });

        writer.merge(result.toUIMessageStream());
      }
    });

    return createUIMessageStreamResponse({ stream });
  }
  async executeTask(description: string, _task: Schedule<string>) {
    await this.saveMessages([
      ...this.messages,
      {
        id: generateId(),
        role: "user",
        parts: [
          {
            type: "text",
            text: `Running scheduled task: ${description}`
          }
        ],
        metadata: {
          createdAt: new Date()
        }
      }
    ]);
  }
}

/**
 * Worker entry point that routes incoming requests to the appropriate handler
 */
export default {
  async fetch(request: Request, env: Env, _ctx: ExecutionContext) {
    const url = new URL(request.url);

    if (url.pathname === "/check-open-ai-key") {
      const hasOpenAIKey = !!process.env.OPENAI_API_KEY;
      return Response.json({
        success: hasOpenAIKey
      });
    }

    // New endpoint: POST /parse-todos
    if (url.pathname === "/parse-todos" && request.method === "POST") {
      try {
        const body = await request.json().catch(() => ({}));
        const text = (body?.text as string) || "";

        if (!text.trim()) {
          return new Response(JSON.stringify({ todos: null }), {
            status: 200,
            headers: { "Content-Type": "application/json" }
          });
        }

        // zod schema for a todo item
        const todoSchema = z.object({
          title: z.string(),
          due: z.string().optional(),
          priority: z.enum(["low", "medium", "high"]).optional(),
          estimatedMinutes: z.number().optional(),
          done: z.boolean().optional()
        });

        const schema = z.object({ todos: z.array(todoSchema).optional().nullable() });

        // Strict prompt guiding the model to return only a JSON object matching our schema
        const prompt = `Extract todos from the following text. If there are todos present, return a JSON object with a single key \"todos\" whose value is an array of todo objects. Each todo object must contain: title (string), due (ISO date string, optional), priority (one of \"low\", \"medium\", \"high\"; optional), estimatedMinutes (number, optional), done (boolean, optional). If there are no todos, return { "todos": null }. Output must be valid JSON only, nothing else. Here is the input:\n\n${text}`;

        const response = await generateObject({
          model,
          prompt,
          schema,
          // be conservative with tokens
          maxOutputTokens: 1000
        });

        const todos = response.object?.todos ?? null;

        return new Response(JSON.stringify({ todos }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (err) {
        console.error("/parse-todos error", err);
        return new Response(JSON.stringify({ error: String(err) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // New API: histories proxy to Durable Object
    if (url.pathname.startsWith("/api/histories")) {
      try {
        // Use a singleton DO instance named 'global' to store sessions
        const namespace = env.Histories as DurableObjectNamespace;
        const id = namespace.idFromName("global");
        const stub = namespace.get(id);

        // Forward the request to the Durable Object
        const forwardUrl = new URL(request.url);
        // adjust pathname to be handled by DO (pass through)
        const doRequest = new Request(forwardUrl.toString(), {
          method: request.method,
          headers: request.headers,
          body: request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.clone().arrayBuffer(),
        });

        return await stub.fetch(doRequest);
      } catch (e) {
        console.error('histories proxy error', e);
        return new Response(JSON.stringify({ error: String(e) }), { status: 500, headers: { 'Content-Type': 'application/json' } });
      }
    }

    if (!process.env.OPENAI_API_KEY) {
      console.error(
        "OPENAI_API_KEY is not set, don't forget to set it locally in .dev.vars, and use `wrangler secret bulk .dev.vars` to upload it to production"
      );
    }
    return (
      // Route the request to our agent or return 404 if not found
      (await routeAgentRequest(request, env)) ||
      new Response("Not found", { status: 404 })
    );
  }
} satisfies ExportedHandler<Env>;
