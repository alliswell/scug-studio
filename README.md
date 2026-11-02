# Switchyards Studio

The design studio's project tool: clubs, the work going into them, and review rounds on the visuals.
Built with Next.js and Convex.

Switchyards is a network of neighborhood work clubs. This app holds the design side of it — club
concept, space planning, furniture layout, build-out oversight and brand consistency — in one place,
with an agent API so the same work can be driven from Claude.

## The shape of it

```
Club  ──<  Project  ──<  Review  ──<  Round (v1, v2, v3…)  ──<  Mark (pinned to a spot on a sheet)
                   └──<  Document ──< Block        the editor
                   └──<  Comment                   on a line, or the whole project
                   └──<  Update                    the Log tab
```

A **club** is a location, and it is first class: a club page lists its projects, its reviews and its
details. A **project** is a piece of work, either a physical build-out or digital work, and it belongs
to a club or to the network.

## Two pipelines

A project's type decides its stages. The two sets share no values, so a stage always says which
pipeline it belongs to.

```
Physical   ○ Concept   ◐ Space plan   ◑ FF&E spec   ◗ Ordered   ◆ Install   ◇ Punch   ● Open
Digital    ○ Brief     ◐ Design       ◑ Review      ◆ Approved  ● Shipped
```

Every stage, club status, review status and mark kind carries a glyph as well as a color. Color is
never the only thing telling you what something is — on the board, in the lists, on a marked-up plan.
That is deliberate; keep it that way when adding anything new. The glyphs and hex values live in
`src/lib/types.ts`.

## Features

- **Projects**: sortable, filterable list with Board, Calendar, List and Log views. Edit title, stage,
  type, club and target date in place. The board shows one pipeline at a time and cards stay where you
  drag them.
- **Clubs**: every location with its status, size, opening date and the work in flight there.
- **Editor**: blocks (text, heading, lists, to-dos), `/` menu for types and colors, links, bold, drag to
  reorder. Tabs per project type — Brief, the main document, Visuals, a punch list or checklist, and a
  Log. Versions with diff review and restore.
- **Review rounds**: upload renders, floor plans, elevations or mockups as v1, pin comments to a point
  or a region on a sheet, request changes, upload v2, approve. A round holds a whole sheet set, and
  PDFs and images both work.
- **Comments**: on any line or the whole project, with photos, files and link previews; comments follow
  their line through edits.
- **Share links**: unguessable `/s/…` links show one project; an optional passcode lets a vendor or GC
  comment or suggest an edited version. `/s/…/agent` gives an agent the project, its comments and a
  download link for every attached file.
- **References**: an inspiration board (images, product links, notes) with search and bookmarks.
- **Library**: every file pasted into a comment, searchable by the line it was attached to.
- **Drawings**: Excalidraw boards for space plans and adjacency studies, and a hand-drawn Scratchboard.
- **PDFs**: drawing sets, permit sets and cutsheets, with highlights, pinned notes and voice notes.
- **Agent API**: an MCP server at `/mcp` and HTTP routes under `/agent` (bearer key) for reading and
  changing clubs, projects, reviews and everything else.
- Light and dark themes.

## Setup

1. `npm install`
2. `npx convex dev` (creates a Convex deployment and writes `.env.local`)
3. Set the environment variables below on the Convex deployment (`npx convex env set NAME value`).
4. `npm run dev`

| Variable | What it's for |
| --- | --- |
| `TEAM_CODE` | Team password needed to create an account. Without it, sign-up is closed. |
| `SITE_URL` | Public URL of the site (used in links the agent API returns). |
| `AGENT_API_KEY`, `AGENT_API_KEYS` | Bearer key(s) for the agent API and MCP server (extra keys comma-separated). |
| `JWT_PRIVATE_KEY`, `JWKS` | Auth keys, set up by `npx @convex-dev/auth`. |
| `ELEVENLABS_API_KEY` / `DEEPGRAM_API_KEY` / `OPENAI_API_KEY` | Any one of these transcribes voice notes on PDFs. Optional. |

Never commit `.env*` files; they are git-ignored.

## Rectangle background gradients

Select a rectangle on a board, then choose **Background → Gradient** in its existing style panel (Style
on phones). Edit the two color swatches or six-digit hex colors, and choose a direction. Direction
follows the rectangle when rotated. **Solid**, a normal background color, or a fill pattern switches
back to the usual fill; undo restores the gradient. Mixed selections apply gradients only to
rectangles. Blur temporarily takes precedence and restores the gradient when turned off.

Gradients render inside the canvas in normal layer order, including rounded/rough edges and opacity.
Board/frame SVG previews and Excalidraw's SVG/PNG exports use the same fill. Gradient metadata lives in
element `customData`, so board saves, scene files, copies, duplicates and history retain it. Unmodified
Excalidraw clients show the start color as a solid fallback. Only two-color linear rectangle backgrounds
are supported; patterned gradient fills, radial gradients and other shape types are outside this feature.

Excalidraw 0.18.1 has no custom-fill renderer API. `npm ci` applies a small renderer/action patch from
`scripts/patch-excalidraw-gradients.mjs` to its development and production bundles. The dependency is
pinned and bundle hashes are checked before writing; upgrades require reviewing this patch. Run
`npm run test:gradients` for focused regression tests. `npm run preview:gradients` opens a backend-free
localhost fixture at `http://127.0.0.1:3211`, using localStorage only; add `-- --production` to verify
production renderer bundles. Preview artifacts are ignored under `output/playwright/`.
