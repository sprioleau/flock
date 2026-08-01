"use client";

import type { TableDataPart } from "@/lib/chat-contract";

/**
 * The compact table part (generative UI): one small, read-only table in the
 * transcript — user-facing headers and string cells only (the server builds
 * them; nothing internal reaches this component). Row count is capped at the
 * contract level (CHAT_TABLE_MAX_ROWS); anything beyond shows as "+N more".
 */
export function ChatTableWidget({ data }: { data: TableDataPart }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border px-3 py-2" data-widget="table">
      {data.title !== undefined && <p className="text-xs font-medium">{data.title}</p>}
      <table className="w-full border-collapse text-xs">
        <thead>
          <tr>
            {data.headers.map((header) => (
              <th
                key={header}
                scope="col"
                className="pb-1 pr-3 text-left font-medium text-muted-foreground last:pr-0"
              >
                {header}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {data.rows.map((row, rowIndex) => (
            <tr key={rowIndex} className="border-t">
              {row.map((cell, cellIndex) => (
                <td key={cellIndex} className="max-w-40 truncate py-1 pr-3 last:pr-0">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {data.moreRowCount !== undefined && data.moreRowCount > 0 && (
        <p className="text-[11px] text-muted-foreground" data-table-more-rows>
          +{data.moreRowCount} more in your library
        </p>
      )}
    </div>
  );
}
