/** biome-ignore-all lint/correctness/useUniqueElementIds: it's alright */
import { useEffect, useState, useRef, useCallback, use } from "react";
import { useAgent } from "agents/react";
import { isStaticToolUIPart } from "ai";
import { useAgentChat } from "@cloudflare/ai-chat/react";
import type { UIMessage } from "@ai-sdk/react";
import type { tools } from "./tools";

// Component imports
import { Button } from "@/components/button/Button";
import { Card } from "@/components/card/Card";
import { Avatar } from "@/components/avatar/Avatar";
import { Toggle } from "@/components/toggle/Toggle";
import { Textarea } from "@/components/textarea/Textarea";
import { MemoizedMarkdown } from "@/components/memoized-markdown";
import { ToolInvocationCard } from "@/components/tool-invocation-card/ToolInvocationCard";
import TodoTable from "@/components/todo/TodoTable";
import HistoryPanel from "@/components/history/HistoryPanel";
import { parseTodosFromJSON, parseTodosFromMarkdownTable, todosToMarkdownTable } from "./lib/todoUtils";
import type { Todo } from "./shared";

// Icon imports
import {
  BugIcon,
  MoonIcon,
  RobotIcon,
  SunIcon,
  TrashIcon,
  PaperPlaneTiltIcon,
  StopIcon
} from "@phosphor-icons/react";

// List of tools that require human confirmation
// NOTE: this should match the tools that don't have execute functions in tools.ts
const toolsRequiringConfirmation: (keyof typeof tools)[] = [
  "getWeatherInformation"
];

