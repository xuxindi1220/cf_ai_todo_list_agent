export type StoredSession = {
  id: string;
  createdAt: string;
  todos: any[];
  messages: any[];
  title?: string;
};

export class HistoryDO {
  state: DurableObjectState;
  env: Env;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
  }

  async fetch(request: Request) {
    const url = new URL(request.url);
    const pathname = url.pathname.replace(/\/+$/, "");

    if (request.method === "POST" && pathname === "/histories") {
      try {
        const body = (await request.json().catch(() => ({}))) as any;
        const id = body?.id ?? crypto.randomUUID();
        const session: StoredSession = {
          id,
          createdAt: new Date().toISOString(),
          todos: body?.todos ?? [],
          messages: body?.messages ?? [],
          title: body?.title ?? undefined
        };
        await this.state.storage.put(`session:${id}`, session);
        return new Response(JSON.stringify({ ok: true, id }), {
          status: 201,
          headers: { "Content-Type": "application/json" }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    if (request.method === "GET" && pathname === "/histories") {
      try {
        const items: StoredSession[] = [];
        // state.storage.list may return different shapes depending on runtime types (async iterable or Map)
        const listResult: any = await (this.state.storage as any)
          .list?.({ prefix: "session:" })
          ?.catch?.(() => null);

        if (listResult == null) {
          // fallback: try to use keys API if available
          const keys =
            (await (this.state.storage as any).getKeys?.({
              prefix: "session:"
            })) ?? [];
          for (const key of keys) {
            try {
              const v = await this.state.storage.get(key);
              if (v) items.push(v as StoredSession);
            } catch (e) {
              console.error("Error fetching session for key", key, e);
            }
          }
        } else {
          // If listResult is an AsyncIterable, iterate with for-await
          if (typeof (listResult as any)[Symbol.asyncIterator] === "function") {
            for await (const entry of listResult as any) {
              const key =
                entry?.key ?? (Array.isArray(entry) ? entry[0] : undefined);
              if (!key) continue;
              try {
                const v = await this.state.storage.get(key);
                if (v) items.push(v as StoredSession);
              } catch (e) {
                console.error("Error fetching session for key", key, e);
              }
            }
          } else if (listResult instanceof Map) {
            for (const [key] of listResult.entries()) {
              try {
                const v = await this.state.storage.get(key);
                if (v) items.push(v as StoredSession);
              } catch (e) {
                console.error("Error fetching session for key", key, e);
              }
            }
          } else if (Array.isArray(listResult)) {
            for (const entry of listResult) {
              const key =
                entry?.key ?? (Array.isArray(entry) ? entry[0] : undefined);
              if (!key) continue;
              try {
                const v = await this.state.storage.get(key);
                if (v) items.push(v as StoredSession);
              } catch (e) {
                console.error(e);
              }
            }
          } else {
            // unknown shape: try to treat as object with keys
            try {
              const keys = Object.keys(listResult ?? {});
              for (const key of keys) {
                try {
                  const v = await this.state.storage.get(key);
                  if (v) items.push(v as StoredSession);
                } catch (e) {
                  console.error("Error fetching session for key", key, e);
                }
              }
            } catch (e) {
              console.error("Error processing listResult", e);
            }
          }
        }

        // sort by createdAt desc
        items.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
        return new Response(JSON.stringify({ histories: items }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // GET /histories/:id
    if (request.method === "GET" && pathname.startsWith("/histories/")) {
      const id = pathname.replace("/histories/", "");
      try {
        const v = await this.state.storage.get(`session:${id}`);
        if (!v)
          return new Response(JSON.stringify({ error: "not_found" }), {
            status: 404,
            headers: { "Content-Type": "application/json" }
          });
        return new Response(JSON.stringify({ session: v }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    // DELETE /histories/:id
    if (request.method === "DELETE" && pathname.startsWith("/histories/")) {
      const id = pathname.replace("/histories/", "");
      try {
        await this.state.storage.delete(`session:${id}`);
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: { "Content-Type": "application/json" }
        });
      } catch (e: any) {
        return new Response(JSON.stringify({ error: String(e) }), {
          status: 500,
          headers: { "Content-Type": "application/json" }
        });
      }
    }

    return new Response("Not found", { status: 404 });
  }
}
