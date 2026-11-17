import { describe, expect, test } from 'vitest';

import { parseCsv, replaceCsvCell } from '@/modules/code-editor/utils/csvDocument';

describe('CSV parsing and lossless cell replacement', () => {
  test('reads BOM, Chinese, escaped JSON, commas and multiline quoted fields', () => {
    const content = '\uFEFFword,evidence,note\r\n贝拉,"[{""source"":""a,b""}]","first\r\nsecond"\r\n';
    const parsed = parseCsv(content);
    expect(parsed.errorRow).toBeNull();
    expect(parsed.rows.map(row => row.map(cell => cell.value))).toEqual([
      ['word', 'evidence', 'note'], ['贝拉', '[{"source":"a,b"}]', 'first\r\nsecond'],
    ]);
    const cell = parsed.rows[1][0];
    expect(replaceCsvCell(content, cell.start, cell.end, '嘉然')).toBe(content.replace('贝拉', '嘉然'));
  });

  test.each(['a,b', 'a"b', 'a\nb', 'a\rb', '', ' 中文 ', '=SUM(A1:A2)'])('round-trips edited field %j without changing adjacent bytes', value => {
    const source = '\uFEFF"name",value\r\n"old",001\r\n';
    const cell = parseCsv(source).rows[1][0];
    const edited = replaceCsvCell(source, cell.start, cell.end, value);
    expect(edited.startsWith('\uFEFF"name",value\r\n')).toBe(true);
    expect(edited.endsWith(',001\r\n')).toBe(true);
    expect(parseCsv(edited).rows[1][0].value).toBe(value);
  });

  test.each([
    ['', [['']]],
    ['\uFEFF', [['']]],
    ['a,b,', [['a', 'b', '']]],
    ['a,b\n\n', [['a', 'b'], ['']]],
    ['a,b\rc', [['a', 'b'], ['c']]],
    ['""""', [['"']]],
  ])('keeps empty fields, blank records and ragged rows in %j', (content, rows) => {
    expect(parseCsv(content as string).rows.map(row => row.map(cell => cell.value))).toEqual(rows);
  });

  test.each(['a,b\n"unclosed', 'a,b\n"closed"extra,c', 'a,b\nun"escaped,c'])('rejects malformed quoting without exposing a partial editable table', content => {
    expect(parseCsv(content)).toEqual({ rows: [], errorRow: 2 });
  });
});
