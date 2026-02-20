import type { Todo } from "../../shared";
import { Button } from "@/components/button/Button";

type Props = {
  todos: Todo[];
  onToggleDone: (id: string) => void;
  onAdd: (todo: Todo) => void;
  onUpdate: (id: string, patch: Partial<Todo>) => void;
  onDelete: (id: string) => void;
};

export function TodoTable({ todos, onToggleDone, onDelete }: Props) {
  return (
    <div className="bg-neutral-100 dark:bg-neutral-900 p-3 rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="space-y-2">
        <table className="w-full text-sm">
          <thead>
            <tr className="text-left text-xs text-muted-foreground">
              <th className="w-8">Done</th>
              <th>Task</th>
              <th>Due</th>
              <th>Priority</th>
              <th>Est (min)</th>
              <th className="w-16">Actions</th>
            </tr>
          </thead>
          <tbody>
            {todos.map((t) => (
              <tr
                key={t.id}
                className="border-t border-neutral-200 dark:border-neutral-800"
              >
                <td>
                  {/* Use a styled button as the visual checkbox to avoid native checkbox rendering issues across browsers */}
                  <button
                    type="button"
                    aria-pressed={Boolean(t.done)}
                    aria-label={`${t.title} ${t.done ? "done" : "not done"}`}
                    onClick={() => {
                      console.debug("TodoTable: toggle click", {
                        id: t.id,
                        todoDone: t.done
                      });
                      onToggleDone(t.id);
                    }}
                    className={
                      `w-5 h-5 inline-flex items-center justify-center rounded border transition-colors ` +
                      (t.done
                        ? "bg-blue-600 border-blue-600 text-white"
                        : "bg-white border-neutral-300 dark:bg-neutral-900 dark:border-neutral-700")
                    }
                  >
                    {t.done && (
                      <svg
                        width="12"
                        height="12"
                        viewBox="0 0 24 24"
                        fill="none"
                        xmlns="http://www.w3.org/2000/svg"
                        aria-hidden
                      >
                        <title>title</title>
                        <path
                          d="M20 6L9 17l-5-5"
                          stroke="currentColor"
                          strokeWidth="2"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        />
                      </svg>
                    )}
                  </button>
                </td>
                <td>{t.title}</td>
                <td>{t.due ?? "-"}</td>
                <td>{t.priority ?? "-"}</td>
                <td>{t.estimatedMinutes ?? "-"}</td>
                <td>
                  <div className="flex gap-2">
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onDelete(t.id)}
                    >
                      Del
                    </Button>
                    {/* Removed the duplicate Toggle button; checkbox is the canonical control */}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export default TodoTable;
