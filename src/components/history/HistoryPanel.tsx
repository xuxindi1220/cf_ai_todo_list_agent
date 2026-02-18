import { useEffect, useState } from "react";
import type { Todo } from "@/shared";

type StoredSession = {
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
  refreshSignal,
}: {
  todos: Todo[];
  messages: any[];
  onLoad: (session: StoredSession) => void;
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
        setList((data && Array.isArray(data.histories)) ? data.histories as StoredSession[] : []);
      }
    } catch (e) {
      console.warn("failed to fetch histories", e);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof refreshSignal !== 'undefined') fetchList();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshSignal]);

  const handleSave = async () => {
    setSaving(true);
    try {
      const payload = { todos, messages, title: `Saved ${new Date().toLocaleString()}` };
      const res = await fetch("/api/histories", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(payload) });
      if (res.ok) {
        await fetchList();
      }
    } catch (e) {
      console.warn("failed to save history", e);
    } finally {
      setSaving(false);
    }
  };

  const handleLoad = async (id: string) => {
    try {
      const res = await fetch(`/api/histories/${id}`);
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as any;
        if (data && data.session) onLoad(data.session as StoredSession);
      }
    } catch (e) {
      console.warn("failed to load session", e);
    }
  };

  const handleDelete = async (id: string) => {
    try {
      const res = await fetch(`/api/histories/${id}`, { method: "DELETE" });
      if (res.ok) await fetchList();
    } catch (e) {
      console.warn("failed to delete session", e);
    }
  };

  return (
    <div className="p-2 bg-neutral-50 dark:bg-neutral-900 rounded-md border border-neutral-200 dark:border-neutral-800">
      <div className="flex items-center justify-between mb-2">
        <h4 className="text-sm font-medium">Saved Sessions</h4>
        <div className="flex items-center gap-2">
          <button className="px-2 py-1 bg-primary text-white rounded" onClick={handleSave} disabled={saving}>{saving ? "Saving..." : "Save Current"}</button>
          <button className="px-2 py-1 border rounded" onClick={fetchList} disabled={loading}>{loading ? "Refreshing..." : "Refresh"}</button>
        </div>
      </div>
      <div className="max-h-48 overflow-auto">
        {list.length === 0 && <div className="text-xs text-muted-foreground">No sessions saved yet.</div>}
        <ul className="space-y-2">
          {list.map((s) => (
            <li key={s.id} className="p-2 border rounded flex items-start justify-between">
              <div>
                <div className="text-sm font-medium">{s.title ?? s.id}</div>
                <div className="text-xs text-muted-foreground">{new Date(s.createdAt).toLocaleString()}</div>
                <div className="text-xs">{s.todos?.length ?? 0} todos · {s.messages?.length ?? 0} messages</div>
              </div>
              <div className="flex flex-col gap-1">
                <button className="px-2 py-1 bg-green-600 text-white rounded text-xs" onClick={() => handleLoad(s.id)}>Load</button>
                <button className="px-2 py-1 bg-red-600 text-white rounded text-xs" onClick={() => handleDelete(s.id)}>Delete</button>
              </div>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}

export default HistoryPanel;

