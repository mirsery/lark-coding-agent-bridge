import { useEffect, useState } from "react";
import { ListTodo, Plus } from "lucide-react";
import { apiGet } from "@/lib/api";
import type { ProfileInfo } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { OnboardWizard } from "./OnboardWizard";
import { TASKS_VIEW } from "./TasksView";

/**
 * Navigation only — start/stop and every other per-profile action live in
 * ProfileDetail's own toolbar once a profile is selected, the same split
 * System Settings/Mail use between their sidebar and content pane.
 */
export function Sidebar({
  selected,
  onSelect,
  refreshToken,
}: {
  selected: string | null;
  onSelect: (profile: string) => void;
  refreshToken: number;
}) {
  const [profiles, setProfiles] = useState<ProfileInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [creating, setCreating] = useState(false);

  const load = () =>
    apiGet<{ profiles: ProfileInfo[] }>("/api/profiles")
      .then((d) => { setProfiles(d.profiles); setError(null); })
      .catch((e) => setError(String(e.message ?? e)));

  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
  }, [refreshToken]);

  const tasksActive = selected === TASKS_VIEW;

  return (
    <aside className="sidebar-glass flex h-full w-64 shrink-0 flex-col">
      <div className="px-2 pt-4">
        <button
          onClick={() => onSelect(TASKS_VIEW)}
          className={
            "ease-spring flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition-colors duration-150 " +
            (tasksActive ? "bg-primary/15 text-foreground" : "hover:bg-accent")
          }
        >
          <ListTodo className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="min-w-0 flex-1 truncate font-medium">任务</span>
        </button>
      </div>

      <div className="flex items-center justify-between px-4 pb-2 pt-5">
        <h1 className="text-[15px] font-semibold tracking-tight">Profiles</h1>
        <Button
          variant="ghost"
          size="icon"
          className="size-7"
          aria-label="新建 Profile"
          onClick={() => setCreating(true)}
        >
          <Plus className="size-4" />
        </Button>
      </div>

      {error && <p className="px-4 text-xs text-destructive">加载失败：{error}</p>}

      <nav className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-3">
        {profiles?.length === 0 && (
          <p className="px-2 py-6 text-center text-xs text-muted-foreground">
            暂无 profile，点右上角「+」开始。
          </p>
        )}
        {profiles?.map((p) => {
          const active = p.name === selected;
          return (
            <button
              key={p.name}
              onClick={() => onSelect(p.name)}
              className={
                "ease-spring group flex w-full items-center gap-2 rounded-xl px-2.5 py-2 text-left text-sm transition-colors duration-150 " +
                (active ? "bg-primary/15 text-foreground" : "hover:bg-accent")
              }
            >
              <span
                className={
                  "size-2 shrink-0 rounded-full " +
                  (p.running ? "bg-success" : "bg-muted-foreground/40")
                }
                aria-hidden
              />
              <span className="min-w-0 flex-1 truncate font-medium">{p.name}</span>
              <Badge variant="secondary" className="shrink-0 text-[10px]">
                {p.agentKind}
              </Badge>
            </button>
          );
        })}
      </nav>

      <Dialog open={creating} onOpenChange={setCreating}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>新建 Profile</DialogTitle>
          </DialogHeader>
          <OnboardWizard
            onCreated={(name) => {
              setCreating(false);
              load();
              onSelect(name);
            }}
          />
        </DialogContent>
      </Dialog>
    </aside>
  );
}
