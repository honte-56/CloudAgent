import { useCallback, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { useTranslation } from "react-i18next";

import { api } from "@/shared/api";
import type { ReleaseInfo,InstallMode } from "@/shared/types";
import { copyTextToClipboard } from "@/shared/utils";

type VersionUpgradeModalProps = {
    isOpen: boolean;
    onClose: () => void;
    releaseInfo: ReleaseInfo | null;
    currentVersion: string;
    latestVersion: string | null;
    installMode: InstallMode;
};

/** This module's only public export: rendered by the sidebar module's modal layer to show release notes and run the app upgrade. */
export function VersionUpgradeModal({
    isOpen,
    onClose,
    releaseInfo,
    currentVersion,
    latestVersion,
    installMode
}: VersionUpgradeModalProps) {
    const { t } = useTranslation('common');
    const upgradeCommand = installMode === 'npm'
        ? t('versionUpdate.npmUpgradeCommand')
        : 'git checkout main && git pull && npm install';
    // Prevent duplicate update requests and show their progress.
    const [isUpdating, setIsUpdating] = useState(false);
    // Retain update command output for the progress panel.
    const [updateOutput, setUpdateOutput] = useState('');
    // Keep a failed update visible until the next attempt.
    const [updateError, setUpdateError] = useState('');

    const handleUpdateNow = useCallback(async () => {
        setIsUpdating(true);
        setUpdateOutput(t('versionUpdate.startingUpdate') + '\n');
        setUpdateError('');

        try {
            // Call the backend API to run the update command
            const response = await api.system.update();

            // The server (or a proxy in front of it) can answer with an HTML
            // page instead of JSON — e.g. while a server deployment
            // restarts mid-update — so never parse the body blindly.
            const rawBody = await response.text();
            let data: { output?: string; error?: string } | null = null;
            try {
                data = JSON.parse(rawBody);
            } catch {
                data = null;
            }

            if (!data) {
                const message = t('versionUpdate.unexpectedResponse', { status: response.status });
                setUpdateError(message);
                setUpdateOutput(prev => prev + '\n❌ ' + t('versionUpdate.updateFailed') + ': ' + message + '\n');
                return;
            }

            if (response.ok) {
                setUpdateOutput(prev => prev + (data.output || '') + '\n');
                setUpdateOutput(prev => prev + '\n✅ ' + t('versionUpdate.updateCompleted') + '\n');
                setUpdateOutput(prev => prev + t('versionUpdate.restartServer') + '\n');
            } else {
                setUpdateError(data.error || t('versionUpdate.updateFailed'));
                setUpdateOutput(prev => prev + '\n❌ ' + t('versionUpdate.updateFailed') + ': ' + (data.error || t('versionUpdate.unknownError')) + '\n');
            }
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            setUpdateError(message);
            setUpdateOutput(prev => prev + '\n❌ ' + t('versionUpdate.updateFailed') + ': ' + message + '\n');
        } finally {
            setIsUpdating(false);
        }
    }, [t]);

    if (!isOpen) return null;

    return (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
            {/* Backdrop */}
            <button
                className="animate-fade-in fixed inset-0 bg-[hsl(var(--scrim))] backdrop-blur-[2px]"
                onClick={onClose}
                aria-label={t('versionUpdate.ariaLabels.closeModal')}
            />

            {/* Modal */}
            <div className="squircle animate-pop-in relative mx-4 max-h-[90vh] w-full max-w-2xl space-y-4 overflow-y-auto rounded-3xl border border-border/50 bg-card p-6 shadow-floating">
                {/* Header */}
                <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                            <svg className="h-5 w-5 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 16a4 4 0 01-.88-7.903A5 5 0 1115.9 6L16 6a5 5 0 011 9.9M9 19l3 3m0 0l3-3m-3 3V10" />
                            </svg>
                        </div>
                        <div>
                            <h2 className="text-lg font-semibold text-foreground">{t('versionUpdate.title')}</h2>
                            <p className="text-sm text-muted-foreground">
                                {releaseInfo?.title || t('versionUpdate.newVersionReady')}
                            </p>
                        </div>
                    </div>
                    <button
                        onClick={onClose}
                        className="rounded-md p-2 text-gray-400 hover:bg-muted hover:text-muted-foreground"
                    >
                        <svg className="h-5 w-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                        </svg>
                    </button>
                </div>

                {/* Version Info */}
                <div className="space-y-3">
                    <div className="flex items-center justify-between rounded-lg bg-muted p-3">
                        <span className="text-sm font-medium text-foreground/80">{t('versionUpdate.currentVersion')}</span>
                        <span className="font-mono text-sm text-foreground">{currentVersion}</span>
                    </div>
                    <div className="flex items-center justify-between rounded-lg border border-primary/30 bg-primary/10 p-3">
                        <span className="text-sm font-medium text-primary">{t('versionUpdate.latestVersion')}</span>
                        <span className="font-mono text-sm text-foreground">{latestVersion}</span>
                    </div>
                </div>

                {/* Changelog */}
                {releaseInfo?.body && (
                    <div className="space-y-3">
                        <div className="flex items-center justify-between">
                            <h3 className="text-sm font-medium text-foreground">{t('versionUpdate.whatsNew')}</h3>
                            {releaseInfo?.htmlUrl && (
                                <a
                                    href={releaseInfo.htmlUrl}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    className="flex items-center gap-1 text-xs text-primary hover:text-primary hover:underline"
                                >
                                    {t('versionUpdate.viewFullRelease')}
                                    <svg className="h-3 w-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                                    </svg>
                                </a>
                            )}
                        </div>
                        <div className="max-h-64 overflow-y-auto rounded-lg border border-border bg-muted p-4">
                            <div className="prose prose-sm max-w-none text-sm text-foreground/80 dark:prose-invert">
                                <ReactMarkdown remarkPlugins={[remarkGfm]} components={changelogComponents}>
                                    {cleanChangelog(releaseInfo.body)}
                                </ReactMarkdown>
                            </div>
                        </div>
                    </div>
                )}

                {/* Update Output */}
                {(updateOutput || updateError) && (
                    <div className="space-y-2">
                        <h3 className="text-sm font-medium text-foreground">{t('versionUpdate.updateProgress')}</h3>
                        <div className="max-h-48 overflow-y-auto rounded-lg border border-gray-700 bg-gray-900 p-4 dark:bg-gray-950">
                            <pre className="whitespace-pre-wrap font-mono text-xs text-green-400">{updateOutput}</pre>
                        </div>

                        {updateError && (
                            <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-xs text-red-700 dark:border-red-900/40 dark:bg-red-900/20 dark:text-red-200">
                                {updateError}
                            </div>
                        )}
                    </div>
                )}

                {/* Upgrade Instructions */}
                {!isUpdating && !updateOutput && (
                    <div className="space-y-3">
                        <h3 className="text-sm font-medium text-foreground">{t('versionUpdate.manualUpgrade')}</h3>
                        <div className="rounded-lg border bg-muted p-3">
                            <code className="font-mono text-sm text-foreground">
                                {upgradeCommand}
                            </code>
                        </div>
                        <p className="text-xs text-muted-foreground">
                            {t('versionUpdate.manualUpgradeHint')}
                        </p>
                    </div>
                )}

                {/* Actions */}
                <div className="flex gap-2 pt-2">
                    <button
                        onClick={onClose}
                        className="flex-1 rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent"
                    >
                        {updateOutput ? t('versionUpdate.buttons.close') : t('versionUpdate.buttons.later')}
                    </button>
                    {!updateOutput && (
                        <>
                            <button
                                onClick={() => copyTextToClipboard(upgradeCommand)}
                                className="flex-1 rounded-md bg-muted px-4 py-2 text-sm font-medium text-foreground/80 transition-colors hover:bg-accent"
                            >
                                {t('versionUpdate.buttons.copyCommand')}
                            </button>
                            <button
                                onClick={handleUpdateNow}
                                disabled={isUpdating}
                                className="flex flex-1 items-center justify-center gap-2 rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground transition-colors hover:bg-primary/90 disabled:cursor-not-allowed disabled:bg-primary"
                            >
                                {isUpdating ? (
                                    <>
                                        <div className="h-4 w-4 animate-spin rounded-full border-2 border-white border-t-transparent" />
                                        {t('versionUpdate.buttons.updating')}
                                    </>
                                ) : (
                                    t('versionUpdate.buttons.updateNow')
                                )}
                            </button>
                        </>
                    )}
                </div>
            </div>
        </div>
    );
};

const changelogComponents = {
    a: ({ href, children }: { href?: string; children?: ReactNode }) => (
        <a href={href} target="_blank" rel="noopener noreferrer" className="text-primary hover:underline">
            {children}
        </a>
    ),
};

// Clean up changelog by removing GitHub-specific metadata
const cleanChangelog = (body: string) => {
    if (!body) return '';

    return body
        // Remove full commit hashes (40 character hex strings)
        .replace(/\b[0-9a-f]{40}\b/gi, '')
        // Remove short commit hashes (7-10 character hex strings at start of line or after dash/space)
        .replace(/(?:^|\s|-)([0-9a-f]{7,10})\b/gi, '')
        // Remove "Full Changelog" links
        .replace(/\*\*Full Changelog\*\*:.*$/gim, '')
        // Remove compare links (e.g., https://github.com/.../compare/v1.0.0...v1.0.1)
        .replace(/https?:\/\/github\.com\/[^\/]+\/[^\/]+\/compare\/[^\s)]+/gi, '')
        // Clean up multiple consecutive empty lines
        .replace(/\n\s*\n\s*\n/g, '\n\n')
        // Trim whitespace
        .trim();
};
