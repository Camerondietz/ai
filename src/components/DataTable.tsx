import { useEffect, useState, type ReactNode } from 'react';
import { Button } from './ui';

export interface Column<T> {
  key: string;
  label: ReactNode;
  render?: (row: T, index: number) => ReactNode;
  num?: boolean;
  width?: number | string;
}

export function DataTable<T>({
  columns,
  rows,
  pageSize = 50,
  rowKey,
  onRowClick,
  empty,
  maxHeight,
}: {
  columns: Column<T>[];
  rows: T[];
  pageSize?: number;
  rowKey?: (row: T, index: number) => string | number;
  onRowClick?: (row: T, index: number) => void;
  empty?: ReactNode;
  maxHeight?: number | string;
}) {
  const [page, setPage] = useState(0);
  const pages = Math.max(1, Math.ceil(rows.length / pageSize));
  const current = Math.min(page, pages - 1);
  useEffect(() => {
    if (page > pages - 1) setPage(0);
  }, [page, pages]);
  const start = current * pageSize;
  const slice = rows.slice(start, start + pageSize);

  if (!rows.length && empty) return <>{empty}</>;

  return (
    <div className="stack sm">
      <div className="table-wrap" style={maxHeight ? { maxHeight } : undefined}>
        <table className="table">
          <thead>
            <tr>
              {columns.map((c) => (
                <th key={c.key} className={c.num ? 'num' : undefined} style={c.width ? { width: c.width } : undefined}>
                  {c.label}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {slice.map((row, i) => {
              const index = start + i;
              return (
                <tr
                  key={rowKey ? rowKey(row, index) : index}
                  className={onRowClick ? 'clickable' : undefined}
                  onClick={onRowClick ? () => onRowClick(row, index) : undefined}
                >
                  {columns.map((c) => (
                    <td key={c.key} className={c.num ? 'num' : undefined}>
                      {c.render ? c.render(row, index) : String((row as Record<string, unknown>)[c.key] ?? '')}
                    </td>
                  ))}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {pages > 1 ? (
        <div className="row between small muted">
          <span>
            {start + 1}–{Math.min(start + pageSize, rows.length)} of {rows.length.toLocaleString()}
          </span>
          <div className="row">
            <Button size="sm" disabled={current === 0} onClick={() => setPage(current - 1)}>
              Previous
            </Button>
            <span>
              Page {current + 1} / {pages}
            </span>
            <Button size="sm" disabled={current >= pages - 1} onClick={() => setPage(current + 1)}>
              Next
            </Button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
