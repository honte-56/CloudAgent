import { memo, useRef } from 'react';

import ProjectEffects from '@/modules/project-workspace/controllers/ProjectEffects';
import type { ProjectWorkspaceShellProps } from '@/shared/types';
import { cn } from '@/shared/utils';
import ProjectCommandPalette from '@/modules/project-workspace/ProjectCommandPalette';
import ProjectMainRegion from '@/modules/project-workspace/ProjectMainRegion';
import ProjectQuickSettingsRegion from '@/modules/project-workspace/ProjectQuickSettingsRegion';
import ProjectSidebarRegion from '@/modules/project-workspace/ProjectSidebarRegion';

/** Rendered by ProjectWorkspaceRoute to lay out the workspace sidebar, main region and global overlays. */
function ProjectWorkspaceShell({
  isMobile,
  ws,
  sendMessage,
  navigate,
}: ProjectWorkspaceShellProps) {
  // The mobile drawer writes its progress onto this element so the main layer
  // below can recede in step with it.
  const shellRef = useRef<HTMLDivElement>(null);

  return (
    <div
      ref={shellRef}
      className="fixed inset-0 flex bg-chrome"
      style={{ bottom: 'var(--keyboard-height, 0px)' }}
    >
      <ProjectEffects navigate={navigate} />
      <ProjectSidebarRegion isMobile={isMobile} motionRootRef={shellRef} />

      {/* On desktop the workspace is a rounded panel resting on the chrome
          canvas beside the sidebar; on mobile the same panel fills the screen. */}
      <div className={cn('workspace-main-layer flex min-w-0 flex-1 flex-col', !isMobile && 'py-2 pr-2')}>
        <div
          className={cn(
            'flex min-h-0 flex-1 flex-col overflow-hidden bg-background',
            !isMobile && 'squircle rounded-3xl shadow-raised',
          )}
        >
          <ProjectMainRegion
            isMobile={isMobile}
            ws={ws}
            sendMessage={sendMessage}
            navigate={navigate}
          />
        </div>
      </div>

      <ProjectCommandPalette />
      {/* Last flex child on purpose: when pinned it docks to the right of the main region. */}
      <ProjectQuickSettingsRegion />
    </div>
  );
}

export default memo(ProjectWorkspaceShell);
