import { useEffect, useState } from "react";
import type { Todo } from "@/shared";

export type StoredSession = {
  id: string;
  createdAt: string;
  todos: Todo[];
  messages: any[];
  title?: string;
};

export function HistoryPanel({
  todos,
  messages,
  onLoad,
  onDelete,
  refreshSignal
}: {
  todos: Todo[];
  messages: any[];
  onLoad: (session: StoredSession) => void;
  onDelete?: (id: string) => void;
  refreshSignal?: number;
}) {
  const [list, setList] = useState<StoredSession[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const fetchList = async () => {
    setLoading(true);
    try {
      const res = await fetch("/api/histories");
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        const serverList: StoredSession[] = Array.isArray(data?.histories)
          ? data.histories
          : [];
        // merge any local fallback sessions stored in localStorage
        try {
          const rawLocal = localStorage.getItem("local:histories:v1");
          const localList: StoredSession[] = rawLocal
            ? JSON.parse(rawLocal)
            : [];
          setList([...localList, ...serverList]);
        } catch (e) {
          console.error(e);
          setList(serverList);
        }
      } else {
        // server returned a non-ok status; fall back to local-only sessions so optimistic entries are visible
        try {
          const rawLocal = localStorage.getItem("local:histories:v1");
          const localList: StoredSession[] = rawLocal
            ? JSON.parse(rawLocal)
            : [];
          setList(localList);
        } catch (e) {
          console.error(e);
          setList([]);
        }
      }
    } catch (e) {
      console.warn("failed to fetch histories", e);
      // fallback to local-only sessions if server fails
      try {
        const rawLocal = localStorage.getItem("local:histories:v1");
        const localList: StoredSession[] = rawLocal ? JSON.parse(rawLocal) : [];
        setList(localList);
      } catch (e2) {
        console.error(e2);
        setList([]);
      }
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchList]);

  // Listen for global updates so external code (e.g. app) can notify us after writing optimistic entries
  useEffect(() => {
    const onUpdated = () => fetchList();
    window.addEventListener("histories:updated", onUpdated);
    return () => window.removeEventListener("histories:updated", onUpdated);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchList]);

  // Listen for save requests from the app (e.g., top '+' button). Re-register when todos/messages change
  useEffect(() => {
    const onSaveRequest = (ev: Event) => {
      try {
        const detail = (ev as CustomEvent)?.detail as any;
        const optimisticId = detail?.optimisticId as string | undefined;
        void handleSave(optimisticId);
      } catch (e) {
        console.warn("handleSave failed from save-request", e);
      }
    };
    window.addEventListener(
      "histories:save-request",
      onSaveRequest as EventListener
    );
    return () =>
      window.removeEventListener(
        "histories:save-request",
        onSaveRequest as EventListener
      );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [todos, messages]);

  useEffect(() => {
    if (typeof refreshSignal !== "undefined") fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal, fetchList]);

  const handleSave = async (optimisticId?: string) => {
    setSaving(true);
    try {
      const payload = {
        todos,
        messages,
        title: `Saved ${new Date().toLocaleString()}`
      };
      const res = await fetch("/api/histories", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload)
      });
      if (res.ok) {
        try {
          const body = (await res.json().catch(() => ({}))) as any;
          const returnedId = body?.id ?? body?.session?.id ?? null;
          if (returnedId && optimisticId) {
            // replace optimistic entry id with server id in local fallback storage
            try {
              const rawLocal = localStorage.getItem("local:histories:v1");
              const arr: StoredSession[] = rawLocal
                ? (JSON.parse(rawLocal) as StoredSession[])
                : [];
              const idx = arr.findIndex((s) => s.id === optimisticId);
              const serverSession: StoredSession = {
                id: returnedId,
                createdAt: new Date().toISOString(),
                todos,
                messages,
                title: payload.title
              };
              if (idx !== -1) {
                arr.splice(idx, 1, serverSession);
              } else {
                arr.unshift(serverSession);
              }
              localStorage.setItem("local:histories:v1", JSON.stringify(arr));
            } catch (e) {
              console.debug(
                "failed to replace optimistic history with server id",
                e
              );
            }
          }
        } catch (e) {
          console.error(e);
        }
        await fetchList();
        return;
      }
      // non-ok: fallback to local storage
      console.warn("save returned non-ok", await res.text().catch(() => ""));
      try {
        // If we already created an optimistic entry, don't duplicate it.
        if (optimisticId) {
          await fetchList();
          return;
        }
        const fallbackId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const session = {
          id: fallbackId,
          createdAt: new Date().toISOString(),
          todos,
          messages,
          title: payload.title
        } as StoredSession;
        const raw = localStorage.getItem("local:histories:v1");
        const arr = raw ? (JSON.parse(raw) as StoredSession[]) : [];
        arr.unshift(session);
        localStorage.setItem("local:histories:v1", JSON.stringify(arr));
        await fetchList();
        return;
      } catch (e) {
        console.warn("local fallback save failed", e);
      }
    } catch (e) {
      console.warn("failed to save history", e);
      // network error: persist locally
      try {
        // If optimistic entry exists, keep it and avoid duplicating
        if (optimisticId) {
          await fetchList();
          return;
        }
        const fallbackId = `local-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
        const session = {
          id: fallbackId,
          createdAt: new Date().toISOString(),
          todos,
          messages,
          title: `Saved ${new Date().toLocaleString()}`
        } as StoredSession;
        const raw = localStorage.getItem("local:histories:v1");
        const arr = raw ? (JSON.parse(raw) as StoredSession[]) : [];
        arr.unshift(session);
        localStorage.setItem("local:histories:v1", JSON.stringify(arr));
        await fetchList();
        return;
      } catch (e2) {
        console.warn("local fallback save failed", e2);
      }
    } finally {
      setSaving(false);
    }
  };

  const handleLoad = async (id: string) => {
    try {
      const res = await fetch(`/api/histories/${id}`);
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        // Server might return { session } or the session object directly. Normalize both.
        const sessionCandidate = data?.session ?? data;
        if (
          sessionCandidate &&
          (sessionCandidate.id ||
            sessionCandidate.todos ||
            sessionCandidate.messages)
        ) {
          // ensure the session follows StoredSession shape
          const normalized: StoredSession = {
            id: String(sessionCandidate.id ?? id),
            createdAt: sessionCandidate.createdAt ?? new Date().toISOString(),
            todos: Array.isArray(sessionCandidate.todos)
              ? sessionCandidate.todos
              : [],
            messages: Array.isArray(sessionCandidate.messages)
              ? sessionCandidate.messages
              : [],
            title: sessionCandidate.title ?? undefined
          };
          onLoad(normalized);
          return;
        }
      } else {
        // non-ok: fall through to local fallback
        console.warn("server returned non-ok loading session", res.status);
      }
    } catch (e) {
      console.warn(
        "failed to load session from server, trying local fallback",
        e
      );
    }

    // Local fallback: try to load from localStorage stored sessions
    try {
      const rawLocal = localStorage.getItem("local:histories:v1");
      if (rawLocal) {
        const arr: StoredSession[] = JSON.parse(rawLocal) as StoredSession[];
        const found = arr.find((s) => s.id === id);
        if (found) {
          onLoad(found);
          return;
        }
      }
    } catch (e) {
      console.warn("failed to load session from local fallback", e);
    }
    // If we get here, nothing found
    console.warn(`session ${id} not found in server or local fallback`);
  };

  const handleDelete = async (id: string) => {
    try {
      // try server-side delete; ignore errors
      try {
        await fetch(`/api/histories/${id}`, { method: "DELETE" });
      } catch (e) {
        console.warn("server delete failed (will try local removal)", e);
      }

      // remove from local fallback storage if present
      try {
        const raw = localStorage.getItem("local:histories:v1");
        if (raw) {
          const arr: StoredSession[] = JSON.parse(raw) as StoredSession[];
          const filtered = arr.filter((s) => s.id !== id);
          localStorage.setItem("local:histories:v1", JSON.stringify(filtered));
        }
      } catch (e) {
        console.warn("failed to remove local fallback entry", e);
      }

      await fetchList();
      // notify parent so it can clear displayed session if needed
      try {
        onDelete?.(id);
      } catch (e) {
        console.warn("onDelete callback failed", e);
      }
    } catch (e) {
      console.warn("failed to delete session", e);
    }
  };

  return (
    <div className="p-2 bg-neutral-50 dark:bg-neutral-900 rounded-md border border-neutral-200 dark:border-neutral-800 h-[calc(100vh-4rem)] flex flex-col">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium">Saved Sessions</h4>
        <div className="flex items-center gap-2">
          <button
            type="submit"
            className="px-2 py-1 bg-primary text-white rounded"
            onClick={() => void handleSave()}
            disabled={saving}
          >
            {saving ? "Saving..." : "Save Current"}
          </button>
          <button
            type="submit"
            className="px-2 py-1 border rounded"
            onClick={fetchList}
            disabled={loading}
          >
            {loading ? "Refreshing..." : "Refresh"}
          </button>
        </div>
      </div>
      <div className="flex-1 overflow-auto">
        {list.length === 0 && (
          <div className="text-xs text-muted-foreground">
            No sessions saved yet.
          </div>
        )}
        <ul className="space-y-2">
          {list.map((s) => (
            <li
              key={s.id}
              className="p-2 border rounded flex items-start justify-between"
            >
              <div>
                <div className="text-sm font-medium">{s.title ?? s.id}</div>
                <div className="text-xs text-muted-foreground">
                  {new Date(s.createdAt).toLocaleString()}
                </div>
                <div className="text-xs">
                  {s.todos?.length ?? 0} todos · {s.messages?.length ?? 0}{" "}
                  messages
                </div>
              </div>
              <div className="flex flex-col gap-1">
                <button
                  type="submit"
                  className="px-2 py-1 bg-green-600 text-white rounded text-xs"
                  onClick={() => handleLoad(s.id)}
                >
                  Display
                </button>
                <button
                  type="submit"
                  className="px-2 py-1 bg-red-600 text-white rounded text-xs"
                  onClick={() => handleDelete(s.id)}
                >
                  Delete
                </button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default HistoryPanel;
