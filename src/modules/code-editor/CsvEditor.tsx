import { useMemo, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, ExternalLink, Maximize2, Minimize2 } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { parseCsv, replaceCsvCell } from '@/modules/code-editor/utils/csvDocument';

const PAGE_SIZE = 100;

type CsvEditorProps = {
  content: string;
  onChange: (content: string) => void;
  onEditSource: () => void;
  isExpanded: boolean;
  onToggleExpand?: (() => void) | null;
  onPopOut?: (() => void) | null;
};

/** Used by CodeEditor to preview CSV records and edit cells in its shared save buffer. */
export function CsvEditor({ content, onChange, onEditSource, isExpanded, onToggleExpand, onPopOut }: CsvEditorProps) {
  const { t } = useTranslation('codeEditor');
  const document = useMemo(() => parseCsv(content), [content]);
  // Users can view headerless files without treating their first record as labels.
  const [hasHeader, setHasHeader] = useState(true);
  // Only the current page is mounted, keeping large CSV files usable in a sidebar.
  const [page, setPage] = useState(0);
  const scrollRef = useRef<HTMLDivElement>(null);
  const firstDataRow = hasHeader ? 1 : 0;
  const rowCount = Math.max(0, document.rows.length - firstDataRow);
  const columnCount = document.rows.reduce((max, row) => Math.max(max, row.length), 0);
  const pageCount = Math.max(1, Math.ceil(rowCount / PAGE_SIZE));
  const currentPage = Math.min(page, pageCount - 1);
  const firstVisibleRow = firstDataRow + currentPage * PAGE_SIZE;
  const buttonClass = 'rounded p-1.5 hover:bg-accent disabled:opacity-40';

  const renderCells = (rowIndex: number, header = false) => {
    const row = document.rows[rowIndex];
    const Cell = header ? 'th' : 'td';
    return Array.from({ length: columnCount }, (_, columnIndex) => {
      const cell = row[columnIndex];
      return <Cell key={columnIndex} scope={header ? 'col' : undefined} className="border-b border-r border-border p-0 align-top font-normal">
        {cell ? <textarea
          aria-label={t('csv.cell', { row: rowIndex + 1, column: columnIndex + 1 })}
          value={cell.value}
          rows={2}
          spellCheck={false}
          className={`block min-h-12 w-full resize-y bg-transparent px-3 py-2 text-sm text-foreground outline-none focus:bg-accent/40 focus:ring-2 focus:ring-inset focus:ring-primary ${header ? 'font-medium' : ''}`}
          onChange={event => onChange(replaceCsvCell(content, cell.start, cell.end, event.target.value))}
        /> : <span className="block p-3 text-muted-foreground" aria-label={t('csv.missingCell')}>—</span>}
      </Cell>;
    });
  };

  return <div className="flex h-full min-w-0 flex-col bg-background">
    <div className="flex shrink-0 flex-wrap items-center gap-3 border-y border-border px-3 py-2 text-xs text-muted-foreground">
      <span className="font-medium text-foreground">{t('csv.title')}</span>
      <label className="flex items-center gap-1.5">
        <input type="checkbox" checked={hasHeader} onChange={event => { setHasHeader(event.target.checked); setPage(0); }} />
        {t('csv.firstRowHeader')}
      </label>
      <div className="ml-auto flex items-center gap-1">
        {onPopOut && <button type="button" className={buttonClass} onClick={onPopOut} aria-label={t('filePreview.openInNewTab')} title={t('filePreview.openInNewTab')}><ExternalLink className="h-4 w-4" /></button>}
        {onToggleExpand && <button type="button" className={buttonClass} onClick={onToggleExpand} aria-label={t(isExpanded ? 'toolbar.collapse' : 'toolbar.expand')} title={t(isExpanded ? 'toolbar.collapse' : 'toolbar.expand')}>
          {isExpanded ? <Minimize2 className="h-4 w-4" /> : <Maximize2 className="h-4 w-4" />}
        </button>}
      </div>
    </div>
    {document.errorRow !== null ? <div role="alert" className="p-4 text-sm">
      <p>{t('csv.parseError', { row: document.errorRow })}</p>
      <button type="button" onClick={onEditSource} className="mt-3 rounded border border-border px-3 py-1.5 hover:bg-accent">{t('actions.editSource')}</button>
    </div> : <>
      <p className="shrink-0 px-3 py-2 text-xs text-muted-foreground">{t('csv.editHint')}</p>
      <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
        <table aria-label={t('csv.title')} className="table-fixed border-separate border-spacing-0 text-left" style={{ width: 48 + columnCount * 240 }}>
          <colgroup><col style={{ width: 48 }} />{Array.from({ length: columnCount }, (_, index) => <col key={index} style={{ width: 240 }} />)}</colgroup>
          <thead className="sticky top-0 z-10 bg-muted">
            <tr><th scope="col" className="border-b border-r border-border text-center text-xs text-muted-foreground">#</th>
              {hasHeader ? renderCells(0, true) : Array.from({ length: columnCount }, (_, index) => <th key={index} scope="col" className="border-b border-r border-border px-3 py-2 text-xs font-medium">{t('csv.column', { column: index + 1 })}</th>)}
            </tr>
          </thead>
          <tbody>
            {document.rows.slice(firstVisibleRow, firstVisibleRow + PAGE_SIZE).map((_, index) => {
              const rowIndex = firstVisibleRow + index;
              return <tr key={rowIndex} className="hover:bg-muted/30">
                <th scope="row" className="border-b border-r border-border bg-muted/40 pt-3 text-center align-top text-xs font-normal text-muted-foreground">{rowIndex + 1}</th>
                {renderCells(rowIndex)}
              </tr>;
            })}
          </tbody>
        </table>
      </div>
      <div className="flex shrink-0 flex-wrap items-center justify-between gap-2 border-t border-border px-3 py-2 text-xs text-muted-foreground">
        <span>{t('csv.dimensions', { rows: rowCount, columns: columnCount })}</span>
        <div className="flex items-center gap-2">
          <button type="button" className={buttonClass} aria-label={t('csv.previousPage')} disabled={currentPage === 0} onClick={() => { setPage(currentPage - 1); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}><ChevronLeft className="h-4 w-4" /></button>
          <span>{t('csv.page', { page: currentPage + 1, pages: pageCount })}</span>
          <button type="button" className={buttonClass} aria-label={t('csv.nextPage')} disabled={currentPage + 1 === pageCount} onClick={() => { setPage(currentPage + 1); if (scrollRef.current) scrollRef.current.scrollTop = 0; }}><ChevronRight className="h-4 w-4" /></button>
        </div>
      </div>
    </>}
  </div>;
}
