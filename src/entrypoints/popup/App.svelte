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
  let note: Note = $state({ text: 'Open the Cloudflare build settings page first.', tone: 'neutral' });

  let triggerEl: HTMLElement | null = null;
  let dialogEl: HTMLDivElement | null = $state(null);

  // ── Derived ────────────────────────────────────────────────────────────────

  const payload = $derived(toPayload(rows));
  const issues = $derived(validateRows(rows));
  const allSelected = $derived(rows.length > 0 && selected.length === rows.length);
  const firstIssue = $derived(issues[0] ?? null);
  const canSync = $derived(connected && !syncing && issues.length === 0 && payload.length > 0);

  // ── Ping loop ──────────────────────────────────────────────────────────────

  let pingController: AbortController | null = null;

  async function ping() {
    pingController?.abort();
    pingController = new AbortController();

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) {
        connected = false;
        note = { text: 'Open the Cloudflare build settings page first.', tone: 'neutral' };
        return;
      }

      const response: CfResponse = await browser.tabs.sendMessage(tab.id, { type: 'cf-ping' });
      if (pingController.signal.aborted) return;

      connected = response.found;
      if (response.found) {
        const r = response.rows;
        note = { text: `Connected · ${r} ${r === 1 ? 'row' : 'rows'} on page`, tone: 'ok' };
      } else {
        note = { text: 'Navigate to Workers → Settings → Build variables.', tone: 'neutral' };
      }
    } catch {
      if (pingController.signal.aborted) return;
      connected = false;
      if (!syncing) {
        note = { text: 'Open the Cloudflare build settings page first.', tone: 'neutral' };
      }
    }
  }

  $effect(() => {
    void ping();
    const id = setInterval(ping, 3000);
    const onFocus = () => void ping();
    window.addEventListener('focus', onFocus);
    return () => {
      clearInterval(id);
      window.removeEventListener('focus', onFocus);
      pingController?.abort();
    };
  });

  // ── Progress messages from content script ─────────────────────────────────

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

  let storageReady = false;

  $effect(() => {
    browser.storage.local.get('rows').then((data) => {
      storageReady = true;
      if (Array.isArray(data.rows) && data.rows.length > 0) {
        const valid = (data.rows as unknown[]).filter(
          (r): r is EnvVar =>
            r !== null &&
            typeof r === 'object' &&
            typeof (r as EnvVar).var_name === 'string' &&
            typeof (r as EnvVar).value === 'string' &&
            typeof (r as EnvVar).is_secret === 'boolean',
        );
        if (valid.length > 0) {
          rows = [...valid, { var_name: '', value: '', is_secret: false }];
        }
      }
    });
  });

  function persist() {
    if (!storageReady) return;
    const saved = rows.filter((r) => r.var_name.trim() !== '' || r.value !== '');
    browser.storage.local.set({ rows: saved });
  }

  // ── Row management ─────────────────────────────────────────────────────────

  function ensureDraft() {
    const last = rows[rows.length - 1];
    if (!last || last.var_name !== '' || last.value !== '') {
      rows = [...rows, { var_name: '', value: '', is_secret: false }];
    }
  }

  function onCellInput(index: number) {
    if (index === rows.length - 1) ensureDraft();
    persist();
  }

  function removeRow(index: number) {
    if (rows.length === 1) {
      rows = [{ var_name: '', value: '', is_secret: false }];
    } else {
      rows = rows.filter((_, i) => i !== index);
      ensureDraft();
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
    rows = next;
    ensureDraft();
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
    if (!parsed) return;
    event.preventDefault();

    const before = rows.slice(0, index);
    const after = rows.slice(index + 1);
    const merged = mergeEnv([...before, ...after], parsed);
    rows = merged;
    ensureDraft();
    selected = [];
    persist();
  }

  function handleGridPaste(event: ClipboardEvent) {
    if ((event.target as HTMLElement)?.tagName === 'INPUT') return;
    const text = event.clipboardData?.getData('text') ?? '';
    const parsed = parsePaste(text);
    if (!parsed) return;
    event.preventDefault();
    rows = mergeEnv(rows, parsed);
    ensureDraft();
    selected = [];
    persist();
  }

  // ── Keyboard shortcuts ─────────────────────────────────────────────────────

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape' && confirmAction) {
      event.preventDefault();
      cancelConfirm();
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
      event.preventDefault();
      if (confirmAction) {
        void confirm();
      } else if (canSync) {
        openConfirm('sync');
      }
    }
  }

  // ── Confirm dialog ─────────────────────────────────────────────────────────

  function openConfirm(action: 'sync' | 'clear') {
    triggerEl = document.activeElement as HTMLElement | null;
    confirmAction = action;
  }

  function cancelConfirm() {
    confirmAction = null;
    setTimeout(() => triggerEl?.focus(), 0);
  }

  function trapFocus(event: KeyboardEvent) {
    if (event.key === 'Enter') {
      // Allow Enter to trigger confirm when inside dialog
      event.preventDefault();
      void confirm();
      return;
    }

    if (event.key !== 'Tab') return;
    const dialog = event.currentTarget as HTMLElement;
    const focusable = [...dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
    )].filter((el) => !el.hasAttribute('disabled'));
    if (focusable.length === 0) return;
    const first = focusable[0]!;
    const last = focusable[focusable.length - 1]!;
    if (event.shiftKey) {
      if (document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }
  }

  $effect(() => {
    if (confirmAction && dialogEl) {
      const primaryBtn = dialogEl.querySelector<HTMLElement>('button.primary, button.danger');
      primaryBtn?.focus();
    }
  });

  async function confirm() {
    if (!confirmAction || syncing) return;
    const action = confirmAction;
    confirmAction = null;
    syncing = true;
    note = { text: 'Working…', tone: 'neutral' };

    try {
      const [tab] = await browser.tabs.query({ active: true, currentWindow: true });
      if (!tab?.id) throw new Error('No active Cloudflare tab found.');

      const request =
        action === 'clear'
          ? { type: 'cf-clear' as const, vars: [] as EnvVar[] }
          : { type: 'cf-sync' as const, vars: payload };

      const response: CfResponse = await browser.tabs.sendMessage(tab.id, request);

      if (!response.ok) {
        note = { text: response.error ?? 'Something went wrong. Try again.', tone: 'error' };
      } else if (response.warning) {
        note = { text: response.warning, tone: 'error' };
      } else {
        const n = payload.length;
        note = {
          text:
            action === 'clear'
              ? 'Cleared — remember to save in Cloudflare.'
              : `Filled ${n} ${n === 1 ? 'variable' : 'variables'} — review and save in Cloudflare.`,
          tone: 'ok',
        };
        if (action === 'clear') {
          rows = [{ var_name: '', value: '', is_secret: false }];
          selected = [];
          persist();
        }
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'Operation failed.';
      note = { text: msg, tone: 'error' };
    } finally {
      syncing = false;
      setTimeout(() => triggerEl?.focus(), 0);
    }
  }
</script>

<svelte:window onkeydown={onKeydown} />

<main class="app">
  <header class="bar">
    <h1>Build env</h1>
  </header>

  <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
  <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
  <div
    class="grid"
    aria-label="Environment variables table"
    role="region"
    tabindex="0"
    onpaste={handleGridPaste}
  >
    <table aria-label="Build variables">
      <thead>
        <tr>
          <th scope="col">
            <input
              type="checkbox"
              checked={allSelected}
              indeterminate={selected.length > 0 && !allSelected}
              onchange={toggleAll}
              aria-label={allSelected ? 'Deselect all rows' : 'Select all rows'}
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
          {@const isDraft = index === rows.length - 1 && trimmed === '' && row.value === ''}
          <tr
            class:selected={selected.includes(index)}
            class:hover={!selected.includes(index)}
            onauxclick={() => toggleSecret([index])}
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
                disabled={isDraft}
              />
            </td>
            <td>
              <input
                class="cell"
                class:bad={invalid || duplicate}
                bind:value={row.var_name}
                oninput={() => onCellInput(index)}
                onpaste={(event) => handlePaste(event, index)}
                placeholder={isDraft ? 'Paste .env or type NAME' : 'NAME'}
                aria-label={`Name, row ${index + 1}`}
                aria-invalid={invalid || duplicate || undefined}
                aria-errormessage={invalid ? `err-name-${index}` : duplicate ? `err-dup-${index}` : undefined}
                autocapitalize="off"
                autocomplete="off"
                spellcheck="false"
                maxlength={255}
              />
              {#if invalid}
                <span id="err-name-{index}" class="sr-only" role="alert">
                  Invalid name: use letters, digits, and underscores only.
                </span>
              {:else if duplicate}
                <span id="err-dup-{index}" class="sr-only" role="alert">
                  Duplicate name — each variable name must be unique.
                </span>
              {/if}
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
                maxlength={100000}
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
                disabled={isDraft}
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
    <p
      class="note"
      data-tone={note.tone}
      aria-live="polite"
      aria-atomic="true"
      title={note.text}
    >{note.text}</p>

    <div class="actions">
      <p class="count" aria-live="polite" aria-atomic="true">
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
          disabled={selected.length === 0 || syncing}
          onclick={deleteSelected}
          aria-label={`Delete ${selected.length} selected row${selected.length === 1 ? '' : 's'}`}
        >
          Delete selected
        </button>
        <button
          class="btn ghost"
          type="button"
          disabled={selected.length === 0 || syncing}
          onclick={() => toggleSecret(selected)}
        >
          {selected.some((i) => rows[i]?.is_secret) ? 'Unset secret' : 'Set secret'}
        </button>
      </div>

      <div class="btn-group">
        <button
          id="clear-btn"
          class="btn"
          type="button"
          disabled={!connected || syncing}
          onclick={() => openConfirm('clear')}
          aria-label="Clear all variables from Cloudflare"
          title={!connected ? 'Not connected to Cloudflare' : undefined}
        >
          Clear all
        </button>
        <button
          id="sync-btn"
          class="btn primary"
          type="button"
          disabled={!canSync}
          onclick={() => openConfirm('sync')}
          aria-label={issues.length > 0 ? firstIssue ?? 'Fix errors before syncing' : `Sync ${payload.length} variable${payload.length === 1 ? '' : 's'} to Cloudflare (Ctrl+Enter)`}
          title={!connected ? 'Not connected to Cloudflare' : issues.length > 0 ? (firstIssue ?? 'Fix errors first') : payload.length === 0 ? 'Add at least one variable' : 'Sync (Ctrl+Enter)'}
        >
          {syncing ? 'Working…' : 'Sync'}
        </button>
      </div>
    </div>
  </footer>

  {#if confirmAction}
    <!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
    <div
      class="overlay"
      role="dialog"
      tabindex="-1"
      aria-modal="true"
      aria-labelledby="confirm-title"
      aria-describedby="confirm-desc"
      onkeydown={trapFocus}
      onclick={(e) => {
        if (e.target === e.currentTarget) cancelConfirm();
      }}
      bind:this={dialogEl}
    >
      <div class="dialog">
        <h2 id="confirm-title">
          {confirmAction === 'clear' ? 'Clear all variables?' : 'Sync variables?'}
        </h2>
        <p id="confirm-desc">
          {#if confirmAction === 'clear'}
            This will delete all build variables and secrets from Cloudflare. You will still need to save in the dashboard. This cannot be undone.
          {:else}
            This will delete all existing build variables and fill in {payload.length}
            {payload.length === 1 ? 'variable' : 'variables'}. You will still need to save in Cloudflare.
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
