import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Eye, EyeOff, FolderOpen, FolderPlus, Loader2, Plus, X } from 'lucide-react';

import { Button, Input } from '@/shared/ui';
import { browseFilesystemFolders, createFolderInFilesystem } from '@/modules/project-creation-wizard/utils/workspaceApi';
import { getParentPath, joinFolderPath } from '@/modules/project-creation-wizard/utils/pathUtils';
import type { FolderSuggestion } from '@/shared/types';

type FolderBrowserModalProps = {
  isOpen: boolean;
  autoAdvanceOnSelect: boolean;
  onClose: () => void;
  onFolderSelected: (folderPath: string, advanceToConfirm: boolean) => void;
};

/** Opened by WorkspacePathField so the user can browse the filesystem and pick or create the workspace folder. */
export default function FolderBrowserModal({
  isOpen,
  autoAdvanceOnSelect,
  onClose,
  onFolderSelected,
}: FolderBrowserModalProps) {
  const { t } = useTranslation();
  const [currentPath, setCurrentPath] = useState('~');
  const [folders, setFolders] = useState<FolderSuggestion[]>([]);
  const [loadingFolders, setLoadingFolders] = useState(false);
  const [showHiddenFolders, setShowHiddenFolders] = useState(false);
  const [showNewFolderInput, setShowNewFolderInput] = useState(false);
  const [newFolderName, setNewFolderName] = useState('');
  const [creatingFolder, setCreatingFolder] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Keep the loader stable across locale changes: t lands in a ref so an
  // open browser does not reload and snap back to the home folder when the
  // user switches language.
  const loadFoldersRef = useRef<(pathToLoad: string) => Promise<void>>();

  const loadFolders = useCallback(async (pathToLoad: string) => {
    setLoadingFolders(true);
    setError(null);

    try {
      const result = await browseFilesystemFolders(pathToLoad);
      setCurrentPath(result.path);
      setFolders(result.suggestions);
    } catch (loadError) {
      setError(loadError instanceof Error ? loadError.message : t('folderBrowser.loadFailed'));
    } finally {
      setLoadingFolders(false);
    }
  }, [t]);

  useEffect(() => {
    loadFoldersRef.current = loadFolders;
  }, [loadFolders]);

  useEffect(() => {
    if (!isOpen) {
      return;
    }
    void loadFoldersRef.current?.('~');
  }, [isOpen]);

  const visibleFolders = useMemo(
    () =>
      folders
        .filter((folder) => showHiddenFolders || !folder.name.startsWith('.'))
        .sort((firstFolder, secondFolder) =>
          firstFolder.name.toLowerCase().localeCompare(secondFolder.name.toLowerCase()),
        ),
    [folders, showHiddenFolders],
  );

  const resetNewFolderState = () => {
    setShowNewFolderInput(false);
    setNewFolderName('');
  };

  const handleClose = () => {
    setError(null);
    resetNewFolderState();
    onClose();
  };

  const handleCreateFolder = useCallback(async () => {
    if (!newFolderName.trim()) {
      return;
    }

    setCreatingFolder(true);
    setError(null);

    try {
      const folderPath = joinFolderPath(currentPath, newFolderName);
      const createdPath = await createFolderInFilesystem(folderPath);
      resetNewFolderState();
      await loadFolders(createdPath);
    } catch (createError) {
      setError(createError instanceof Error ? createError.message : t('folderBrowser.createFailed'));
    } finally {
      setCreatingFolder(false);
    }
  }, [currentPath, loadFolders, newFolderName, t]);

  const parentPath = getParentPath(currentPath);

  if (!isOpen) {
    return null;
  }

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/50 p-4 backdrop-blur-sm">
      <div className="flex max-h-[80vh] w-full max-w-2xl flex-col rounded-lg border border-border bg-card shadow-xl">
        <div className="flex items-center justify-between border-b border-border p-4">
          <div className="flex items-center gap-3">
            <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-primary/10">
              <FolderOpen className="h-4 w-4 text-primary" />
            </div>
            <h3 className="text-lg font-semibold text-foreground">{t('folderBrowser.title')}</h3>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => setShowHiddenFolders((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showHiddenFolders
                  ? 'bg-primary/10 text-primary'
                  : 'text-gray-400 hover:bg-muted hover:text-muted-foreground'
              }`}
              title={showHiddenFolders ? t('folderBrowser.hideHidden') : t('folderBrowser.showHidden')}
            >
              {showHiddenFolders ? <Eye className="h-5 w-5" /> : <EyeOff className="h-5 w-5" />}
            </button>
            <button
              onClick={() => setShowNewFolderInput((previous) => !previous)}
              className={`rounded-md p-2 transition-colors ${
                showNewFolderInput
                  ? 'bg-primary/10 text-primary'
                  : 'text-gray-400 hover:bg-muted hover:text-muted-foreground'
              }`}
              title={t('folderBrowser.createNew')}
            >
              <Plus className="h-5 w-5" />
            </button>
            <button
              onClick={handleClose}
              className="rounded-md p-2 text-gray-400 hover:bg-muted hover:text-muted-foreground"
            >
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>

        {showNewFolderInput && (
          <div className="border-b border-border bg-primary/10 px-4 py-3">
            <div className="flex items-center gap-2">
              <Input
                type="text"
                value={newFolderName}
                onChange={(event) => setNewFolderName(event.target.value)}
                placeholder={t('folderBrowser.newFolderPlaceholder')}
                className="flex-1"
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    handleCreateFolder();
                  }
                  if (event.key === 'Escape') {
                    resetNewFolderState();
                  }
                }}
                autoFocus
              />
              <Button
                size="sm"
                onClick={handleCreateFolder}
                disabled={!newFolderName.trim() || creatingFolder}
              >
                {creatingFolder ? <Loader2 className="h-4 w-4 animate-spin" /> : t('folderBrowser.create')}
              </Button>
              <Button size="sm" variant="ghost" onClick={resetNewFolderState}>
                {t('common:cancel')}
              </Button>
            </div>
          </div>
        )}

        {error && (
          <div className="px-4 pt-3">
            <p className="text-sm text-red-600 dark:text-red-400">{error}</p>
          </div>
        )}

        <div className="flex-1 overflow-y-auto p-4">
          {loadingFolders ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-gray-400" />
            </div>
          ) : (
            <div className="space-y-1">
              {parentPath && (
                <button
                  onClick={() => loadFolders(parentPath)}
                  className="flex w-full items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted"
                >
                  <FolderOpen className="h-5 w-5 text-gray-400" />
                  <span className="font-medium text-foreground/80">..</span>
                </button>
              )}

              {visibleFolders.length === 0 ? (
                <div className="py-8 text-center text-muted-foreground">
                  {t('folderBrowser.noSubfolders')}
                </div>
              ) : (
                visibleFolders.map((folder) => (
                  <div key={folder.path} className="flex items-center gap-2">
                    <button
                      onClick={() => loadFolders(folder.path)}
                      className="flex flex-1 items-center gap-3 rounded-lg px-4 py-3 text-left hover:bg-muted"
                    >
                      <FolderPlus className="h-5 w-5 text-primary" />
                      <span className="font-medium text-foreground">
                        {folder.name}
                      </span>
                    </button>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={() => onFolderSelected(folder.path, autoAdvanceOnSelect)}
                      className="px-3 text-xs"
                    >
                      {t('folderBrowser.select')}
                    </Button>
                  </div>
                ))
              )}
            </div>
          )}
        </div>

        <div className="border-t border-border">
          <div className="flex items-center gap-2 bg-muted px-4 py-3">
            <span className="text-sm text-muted-foreground">{t('folderBrowser.pathLabel')}</span>
            <code className="flex-1 truncate font-mono text-sm text-foreground">
              {currentPath}
            </code>
          </div>
          <div className="flex items-center justify-end gap-2 p-4">
            <Button variant="outline" onClick={handleClose}>
              {t('common:cancel')}
            </Button>
            <Button
              variant="outline"
              onClick={() => onFolderSelected(currentPath, autoAdvanceOnSelect)}
            >
              {t('folderBrowser.useThisFolder')}
            </Button>
          </div>
        </div>
      </div>
    </div>
  );
}
