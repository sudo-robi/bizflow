"use client";

import type { ReactNode } from "react";
import { EmptyState } from "./EmptyState";
import { Skeleton } from "./LoadingSkeleton";

export interface Column<T> {
  key: string;
  header: string;
  render?: (row: T) => ReactNode;
  className?: string;
  headerClassName?: string;
}

interface DataTableProps<T> {
  columns: Column<T>[];
  rows: T[];
  rowKey: (row: T) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptyDescription?: string;
  emptyAction?: ReactNode;
  onRowClick?: (row: T) => void;
  dense?: boolean;
}

export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading = false,
  emptyTitle = "Nothing here yet",
  emptyDescription,
  emptyAction,
  onRowClick,
  dense = false,
}: DataTableProps<T>) {
  if (loading) {
    return (
      <div className="ui-card overflow-hidden">
        <div className="flex gap-6 border-b border-slate-100 bg-slate-50/50 px-6 py-3.5">
          {columns.map((column) => (
            <Skeleton key={column.key} className="h-3 flex-1" />
          ))}
        </div>
        {Array.from({ length: 5 }).map((_, index) => (
          <div key={index} className="flex items-center gap-6 border-b border-slate-50 px-6 py-4 last:border-0">
            {columns.map((column) => (
              <Skeleton key={column.key} className="h-4 flex-1" />
            ))}
          </div>
        ))}
      </div>
    );
  }

  if (!rows.length) {
    return (
      <div className="ui-card overflow-hidden">
        <EmptyState title={emptyTitle} description={emptyDescription} action={emptyAction} />
      </div>
    );
  }

  return (
    <div className="ui-card overflow-hidden">
      <div className="overflow-x-auto">
        <table className="w-full min-w-[640px] border-collapse text-left">
          <thead>
            <tr className="border-b border-line bg-slate-50/60">
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  className={`ui-th ${column.headerClassName ?? ""}`}
                >
                  {column.header}
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.map((row) => (
              <tr
                key={rowKey(row)}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
                tabIndex={onRowClick ? 0 : undefined}
                role={onRowClick ? "link" : undefined}
                onKeyDown={
                  onRowClick
                    ? (event) => {
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          onRowClick(row);
                        }
                      }
                    : undefined
                }
                className={`transition-colors duration-200 ease-smooth ${
                  onRowClick ? "cursor-pointer hover:bg-accent-50/50 focus:bg-accent-50 focus:outline-none" : "hover:bg-slate-50/60"
                }`}
              >
                {columns.map((column) => (
                  <td key={column.key} className={`ui-td ${dense ? "py-2.5" : ""} ${column.className ?? ""}`}>
                    {column.render ? column.render(row) : String((row as Record<string, unknown>)[column.key] ?? "—")}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

interface ToolbarProps {
  children: ReactNode;
  className?: string;
}

export function TableToolbar({ children, className = "" }: ToolbarProps) {
  return <div className={`mb-4 flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between ${className}`}>{children}</div>;
}

export function FilterTabs<T extends string>({
  options,
  value,
  onChange,
}: {
  options: Array<{ value: T; label: string; count?: number }>;
  value: T;
  onChange: (value: T) => void;
}) {
  return (
    <div className="inline-flex flex-wrap items-center gap-1 rounded-lg border border-slate-200 bg-white p-1 shadow-sm" role="group" aria-label="Filter by status">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          aria-pressed={value === option.value}
          onClick={() => onChange(option.value)}
          className={`rounded-md px-3 py-1.5 text-xs font-medium transition-all duration-200 ease-spring focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-500 ${
            value === option.value ? "bg-navy-900 text-white shadow-sm" : "text-slate-600 hover:bg-slate-100"
          }`}
        >
          {option.label}
          {typeof option.count === "number" ? (
            <span className={`ml-1.5 ${value === option.value ? "text-accent-200" : "text-slate-400"}`}>{option.count}</span>
          ) : null}
        </button>
      ))}
    </div>
  );
}
