import type { Todo } from "../shared";

// Parse JSON string into Todo[] if possible
export function parseTodosFromJSON(input: string): Todo[] | null {
  try {
    const obj = JSON.parse(input);
    if (Array.isArray(obj)) {
      return obj.map(normalizeTodo);
    }
    if (obj && Array.isArray(obj.todos)) {
      return obj.todos.map(normalizeTodo);
    }
  } catch (e) {
    return null;
  }
  return null;
}

// Parse a simple markdown table into Todo[]. Expects header row like: | title | due | priority | estimatedMinutes | done |
export function parseTodosFromMarkdownTable(md: string): Todo[] | null {
  const lines = md.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines.length < 2) return null;

  // Find first table header line
  const headerIdx = lines.findIndex((l) => l.startsWith("|") && l.includes("|"));
  if (headerIdx === -1) return null;

  const header = lines[headerIdx].split("|").map((c) => c.trim()).filter(Boolean);
  const separator = lines[headerIdx + 1] || "";
  if (!separator.includes("---")) return null;

  const rows = lines.slice(headerIdx + 2).filter((l) => l.startsWith("|"));
  const todos: Todo[] = [];

  for (const row of rows) {
    const cols = row.split("|").map((c) => c.trim()).filter(Boolean);
    const obj: Record<string, string> = {};
    for (let i = 0; i < header.length; i++) {
      obj[header[i].toLowerCase()] = cols[i] ?? "";
    }
    const t: Todo = {
      id: obj.id || `md_${Math.random().toString(36).slice(2, 8)}`,
      title: obj.title || obj.task || "",
      due: obj.due || undefined,
      priority: (obj.priority as Todo["priority"]) || undefined,
      estimatedMinutes: obj.estimatedminutes ? Number(obj.estimatedminutes) : undefined,
      done: (obj.done || "").toLowerCase().startsWith("y") || (obj.done || "").toLowerCase().startsWith("t") || (obj.done || "").includes("[x]")
    };
    todos.push(t);
  }

  return todos.length > 0 ? todos : null;
}

export function normalizeTodo(input: any): Todo {
  return {
    id: input.id ?? `j_${Math.random().toString(36).slice(2, 8)}`,
    title: String(input.title ?? input.task ?? ""),
    due: input.due ?? input.date ?? undefined,
    priority: input.priority ?? undefined,
    estimatedMinutes: typeof input.estimatedMinutes === "number" ? input.estimatedMinutes : (input.estimatedMinutes ? Number(input.estimatedMinutes) : undefined),
    done: !!input.done,
    createdAt: input.createdAt ?? new Date().toISOString()
  };
}

export function todosToMarkdownTable(todos: Todo[]): string {
  const headers = ["id", "title", "due", "priority", "estimatedMinutes", "done"];
  const rows = todos.map((t) => `| ${t.id} | ${escapeCell(t.title)} | ${t.due ?? ""} | ${t.priority ?? ""} | ${t.estimatedMinutes ?? ""} | ${t.done ? "[x]" : "[ ]"} |`);
  return [`| ${headers.join(" | ")} |`, `| ${headers.map(() => "---").join(" | ")} |`, ...rows].join("\n");
}

function escapeCell(s: string) {
  return String(s).replace(/\|/g, "\\|");
}
