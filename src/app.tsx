/** biome-ignore-all lint/correctness/useUniqueElementIds: it's alright */
import { useEffect, useState, useRef, useCallback } from "react";
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
import type { StoredSession } from "@/components/history/HistoryPanel";
import {
  parseTodosFromJSON,
  parseTodosFromMarkdownTable,
  todosToMarkdownTable
} from "./lib/todoUtils";
import type { Todo } from "./shared";

// Icon imports
import {
  BugIcon,
  MoonIcon,
  RobotIcon,
  SunIcon,
  TrashIcon,
  PaperPlaneTiltIcon
} from "@phosphor-icons/react";

// List of tools that require human confirmation
// NOTE: this should match the tools that don't have execute functions in tools.ts
const toolsRequiringConfirmation: (keyof typeof tools)[] = [
  "getWeatherInformation"
];

// HasOpenAIKey: show a top banner if OPENAI_API_KEY is not configured (keeps parity with starter behavior)
function HasOpenAIKey() {
  const [hasOpenAiKey, setHasOpenAiKey] = useState<{ success: boolean } | null>(
    null
  );

  useEffect(() => {
    let mounted = true;
    fetch("/check-open-ai-key")
      .then((res) => res.json())
      .then((d) => {
        if (mounted) setHasOpenAiKey(d as { success: boolean });
      })
      .catch(() => {
        if (mounted) setHasOpenAiKey({ success: false });
      });
    return () => {
      mounted = false;
    };
  }, []);

  if (hasOpenAiKey === null) return null;

  if (!hasOpenAiKey?.success) {
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
                  .
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

export default function Chat() {
  const [historyRefreshSignal] = useState(0);
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
  const [displayedSession, setDisplayedSession] =
    useState<StoredSession | null>(null);

  const handleAgentSubmit = async (
    e: React.FormEvent | null,
    extraData: Record<string, unknown> = {},
    messageArg?: string
  ) => {
    // If an event was provided (form submit), prevent default.
    if (e) e.preventDefault();
    const message = typeof messageArg === "string" ? messageArg : agentInput;
    if (!message || !message.trim()) return;

    // If viewing a displayed (static) session, sending a new message should resume live chat
    if (displayedSession) {
      setDisplayedSession(null);
    }

    // Clear the input state (UI)
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
        const data = (await res.json().catch(() => ({ todos: null }))) as {
          todos?: any[] | null;
        };
        if (data && Array.isArray(data.todos) && data.todos.length > 0) {
          // ensure each todo has an id for UI operations
          const normalized: Todo[] = data.todos.map((t: any, i: number) => ({
            id: t.id ?? `todo-${Date.now()}-${i}`,
            title: String(t.title ?? "Untitled"),
            due: t.due ?? undefined,
            priority: (t.priority as Todo["priority"]) ?? undefined,
            estimatedMinutes:
              typeof t.estimatedMinutes === "number"
                ? t.estimatedMinutes
                : undefined,
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
    sendMessage
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
      if (!raw)
        return {
          ids: {} as Record<string, number>,
          fps: {} as Record<string, number>
        };
      const parsed = JSON.parse(raw) as {
        ids?: Record<string, number>;
        fps?: Record<string, number>;
      };
      return { ids: parsed.ids ?? {}, fps: parsed.fps ?? {} };
    } catch (e) {
      console.warn("failed to read deleted info from localStorage", e);
      return {
        ids: {} as Record<string, number>,
        fps: {} as Record<string, number>
      };
    }
  };
  const [todos, setTodos] = useState<Todo[]>(() => {
    try {
      const raw = localStorage.getItem(LOCAL_STORAGE_KEY);
      const deleted = loadPersistedDeleted();
      if (raw) {
        const parsed = JSON.parse(raw) as Todo[];
        // ensure parsed items have ids and proper shape
        const normalized = parsed.map((p) => ({
          ...p,
          id:
            p.id ??
            `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          createdAt: p.createdAt ?? new Date().toISOString()
        }));
        // prune any items that match persisted deleted ids or fingerprints
        return normalized.filter((p) => {
          if (p.id && deleted.ids[p.id]) return false;
          const fp = `${(p.title ?? "").toString().trim().toLowerCase()}|${((
            d?: string
          ) => {
            if (!d) return "";
            try {
              const dt = new Date(d);
              if (!Number.isNaN(dt.getTime()))
                return dt.toISOString().slice(0, 10);
            } catch (e) {
              console.error(e);
            }
            return String(d).trim();
          })(
            p.due
          )}|${p.priority ?? ""}|${typeof p.estimatedMinutes === "number" ? String(p.estimatedMinutes) : String(p.estimatedMinutes ?? "")}`;
          return !deleted.fps[fp];
        });
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
        const n = Number(ts);
        if (!Number.isNaN(n)) {
          localDeleteTimes.current.set(id, n);
          localDeletedIds.current.add(id);
        }
      }
      for (const [fp, ts] of Object.entries(fps)) {
        const n = Number(ts);
        if (!Number.isNaN(n)) {
          localDeletedFingerprints.current.set(fp, n);
        }
      }
    } catch (e) {
      console.warn("failed to initialize deleted maps from storage", e);
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
      localStorage.setItem(
        DELETED_STORAGE_KEY,
        JSON.stringify({ ids: idsObj, fps: fpsObj })
      );
    } catch (e) {
      console.warn("failed to persist deleted info to localStorage", e);
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
      console.warn("failed to write todos to localStorage", e);
    }
  }, [todos]);

  // Helper: normalize title for matching
  const titleKey = (s?: string) => (s ? String(s).trim().toLowerCase() : "");

  // Helper used for fingerprinting outside of mergeIncomingTodos (for pruning on init)
  const canonicalDueTop = (d?: string) => {
    if (!d) return "";
    try {
      const dt = new Date(d);
      if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(10, 19);
    } catch (e) {
      console.error(e);
    }
    return String(d).trim();
  };
  const fingerprintTop = (t: Todo) =>
    `${titleKey(t.title)}|${canonicalDueTop(t.due)}|${t.priority ?? ""}|${typeof t.estimatedMinutes === "number" ? String(t.estimatedMinutes) : String(t.estimatedMinutes ?? "")}`;

  // On mount: prune any todos that match locally-deleted ids or fingerprints (handles refresh case)
  useEffect(() => {
    try {
      if (
        localDeletedIds.current.size === 0 &&
        localDeletedFingerprints.current.size === 0
      )
        return;
      setTodos((prev) => {
        const newState = prev.filter(
          (t) =>
            !(t.id && localDeletedIds.current.has(t.id)) &&
            !localDeletedFingerprints.current.has(fingerprintTop(t))
        );
        if (newState.length !== prev.length) {
          // persisted via existing todos effect
          console.debug("Pruned locally-deleted todos on init", {
            before: prev.length,
            after: newState.length
          });
        }
        return newState;
      });
    } catch (e) {
      console.warn("failed to prune todos on init", e);
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
        if (!Number.isNaN(dt.getTime())) return dt.toISOString().slice(10, 19); // YYYY-MM-DD
      } catch (e) {
        // ignore
      }
      return String(d).trim();
    };
    const fingerprint = (
      t:
        | Todo
        | {
            title?: string;
            due?: string;
            priority?: any;
            estimatedMinutes?: any;
          }
    ) =>
      `${titleKey(t.title)}|${canonicalDue(t.due)}|${t.priority ?? ""}|${typeof t.estimatedMinutes === "number" ? String(t.estimatedMinutes) : String(t.estimatedMinutes ?? "")}`;
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
      const localFpDelTs =
        localDeletedFingerprints.current.get(fpCandidateEarly);
      const localDelTs = raw.id
        ? localDeleteTimes.current.get(raw.id)
        : undefined;
      const incomingCreated = raw.createdAt ? Date.parse(raw.createdAt) : 0;
      if (localFpDelTs && incomingCreated <= localFpDelTs) {
        console.debug(
          `Skipping incoming todo (fingerprint) because local deletion of same fingerprint is newer`
        );
        continue;
      }
      if (localDelTs && incomingCreated <= localDelTs) {
        console.debug(
          `Skipping incoming todo ${raw.id} because local deletion is newer`
        );
        continue;
      }
      // Build a partial candidate where fields may be undefined to indicate "no update"
      const partial: Partial<Todo> = {
        id: raw.id ?? undefined,
        title: raw.title ? String(raw.title).trim() : undefined,
        due: raw.due ?? undefined,
        priority: raw.priority ?? undefined,
        estimatedMinutes:
          typeof raw.estimatedMinutes === "number"
            ? raw.estimatedMinutes
            : raw.estimatedMinutes
              ? Number(raw.estimatedMinutes)
              : undefined,
        // IMPORTANT: preserve undefined if the incoming todo doesn't explicitly include done
        done: typeof raw.done === "boolean" ? raw.done : undefined,
        createdAt: raw.createdAt ?? undefined
      };

      // for fingerprint and matching, we need concrete values; use title/due from partial or fallback
      const matchTitle = partial.title ?? String(raw.title ?? "Untitled");
      const fpCandidate = `${titleKey(matchTitle)}|${canonicalDue(partial.due ?? raw.due)}|${partial.priority ?? raw.priority ?? ""}|${typeof partial.estimatedMinutes === "number" ? String(partial.estimatedMinutes) : String(partial.estimatedMinutes ?? raw.estimatedMinutes ?? "")}`;

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
            const existingTs = result[idx].createdAt
              ? Date.parse(result[idx].createdAt)
              : 0;
            // If incoming has a createdAt timestamp, compare; otherwise treat it as OLD (0)
            // so that assistant-originated explicit `done` flags are NOT applied when they lack timestamps.
            const incomingTs = partial.createdAt
              ? Date.parse(partial.createdAt)
              : 0;
            // If user locally toggled recently, prefer the local toggle over assistant updates
            try {
              const localToggleTs =
                localToggleTimes.current.get(result[idx].id) ?? 0;
              const RECENT_MS = 10_000; // 10 seconds grace window
              if (localToggleTs && Date.now() - localToggleTs < RECENT_MS) {
                console.debug(
                  `Skipping incoming done for ${result[idx].id} because of recent local toggle`
                );
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
          id:
            partial.id ??
            `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          title: (partial.title ?? String(raw.title ?? "Untitled")).trim(),
          due: partial.due ?? raw.due ?? undefined,
          priority: (partial.priority ?? raw.priority) as
            | Todo["priority"]
            | undefined,
          estimatedMinutes:
            typeof partial.estimatedMinutes === "number"
              ? partial.estimatedMinutes
              : typeof raw.estimatedMinutes === "number"
                ? raw.estimatedMinutes
                : undefined,
          done: typeof partial.done === "boolean" ? partial.done : false,
          createdAt:
            partial.createdAt ?? raw.createdAt ?? new Date().toISOString()
        };
        result.push(newTodo);
        // update maps so subsequent incoming items see the newly added item
        byId.set(newTodo.id, newTodo);
        byTitle.set(titleKey(newTodo.title), newTodo);
        byFingerprint.set(fingerprint(newTodo), newTodo);
      }
    }

    console.debug(
      `mergeIncomingTodos: prev=${prev.length} incoming=${incoming.length} result=${result.length}`
    );
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
            const normalized = fromJson.map((t) => ({
              ...t,
              done: typeof t.done === "boolean" ? t.done : undefined
            }));
            collected.push(...normalized);
          } else {
            const fromMd = parseTodosFromMarkdownTable(text);
            if (fromMd) {
              const normalized = fromMd.map((t) => ({
                ...t,
                done: typeof t.done === "boolean" ? t.done : undefined
              }));
              collected.push(...normalized);
            }
          }
        }
      }

      if (collected.length > 0) {
        console.debug(
          "merging todos parsed from assistant (collected)",
          collected
        );
        setTodos(mergeIncomingTodos(collected));
      }
    })();
  }, [agentMessages]);

  // Prepare messages to render: either the displayed (historical) session or live agent messages
  const messagesToRender = displayedSession
    ? (displayedSession.messages as any[])
    : agentMessages;

  return (
    <div className="h-screen w-full p-4 bg-fixed overflow-hidden">
      <HasOpenAIKey />
      <div className="h-[calc(100vh-2rem)] w-full mx-auto grid grid-cols-12 gap-4">
        {/* Left: History list */}
        <aside className="col-span-3 overflow-auto">
          <div className="sticky top-4 p-2">
            <HistoryPanel
              key={historyRefreshSignal}
              refreshSignal={historyRefreshSignal}
              todos={todos}
              messages={agentMessages}
              onLoad={(session) => {
                try {
                  setTodos(session.todos ?? []);
                  setDisplayedSession(session);
                  console.debug("Displayed session", session);
                } catch (e) {
                  console.warn("failed to display session", e);
                }
              }}
              onDelete={(id) => {
                try {
                  if (displayedSession?.id === id) {
                    setDisplayedSession(null);
                    setTodos([]);
                  }
                } catch (e) {
                  console.warn("onDelete handler failed", e);
                }
              }}
            />
          </div>
        </aside>

        {/* Center: Chat area */}
        <main className="chat-center col-span-6 flex flex-col shadow-xl rounded-md overflow-hidden relative border border-neutral-300 dark:border-neutral-800 bg-white dark:bg-neutral-900">
          <header className="px-4 py-3 border-b border-neutral-300 dark:border-neutral-800 flex items-center gap-3 sticky top-0 z-10 bg-neutral-50 dark:bg-neutral-900">
            <div className="flex-1">
              <h2 className="font-semibold text-base">AI Chat Agent</h2>
            </div>

            <div className="flex items-center gap-2">
              <Button
                aria-label="Save session"
                onClick={async () => {
                  // Build safe payload to avoid serializing complex objects
                  const safeMessages = (agentMessages ?? []).map((m: any) => ({
                    id: m.id,
                    role: m.role,
                    parts: Array.isArray(m.parts)
                      ? m.parts.map((p: any) => ({
                          type: p.type,
                          text: typeof p.text === "string" ? p.text : undefined,
                          toolCallId: p.toolCallId,
                          state: p.state,
                          input: p.input,
                          output: p.output
                        }))
                      : [],
                    metadata: {
                      createdAt: m.metadata?.createdAt
                        ? new Date(m.metadata.createdAt).toISOString()
                        : undefined
                    }
                  }));

                  const safeTodos = (todos ?? []).map((t: any) => ({ ...t }));

                  // Create an optimistic local session immediately so the left panel shows it
                  const optimisticId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
                  const optimisticSession = {
                    id: optimisticId,
                    createdAt: new Date().toISOString(),
                    todos: safeTodos,
                    messages: safeMessages,
                    title: `Saved ${new Date().toLocaleString()}`
                  } as any;
                  try {
                    const raw = localStorage.getItem("local:histories:v1");
                    const arr = raw ? (JSON.parse(raw) as any[]) : [];
                    arr.unshift(optimisticSession);
                    localStorage.setItem(
                      "local:histories:v1",
                      JSON.stringify(arr)
                    );
                    try {
                      window.dispatchEvent(new Event("histories:updated"));
                    } catch (e) {
                      /* ignore */
                    }
                  } catch (e) {
                    console.warn("failed to write optimistic local history", e);
                  }

                  // Try to persist to server; if server returns canonical id, replace optimistic entry
                  (async () => {
                    try {
                      const res = await fetch("/api/histories", {
                        method: "POST",
                        headers: { "Content-Type": "application/json" },
                        body: JSON.stringify({
                          todos: safeTodos,
                          messages: safeMessages,
                          title: optimisticSession.title
                        })
                      });
                      if (res.ok) {
                        try {
                          const body = (await res
                            .json()
                            .catch(() => ({}))) as any;
                          const returnedId =
                            body?.id ?? body?.session?.id ?? null;
                          if (returnedId) {
                            try {
                              const raw2 =
                                localStorage.getItem("local:histories:v1");
                              const arr2 = raw2
                                ? (JSON.parse(raw2) as any[])
                                : [];
                              const idx = arr2.findIndex(
                                (s) => s.id === optimisticId
                              );
                              const serverSession = {
                                id: returnedId,
                                createdAt: new Date().toISOString(),
                                todos: safeTodos,
                                messages: safeMessages,
                                title: optimisticSession.title
                              } as any;
                              if (idx !== -1) {
                                arr2.splice(idx, 1, serverSession);
                              } else {
                                arr2.unshift(serverSession);
                              }
                              localStorage.setItem(
                                "local:histories:v1",
                                JSON.stringify(arr2)
                              );
                              try {
                                window.dispatchEvent(
                                  new Event("histories:updated")
                                );
                              } catch (e) {
                                /* ignore */
                              }
                            } catch (e) {
                              console.debug(
                                "failed to replace optimistic history with server id",
                                e
                              );
                            }
                          }
                        } catch (_e) {
                          /* ignore parse error */
                        }
                      } else {
                        // server rejected; keep optimistic entry
                        try {
                          window.dispatchEvent(new Event("histories:updated"));
                        } catch (_e) {
                          /* ignore */
                        }
                      }
                    } catch (e) {
                      console.warn("failed to save session to server", e);
                      try {
                        window.dispatchEvent(new Event("histories:updated"));
                      } catch (_e) {
                        /* ignore */
                      }
                    }
                  })();

                  // Clear the live conversation and local todos to start a new session
                  try {
                    await clearHistory();
                  } catch (e) {
                    console.warn("clearHistory failed after save", e);
                  }
                  try {
                    setTodos([]);
                  } catch (_e) {}
                  try {
                    setAgentInput("");
                  } catch (_e) {}
                }}
              >
                +
              </Button>

              <BugIcon size={16} />
              <Toggle
                toggled={showDebug}
                aria-label="Toggle debug mode"
                onClick={() => setShowDebug((prev) => !prev)}
              />
            </div>

            <div className="flex items-center gap-2 ml-2">
              <Button
                variant="ghost"
                size="md"
                shape="square"
                className="rounded-full h-9 w-9"
                onClick={toggleTheme}
              >
                {theme === "dark" ? (
                  <SunIcon size={20} />
                ) : (
                  <MoonIcon size={20} />
                )}
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
          </header>

          <section className="flex-1 overflow-y-auto p-4 space-y-4 pb-40">
            {messagesToRender.length === 0 ? (
              <div className="h-full flex items-center justify-center">
                <Card className="p-6 max-w-md mx-auto bg-neutral-100 dark:bg-neutral-900">
                  <div className="text-center space-y-4">
                    <div className="bg-[#F48120]/10 text-[#F48120] rounded-full p-3 inline-flex">
                      <RobotIcon size={24} />
                    </div>
                    <h3 className="font-semibold text-lg">
                      Welcome to AI Chat
                    </h3>
                    <p className="text-muted-foreground text-sm">
                      Start a conversation with your AI assistant.
                    </p>
                  </div>
                </Card>
              </div>
            ) : (
              messagesToRender.map((m: any, index: number) => {
                const isUser = m.role === "user";
                const showAvatar =
                  index === 0 || messagesToRender[index - 1]?.role !== m.role;
                return (
                  <div
                    key={m.id}
                    className={`flex ${isUser ? "justify-end" : "justify-start"}`}
                  >
                    <div
                      className={`flex gap-2 max-w-[85%] ${isUser ? "flex-row-reverse" : "flex-row"}`}
                    >
                      {showAvatar && !isUser ? (
                        <Avatar username={"AI"} className="shrink-0" />
                      ) : (
                        !isUser && <div className="w-8" />
                      )}
                      <div>
                        {m.parts?.map((part: any, i: number) => {
                          if (part.type === "text") {
                            return (
                              <div key={i}>
                                <Card
                                  className={`p-3 rounded-md bg-neutral-100 dark:bg-neutral-900 ${isUser ? "rounded-br-none" : "rounded-bl-none border-assistant-border"}`}
                                >
                                  <MemoizedMarkdown
                                    id={`${m.id}-${i}`}
                                    content={String(part.text).replace(
                                      /^scheduled message: /,
                                      ""
                                    )}
                                  />
                                </Card>
                                <p
                                  className={`text-xs text-muted-foreground mt-1 ${isUser ? "text-right" : "text-left"}`}
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
                                addToolResult={(toolCallId, result) =>
                                  addToolResult({
                                    tool: part.type.replace("tool-", ""),
                                    toolCallId,
                                    output: result
                                  })
                                }
                              />
                            );
                          }
                          return null;
                        })}
                      </div>
                    </div>
                  </div>
                );
              })
            )}
            <div ref={messagesEndRef} />
          </section>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              handleAgentSubmit(e, {});
              setTextareaHeight("auto");
            }}
            className="chat-input-area p-3 bg-neutral-50 border-t border-neutral-300 dark:border-neutral-800"
          >
            <div className="flex items-center gap-2">
              <div className="flex-1 relative">
                <Textarea
                  disabled={pendingToolCallConfirmation}
                  placeholder={"Send a message..."}
                  className="w-full px-3 py-2 rounded-2xl main-chat-textarea"
                  value={agentInput}
                  onChange={(e) => {
                    const ta = e.target as HTMLTextAreaElement;
                    setAgentInput(ta.value);
                    // auto-resize
                    try {
                      ta.style.height = "auto";
                      ta.style.height = `${ta.scrollHeight}px`;
                      setTextareaHeight(`${ta.scrollHeight}px`);
                    } catch (_err) {
                      // ignore
                    }
                  }}
                  onKeyDown={(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
                    // Submit on Enter (without Shift). Respect IME composition.
                    if (
                      e.key === "Enter" &&
                      !e.shiftKey &&
                      !e.nativeEvent.isComposing
                    ) {
                      e.preventDefault();
                      const current = (e.currentTarget as HTMLTextAreaElement)
                        .value;
                      // Call submit with messageArg taken from the textarea value because
                      // onKeyDown can fire before React state updates from onChange.
                      try {
                        void handleAgentSubmit(null, {}, current);
                      } catch (err) {
                        console.warn("submit via Enter failed", err);
                      }
                      setTextareaHeight("auto");
                    }
                  }}
                  rows={2}
                  style={{ height: textareaHeight }}
                />
              </div>
              <div className="flex items-center gap-2">
                <button
                  type="submit"
                  className="inline-flex items-center justify-center bg-primary text-white rounded-full p-2"
                  disabled={pendingToolCallConfirmation || !agentInput.trim()}
                >
                  <PaperPlaneTiltIcon size={16} />
                </button>
              </div>
            </div>
          </form>
        </main>

        {/* Right: Todo table */}
        <aside className="col-span-3 overflow-auto">
          <div className="sticky top-4 p-2">
            <div className="px-4 py-2">
              <h3 className="font-medium mb-2">
                Todo List (parsed from AI){" "}
                <span className="text-xs text-muted-foreground">
                  ({todos.length} items)
                </span>
              </h3>
              {showDebug && (
                <pre className="text-xs text-muted-foreground max-h-32 overflow-auto bg-white/5 p-2 rounded mb-2">
                  {JSON.stringify(todos, null, 2)}
                </pre>
              )}
              <TodoTable
                todos={todos}
                onToggleDone={(id) => {
                  setTodos((prev) => {
                    const now = new Date().toISOString();
                    const newState = prev.map((t) =>
                      t.id === id ? { ...t, done: !t.done, createdAt: now } : t
                    );
                    try {
                      localToggleTimes.current.set(id, Date.now());
                    } catch (_e) {}
                    (async () => {
                      try {
                        const md = todosToMarkdownTable(newState);
                        await sendMessage({
                          role: "user",
                          parts: [
                            {
                              type: "text",
                              text: `Updated todos (toggled ${id}):\n\n${md}`
                            }
                          ]
                        });
                      } catch (_e) {}
                    })();
                    return newState;
                  });
                }}
                onAdd={(todo) =>
                  setTodos((prev) => mergeIncomingTodos([todo])(prev))
                }
                onUpdate={(id, patch) =>
                  setTodos((prev) =>
                    prev.map((t) => (t.id === id ? { ...t, ...patch } : t))
                  )
                }
                onDelete={(id) => {
                  setTodos((prev) => {
                    const deleted = prev.find((t) => t.id === id);
                    const newState = prev.filter((t) => t.id !== id);
                    try {
                      localDeleteTimes.current.set(id, Date.now());
                      localDeletedIds.current.add(id);
                      persistDeletedToStorage();
                      setTimeout(
                        () => {
                          try {
                            localDeletedIds.current.delete(id);
                            localDeleteTimes.current.delete(id);
                            persistDeletedToStorage();
                          } catch (_e) {}
                        },
                        5 * 60 * 1000
                      );
                      if (deleted) {
                        const fp = `${titleKey(deleted.title)}|${((
                          d?: string
                        ) => {
                          if (!d) return "";
                          try {
                            const dt = new Date(d);
                            if (!Number.isNaN(dt.getTime()))
                              return dt.toISOString().slice(0, 10);
                          } catch (e) {}
                          return String(d).trim();
                        })(
                          deleted.due
                        )}|${deleted.priority ?? ""}|${typeof deleted.estimatedMinutes === "number" ? String(deleted.estimatedMinutes) : String(deleted.estimatedMinutes ?? "")}`;
                        localDeletedFingerprints.current.set(fp, Date.now());
                        persistDeletedToStorage();
                      }
                    } catch (e) {
                      console.warn("failed to set local delete time", e);
                    }
                    (async () => {
                      try {
                        const md = todosToMarkdownTable(newState);
                        await sendMessage({
                          role: "user",
                          parts: [
                            {
                              type: "text",
                              text: `Deleted todo (${id}):\n\n${md}`
                            }
                          ]
                        });
                      } catch (e) {}
                    })();
                    return newState;
                  });
                }}
              />
            </div>
          </div>
        </aside>
      </div>
    </div>
  );
}
