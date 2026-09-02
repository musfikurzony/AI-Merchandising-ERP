import React from "react";

/* Pagination that states where you are and lets you get to either end.
   Millions of rows never render; fifty do. */
export const PAGE_SIZES = [25, 50, 100];

export function Pager({ total, page, pageSize, onPage, onPageSize }) {
  const pageCount = Math.max(1, Math.ceil(total / pageSize));
  const current = Math.min(page, pageCount);
  const from = total === 0 ? 0 : (current - 1) * pageSize + 1;
  const to = Math.min(current * pageSize, total);
  const near = [];
  for (let p = Math.max(1, current - 2); p <= Math.min(pageCount, current + 2); p++) near.push(p);

  return (
    <div className="ct-pager">
      <span>Showing {from.toLocaleString()}–{to.toLocaleString()} of {total.toLocaleString()}</span>
      <span className="spacer" />
      <label className="db-pagesize">
        Rows per page
        <select value={pageSize} onChange={e => { onPageSize(Number(e.target.value)); onPage(1); }}>
          {PAGE_SIZES.map(s => <option key={s} value={s}>{s}</option>)}
        </select>
      </label>
      <button className="btn-outline" disabled={current === 1} onClick={() => onPage(1)}>First</button>
      <button className="btn-outline" disabled={current === 1} onClick={() => onPage(current - 1)}>Previous</button>
      {near.map(p => (
        <button key={p} className={p === current ? "btn-amber" : "btn-outline"} onClick={() => onPage(p)}>{p}</button>
      ))}
      <button className="btn-outline" disabled={current === pageCount} onClick={() => onPage(current + 1)}>Next</button>
      <button className="btn-outline" disabled={current === pageCount} onClick={() => onPage(pageCount)}>Last</button>
    </div>
  );
}
