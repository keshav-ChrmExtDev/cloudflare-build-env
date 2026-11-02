# Build env

A Chrome extension for replacing the build variables and secrets on a Cloudflare Worker from a
pasted `.env` file.

## Use it

1. Open your Worker in the Cloudflare dashboard and go to **Settings → Build**.
2. Open the extension on that tab. **Sync** is enabled once it finds the card.
3. Click any cell and paste — a whole `.env`, or columns copied from a spreadsheet, fills rows from
   that cell down. Typing in a cell works the same as any spreadsheet; the last row is always blank.
4. **Sync** deletes every build variable in the **Variables and secrets** card, adds the rows in the
   extension, and clicks Save. **Clear all** only deletes.

Rows with no name are ignored. A pasted name that already exists in the table is kept as a second
row. New names default to Secret; public prefixes (`VITE_`, `PUBLIC_`, `NEXT_PUBLIC_`,
`NUXT_PUBLIC_`, `REACT_APP_`, `EXPO_PUBLIC_`, `GATSBY_`) default to Variable.

The popup matches any `dash.cloudflare.com` tab and finds the build card by its markup, so no
account or worker id is baked into the manifest.

## Notes

- State is kept in `browser.storage.local` so closing the popup does not lose it. It is not encrypted.
- The content script only acts on the Workers Builds card, identified by
  `KumoBuildVariableEditorRow` / `WorkersBuildVariablesTable.tsx` markers. It refuses to act on the
  runtime variables card, which has a similar title.
- Cloudflare's dashboard markup is not a public API. If the Build settings page changes, update the
  selectors in `src/entrypoints/content.ts` and the Save-button labels.
- Sync is destructive. If it fails midway, the card can be left empty; the popup reports what
  happened but cannot roll back.

## Develop

```sh
bun install
bun run dev        # load .output/chrome-mv3 as an unpacked extension
bun run test       # parser and validation checks
bun run check      # svelte-check
bun run build
```
