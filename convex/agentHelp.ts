import { httpAction } from "./_generated/server";

/** Public guide for agents (no key needed to read it). Also returned by the MCP tool read_guide. */
// The deployment's own HTTP address (Convex sets CONVEX_SITE_URL) and the app's address (SITE_URL),
// so no deployment name or domain is written into the code.
const API = process.env.CONVEX_SITE_URL ?? "https://<your-deployment>.convex.site";
const APP = process.env.SITE_URL ?? "https://<your-studio>";

export const HELP = `# Switchyards Studio: guide for agents

Switchyards Studio is the design studio's app for a growing network of neighborhood work clubs
(${APP}). A club is a location. A project is a piece of work on one club, or on the whole network.
You can read everything and change anything, including editing, adding and deleting lines of a
project's document. The one thing you can't do is delete a project. Every document edit saves the
previous text as a version first, so nothing is ever lost and any edit can be undone with
restore_version.

The person who uses this app is colour blind. Never name a stage, a status or a mark by its colour
alone — every one of them has a label and a glyph. Write the label.

## How to connect
- As an MCP server: ${API}/mcp (Authorization: Bearer <key>).
- Plain HTTP: the same operations under ${API}/agent/... (see the end).
- Keep the key in your own secret store. Never ask for, look for, or print one.

## What a club has
A location: name, neighborhood, city, address, status, the day it opened (or is due to), square feet,
seats, and free-form notes (landlord, GC, lease dates — whatever is worth keeping on the club itself).
Its page lists its projects and its reviews.
Club statuses, in order of life: prospect (○) | signed (◐) | design (◑) | construction (◆) | open (●) |
closed (◌).
list_clubs, get_club {club} (its projects and reviews too), create_club, update_club. "club" anywhere
is a club's id or its name: an exact name first, then a single partial match. Two matches is an error
naming both, never a guess.

## What a project has (the tabs under the title)
- Title, and the project document: lines, each with a stable key, a type (p text, h1 heading, bullet,
  number, todo, images, board) and text. A board line shows an Excalidraw board right in the document:
  its text is the board id, and get_project adds "board" with the board's title, link and full summary
  (see "Excalidraw boards").
  Lines can hold links: write [the words](https://example.com) to link words, or paste a bare https:// URL.
  They show as real links in the app (just "the words", underlined). **Bold** is written with double asterisks.
  Each line can have a text color (textColor: gray, red, orange, green, blue, purple) and a background color
  (color: yellow, blue, green, red, rose; red shows as purple and rose shows as red). Set them in
  edit_lines / replace_document; get_project shows them. Colour is decoration — never put meaning only there.
- Tasks: the punch list. To-dos on the project, each with a key, text and checked.
- Details: type (physical | digital), stage (see the pipelines below), club (null = network-wide work),
  targetDate (YYYY-MM-DD or null — the open date for a build-out, the ship date for digital work).
- Brief: free text — scope, constraints, what done looks like — plus a list of links (lease, drawing set,
  permit set, vendor quote, Figma, email and Slack threads). Internal: not shown on share links.
- Log: a running record of what happened, newest first. Each entry has a title, details, a link to where it
  came from (email, Slack, doc), a source and a date. Internal: not shown on share links.
- Reviews: the sets of visuals filed against this project (see "Reviews" below).
- Comments: on the whole project or on one line. Agent comments show an "Agent" badge.
  Files attached to comments (renders, photos, cutsheets) come with direct download URLs in get_project
  (comments[].files[].url).
  To hand the whole thing to a GC, a fabricator or a vendor: GET <shareUrl>/agent for the project, its
  comments and every file (JSON; ?format=md for Markdown), or run:
  curl -fsSL '<shareUrl>/agent?format=sh' | sh   to download every file into ./assets (no sign-in needed).
  Links in comments show as preview cards. Agents can attach files to comments too, including files from
  their own computer (see "Files in comments").

## The two pipelines
A project's type decides which stages are legal. The two lists share no value, so a stage names its own
pipeline. Passing a stage from the wrong pipeline is an error that tells you the legal ones.

physical — a build-out:
  concept (○) → spacePlan (◐) → ffe (◑, the FF&E spec) → ordered (◗) → install (◆) → punch (◇) → open (●)
digital — brand, signage artwork, web, a campaign:
  briefing (○, the brief) → design (◐) → review (◑) → approved (◆) → shipped (●)

Changing a project's type moves it to the new pipeline's first stage, unless the same update_project call
says which stage it lands in.

## Reviews
A review is a set of visuals — renders, floor plans, elevations, mockups, finish boards — carried through
numbered rounds until it's signed off. It belongs to a project and/or a club.
- Each round (v1, v2, v3 … no limit) holds one or more sheets, in order. A plan set is several; a render is
  one. Only images and PDFs are accepted: anything else has nothing to pin a mark to.
- A mark is feedback pinned to one sheet of one round, at a point (x, y) or over an area (rects). x and y are
  fractions of the sheet, 0-1 from its top left, so a mark stays where it was put at any zoom or paper size:
  x 0.5, y 0.25 is halfway across and a quarter down. page is the page within a PDF sheet (1 for an image).
- A mark has a kind, which reads without colour: fix (✕, must fix) | question (?) | note (•) | approve (✓).
- A review has its own status: inReview (◐) | changesRequested (◇) | approved (●) | archived (◌, dropped).
  It is never the project's stage, and posting a round never moves a project backwards.
How a cycle goes:
1. start_review {title, files:[{url | storageId | base64}], project?, club?, note?} → v1.
2. Someone marks up the sheets and asks for changes (status changesRequested).
3. list_reviews {changesRequested:true} shows what's waiting. get_review {review} gives every round and mark;
   toDo is the marks still open on the latest round, in reading order down each sheet. Make those changes.
4. add_review_round {review, files, note:"what changed"} → v2, v3, … That clears the request and resolves the
   previous round's marks (resolveMarks false keeps them open).
5. approve_review {review} when it's signed off. resolve_mark {mark} ticks off a single mark.
- Archived sets say in their marks why they were dropped. Read them (list_reviews {status:"archived"}, then
  get_review) before redoing work someone already rejected.
- Mark, change status or approve only when asked.
For big files: get_upload_url, POST the raw bytes there, then pass {storageId}.

## Reference board
The studio's board of saved references: product and furniture links, images, posts, any web page, or a plain
note. The card type is worked out from the link. Save one with add_references, or import many at once (up to
200 per call); links already saved aren't duplicated. Write a short note on each saying what it is and why
it's worth keeping. Use list_references to search what's there.

## Todo list
The team's one shared Todo list: a checklist (with sub-items) at the top of the sidebar and of Home, for
everyone. Everyone who has signed up is on the team and can be assigned items. get_todo reads it: its id,
every item with its key, text, checked (done), indent (0 = top level, 1-4 = sub-item levels) and assignee,
its comments, and the team.
add_todo {items:[{text, indent?, assignee?}], under?} adds to-dos at the end, or as sub-items under one
(under = its key). update_todo_item {key, checked?, assignee?, text?} marks one done / not done, assigns it
(name or email; null = nobody) or rewords it. To reorder, nest or remove items use edit_lines with
project = the Todo's id. Comment on an item with comment_on_project {project: todo id, blockKey: its key,
text, attachments?}. Only add, change or remove items when asked.
Mention a project in an item (it shows as a pill that opens the project) by writing
[@Project title](${APP}/p/<project id>) in the text; list_projects gives the ids.

## PDFs
Drawing sets, permit sets, vendor cutsheets and papers to read, mark up and talk about (Apps > PDFs; links
look like /pdf/<id>). People read them there, highlight words, comment, and leave notes on a spot or a page
(typed or voice, with a transcript). list_pdfs, get_pdf {pdf} (details, notes page by page, and fileUrl to
read the PDF itself), add_pdf {url | storageId | base64, title, authors, about}, update_pdf,
add_pdf_note {pdf, page, text, quote?}.
Adding one: find the actual PDF, not the page it sits on. Always set the real title, the firm or vendor as
authors, and about: one or two plain sentences on what it is and why it matters. If something has no PDF,
say so rather than saving a web page.

## Studio notes
Internal docs and personal entries. They're the same kind of document as projects (same editor, lines,
comments, versions) but kept out of the project views and have no type, stage or other details.
list_notes to find one, get_project {project: id} to read it, edit_lines / replace_document to change it,
create_note {title, lines?} to add one (only when asked). list_projects never includes them.

## Scratchboard
Hand-drawn sketches in the studio's own style, drawn by its own engine (not Excalidraw): warm paper,
hand-inked lines with a slow waver and pencil grain, colored-pencil hatching, Archivo 800/900 headings and
big numbers, Architects Daughter handwritten notes, blue JetBrains Mono labels. Links look like /sb/<id>.
list_scratchboards, get_scratchboard {board}, create_scratchboard {title, items?}, add_to_scratchboard
{board, items}, edit_scratchboard {board, ops, title?}. Every item has an id (get_scratchboard shows them;
add_to_scratchboard returns the new ones). To fix a draft, edit it in place instead of adding again:
update {id, set:{text:"…", x:…}} (any field; null removes it), move {id, dx, dy}, scale {id, scale:1.5},
delete {id}, front/back {id}; each takes id or ids:[…]. Only change what you drew or were asked to change.
Items (coordinates in px; a sheet is usually ~1080 wide), drawn in order:
  {"kind":"text","style":"head","text":"Front of house","x":540,"y":120,"align":"center"}   heading (uppercase)
  {"kind":"text","style":"big","text":"72","x":540,"y":420,"size":260,"align":"center","fill":{"color":"#E2774F"}}
  {"kind":"text","style":"note","text":"long table here","x":700,"y":600}        handwritten aside
  {"kind":"text","style":"label","text":"3'-6\\" clear","x":200,"y":700,"color":"#5B8FC7"}
  {"kind":"rect","x":100,"y":200,"width":300,"h":180,"r":22,"fill":{"color":"#4F8DD6"}}   (r 0 = sharp corners)
  {"kind":"ellipse","cx":250,"cy":840,"rx":56,"ry":56,"fill":{"color":"#7FA752"}}
  {"kind":"poly","pts":[[70,130],[1010,130],[840,1000],[240,1000]],"fill":{"color":"#E2774F","tint":true}}
  {"kind":"pen","pts":[[70,260],[220,150],[420,360],[650,230]]}   free curve through points
  {"kind":"arrow","a":[880,1085],"b":[790,640],"bend":0.3}
  {"kind":"line","a":[60,380],"b":[660,380],"dashed":true,"color":"#9B6FC9"}
  {"kind":"badge","cx":90,"cy":100,"r":44,"text":"1","fill":{"color":"#4F8DD6"}}
  {"kind":"tick","x":610,"y":190}
  {"kind":"image","x":600,"y":200,"width":360,"h":240,"url":"https://…/photo.jpg"}   picture (keep its aspect ratio)
  {"kind":"rect","id":"b1","x":100,"y":200,"width":300,"h":140} then {"kind":"text","style":"note","text":"Lobby","bind":"b1"}
    text written inside a shape (rect, diamond or ellipse): give the shape an id and the text bind = that id
Palette: ink #2B2B2C, graphite #6B6A66, blue labels #5B8FC7, coral #E2774F, blue #4F8DD6, violet #9B6FC9,
pink #C96FA6, tan #C28F55, green #7FA752, red #E24B3F, grey #8E8B84, highlighter #F6D36B. Style rules: ink
outline first, color underneath; no boxes around groups (group with space and headings); one light tint per
region (fill.tint true) plus one or two solid accents.

## Excalidraw boards
The studio's whiteboards: space plans, bubble diagrams, adjacency studies, furniture layouts (links look
like /b/<id>). list_boards to find one, get_board to read it: a summary (all text top to bottom, labelled
shapes, arrows "A → B", links), its style, and items (everything on it with ids). Agents can draw too:
- create_board {title, items?} makes a board (and draws on it).
- add_to_board {board, items} adds to a board and never removes or moves what's there.
- edit_board {board, ops} changes existing things by id: setText, setColor, move, delete.
Items are simple; the server makes the real Excalidraw shapes and lays them out:
  {"type":"text","text":"Ground floor","size":"xl"}              heading (size s/m/l/xl)
  {"type":"shape","id":"a","label":"Lobby","shape":"rectangle"}  labelled box (rectangle/ellipse/diamond)
  {"type":"sticky","text":"Daylight on this wall all afternoon"} sticky note (yellow unless color is set)
  {"type":"arrow","from":"a","to":"b","label":"through"}         arrow between new items (your ids) or
                                                                 existing things (element id, or their label)
  {"type":"image","url":"https://…/plan.jpg","width":320}        picture
How to draw boards that fit the ones already there:
1. Always get_board first. Its style says how the board is drawn (stroke and fill colors, fill style,
   roughness, corners, font, text and heading sizes, usual box size, spacing, direction). add_to_board
   copies all of it by default, so leave color and size out unless you mean to differ. Reuse the board's own
   fill colors for meaning (the same color for the same kind of thing) and label the thing as well.
2. New content goes beside what's there, in the board's direction (to the right for left-to-right boards,
   below for top-to-bottom). Put one group per call: a heading text first, then its boxes and arrows.
3. Keep labels short (2-6 words); details go in stickies or a text under the box. One idea per box.
4. Flows: give every box an id and connect them with arrows; layout auto draws them as a flowchart. Use
   diamond for decisions, ellipse for start/end, dashed arrows for "maybe".
5. Brainstorms: stickies (they go in a grid). Lists: text items in a column.
6. To change existing things use edit_board with ids from get_board items; don't redraw them.
7. A new board that should look like another one: create_board with styleFrom set to that board's id. For
   layouts the auto layout can't do (panels with notes inside), give items x/y (relative to the group's
   start) and width/height.
Boards can sit inside a project document as a board line, either the whole board or one frame of it
(text "<board id>#frame=<frame id>"; frame ids are the items with kind frame in get_board). get_project
already includes each one's summary. To put a board in a document, add a line
{"type":"board","text":"<board id or /b/<id> link>"} with edit_lines or replace_document.

## Rules
1. You can't delete a project. Everything else is yours to change.
2. Edit a project's document directly with edit_lines (small changes) or replace_document (big rewrites).
   The previous text is saved automatically under Versions, with your name, so people can see and restore it.
3. Always read the project (get_project) first and work from its current lines and keys.
   Comments are never lost by an edit. To keep a comment on a line, keep (or replace) that line rather than
   deleting it and adding a new one. If you do rewrite lines, comments follow to the new line that reads most
   like the old one; any left over show on the whole project (get_project marks them onRemovedLine), so move
   them to the right line with move_comment. Earlier versions keep where every comment was, and restoring a
   version puts comments back on their old lines.
4. Keep each edit focused on what the user asked; don't rewrite parts they didn't ask about.
5. A stage belongs to one pipeline. Check the project's type before setting a stage.
6. A review's status is its own. Never move a project's stage because a review changed.
7. Whenever you learn something new about a project (a site visit, an approval, a date moving),
   log it with add_project_update, with a link to where it came from.
8. Don't create projects or clubs in bulk unless asked.
9. Say the label, not the colour: "Must fix", "Install", "Changes requested".
10. After changing something, tell the user what you changed. They can undo any document edit from Versions.

## Tools ("project" is always a project's id or its share link; "club" an id or a name; "review" an id, a
link or an exact title)
| Tool | What it does |
|---|---|
| read_guide | This guide |
| list_clubs {} | Every club with its status, details and project counts |
| get_club {club} | One club: details, its projects, its reviews |
| create_club {name, neighborhood?, city?, address?, status?, openedAt?, squareFeet?, seats?, notes?} | Add a club |
| update_club {club, …same fields} | Change a club's details |
| list_projects {query?, club?, type?} | Projects, newest activity first, with type, stage, club, target date |
| get_project {project} | Everything above: details, lines, tasks, brief, reviews, log, comments |
| edit_lines {project, ops, agentName?} | Edit the document line by line: replace / insert / delete / move |
| replace_document {project, lines, agentName?} | Rewrite the whole document |
| list_versions {project} | Earlier versions of the document |
| restore_version {project, versionId} | Bring an earlier version back |
| suggest_project_edit {project, agentName?, lines} | Only if the user wants to approve changes first |
| comment_on_project {project, text, agentName?, blockKey?, lineContains?, shared?, attachments?} | Comment on the project or a line, with images, PDFs or any files. Internal unless shared: true |
| attach_files {comment, attachments} | Add files to an existing comment |
| get_upload_url {} | One-time URL to upload a file from your computer (any size) |
| move_comment {project, commentId, toKey? or lineContains?} | Put any comment on another line (or the whole project) |
| update_comment {project, commentId, text} | Rewrite a comment an agent wrote |
| delete_comment {project, commentId} | Delete a comment an agent wrote |
| add_project_tasks {project, items} | Add tasks to the punch list |
| update_project_task {project, key, text?, checked?} | Edit a task or tick it off |
| delete_project_task {project, key} | Remove a task |
| update_project {project, title?, targetDate?, type?, stage?, club?} | Change details |
| set_brief {project, text, mode?} | Append to the brief (default) or replace it (mode "replace") |
| add_brief_links {project, links:[{label,url}]} | Attach the lease, drawings, quotes, threads to the brief |
| remove_brief_links {project, urls} | Remove brief links |
| add_project_update {project, title, details?, link?, source?, date?, urgent?} | Log what happened (urgent: needs a response now, pinned to the top of the Log) |
| pin_project {project, pinned?} | Pin a project to the sidebar and the top of the views (pinned false unpins) |
| list_reviews {status?, changesRequested?, project?, club?} | Reviews: status, latest round, open marks |
| get_review {review} | One review: every round (sheet URLs, note) and mark; toDo = open marks on the latest |
| start_review {title, files, note?, project?, club?, agentName?} | Start a review with v1 |
| add_review_round {review, files, note?, agentName?, resolveMarks?} | Post the next round (v2, v3, …) |
| mark_review {review, text, roundNumber?, fileIndex?, page?, x?, y?, rects?, quote?, markKind?, attachments?} | Pin a mark to a sheet |
| resolve_mark {mark, resolved?} | Tick one mark off, or re-open it |
| set_review_status {review, status, note?} | inReview / changesRequested / approved / archived |
| approve_review {review, agentName?} | Sign a review off |
| add_references {references:[{url?, note?, date?}]} | Save references to the reference board (bulk import OK) |
| list_references {query?, limit?} | Search the reference board |
| get_todo {} | The team's Todo list: id, lines (key, text, indent), comments and the team |
| add_todo {items:[{text, indent?, assignee?}], under?, agentName?} | Add to-dos (under = an item's key, for sub-items) |
| update_todo_item {key, checked?, assignee?, text?} | Tick / untick, assign or reword a to-do |
| list_pdfs {query?} | PDFs app: drawing sets, cutsheets, papers |
| get_pdf {pdf} | One PDF: details, fileUrl, highlights and notes by page |
| add_pdf {url or storageId or base64, title, authors?, about?} | Save a PDF |
| update_pdf {pdf, title?, authors?, about?} | Change a PDF's details |
| add_pdf_note {pdf, page, text, quote?} | Note on a page of a PDF |
| list_notes {query?} | Studio notes (internal docs) |
| create_note {title, lines?, agentName?} | New studio note |
| list_scratchboards {query?} | Scratchboards (the studio's drawing-board style) |
| get_scratchboard {board} | Read a scratchboard's summary and items |
| create_scratchboard {title, items?} | New scratchboard |
| add_to_scratchboard {board, items} | Draw on a scratchboard |
| edit_scratchboard {board, ops, title?} | Change items already drawn |
| list_boards {query?} | List / search Excalidraw boards (pinned: shown in the sidebar) |
| get_board {board, includeElements?} | Read a board: summary, style and items (with ids) |
| create_board {title, items?, layout?, direction?} | New board, optionally drawn on |
| add_to_board {board, items, layout?, direction?, placement?} | Draw on a board in its style (never removes anything) |
| edit_board {board, ops?, title?} | Change existing things by id: setText, setColor, move, delete |
| pin_board {board, pinned?} | Pin a board to the sidebar (pinned false unpins) |
| create_project {title, type?, stage?, club?, targetDate?, lines?, tasks?, brief?, updates?} | New project |

### edit_lines
Line keys come from get_project. ops run in order as one change:
  {"op":"replace","key":"<key>","text":"New text"}              change a line (text and/or type)
  {"op":"insert","afterKey":"<key>","lines":[{"text":"..."}]}  add lines after a line (afterKey null = at the top)
  {"op":"delete","key":"<key>"}                                remove a line
  {"op":"move","key":"<key>","afterKey":"<key>"}               move a line
The result lists the new lines and keys. Line types: p (text), h1 (heading), bullet, number, todo, board
(text = board id).

### replace_document
"lines" is the WHOLE document as you want it, in order. Keep a line's key to keep that line (its comments
stay on it). Leave out key for new lines. Lines you leave out are deleted.

### Files in comments
"attachments" (on comment_on_project and attach_files) is a list; each item is ONE of:
- {"url": "https://..."}: a link. Image/video URLs show as media. Nothing is copied.
- {"base64": "...", "name": "render.png"}: the file's bytes (raw base64 or a data: URL), stored here. Under 20 MB.
- {"storageId": "...", "name": "render.png"}: a file you uploaded. Best for files on your computer, any size:
    1. get_upload_url {}                                  -> {"uploadUrl": "..."}
    2. curl -s -X POST -H "Content-Type: image/png" --data-binary @render.png "<uploadUrl>"   -> {"storageId": "..."}
    3. comment_on_project / attach_files with attachments [{"storageId": "...", "name": "render.png"}]
"mime" is optional everywhere (guessed from the name). Up to 20 files per call. Stored files show in the app
like files people drop in: images and videos play inline, anything else is a download.
Review sheets (start_review, add_review_round) take the same three shapes, but only images and PDFs.
With plain HTTP there's also a one-step upload (under 20 MB), see the end.

## Examples
Start a build-out on a club:
  create_project {"title":"<project title>","type":"physical","stage":"concept","club":"<club name>",
                  "targetDate":"2026-06-01","brief":"Scope: … Constraints: … Done looks like: …"}
Move a digital project on once the artwork is signed off:
  update_project {"project":"<id>","stage":"approved"}
Log a site visit:
  add_project_update {"project":"<id>","title":"Site visit: slab poured","source":"Site visit",
                      "date":"2026-02-11","details":"Two inches low at the east wall; GC to grind."}
Add punch-list tasks:
  add_project_tasks {"project":"<id>","items":["Swap the pendant over the long table","Re-key the back door"]}
Tick one off (key from get_project's tasks):
  update_project_task {"project":"<id>","key":"<key>","checked":true}
Put a plan set up for review:
  start_review {"title":"<set name> v1","project":"<id>","files":[{"storageId":"<id>","name":"floor-plan.pdf"}],
                "note":"Floor plan, RCP and furniture plan."}
Mark something to fix, a third of the way across and two thirds down sheet 1:
  mark_review {"review":"<id>","fileIndex":0,"x":0.33,"y":0.66,"markKind":"fix",
               "text":"This run is 2 inches short of the clear width."}
Post the answer to those marks:
  add_review_round {"review":"<id>","files":[{"storageId":"<id>","name":"floor-plan-v2.pdf"}],
                    "note":"Widened the run; moved the bench back 4 inches."}
Tighten the second line of a document and add a line after it:
  p = get_project {"project":"<id>"}
  edit_lines {"project":"<id>","agentName":"Claude","ops":[
    {"op":"replace","key":p.lines[1].key,"text":"A tighter second line."},
    {"op":"insert","afterKey":p.lines[1].key,"lines":[{"text":"A brand new third line."}]}]}
Comment on a line with an image:
  comment_on_project {"project":"<id>","lineContains":"storefront","text":"This is the profile I mean",
                      "attachments":[{"url":"https://example.com/profile.png"}]}
Put a photo from your computer on a line:
  get_upload_url {}  ->  curl -s -X POST -H "Content-Type: image/png" --data-binary @site.png "<uploadUrl>"  ->  {"storageId":"kg2..."}
  comment_on_project {"project":"<id>","lineContains":"east wall","text":"As built",
                      "attachments":[{"storageId":"kg2...","name":"site.png"}]}
Add another file to that comment later:
  attach_files {"comment":"<comment id>","attachments":[{"storageId":"kg3...","name":"cutsheet.pdf"}]}

## Plain HTTP (header Authorization: Bearer <key>, from your own secret store; never put a key in a prompt or skill)
GET  /agent/help                        this guide (no key needed)
GET  /agent/clubs                       list_clubs
GET  /agent/club?club=<id or name>      get_club
POST /agent/clubs                       create_club
POST /agent/club                        update_club
GET  /agent/projects?q=&club=&type=     list_projects
GET  /agent/project?project=<id>        get_project
POST /agent/projects                    create_project
POST /agent/project/update              update_project
POST /agent/edit-lines                  edit_lines
POST /agent/replace                     replace_document
GET  /agent/versions?project=<id>       list_versions
POST /agent/restore                     restore_version
POST /agent/suggest                     suggest_project_edit
POST /agent/tasks                       add_project_tasks
POST /agent/task                        update_project_task
POST /agent/task/delete                 delete_project_task
POST /agent/brief                       set_brief
POST /agent/brief-links                 add_brief_links
POST /agent/brief-links/delete          remove_brief_links
POST /agent/update                      add_project_update
POST /agent/pin                         pin_project
POST /agent/comment                     comment_on_project
POST /agent/comment/attach              attach_files
POST /agent/comment/move                move_comment
POST /agent/comment/update              update_comment
POST /agent/comment/delete              delete_comment
GET  /agent/reviews?status=&requested=1&project=&club=   list_reviews
GET  /agent/review?review=<id>          get_review
POST /agent/reviews                     start_review
POST /agent/review/round                add_review_round
POST /agent/review/mark                 mark_review
POST /agent/review/mark/resolve         resolve_mark
POST /agent/review/status               set_review_status
POST /agent/review/approve              approve_review
GET  /agent/boards?q=...                list_boards
GET  /agent/board?board=<id>&elements=1 get_board
POST /agent/board/create                create_board
POST /agent/board/add                   add_to_board
POST /agent/board/edit                  edit_board
POST /agent/board/pin                   pin_board
POST /agent/references                  add_references
GET  /agent/references?q=...            list_references
POST /agent/upload-url                  get_upload_url
POST /agent/file?project=<id>&lineContains=...&text=...&name=site.png   (or ?comment=<id>)
     One step: the body is the raw file (Content-Type = its type, under 20 MB); posts the comment with it attached.
     curl -s -X POST -H "Authorization: Bearer $KEY" -H "Content-Type: image/png" --data-binary @site.png \\
       "${API}/agent/file?project=<id>&lineContains=east%20wall&text=As%20built&name=site.png"
Bodies are the same JSON as the tool arguments. Errors come back as {"error": "..."} with a 4xx status.
Fix the input; don't retry the same call in a loop.
`;

export const help = httpAction(async () => new Response(HELP, { headers: { "content-type": "text/markdown; charset=utf-8" } }));
