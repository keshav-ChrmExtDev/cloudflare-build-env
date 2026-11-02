<script lang="ts">
  import { NAME_RE, mergeEnv, parsePaste, toPayload, validateRows, type EnvVar } from '../../lib/env';

  // ── Types ──────────────────────────────────────────────────────────────────

  type Note = { text: string; tone: 'ok' | 'error' | 'neutral' };

  type CfResponse = {
    ok: boolean;
    found: boolean;
    rows: number;
    log: string[];
    error?: string;
    warning?: string;
  };

  // ── State ──────────────────────────────────────────────────────────────────

  let rows: EnvVar[] = $state([{ var_name: '', value: '', is_secret: false }]);
  let selected: number[] = $state([]);
  let connected: boolean = $state(false);
  let syncing: boolean = $state(false);
  let confirmAction: 'sync' | 'clear' | null = $state(null);
  let note: Note = $state({ text: 'Open the Cloudflare Workers build settings page first.', tone: 'neutral' });

  // ── Derived ────────────────────────────────────────────────────────────────

  const payload = $derived(toPayload(rows));
  const issues = $derived(validateRows(rows));
  const allSelected = $derived(
    rows.length > 0 && selected.length === rows.length,
  );

  // ── Ping loop ──────────────────────────────────────────────────────────────

  async function ping() {
    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        connected = false;
        note = { text: 'Open the Cloudflare Workers build settings page first.', tone: 'neutral' };
        return;
      }
      const response: CfResponse = await browser.tabs.sendMessage(tab.id, { type: 'cf-ping' });
      connected = response.found;
      if (response.found) {
        note = { text: `Connected · ${response.rows} row${response.rows === 1 ? '' : 's'} on page`, tone: 'ok' };
      } else {
        note = { text: 'Navigate to Workers → Settings → Build variables.', tone: 'neutral' };
      }
    } catch {
      connected = false;
      note = { text: 'Open the Cloudflare Workers build settings page first.', tone: 'neutral' };
    }
  }

  // Run once on mount and whenever the popup gains focus.
  $effect(() => {
    void ping();
    const interval = setInterval(ping, 3000);
    return () => clearInterval(interval);
  });

  // Listen for progress messages pushed from the content script.
  $effect(() => {
    function onMessage(message: unknown) {
      if (
        message &&
        typeof message === 'object' &&
        'type' in message &&
        (message as { type: string }).type === 'cf-progress' &&
        'message' in message
      ) {
        note = { text: String((message as { message: unknown }).message), tone: 'neutral' };
      }
    }
    browser.runtime.onMessage.addListener(onMessage);
    return () => browser.runtime.onMessage.removeListener(onMessage);
  });

  // ── Storage ────────────────────────────────────────────────────────────────

  $effect(() => {
    browser.storage.local.get('rows').then((data) => {
      if (Array.isArray(data.rows) && data.rows.length > 0) {
        rows = [...data.rows, { var_name: '', value: '', is_secret: false }];
      }
    });
  });

  function persist() {
    const saved = rows.filter((r) => r.var_name.trim() !== '' || r.value !== '');
    browser.storage.local.set({ rows: saved });
  }

  // ── Row management ─────────────────────────────────────────────────────────

  function onCellInput(index: number) {
    // Ensure there is always a blank draft at the end.
    if (index === rows.length - 1 && (rows[index]!.var_name !== '' || rows[index]!.value !== '')) {
      rows = [...rows, { var_name: '', value: '', is_secret: false }];
    }
    persist();
  }

  function removeRow(index: number) {
    // Never remove the last remaining blank draft.
    if (rows.length === 1) {
      rows = [{ var_name: '', value: '', is_secret: false }];
    } else {
      rows = rows.filter((_, i) => i !== index);
    }
    selected = selected.filter((i) => i !== index).map((i) => (i > index ? i - 1 : i));
    persist();
  }

  function selectRow(index: number) {
    selected = selected.includes(index)
      ? selected.filter((i) => i !== index)
      : [...selected, index];
  }

  function toggleAll() {
    selected = allSelected ? [] : rows.map((_, i) => i);
  }

  function deleteSelected() {
    const keep = new Set(selected);
    const next = rows.filter((_, i) => !keep.has(i));
    // Ensure there's always at least one blank draft row.
    if (next.length === 0 || next[next.length - 1]!.var_name !== '' || next[next.length - 1]!.value !== '') {
      next.push({ var_name: '', value: '', is_secret: false });
    }
    rows = next;
    selected = [];
    persist();
  }

  function toggleSecret(indices: number[]) {
    const allSecret = indices.every((i) => rows[i]?.is_secret);
    rows = rows.map((row, i) => (indices.includes(i) ? { ...row, is_secret: !allSecret } : row));
    persist();
  }

  function handlePaste(event: ClipboardEvent, index: number) {
    const text = event.clipboardData?.getData('text') ?? '';
    const parsed = parsePaste(text);
    if (!parsed) return; // Let the browser paste normally.
    event.preventDefault();

    const before = rows.slice(0, index);
    const after = rows.slice(index + 1);
    const merged = mergeEnv([...before, ...after], parsed);
    // Always keep a blank draft at the end.
    if (merged.length === 0 || merged[merged.length - 1]!.var_name !== '' || merged[merged.length - 1]!.value !== '') {
      merged.push({ var_name: '', value: '', is_secret: false });
    }
    rows = merged;
    selected = [];
    persist();
  }

  // ── Confirm dialog ─────────────────────────────────────────────────────────

  async function confirm() {
    if (!confirmAction) return;
    const action = confirmAction;
    confirmAction = null;
    syncing = true;
    note = { text: 'Working…', tone: 'neutral' };

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active tab found.');

      let response: CfResponse;

      if (action === 'clear') {
        response = await browser.tabs.sendMessage(tab.id, { type: 'cf-clear', vars: [] });
      } else {
        response = await browser.tabs.sendMessage(tab.id, { type: 'cf-sync', vars: payload });
      }

      if (!response.ok) {
        note = { text: response.error ?? 'Unknown error.', tone: 'error' };
      } else if (response.warning) {
        note = { text: response.warning, tone: 'error' };
      } else {
        note = {
          text: action === 'clear'
            ? 'Cleared all variables.'
            : `Synced ${payload.length} variable${payload.length === 1 ? '' : 's'}.`,
          tone: 'ok',
        };
        if (action === 'clear') {
          rows = [{ var_name: '', value: '', is_secret: false }];
          selected = [];
          persist();
        }
      }
    } catch (err) {
      note = { text: err instanceof Error ? err.message : 'Operation failed.', tone: 'error' };
    } finally {
      syncing = false;
    }
  }

  function cancelConfirm() {
    confirmAction = null;
  }
