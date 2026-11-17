// Source offsets let table edits replace only one field, preserving the BOM,
// record separators, trailing newline and quoting of every untouched field.
type CsvCell = { value: string; start: number; end: number };

export function parseCsv(content: string) {
  const rows: CsvCell[][] = [];
  let row: CsvCell[] = [];
  let offset = content.startsWith('\uFEFF') ? 1 : 0;

  while (offset <= content.length) {
    const start = offset;
    let value = '';
    if (content[offset] === '"') {
      offset++;
      let closed = false;
      while (offset < content.length) {
        if (content[offset] === '"') {
          offset++;
          if (content[offset] !== '"') {
            closed = true;
            break;
          }
        }
        value += content[offset++];
      }
      if (!closed || (offset < content.length && !/[,\r\n]/.test(content[offset]))) {
        return { rows: [], errorRow: rows.length + 1 };
      }
    } else {
      while (offset < content.length && !/[,\r\n]/.test(content[offset])) {
        // An unescaped quote is ambiguous: require source repair before editing.
        if (content[offset] === '"') return { rows: [], errorRow: rows.length + 1 };
        value += content[offset++];
      }
    }
    row.push({ value, start, end: offset });
    if (content[offset] === ',') {
      offset++;
      continue;
    }
    rows.push(row);
    row = [];
    if (offset >= content.length) break;
    offset += content[offset] === '\r' && content[offset + 1] === '\n' ? 2 : 1;
    // A final record separator terminates the last row; it isn't an extra row.
    if (offset === content.length) break;
  }
  return { rows, errorRow: null };
}

export function replaceCsvCell(content: string, start: number, end: number, value: string) {
  const quoted = content[start] === '"' || /[,"\r\n]/.test(value);
  const field = quoted ? `"${value.replace(/"/g, '""')}"` : value;
  return content.slice(0, start) + field + content.slice(end);
}
