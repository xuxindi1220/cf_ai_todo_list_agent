import type { Todo } from "../shared";

// Helper: trim and remove markdown code fences and surrounding text, return candidate JSON string(s)
function extractJsonCandidates(input: string): string[] {
  const s = input.trim();

  // If the entire input is enclosed in triple-backtick code fence, extract inner
  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced && fenced[1]) {
    return [fenced[1].trim()];
  }

  // Try to find a JSON array or object anywhere in the text
  const candidates: string[] = [];

  // Find first JSON array [...] occurrence
  const arrayMatch = s.match(/\[([\s\S]*?)\]/);
  if (arrayMatch) {
    // Rebuild with outer brackets to ensure valid JSON
    candidates.push("[" + arrayMatch[1] + "]");
  }

  // Find first JSON object {...} occurrence
  const objMatch = s.match(/\{([\s\S]*?)\}/);
  if (objMatch) {
    candidates.push("{" + objMatch[1] + "}");
  }

  // As a fallback, return the whole trimmed string
  candidates.push(s);

  return candidates;
}

// Parse JSON string into Todo[] if possible
export function parseTodosFromJSON(input: string): Todo[] | null {
  if (!input || typeof input !== "string") return null;

  const candidates = extractJsonCandidates(input);

  for (const candidate of candidates) {
    try {
      const obj = JSON.parse(candidate);
      if (Array.isArray(obj)) {
        return obj.map(normalizeTodo);
      }
      if (obj && Array.isArray(obj.todos)) {
        return obj.todos.map(normalizeTodo);
      }
      // Support object with tasks key
      if (obj && Array.isArray(obj.tasks)) {
        return obj.tasks.map(normalizeTodo);
      }
    } catch (e) {
      // try next candidate
      continue;
    }
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
    const doneRaw = obj.done ?? "";
    let doneVal: boolean | undefined;
    if (doneRaw === "") {
      doneVal = undefined;
    } else {
      const lower = doneRaw.toLowerCase();
      doneVal = lower.startsWith("y") || lower.startsWith("t") || lower.includes("[x]");
    }
    const t: Todo = {
      id: obj.id || `md_${Math.random().toString(36).slice(2, 8)}`,
      title: obj.title || obj.task || "",
      due: obj.due || undefined,
      priority: (obj.priority as Todo["priority"]) || undefined,
      estimatedMinutes: obj.estimatedminutes ? Number(obj.estimatedminutes) : undefined,
      done: doneVal
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
    done: typeof input.done === 'boolean' ? input.done : undefined,
    // IMPORTANT: do not invent a createdAt timestamp here. If the assistant/source
    // didn't provide createdAt, leave it undefined so caller can decide how to treat it.
    createdAt: input.createdAt ?? undefined
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
