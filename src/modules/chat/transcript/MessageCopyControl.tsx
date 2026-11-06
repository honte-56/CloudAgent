import { useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { Download } from 'lucide-react';

import { copyTextToClipboard } from '@/shared/utils';

const COPY_SUCCESS_TIMEOUT_MS = 2000;

type CopyFormat = 'text' | 'markdown';

type CopyFormatOption = {
  format: CopyFormat;
  label: string;
};

// Converts markdown into readable plain text for "Copy as text".
const convertMarkdownToPlainText = (markdown: string): string => {
  let plainText = markdown.replace(/\r\n/g, '\n');
  const codeBlocks: string[] = [];
  plainText = plainText.replace(/```[\w-]*\n([\s\S]*?)```/g, (_match, code: string) => {
    const placeholder = `@@CODEBLOCK${codeBlocks.length}@@`;
    codeBlocks.push(code.replace(/\n$/, ''));
    return placeholder;
  });
  plainText = plainText.replace(/`([^`]+)`/g, '$1');
  plainText = plainText.replace(/!\[([^\]]*)\]\(([^)]+)\)/g, '$1');
  plainText = plainText.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
  plainText = plainText.replace(/^>\s?/gm, '');
  plainText = plainText.replace(/^#{1,6}\s+/gm, '');
  plainText = plainText.replace(/^[-*+]\s+/gm, '');
  plainText = plainText.replace(/^\d+\.\s+/gm, '');
  plainText = plainText.replace(/(\*\*|__)(.*?)\1/g, '$2');
  plainText = plainText.replace(/(\*|_)(.*?)\1/g, '$2');
  plainText = plainText.replace(/~~(.*?)~~/g, '$1');
  plainText = plainText.replace(/<\/?[^>]+(>|$)/g, '');
  plainText = plainText.replace(/\n{3,}/g, '\n\n');
  plainText = plainText.replace(/@@CODEBLOCK(\d+)@@/g, (_match, index: string) => codeBlocks[Number(index)] ?? '');
  return plainText.trim();
};

/**
 * Rendered by chat's MessageComponent to copy a turn or download an assistant
 * reply as Markdown/plain text from its format menu.
 */
const MessageCopyControl = ({
  content,
  messageType,
}: {
  content: string;
  messageType: 'user' | 'assistant';
}) => {
  const { t } = useTranslation('chat');
  const canSelectCopyFormat = messageType === 'assistant';
  const defaultFormat: CopyFormat = canSelectCopyFormat ? 'markdown' : 'text';
  const [selectedFormat, setSelectedFormat] = useState<CopyFormat>(defaultFormat);
  const [copied, setCopied] = useState(false);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [menuStyle, setMenuStyle] = useState<CSSProperties>({});
  const dropdownRef = useRef<HTMLDivElement | null>(null);
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const copyFeedbackTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // The dropdown is rendered in a portal so it escapes the chat message's
  // `contain: paint` box (which would otherwise clip it). Anchor it to the
  // trigger, flipping above when there isn't room below.
  const openDropdown = () => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (rect) {
      const ESTIMATED_MENU_HEIGHT = 160;
      const openUp = rect.bottom + ESTIMATED_MENU_HEIGHT + 8 > window.innerHeight;
      setMenuStyle({
        position: 'fixed',
        left: Math.max(8, Math.min(rect.right - 192, window.innerWidth - 200)),
        zIndex: 1000,
        ...(openUp
          ? { bottom: window.innerHeight - rect.top + 4 }
          : { top: rect.bottom + 4 }),
      });
    }
    setIsDropdownOpen(true);
  };

  const copyFormatOptions: CopyFormatOption[] = useMemo(
    () => [
      {
        format: 'markdown',
        label: t('copyMessage.copyAsMarkdown', { defaultValue: 'Copy as markdown' }),
      },
      {
        format: 'text',
        label: t('copyMessage.copyAsText', { defaultValue: 'Copy as text' }),
      },
    ],
    [t]
  );

  const selectedFormatTag = selectedFormat === 'markdown'
    ? t('copyMessage.markdownShort', { defaultValue: 'MD' })
    : t('copyMessage.textShort', { defaultValue: 'TXT' });

  const copyPayload = useMemo(() => {
    if (selectedFormat === 'markdown') {
      return content;
    }
    return convertMarkdownToPlainText(content);
  }, [content, selectedFormat]);

  useEffect(() => {
    setSelectedFormat(defaultFormat);
    setIsDropdownOpen(false);
  }, [defaultFormat]);

  useEffect(() => {
    if (!isDropdownOpen) return;

    // Close when clicking outside both the control and the portaled menu.
    const closeOnOutsideClick = (event: MouseEvent) => {
      const target = event.target as Node;
      if (dropdownRef.current?.contains(target) || menuRef.current?.contains(target)) {
        return;
      }
      setIsDropdownOpen(false);
    };

    // The menu is fixed-positioned; close it if the page scrolls so it can't
    // detach from the trigger.
    const closeOnScroll = () => setIsDropdownOpen(false);

    window.addEventListener('mousedown', closeOnOutsideClick);
    window.addEventListener('scroll', closeOnScroll, true);
    window.addEventListener('resize', closeOnScroll);
    return () => {
      window.removeEventListener('mousedown', closeOnOutsideClick);
      window.removeEventListener('scroll', closeOnScroll, true);
      window.removeEventListener('resize', closeOnScroll);
    };
  }, [isDropdownOpen]);

  useEffect(() => {
    return () => {
      if (copyFeedbackTimerRef.current) {
        clearTimeout(copyFeedbackTimerRef.current);
      }
    };
  }, []);

  const handleCopyClick = async () => {
    if (!copyPayload.trim()) return;
    const didCopy = await copyTextToClipboard(copyPayload);
    if (!didCopy) return;

    setCopied(true);
    if (copyFeedbackTimerRef.current) {
      clearTimeout(copyFeedbackTimerRef.current);
    }
    copyFeedbackTimerRef.current = setTimeout(() => {
      setCopied(false);
    }, COPY_SUCCESS_TIMEOUT_MS);
  };

  const handleFormatChange = (format: CopyFormat) => {
    setSelectedFormat(format);
    setIsDropdownOpen(false);
  };

  const handleDownload = (format: CopyFormat) => {
    const payload = format === 'markdown' ? content : convertMarkdownToPlainText(content);
    if (!payload.trim()) return;
    const extension = format === 'markdown' ? 'md' : 'txt';
    const blob = new Blob([payload], { type: `${format === 'markdown' ? 'text/markdown' : 'text/plain'};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = `response-${new Date().toISOString().replace(/[:.]/g, '-')}.${extension}`;
    document.body.appendChild(link);
    try {
      link.click();
      setIsDropdownOpen(false);
    } finally {
      link.remove();
      // Keep the URL alive long enough for mobile browsers to start the download.
      window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
    }
  };

  const toneClass = messageType === 'user'
    ? 'text-muted-foreground hover:text-foreground'
    : 'text-muted-foreground/70 hover:text-muted-foreground';
  const copyTitle = copied ? t('copyMessage.copied') : t('copyMessage.copy');
  const rootClassName = canSelectCopyFormat
    ? 'relative flex min-w-0 flex-1 items-center gap-0.5 sm:min-w-max sm:flex-none sm:w-auto'
    : 'relative flex items-center gap-0.5';

  return (
    <div ref={dropdownRef} className={rootClassName}>
      <button
        type="button"
        onClick={handleCopyClick}
        title={copyTitle}
        aria-label={copyTitle}
        className={`inline-flex items-center gap-1 rounded px-1 py-0.5 transition-colors ${toneClass}`}
      >
        {copied ? (
          <svg className="h-3.5 w-3.5" viewBox="0 0 20 20" fill="currentColor">
            <path
              fillRule="evenodd"
              d="M16.707 5.293a1 1 0 010 1.414l-8 8a1 1 0 01-1.414 0l-4-4a1 1 0 011.414-1.414L8 12.586l7.293-7.293a1 1 0 011.414 0z"
              clipRule="evenodd"
            />
          </svg>
        ) : (
          <svg
            className="h-3.5 w-3.5"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <rect x="9" y="9" width="13" height="13" rx="2" ry="2" />
            <path d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
          </svg>
        )}
        <span className="text-[10px] font-semibold uppercase tracking-wide">{selectedFormatTag}</span>
      </button>

      {canSelectCopyFormat && (
        <>
          <button
            ref={triggerRef}
            type="button"
            onClick={() => (isDropdownOpen ? setIsDropdownOpen(false) : openDropdown())}
            className={`rounded px-1 py-0.5 transition-colors ${toneClass}`}
            aria-label={t('copyMessage.selectFormat', { defaultValue: 'Select copy format' })}
            title={t('copyMessage.selectFormat', { defaultValue: 'Select copy format' })}
          >
            <svg
              className={`h-3 w-3 transition-transform ${isDropdownOpen ? 'rotate-180' : ''}`}
              fill="none"
              stroke="currentColor"
              viewBox="0 0 24 24"
            >
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
            </svg>
          </button>

          {isDropdownOpen && createPortal(
            <div
              ref={menuRef}
              style={menuStyle}
              className="max-h-[calc(100dvh-16px)] w-48 max-w-[calc(100vw-16px)] overflow-y-auto rounded-md border border-border bg-popover p-1 shadow-lg"
            >
              {copyFormatOptions.map((option) => {
                const isSelected = option.format === selectedFormat;
                return (
                  <button
                    key={option.format}
                    type="button"
                    onClick={() => handleFormatChange(option.format)}
                    className={`block w-full rounded px-2 py-1.5 text-left transition-colors ${isSelected
                      ? 'bg-accent text-foreground'
                      : 'text-foreground hover:bg-accent'
                      }`}
                  >
                    <span className="block text-xs font-medium">{option.label}</span>
                  </button>
                );
              })}
              <div role="separator" className="my-1 border-t border-border" />
              {(['text', 'markdown'] as const).map(format => (
                <button
                  key={`download-${format}`}
                  type="button"
                  onClick={() => handleDownload(format)}
                  className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs font-medium text-foreground transition-colors hover:bg-accent"
                >
                  <Download className="h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                  {format === 'text'
                    ? t('copyMessage.downloadAsText', { defaultValue: 'Download as TXT' })
                    : t('copyMessage.downloadAsMarkdown', { defaultValue: 'Download as Markdown' })}
                </button>
              ))}
            </div>,
            document.body,
          )}
        </>
      )}
    </div>
  );
};

export default MessageCopyControl;
