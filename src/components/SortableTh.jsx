import React from "react";

/* A column heading you can click.

   The arrow is shown at half opacity on every sortable column rather than
   only on the active one — a control that appears only once you have already
   used it is a control nobody finds. Hovering brings it up to full strength;
   the active column keeps it there.

   `aria-sort` is set because a screen reader otherwise announces these as
   plain headers and gives no way to know the table is ordered at all. */
export default function SortableTh({ column, sort, onSort, className = "", children }) {
  if (!column?.key || !onSort) return <th className={className}>{children ?? column?.label}</th>;

  const active = sort?.key === column.key;
  const dir = active ? sort.dir : null;
  const label = children ?? column.label;

  return (
    <th
      className={`sort-th ${className} ${active ? "on" : ""}`.trim()}
      aria-sort={active ? (dir === "asc" ? "ascending" : "descending") : "none"}
      onClick={() => onSort(column.key)}
      title={active
        ? `Sorted by ${column.label} ${dir === "asc" ? "A→Z / earliest first" : "Z→A / latest first"} — click to reverse`
        : `Sort by ${column.label}`}
    >
      <span className="sort-th-inner">
        {label}
        <span className="sort-arrow" aria-hidden="true">{active ? (dir === "asc" ? "▲" : "▼") : "↕"}</span>
      </span>
    </th>
  );
}