</script>

<main class="app">
  <header class="bar">
    <h1>Build env</h1>
  </header>

  <div class="grid">
    <table>
      <thead>
        <tr>
          <th scope="col">
            <input
              type="checkbox"
              checked={allSelected}
              indeterminate={selected.length > 0 && !allSelected}
              onchange={toggleAll}
              aria-label="Select all rows"
            />
          </th>
          <th scope="col">Name</th>
          <th scope="col">Value</th>
          <th scope="col" class="secret-col">Secret</th>
          <th scope="col" class="remove-col"><span class="sr-only">Remove</span></th>
        </tr>
      </thead>
      <tbody>
        {#each rows as row, index (index)}
          {@const trimmed = row.var_name.trim()}
          {@const invalid = trimmed !== '' && !NAME_RE.test(trimmed)}
          {@const duplicate =
            trimmed !== '' && rows.some((other, i) => i !== index && other.var_name.trim() === trimmed)}
          <tr
            class:selected={selected.includes(index)}
            class:hover={!selected.includes(index)}
            onauxclick={() => {
              toggleSecret([index]);
            }}
            oncontextmenu={(event) => {
              event.preventDefault();
              selected = [index];
              toggleSecret(selected);
            }}
          >
            <td class="check-cell">
              <input
                type="checkbox"
                checked={selected.includes(index)}
                onclick={(e) => e.stopPropagation()}
                onchange={() => selectRow(index)}
                aria-label={`Select ${trimmed || `row ${index + 1}`}`}
              />
            </td>
            <td>
              <input
                class="cell"
                class:bad={invalid || duplicate}
                bind:value={row.var_name}
                oninput={() => onCellInput(index)}
                onpaste={(event) => handlePaste(event, index)}
                placeholder={index === rows.length - 1 ? 'Paste .env or type NAME' : 'NAME'}
                aria-label={`Name, row ${index + 1}`}
                aria-invalid={invalid || duplicate}
                autocapitalize="off"
                autocomplete="off"
                spellcheck="false"
              />
            </td>
            <td>
              <input
                class="cell"
                class:masked={row.is_secret}
                bind:value={row.value}
                oninput={() => onCellInput(index)}
                onpaste={(event) => handlePaste(event, index)}
                placeholder="Value"
                aria-label={`Value, row ${index + 1}`}
                autocomplete="off"
                spellcheck="false"
              />
            </td>
            <td class="secret-col">
              <input
                type="checkbox"
                bind:checked={row.is_secret}
                aria-label={`${trimmed || `Row ${index + 1}`} is a secret`}
              />
            </td>
            <td class="remove-col">
              <button
                class="remove"
                type="button"
                onclick={() => removeRow(index)}
                aria-label={`Remove ${trimmed || `row ${index + 1}`}`}
                title="Remove row"
              >
                ×
              </button>
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>

  <footer class="footer">
    <p class="note" data-tone={note.tone} aria-live="polite">{note.text}</p>

    <div class="actions">
      <p class="count">
        <strong>{rows.length}</strong>
        {rows.length === 1 ? 'row' : 'rows'}
        {#if selected.length}
          <span class="selection">· {selected.length} selected</span>
        {/if}
      </p>

      <div class="tools">
        <button
          class="btn ghost danger-text"
          type="button"
          disabled={selected.length === 0}
          onclick={deleteSelected}
        >
          Delete selected
        </button>
        <button
          class="btn ghost"
          type="button"
          disabled={selected.length === 0}
          onclick={() => toggleSecret(selected)}
        >
          {selected.some((i) => rows[i]?.is_secret) ? 'Unset secret' : 'Set secret'}
        </button>
      </div>

      <div class="btn-group">
        <button
          class="btn"
          type="button"
          disabled={!connected || syncing}
          onclick={() => (confirmAction = 'clear')}
        >
          Clear all
        </button>
        <button
          class="btn primary"
          type="button"
          disabled={!connected || syncing || issues.length > 0 || payload.length === 0}
          onclick={() => (confirmAction = 'sync')}
        >
          {syncing ? 'Working…' : 'Sync'}
        </button>
      </div>
    </div>
  </footer>

  {#if confirmAction}
    <div class="overlay" role="dialog" aria-modal="true" aria-labelledby="confirm-title">
      <div class="dialog">
        <h2 id="confirm-title">
          {confirmAction === 'clear' ? 'Clear all variables?' : 'Sync variables?'}
        </h2>
        <p>
          {#if confirmAction === 'clear'}
            This will delete all build variables and secrets from the Cloudflare dashboard. This cannot be undone.
          {:else}
            This will delete all existing build variables and replace them with the {payload.length} row{payload.length === 1 ? '' : 's'} listed above.
          {/if}
        </p>
        <div class="dialog-actions">
          <button class="btn ghost" type="button" onclick={cancelConfirm}>Cancel</button>
          <button
            class="btn {confirmAction === 'clear' ? 'danger' : 'primary'}"
            type="button"
            onclick={confirm}
          >
            {confirmAction === 'clear' ? 'Clear all' : 'Sync'}
          </button>
        </div>
      </div>
    </div>
  {/if}
</main>
