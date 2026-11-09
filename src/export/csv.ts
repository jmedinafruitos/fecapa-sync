export type CsvValue = string | number | boolean | null | undefined;

/** One RFC 4180 field: quoted when it holds a comma, a double quote, CR or LF; quotes are doubled. `null` is empty. */
export function csvField(value: CsvValue): string {
  if (value === null || value === undefined) return "";
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** RFC 4180 CSV: a header row, CRLF line breaks (also after the last row), UTF-8 text without a BOM. */
export function toCsv(header: readonly string[], rows: ReadonlyArray<readonly CsvValue[]>): string {
  return [header, ...rows].map((row) => `${row.map(csvField).join(",")}\r\n`).join("");
}

/** List values inside one CSV field are joined with `|`. */
export const csvList = (values: ReadonlyArray<string | number | null>) => values.filter((value) => value !== null).join("|");