export default function Chat() {
  const [theme, setTheme] = useState<"dark" | "light">(() => {
    // Check localStorage first, default to dark if not found
    const savedTheme = localStorage.getItem("theme");
    return (savedTheme as "dark" | "light") || "dark";
  });
  const [showDebug, setShowDebug] = useState(false);
  const [textareaHeight, setTextareaHeight] = useState("auto");
  const messagesEndRef = useRef<HTMLDivElement>(null);

  const scrollToBottom = useCallback(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, []);

  useEffect(() => {
    // Apply theme class on mount and when theme changes
    if (theme === "dark") {
      document.documentElement.classList.add("dark");
      document.documentElement.classList.remove("light");
    } else {
      document.documentElement.classList.remove("dark");
      document.documentElement.classList.add("light");
    }

    // Save theme preference to localStorage
    localStorage.setItem("theme", theme);
  }, [theme]);

  // Scroll to bottom on mount
  useEffect(() => {
    scrollToBottom();
  }, [scrollToBottom]);

  const toggleTheme = () => {
    const newTheme = theme === "dark" ? "light" : "dark";
    setTheme(newTheme);
  };

  const agent = useAgent({
    agent: "chat"
  });

  const [agentInput, setAgentInput] = useState("");
  const handleAgentInputChange = (
    e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>
  ) => {
    setAgentInput(e.target.value);
  };

  const handleAgentSubmit = async (
    e: React.FormEvent,
    extraData: Record<string, unknown> = {}
  ) => {
    e.preventDefault();
    if (!agentInput.trim()) return;

    const message = agentInput;
    setAgentInput("");

    // Try to parse todos locally first. If the user pasted a JSON array or a markdown table,
    // populate the local todos immediately so the TodoTable shows the items without waiting
    // for the assistant to respond.
    const fromJson = parseTodosFromJSON(message);
    const fromMd = !fromJson ? parseTodosFromMarkdownTable(message) : null;
    if (fromJson || fromMd) {
      const parsed = fromJson ?? fromMd!;
      console.debug("setting todos from local parse", parsed);
      setTodos(mergeIncomingTodos(parsed));

      // Send a compact markdown representation to the agent so the conversation stays in sync
      const md = todosToMarkdownTable(parsed);
      await sendMessage(
        {
          role: "user",
          parts: [{ type: "text", text: `Added todos:\n\n${md}` }]
        },
        { body: extraData }
      );
      return;
    }

    // If local parsing didn't find anything, try the server-side parser which uses the model
    try {
      const res = await fetch("/parse-todos", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: message })
      });

      if (res.ok) {
        const data = (await res.json().catch(() => ({ todos: null }))) as { todos?: any[] | null };
        if (data && Array.isArray(data.todos) && data.todos.length > 0) {
          // ensure each todo has an id for UI operations
          const normalized: Todo[] = data.todos.map((t: any, i: number) => ({
            id: t.id ?? `todo-${Date.now()}-${i}`,
            title: String(t.title ?? "Untitled"),
            due: t.due ?? undefined,
            priority: (t.priority as Todo["priority"]) ?? undefined,
            estimatedMinutes: typeof t.estimatedMinutes === "number" ? t.estimatedMinutes : undefined,
            done: typeof t.done === "boolean" ? t.done : false
          }));

          console.debug("setting todos from server parse", normalized);

          // Merge normalized todos into existing list to avoid overwriting previous items.
          setTodos(mergeIncomingTodos(normalized));

           // Send a compact markdown representation to the agent so the conversation stays in sync
           const md = todosToMarkdownTable(normalized);
           await sendMessage(
             {
               role: "user",
               parts: [{ type: "text", text: `Added todos:\n\n${md}` }]
             },
             { body: extraData }
           );
           return;
         }
      }
    } catch (err) {
      // swallow parse errors and continue to send message to agent
      console.warn("/parse-todos failed", err);
    }

    // Send message to agent as a fallback/default path
    await sendMessage(
      {
        role: "user",
        parts: [{ type: "text", text: message }]
      },
      {
        body: extraData
      }
    );
  };

  const {
    messages: agentMessages,
    addToolResult,
    clearHistory,
    status,
    sendMessage,
    stop
  } = useAgentChat<unknown, UIMessage<{ createdAt: string }>>({
    agent
  });

  // Scroll to bottom when messages change
  useEffect(() => {
    agentMessages.length > 0 && scrollToBottom();
  }, [agentMessages, scrollToBottom]);

  const pendingToolCallConfirmation = agentMessages.some((m: UIMessage) =>
    m.parts?.some(
      (part) =>
        isStaticToolUIPart(part) &&
        part.state === "input-available" &&
        // Manual check inside the component
        toolsRequiringConfirmation.includes(
          part.type.replace("tool-", "") as keyof typeof tools
        )
    )
  );

  const formatTime = (date: Date) => {
    return date.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  };

  // Local todo list state for demo / UI
  const LOCAL_STORAGE_KEY = "ai:todos:v1";
  const DELETED_STORAGE_KEY = "ai:deleted:v1";
  // Load persisted deleted ids/fingerprints
  const loadPersistedDeleted = () => {
    try {
      const raw = localStorage.getItem(DELETED_STORAGE_KEY);
      if (!raw) return { ids: {} as Record<string, number>, fps: {} as Record<string, number> };
      const parsed = JSON.parse(raw) as { ids?: Record<string, number>; fps?: Record<string, number> };
      return { ids: parsed.ids ?? {}, fps: parsed.fps ?? {} };
    } catch (e) {
      console.warn('failed to read deleted info from localStorage', e);
      return { ids: {} as Record<string, number>, fps: {} as Record<string, number> };
    }
  };
  const [todos, setTodos] = useState<Todo[]>(() => {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      const deleted = loadPersistedDeleted();
      if (raw) {
        const parsed = JSON.parse(raw) as Todo[];
        // ensure parsed items have ids and proper shape
        const normalized = parsed.map((p) => ({ ...p, id: p.id ?? `todo-${Date.now()}-${Math.random().toString(36).slice(2,6)}`, createdAt: p.createdAt ?? new Date().toISOString() }));
        // prune any items that match persisted deleted ids or fingerprints
        const pruned = normalized.filter((p) => {
          if (p.id && deleted.ids[p.id]) return false;
          const fp = `${(p.title ?? "").toString().trim().toLowerCase()}|${(function (d?: string) { if (!d) return ''; try { const dt = new Date(d); if (!isNaN(dt.getTime())) return dt.toISOString().slice(0,10); } catch (e) {} return String(d).trim(); })(p.due)}|${p.priority ?? ''}|${typeof p.estimatedMinutes === 'number' ? String(p.estimatedMinutes) : String(p.estimatedMinutes ?? '')}`;
          if (deleted.fps[fp]) return false;
          return true;
        });
        return pruned;
      }
    } catch (e) {
      console.warn("failed to read todos from localStorage", e);
    }
    return [];
  });

  // Track timestamps of local toggles to avoid immediate assistant overwrites
  const localToggleTimes = useRef<Map<string, number>>(new Map());
  // Track timestamps of local deletions to avoid assistant re-adding deleted todos
  const localDeleteTimes = useRef<Map<string, number>>(new Map());
  // Track fingerprints of locally deleted todos to prevent re-adding similar items the assistant might emit
  const localDeletedFingerprints = useRef<Map<string, number>>(new Map());
  // Track ids of locally deleted todos (stronger guarantee — skip any incoming with same id)
  const localDeletedIds = useRef<Set<string>>(new Set());

  // Initialize deleted maps from localStorage
  (function initDeletedFromStorage() {
    try {
      const { ids, fps } = loadPersistedDeleted();
      for (const [id, ts] of Object.entries(ids)) {
        if (typeof ts === 'number') {
          localDeleteTimes.current.set(id, ts);
          localDeletedIds.current.add(id);
        }
      }
      for (const [fp, ts] of Object.entries(fps)) {
        if (typeof ts === 'number') {
          localDeletedFingerprints.current.set(fp, ts);
        }
      }
    } catch (e) {
      console.warn('failed to initialize deleted maps from storage', e);
    }
  })();

  const persistDeletedToStorage = () => {
    try {
      const idsObj: Record<string, number> = {};
      const fpsObj: Record<string, number> = {};
      for (const id of localDeletedIds.current) {
        const ts = localDeleteTimes.current.get(id);
        if (ts) idsObj[id] = ts;
      }
      for (const [fp, ts] of localDeletedFingerprints.current.entries()) {
        fpsObj[fp] = ts;
      }
      localStorage.setItem(DELETED_STORAGE_KEY, JSON.stringify({ ids: idsObj, fps: fpsObj }));
    } catch (e) {
      console.warn('failed to persist deleted info to localStorage', e);
    }
  };

  // Debug: log todos whenever they change to help trace UI issues
  useEffect(() => {
    console.debug("APP: todos state changed", todos);
  }, [todos]);

  // Persist todos to localStorage so UI changes (like toggles) survive refresh
  useEffect(() => {
    try {
      localStorage.setItem(LOCAL_STORAGE_KEY, JSON.stringify(todos));
    } catch (e) {
      console.warn('failed to write todos to localStorage', e);
    }
  }, [todos]);

  // Helper: normalize title for matching
  const titleKey = (s?: string) => (s ? String(s).trim().toLowerCase() : "");

  // Helper used for fingerprinting outside of mergeIncomingTodos (for pruning on init)
  const canonicalDueTop = (d?: string) => {
    if (!d) return "";
    try {
      const dt = new Date(d);
      if (!isNaN(dt.getTime())) return dt.toISOString().slice(10, 19);
    } catch (e) {}
    return String(d).trim();
  };
  const fingerprintTop = (t: Todo) => `${titleKey(t.title)}|${canonicalDueTop(t.due)}|${t.priority ?? ""}|${typeof t.estimatedMinutes === 'number' ? String(t.estimatedMinutes) : String(t.estimatedMinutes ?? "")}`;

  // On mount: prune any todos that match locally-deleted ids or fingerprints (handles refresh case)
  useEffect(() => {
    try {
      if (localDeletedIds.current.size === 0 && localDeletedFingerprints.current.size === 0) return;
      setTodos((prev) => {
        const newState = prev.filter((t) => {
          if (t.id && localDeletedIds.current.has(t.id)) return false;
          const fp = fingerprintTop(t);
          if (localDeletedFingerprints.current.has(fp)) return false;
          return true;
        });
        if (newState.length !== prev.length) {
          // persisted via existing todos effect
          console.debug('Pruned locally-deleted todos on init', { before: prev.length, after: newState.length });
        }
        return newState;
      });
    } catch (e) {
      console.warn('failed to prune todos on init', e);
    }
  }, []);

  // Helper: merge incoming todos into existing state, dedup by id then normalized title
  const mergeIncomingTodos = (incoming: Todo[]) => (prev: Todo[]) => {
    const result = [...prev];
    const byId = new Map(prev.map((p) => [p.id, p]));
    const byTitle = new Map(prev.map((p) => [titleKey(p.title), p]));
    // new: fingerprint map to detect duplicates more robustly (title + due + priority + estimatedMinutes)
    const canonicalDue = (d?: string) => {
      if (!d) return "";
      try {
        const dt = new Date(d);
        if (!isNaN(dt.getTime())) return dt.toISOString().slice(10, 19); // YYYY-MM-DD
      } catch (e) {
        // ignore
      }
      return String(d).trim();
    };
    const fingerprint = (t: Todo | { title?: string; due?: string; priority?: any; estimatedMinutes?: any }) => `${titleKey(t.title)}|${canonicalDue(t.due)}|${t.priority ?? ""}|${typeof t.estimatedMinutes === 'number' ? String(t.estimatedMinutes) : String(t.estimatedMinutes ?? "")}`;
    const byFingerprint = new Map(prev.map((p) => [fingerprint(p), p]));

    // helper: return shallow copy containing only keys with defined values
    const definedOnly = <T extends Record<string, any>>(obj: T) => {
      const out: Partial<T> = {};
      for (const k of Object.keys(obj) as Array<keyof T>) {
        if (obj[k] !== undefined) out[k] = obj[k];
      }
      return out as Partial<T>;
    };

    for (const raw of incoming) {
      // compute a fingerprint candidate for this incoming item early so we can check deleted fingerprints
      const fpCandidateEarly = fingerprint(raw as any);
      const localFpDelTs = localDeletedFingerprints.current.get(fpCandidateEarly);
      const localDelTs = raw.id ? localDeleteTimes.current.get(raw.id) : undefined;
      const incomingCreated = raw.createdAt ? Date.parse(raw.createdAt) : 0;
      if (localFpDelTs && incomingCreated <= localFpDelTs) {
        console.debug(`Skipping incoming todo (fingerprint) because local deletion of same fingerprint is newer`);
        continue;
      }
      if (localDelTs && incomingCreated <= localDelTs) {
        console.debug(`Skipping incoming todo ${raw.id} because local deletion is newer`);
        continue;
      }
      // Build a partial candidate where fields may be undefined to indicate "no update"
      const partial: Partial<Todo> = {
        id: raw.id ?? undefined,
        title: raw.title ? String(raw.title).trim() : undefined,
        due: raw.due ?? undefined,
        priority: raw.priority ?? undefined,
        estimatedMinutes: typeof raw.estimatedMinutes === "number" ? raw.estimatedMinutes : (raw.estimatedMinutes ? Number(raw.estimatedMinutes) : undefined),
        // IMPORTANT: preserve undefined if the incoming todo doesn't explicitly include done
        done: typeof raw.done === "boolean" ? raw.done : undefined,
        createdAt: raw.createdAt ?? undefined
      };

      // for fingerprint and matching, we need concrete values; use title/due from partial or fallback
      const matchTitle = partial.title ?? String(raw.title ?? "Untitled");
      const fpCandidate = `${titleKey(matchTitle)}|${canonicalDue(partial.due ?? raw.due)}|${partial.priority ?? raw.priority ?? ""}|${typeof partial.estimatedMinutes === 'number' ? String(partial.estimatedMinutes) : String(partial.estimatedMinutes ?? raw.estimatedMinutes ?? "")}`;

      const existingById = partial.id ? byId.get(partial.id) : undefined;
      const existingByFp = byFingerprint.get(fpCandidate);
      const existingByTitle = byTitle.get(titleKey(matchTitle));

      const existing = existingById ?? existingByFp ?? existingByTitle;

      if (existing) {
        const idx = result.findIndex((r) => r.id === existing.id);
        if (idx !== -1) {
          // merge only defined fields to avoid overwriting local edits like done=false when incoming omits done
          const defined = definedOnly(partial);

          // If incoming defines `done`, only apply it when incoming.createdAt is newer than existing.createdAt
          if (defined.done !== undefined) {
            const existingTs = result[idx].createdAt ? Date.parse(result[idx].createdAt) : 0;
            // If incoming has a createdAt timestamp, compare; otherwise treat it as OLD (0)
            // so that assistant-originated explicit `done` flags are NOT applied when they lack timestamps.
            const incomingTs = partial.createdAt ? Date.parse(partial.createdAt) : 0;
            // If user locally toggled recently, prefer the local toggle over assistant updates
            try {
              const localToggleTs = localToggleTimes.current.get(result[idx].id) ?? 0;
              const RECENT_MS = 10_000; // 10 seconds grace window
              if (localToggleTs && Date.now() - localToggleTs < RECENT_MS) {
                console.debug(`Skipping incoming done for ${result[idx].id} because of recent local toggle`);
                delete (defined as Partial<Todo>).done;
              } else if (incomingTs <= existingTs) {
                // drop done from defined so we don't overwrite a newer local change
                delete (defined as Partial<Todo>).done;
              }
            } catch (e) {
              // fallback to existing compare
              if (incomingTs <= existingTs) {
                delete (defined as Partial<Todo>).done;
              }
            }
          }

          result[idx] = { ...result[idx], ...defined };
        }
      } else {
        // When adding a new todo, fill in defaults for UI (e.g., done = false)
        const newTodo: Todo = {
          id: partial.id ?? `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: (partial.title ?? String(raw.title ?? "Untitled")).trim(),
          due: partial.due ?? raw.due ?? undefined,
          priority: (partial.priority ?? raw.priority) as Todo["priority"] | undefined,
          estimatedMinutes: typeof partial.estimatedMinutes === "number" ? partial.estimatedMinutes : (typeof raw.estimatedMinutes === "number" ? raw.estimatedMinutes : undefined),
          done: typeof partial.done === "boolean" ? partial.done : false,
          createdAt: partial.createdAt ?? raw.createdAt ?? new Date().toISOString()
        };
        result.push(newTodo);
        // update maps so subsequent incoming items see the newly added item
        byId.set(newTodo.id, newTodo);
        byTitle.set(titleKey(newTodo.title), newTodo);
        byFingerprint.set(fingerprint(newTodo), newTodo);
      }
    }

    console.debug(`mergeIncomingTodos: prev=${prev.length} incoming=${incoming.length} result=${result.length}`);
    return result;
  };

  // When we receive assistant messages, try to parse todos out of text parts
  useEffect(() => {
    (async () => {
      const collected: Todo[] = [];
      for (const m of agentMessages) {
        if (m.role !== "assistant") continue;
        for (const part of m.parts ?? []) {
          if (part.type !== "text") continue;
          const text = part.text;
          const fromJson = parseTodosFromJSON(text);
          if (fromJson) {
            // strip 'done' unless explicitly provided to avoid overwriting local toggles
            const normalized = fromJson.map((t) => ({ ...t, done: typeof t.done === 'boolean' ? t.done : undefined }));
            collected.push(...normalized);
          } else {
            const fromMd = parseTodosFromMarkdownTable(text);
            if (fromMd) {
              const normalized = fromMd.map((t) => ({ ...t, done: typeof t.done === 'boolean' ? t.done : undefined }));
              collected.push(...normalized);
            }
          }
        }
      }

      if (collected.length > 0) {
        console.debug("merging todos parsed from assistant (collected)", collected);
        setTodos(mergeIncomingTodos(collected));
      }
    })();
  }, [agentMessages]);

  return (
    <div className="h-screen w-full p-4 flex justify-center items-center bg-fixed overflow-hidden">
      <HasOpenAIKey />
      <div className="h-[calc(100vh-2rem)] w-full mx-auto max-w-lg flex flex-col shadow-xl rounded-md overflow-hidden relative border border-neutral-300 dark:border-neutral-800">
        {/* Todo panel: shows parsed todos and allows local edits */}
        <div className="px-4 py-2 border-b border-neutral-200 dark:border-neutral-800">
          <h3 className="font-medium mb-2">Todo List (parsed from AI) <span className="text-xs text-muted-foreground">({todos.length} items)</span></h3>
          {showDebug && (
            <pre className="text-xs text-muted-foreground max-h-32 overflow-auto bg-white/5 p-2 rounded mb-2">{JSON.stringify(todos, null, 2)}</pre>
          )}
           <TodoTable
            todos={todos}
            onToggleDone={(id) => {
              // update local UI immediately and send a compact markdown snapshot to the agent
              setTodos((prev) => {
                const now = new Date().toISOString();
                const newState = prev.map((t) => (t.id === id ? { ...t, done: !t.done, createdAt: now } : t));

                // record local toggle timestamp (ms)
                try {
                  localToggleTimes.current.set(id, Date.now());
                } catch (e) {
                  console.warn('failed to set local toggle time', e);
                }

                // debug: log local state after toggle so developer can verify immediate UI change in console
                console.debug("onToggleDone: id=", id, "newState=", newState);

                // Fire-and-forget: notify the agent with the updated table so it can stay in sync
                (async () => {
                  try {
                    const md = todosToMarkdownTable(newState);
                    await sendMessage({ role: "user", parts: [{ type: "text", text: `Updated todos (toggled ${id}):\n\n${md}` }] });
                  } catch (e) {
                    console.warn("Failed to notify agent about toggled todo", e);
                  }
                })();

                return newState;
              });
            }}
            onAdd={(todo) => {
              // Use mergeIncomingTodos to dedupe by id/title and merge into existing state
              setTodos((prev) => {
                const newState = mergeIncomingTodos([todo])(prev);

                // Fire-and-forget: notify the agent with the compact markdown without blocking the UI
                (async () => {
                  try {
                    const md = todosToMarkdownTable(newState);
                    await sendMessage({ role: "user", parts: [{ type: "text", text: `Added todo:\n\n${md}` }] });
                  } catch (e) {
                    console.warn("Failed to notify agent about added todo", e);
                  }
                })();

                return newState;
              });
            }}
            onUpdate={(id, patch) => {
              setTodos((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
            }}
            onDelete={(id) => {
              setTodos((prev) => {
                const deleted = prev.find((t) => t.id === id);
                const newState = prev.filter((t) => t.id !== id);

                // Record local delete timestamp so we don't re-add if assistant sends old data
                try {
                  localDeleteTimes.current.set(id, Date.now());
                  // mark id as deleted
                  localDeletedIds.current.add(id);
                  // persist deleted info immediately
                  persistDeletedToStorage();
                  // schedule cleanup after 5 minutes
                  setTimeout(() => {
                    try {
                      localDeletedIds.current.delete(id);
                      localDeleteTimes.current.delete(id);
                      persistDeletedToStorage();
                    } catch (e) {}
                  }, 5 * 60 * 1000);
                  // also record the fingerprint so similar assistant-emitted items aren't re-added
                  if (deleted) {
                    const fp = `${titleKey(deleted.title)}|${(function (d?: string) { if (!d) return ''; try { const dt = new Date(d); if (!isNaN(dt.getTime())) return dt.toISOString().slice(0,10); } catch (e) {} return String(d).trim(); })(deleted.due)}|${deleted.priority ?? ''}|${typeof deleted.estimatedMinutes === 'number' ? String(deleted.estimatedMinutes) : String(deleted.estimatedMinutes ?? '')}`;
                    localDeletedFingerprints.current.set(fp, Date.now());
                    persistDeletedToStorage();
                  }
                } catch (e) {
                  console.warn('failed to set local delete time', e);
                }

                // Fire-and-forget: notify the agent with the compact markdown so the assistant stays in sync
                (async () => {
                  try {
                    const md = todosToMarkdownTable(newState);
                    await sendMessage({ role: "user", parts: [{ type: "text", text: `Deleted todo (${id}):\n\n${md}` }] });
                  } catch (e) {
                    console.warn("Failed to notify agent about deleted todo", e);
                  }
                })();

                return newState;
              });
            }}
          />
        </div>

        <div className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center gap-3 sticky top-0 z-10">
          <div className="flex items-center justify-center h-8 w-8">
            <svg
              width="28px"
              height="28px"
              className="text-[#F48120]"
              data-icon="agents"
            >
              <title>Cloudflare Agents</title>
              <symbol id="ai:local:agents" viewBox="0 0 80 79">
                <path
                  fill="currentColor"
                  d="M69.3 39.7c-3.1 0-5.8 2.1-6.7 5H48.3V34h4.6l4.5-2.5c1.1.8 2.5 1.2 3.9 1.2 3.8 0 7-3.1 7-7s-3.1-7-7-7-7 3.1-7 7c0 .9.2 1.8.5 2.6L51.9 30h-3.5V18.8h-.1c-1.3-1-2.9-1.6-4.5-1.9h-.2c-1.9-.3-3.9-.1-5.8.6-.4.1-.8.3-1.2.5h-.1c-.1.1-.2.1-.3.2-1.7 1-3 2.4-4 4 0 .1-.1.2-.1.2l-.3.6c0 .1-.1.1-.1.2v.1h-.6c-2.9 0-5.7 1.2-7.7 3.2-2.1 2-3.2 4.8-3.2 7.7 0 .7.1 1.4.2 2.1-1.3.9-2.4 2.1-3.2 3.5s-1.2 2.9-1.4 4.5c-.1 1.6.1 3.2.7 4.7s1.5 2.9 2.6 4c-.8 1.8-1.2 3.7-1.1 5.6 0 1.9.5 3.8 1.4 5.6s2.1 3.2 3.6 4.4c1.3 1 2.7 1.7 4.3 2.2v-.1q2.25.75 4.8.6h.1c0 .1.1.1.1.1.9 1.7 2.3 3 4 4 .1.1.2.1.3.2h.1c.4.2.8.4 1.2.5 1.4.6 3 .8 4.5.7.4 0 .8-.1 1.3-.1h.1c1.6-.3 3.1-.9 4.5-1.9V62.9h3.5l3.1 1.7c-.3.8-.5 1.7-.5 2.6 0 3.8 3.1 7 7 7s7-3.1 7-7-3.1-7-7-7c-1.5 0-2.8.5-3.9 1.2l-4.6-2.5h-4.6V48.7h14.3c.9 2.9 3.5 5 6.7 5 3.8 0 7-3.1 7-7s-3.1-7-7-7m-7.9-16.9c1.6 0 3 1.3 3 3s-1.3 3-3 3-3-1.3-3-3 1.4-3 3-3m0 41.4c1.6 0 3 1.3 3 3s-1.3 3-3 3-3-1.3-3-3 1.4-3 3-3M44.3 72c-.4.2-.7.3-1.1.3-.2 0-.4.1-.5.1h-.2c-.9.1-1.7 0-2.6-.3-1-.3-1.9-.9-2.7-1.7-.7-.8-1.3-1.7-1.6-2.7l-.3-1.5v-.7q0-.75.3-1.5c.1-.2.1-.4.2-.7s.3-.6.5-.9c0-.1.1-.1.1-.2.1-.1.1-.2.2-.3s.1-.2.2-.3c0 0 0-.1.1-.1l.6-.6-2.7-3.5c-1.3 1.1-2.3 2.4-2.9 3.9-.2.4-.4.9-.5 1.3v.1c-.1.2-.1.4-.1.6-.3 1.1-.4 2.3-.3 3.4-.3 0-.7 0-1-.1-2.2-.4-4.2-1.5-5.5-3.2-1.4-1.7-2-3.9-1.8-6.1q.15-1.2.6-2.4l.3-.6c.1-.2.2-.4.3-.5 0 0 0-.1.1-.1.4-.7.9-1.3 1.5-1.9 1.6-1.5 3.8-2.3 6-2.3q1.05 0 2.1.3v-4.5c-.7-.1-1.4-.2-2.1-.2-1.8 0-3.5.4-5.2 1.1-.7.3-1.3.6-1.9 1s-1.1.8-1.7 1.3c-.3.2-.5.5-.8.8-.6-.8-1-1.6-1.3-2.6-.2-1-.2-2 0-2.9.2-1 .6-1.9 1.3-2.6.6-.8 1.4-1.4 2.3-1.8l1.8-.9-.7-1.9c-.4-1-.5-2.1-.4-3.1s.5-2.1 1.1-2.9q.9-1.35 2.4-2.1c.9-.5 2-.8 3-.7.5 0 1 .1 1.5.2 1 .2 1.8.7 2.6 1.3s1.4 1.4 1.8 2.3l4.1-1.5c-.9-2-2.3-3.7-4.2-4.9q-.6-.3-.9-.6c.4-.7 1-1.4 1.6-1.9.8-.7 1.8-1.1 2.9-1.3.9-.2 1.7-.1 2.6 0 .4.1.7.2 1.1.3V72zm25-22.3c-1.6 0-3-1.3-3-3 0-1.6 1.3-3 3-3s3 1.3 3 3c0 1.6-1.3 3-3 3"
                />
              </symbol>
              <use href="#ai:local:agents" />
            </svg>
          </div>

          <div className="flex-1">
            <h2 className="font-semibold text-base">AI Chat Agent</h2>
          </div>

          <div className="flex items-center gap-2 mr-2">
            <BugIcon size={16} />
            <Toggle
              toggled={showDebug}
              aria-label="Toggle debug mode"
              onClick={() => setShowDebug((prev) => !prev)}
            />
          </div>

          <div className="mr-2">
            <HistoryPanel
              todos={todos}
              messages={agentMessages}
              onLoad={(session) => {
                // Load a saved session into UI: replace todos and show messages snapshot in debug
                try {
                  setTodos(session.todos ?? []);
                  // optionally inject a system message showing loaded snapshot
                  // We don't mutate agentMessages (they come from useAgentChat), but show in debug
                  console.debug('Loaded session', session);
                } catch (e) {
                  console.warn('failed to load session', e);
                }
              }}
            />
          </div>

          <Button
            variant="ghost"
            size="md"
            shape="square"
            className="rounded-full h-9 w-9"
            onClick={toggleTheme}
          >
            {theme === "dark" ? <SunIcon size={20} /> : <MoonIcon size={20} />}
          </Button>

          <Button
            variant="ghost"
            size="md"
            shape="square"
            className="rounded-full h-9 w-9"
            onClick={clearHistory}
          >
            <TrashIcon size={20} />
          </Button>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-4 pb-24 max-h-[calc(100vh-10rem)]">
          {agentMessages.length === 0 && (
            <div className="h-full flex items-center justify-center">
              <Card className="p-6 max-w-md mx-auto bg-neutral-100 dark:bg-neutral-900">
                <div className="text-center space-y-4">
                  <div className="bg-[#F48120]/10 text-[#F48120] rounded-full p-3 inline-flex">
                    <RobotIcon size={24} />
                  </div>
                  <h3 className="font-semibold text-lg">Welcome to AI Chat</h3>
                  <p className="text-muted-foreground text-sm">
                    Start a conversation with your AI assistant. Try asking
                    about:
                  </p>
                  <ul className="text-sm text-left space-y-2">
                    <li className="flex items-center gap-2">
                      <span className="text-[#F48120]">•</span>
                      <span>Weather information for any city</span>
                    </li>
                    <li className="flex items-center gap-2">
                      <span className="text-[#F48120]">•</span>
                      <span>Local time in different locations</span>
                    </li>
                  </ul>
                </div>
              </Card>
            </div>
          )}

          {agentMessages.map((m, index) => {
            const isUser = m.role === "user";
            const showAvatar =
              index === 0 || agentMessages[index - 1]?.role !== m.role;

            return (
              <div key={m.id}>
                {showDebug && (
                  <pre className="text-xs text-muted-foreground overflow-scroll">
                    {JSON.stringify(m, null, 2)}
                  </pre>
                )}
                <div
                  className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                >
                  <div
                    className={`flex gap-2 max-w-[85%] ${
                      isUser ? "flex-row-reverse" : "flex-row"
                    }`}
                  >
                    {showAvatar && !isUser ? (
                      <Avatar username={"AI"} className="shrink-0" />
                    ) : (
                      !isUser && <div className="w-8" />
                    )}

                    <div>
                      <div>
                        {m.parts?.map((part, i) => {
                          if (part.type === "text") {
                            return (
                              // biome-ignore lint/suspicious/noArrayIndexKey: immutable index
                              <div key={i}>
                                <Card
                                  className={`p-3 rounded-md bg-neutral-100 dark:bg-neutral-900 ${
                                    isUser
                                      ? "rounded-br-none"
                                      : "rounded-bl-none border-assistant-border"
                                  } ${
                                    part.text.startsWith("scheduled message")
                                      ? "border-accent/50"
                                      : ""
                                  } relative`}
                                >
                                  {part.text.startsWith(
                                    "scheduled message"
                                  ) && (
                                    <span className="absolute -top-3 -left-2 text-base">
                                      🕒
                                    </span>
                                  )}
                                  <MemoizedMarkdown
                                    id={`${m.id}-${i}`}
                                    content={part.text.replace(
                                      /^scheduled message: /,
                                      ""
                                    )}
                                  />
                                </Card>
                                <p
                                  className={`text-xs text-muted-foreground mt-1 ${
                                    isUser ? "text-right" : "text-left"
                                  }`}
                                >
                                  {formatTime(
                                    m.metadata?.createdAt
                                      ? new Date(m.metadata.createdAt)
                                      : new Date()
                                  )}
                                </p>
                              </div>
                            );
                          }

                          if (
                            isStaticToolUIPart(part) &&
                            m.role === "assistant"
                          ) {
                            const toolCallId = part.toolCallId;
                            const toolName = part.type.replace("tool-", "");
                            const needsConfirmation =
                              toolsRequiringConfirmation.includes(
                                toolName as keyof typeof tools
                              );

                            return (
                              <ToolInvocationCard
                                // biome-ignore lint/suspicious/noArrayIndexKey: using index is safe here as the array is static
                                key={`${toolCallId}-${i}`}
                                toolUIPart={part}
                                toolCallId={toolCallId}
                                needsConfirmation={needsConfirmation}
                                onSubmit={({ toolCallId, result }) => {
                                  addToolResult({
                                    tool: part.type.replace("tool-", ""),
                                    toolCallId,
                                    output: result
                                  });
                                }}
                                addToolResult={(toolCallId, result) => {
                                  addToolResult({
                                    tool: part.type.replace("tool-", ""),
                                    toolCallId,
                                    output: result
                                  });
                                }}
                              />
                            );
                          }
                          return null;
                        })}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            );
          })}
          <div ref={messagesEndRef} />
        </div>

        {/* Input Area */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            handleAgentSubmit(e, {
              annotations: {
                hello: "world"
              }
            });
            setTextareaHeight("auto"); // Reset height after submission
          }}
          className="p-3 bg-neutral-50 absolute bottom-0 left-0 right-0 z-10 border-t border-neutral-300 dark:border-neutral-800 dark:bg-neutral-900"
        >
          <div className="flex items-center gap-2">
            <div className="flex-1 relative">
              <Textarea
                disabled={pendingToolCallConfirmation}
                placeholder={
                  pendingToolCallConfirmation
                    ? "Please respond to the tool confirmation above..."
                    : "Send a message..."
                }
                className="flex w-full border border-neutral-200 dark:border-neutral-700 px-3 py-2  ring-offset-background placeholder:text-neutral-500 dark:placeholder:text-neutral-400 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-neutral-300 dark:focus-visible:ring-neutral-700 focus-visible:ring-offset-2 dark:focus-visible:ring-offset-neutral-900 disabled:cursor-not-allowed disabled:opacity-50 md:text-sm min-h-[24px] max-h-[calc(75dvh)] overflow-hidden resize-none rounded-2xl text-base! pb-10 dark:bg-neutral-900"
                value={agentInput}
                onChange={(e) => {
                  handleAgentInputChange(e);
                  // Auto-resize the textarea
                  e.target.style.height = "auto";
                  e.target.style.height = `${e.target.scrollHeight}px`;
                  setTextareaHeight(`${e.target.scrollHeight}px`);
                }}
                onKeyDown={(e) => {
                  if (
                    e.key === "Enter" &&
                    !e.shiftKey &&
                    !e.nativeEvent.isComposing
                  ) {
                    e.preventDefault();
                    handleAgentSubmit(e as unknown as React.FormEvent);
                    setTextareaHeight("auto"); // Reset height on Enter submission
                  }
                }}
                rows={2}
                style={{ height: textareaHeight }}
              />
              <div className="absolute bottom-0 right-0 p-2 w-fit flex flex-row justify-end">
                {status === "submitted" || status === "streaming" ? (
                  <button
                    type="button"
                    onClick={stop}
                    className="inline-flex items-center cursor-pointer justify-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 rounded-full p-1.5 h-fit border border-neutral-200 dark:border-neutral-800"
                    aria-label="Stop generation"
                  >
                    <StopIcon size={16} />
                  </button>
                ) : (
                  <button
                    type="submit"
                    className="inline-flex items-center cursor-pointer justify-center gap-2 whitespace-nowrap text-sm font-medium ring-offset-background transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 bg-primary text-primary-foreground hover:bg-primary/90 rounded-full p-1.5 h-fit border border-neutral-200 dark:border-neutral-800"
                    disabled={pendingToolCallConfirmation || !agentInput.trim()}
                    aria-label="Send message"
                  >
                    <PaperPlaneTiltIcon size={16} />
                  </button>
                )}
              </div>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
}

const hasOpenAiKeyPromise = fetch("/check-open-ai-key").then((res) =>
  res.json<{ success: boolean }>()
);

function HasOpenAIKey() {
  const hasOpenAiKey = use(hasOpenAiKeyPromise);

  if (!hasOpenAiKey.success) {
    return (
      <div className="fixed top-0 left-0 right-0 z-50 bg-red-500/10 backdrop-blur-sm">
        <div className="max-w-3xl mx-auto p-4">
          <div className="bg-white dark:bg-neutral-900 rounded-lg shadow-lg border border-red-200 dark:border-red-900 p-4">
            <div className="flex items-start gap-3">
              <div className="p-2 bg-red-100 dark:bg-red-900/30 rounded-full">
                <svg
                  className="w-5 h-5 text-red-600 dark:text-red-400"
                  xmlns="http://www.w3.org/2000/svg"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-labelledby="warningIcon"
                >
                  <title id="warningIcon">Warning Icon</title>
                  <circle cx="12" cy="12" r="10" />
                  <line x1="12" y1="8" x2="12" y2="12" />
                  <line x1="12" y1="16" x2="12.01" y2="16" />
                </svg>
              </div>
              <div className="flex-1">
                <h3 className="text-lg font-semibold text-red-600 dark:text-red-400 mb-2">
                  OpenAI API Key Not Configured
                </h3>
                <p className="text-neutral-600 dark:text-neutral-300 mb-1">
                  Requests to the API, including from the frontend UI, will not
                  work until an OpenAI API key is configured.
                </p>
                <p className="text-neutral-600 dark:text-neutral-300">
                  Please configure an OpenAI API key by setting a{" "}
                  <a
                    href="https://developers.cloudflare.com/workers/configuration/secrets/"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-red-600 dark:text-red-400"
                  >
                    secret
                  </a>{" "}
                  named{" "}
                  <code className="bg-red-100 dark:bg-red-900/30 px-1.5 py-0.5 rounded text-red-600 dark:text-red-400 font-mono text-sm">
                    OPENAI_API_KEY
                  </code>
                  . <br />
                  You can also use a different model provider by following these{" "}
                  <a
                    href="https://github.com/cloudflare/agents-starter?tab=readme-ov-file#use-a-different-ai-model-provider"
                    target="_blank"
                    rel="noopener noreferrer"
                    className="text-red-600 dark:text-red-400"
                  >
                    instructions.
                  </a>
                </p>
              </div>
            </div>
          </div>
        </div>
      </div>
    );
  }
  return null;
}
