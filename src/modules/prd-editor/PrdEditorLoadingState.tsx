/** Rendered by PRDEditor inside the prd-editor module while an existing PRD's contents are still loading. */
export default function PrdEditorLoadingState() {
  return (
    <div className="animate-fade-in fixed inset-0 z-[200] md:flex md:items-center md:justify-center md:bg-[hsl(var(--scrim))]">
      <div className="flex h-full w-full items-center justify-center bg-card p-8 md:h-auto md:w-auto md:rounded-lg">
        <div className="flex items-center gap-3">
          <div className="h-6 w-6 animate-spin rounded-full border-b-2 border-primary" />
          <span className="text-foreground">Loading PRD...</span>
        </div>
      </div>
    </div>
  );
}
