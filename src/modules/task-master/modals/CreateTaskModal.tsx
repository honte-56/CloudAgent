import { Sparkles, X } from 'lucide-react';

type CreateTaskModalProps = {
  isOpen: boolean;
  onClose: () => void;
};

/** Rendered by TaskBoard to explain how tasks are created through chat and the TaskMaster CLI. */
export default function CreateTaskModal({ isOpen, onClose }: CreateTaskModalProps) {
  if (!isOpen) {
    return null;
  }

  return (
    <div className="animate-fade-in fixed inset-0 z-50 flex items-center justify-center bg-[hsl(var(--scrim))] p-4 backdrop-blur-[2px]">
      <div className="squircle animate-pop-in w-full max-w-md rounded-3xl border border-border/50 bg-card shadow-floating">
        <div className="flex items-center justify-between border-b border-border p-6">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <Sparkles className="h-4 w-4 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">Create AI-Generated Task</h3>
          </div>
          <button
            onClick={onClose}
            className="rounded-md p-2 text-gray-400 hover:bg-muted hover:text-muted-foreground"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="space-y-6 p-6">
          <div className="rounded-lg border border-primary/30 bg-primary/10 p-4">
            <div className="flex items-start gap-3">
              <div className="mt-0.5 flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg bg-primary/10">
                <Sparkles className="h-4 w-4 text-primary" />
              </div>
              <div>
                <h4 className="mb-2 font-semibold text-foreground">Pro tip: ask Claude Code directly</h4>
                <p className="mb-3 text-sm text-primary">
                  Ask for a task in chat with context and requirements. TaskMaster can generate implementation-ready tasks.
                </p>
                <div className="rounded border border-primary/30 bg-card p-3">
                  <p className="mb-1 text-xs font-medium text-muted-foreground">Example:</p>
                  <p className="font-mono text-sm text-foreground">
                    Please add a task for profile image uploads and include best-practice research.
                  </p>
                </div>
              </div>
            </div>
          </div>

          <div className="border-t border-border pt-4 text-center">
            <a
              href="https://github.com/eyaltoledano/claude-task-master/blob/main/docs/examples.md"
              target="_blank"
              rel="noopener noreferrer"
              className="inline-block text-sm font-medium text-primary underline hover:text-primary"
            >
              View TaskMaster documentation
            </a>
          </div>

          <button
            onClick={onClose}
            className="w-full rounded-lg border border-border bg-card px-4 py-2 text-sm font-medium text-foreground/80 hover:bg-gray-50 dark:hover:bg-gray-600"
          >
            Got it
          </button>
        </div>
      </div>
    </div>
  );
}
