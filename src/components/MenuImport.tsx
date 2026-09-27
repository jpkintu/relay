import { useState } from 'react';
import { FileUp, Download } from 'lucide-react';
import Parse from '../parse';
import { MENU_TEMPLATE, menuRowsFromCsv, parseCsv, type MenuRow } from '../lib/csv';
import { useMoney } from '../lib/session';

type Summary = {
  created: number;
  updated: number;
  skipped: number;
  categoriesCreated: string[];
  starterRemoved: number;
  errors: { row: number; message: string }[];
};

function downloadTemplate() {
  const url = URL.createObjectURL(new Blob([MENU_TEMPLATE], { type: 'text/csv' }));
  const link = document.createElement('a');
  link.href = url;
  link.download = 'relay-menu.csv';
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}

// Adds dishes from a spreadsheet saved as CSV: pick the file, check what
// will happen, import. Used in Get started and on the Menu page.
export function MenuImport({
  starterDishes = 0,
  onImported,
}: {
  starterDishes?: number;
  onImported?: (summary: Summary) => void;
}) {
  const money = useMoney();
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<MenuRow[]>([]);
  const [check, setCheck] = useState<Summary | null>(null);
  const [updateExisting, setUpdateExisting] = useState(false);
  const [removeStarter, setRemoveStarter] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState<Summary | null>(null);
  const options = (next: { updateExisting?: boolean; removeStarter?: boolean } = {}) => ({
    updateExisting: next.updateExisting ?? updateExisting,
    removeStarter: starterDishes > 0 && (next.removeStarter ?? removeStarter),
  });

  const runCheck = async (list: MenuRow[], opts = options()) => {
    setBusy(true);
    setError('');
    try {
      setCheck(await Parse.Cloud.run('adminImportMenu', { rows: list, dryRun: true, ...opts }));
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not check the file');
    } finally {
      setBusy(false);
    }
  };

  const pick = async (file: File | undefined) => {
    setDone(null);
    setCheck(null);
    setRows([]);
    setError('');
    if (!file) return;
    setFileName(file.name);
    if (!/\.(csv|txt)$/i.test(file.name) && !/csv|text/.test(file.type)) {
      setError('Save the spreadsheet as CSV first (File → Save as / Download → CSV)');
      return;
    }
    const { rows: found, problem } = menuRowsFromCsv(parseCsv(await file.text()));
    if (problem) {
      setError(problem);
      return;
    }
    setRows(found);
    await runCheck(found);
  };

  const setOption = (next: { updateExisting?: boolean; removeStarter?: boolean }) => {
    if (next.updateExisting !== undefined) setUpdateExisting(next.updateExisting);
    if (next.removeStarter !== undefined) setRemoveStarter(next.removeStarter);
    if (rows.length) void runCheck(rows, options(next));
  };

  const importNow = async () => {
    setBusy(true);
    setError('');
    try {
      const summary: Summary = await Parse.Cloud.run('adminImportMenu', { rows, ...options() });
      setDone(summary);
      setRows([]);
      setCheck(null);
      setFileName('');
      onImported?.(summary);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Could not import');
    } finally {
      setBusy(false);
    }
  };

  const errorRows = new Map((check?.errors || []).map((e) => [e.row, e.message]));
  return (
    <div className="menu-import">
      <p className="muted small">
        Put your dishes in a spreadsheet with the columns <b>Name</b>, <b>Price</b> and, if you
        like, <b>Category</b>, <b>Description</b> and <b>Prep minutes</b>. Save it as CSV and pick
        it here. You can check the result before anything is saved.
      </p>
      <div className="menu-import-actions">
        <label className="setup-submit file-button">
          <FileUp aria-hidden /> {fileName ? 'Pick another file' : 'Pick a CSV file'}
          <input
            type="file"
            accept=".csv,text/csv,text/plain"
            onChange={(e) => {
              void pick(e.target.files?.[0]);
              e.target.value = '';
            }}
          />
        </label>
        <button className="link-button icon-link" type="button" onClick={downloadTemplate}>
          <Download aria-hidden /> Download a template
        </button>
      </div>
      {error && <p className="ops-error">{error}</p>}
      {done && (
        <p className="setup-notice">
          Imported: {done.created} new dish{done.created === 1 ? '' : 'es'}
          {done.updated > 0 && `, ${done.updated} updated`}
          {done.skipped > 0 && `, ${done.skipped} already on the menu (left as they were)`}
          {done.categoriesCreated.length > 0 &&
            `. New categories: ${done.categoriesCreated.join(', ')}`}
          {done.starterRemoved > 0 && `. ${done.starterRemoved} starter dishes archived`}.
        </p>
      )}
      {check && rows.length > 0 && (
        <div className="menu-import-check">
          <p>
            <b>{fileName}</b>: {rows.length} row{rows.length === 1 ? '' : 's'}.{' '}
            {check.errors.length ? (
              <span className="bad-text">
                {check.errors.length} row{check.errors.length === 1 ? ' needs' : 's need'} fixing in
                the spreadsheet before importing.
              </span>
            ) : (
              <>
                {check.created} new
                {check.updated > 0 && `, ${check.updated} to update`}
                {check.skipped > 0 && `, ${check.skipped} already on the menu`}
                {check.categoriesCreated.length > 0 &&
                  `; new categories: ${check.categoriesCreated.join(', ')}`}
                {check.starterRemoved > 0 && `; ${check.starterRemoved} starter dishes archived`}.
              </>
            )}
          </p>
          <div className="table-scroll">
            <table className="data stack-on-phone menu-import-table">
              <thead>
                <tr>
                  <th>Row</th>
                  <th>Name</th>
                  <th>Category</th>
                  <th className="num">Price</th>
                  <th>Check</th>
                </tr>
              </thead>
              <tbody>
                {/* Rows with a problem first, so they are seen on a phone. */}
                {rows
                  .map((row, index) => ({ row, index }))
                  .sort(
                    (a, b) =>
                      Number(errorRows.has(b.index + 2)) - Number(errorRows.has(a.index + 2)),
                  )
                  .slice(0, 200)
                  .map(({ row, index }) => {
                    const problem = errorRows.get(index + 2);
                    const price = Number(row.price.replace(/[^\d.]/g, ''));
                    return (
                      <tr key={index} className={problem ? 'bad-row' : ''}>
                        <td data-label="Row">{index + 2}</td>
                        <td data-label="Name">{row.title || '—'}</td>
                        <td data-label="Category">{row.category || 'Mains'}</td>
                        <td className="num" data-label="Price">
                          {/\d/.test(row.price) && Number.isFinite(price)
                            ? money(price)
                            : row.price || '—'}
                        </td>
                        <td data-label="Check">{problem || 'OK'}</td>
                      </tr>
                    );
                  })}
              </tbody>
            </table>
          </div>
          {rows.length > 200 && <p className="muted small">Showing the first 200 rows.</p>}
          <label className="setup-checkbox">
            <input
              type="checkbox"
              checked={updateExisting}
              onChange={(e) => setOption({ updateExisting: e.target.checked })}
            />
            Dishes already on the menu: take the price, category and details from the file
          </label>
          {starterDishes > 0 && (
            <label className="setup-checkbox">
              <input
                type="checkbox"
                checked={removeStarter}
                onChange={(e) => setOption({ removeStarter: e.target.checked })}
              />
              Remove the {starterDishes} example dishes Relay started with
            </label>
          )}
          <button
            className="setup-submit"
            type="button"
            disabled={busy || check.errors.length > 0}
            onClick={() => void importNow()}
          >
            {busy ? 'Working…' : `Import ${check.created + check.updated} dishes`}
          </button>
        </div>
      )}
    </div>
  );
}
