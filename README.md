# todo.md

A small local task list that reads and writes a plain `TODO.md` file. You get a web page to look at and
work through your tasks, while the file itself stays readable markdown that you (or an agent like Claude)
can edit directly. The page updates live when the file changes.

- **One TODO.md per project.** Switch between project folders from the sidebar, and add new ones with a
  folder picker that can also create folders.
- **Priority board.** Columns for **Now**, **Next**, **Later** and **Unsorted**, most urgent on the left.
  Drag a card between columns to change its priority.
- **Status.** To do, in progress and done, toggled with one click.
- **Image attachments.** Attach, paste or drop screenshots, then view them full-size and arrow through them.
- **Multi-line tasks.** Line breaks are kept.
- **Areas.** Group tasks under `##` headings.

## Run it

Requires Node 18+.

```sh
git clone https://github.com/Micah-L18/todo.md.git
cd todo.md
npm install
npm start                          # uses ./TODO.md
node server.js ~/code/my-app       # or point it at a project folder or a TODO.md file
node server.js --port 5000         # default port is 4747
```

Then open http://localhost:4747. The server only listens on `127.0.0.1`.

The project you start with is always in the list. Projects you add in the page are remembered in
`~/.todo-md/projects.json`. Adding a project creates `TODO.md` and a `todos/` folder (for images) in it
if they're missing. Removing a project from the list leaves its files alone.

**Import existing** in the sidebar searches a folder (your home folder by default, 5 levels deep) for
`TODO.md` files you already have, and lets you pick which ones to add. It skips hidden folders,
`node_modules`, build output and folders like Library and Music.

## Keyboard

| Key | Action |
| --- | --- |
| `N` | Add a task |
| `⌘/Ctrl + Enter` | Save the task |
| `Esc` | Close the form or the image viewer |
| `←` `→` | Previous / next image of a task in the viewer |

## File format

```markdown
# TODO

- [ ] a task with no area
- [-] something in progress !now

## Checkout page

- [ ] fix the coupon field !next
  It rejects codes with lowercase letters.

  Repro: try "save10".
  ![](todos/fix-the-coupon-field-mw6uk6cp.png)
- [X] done things get crossed out
```

- `- [ ]` to do, `- [-]` in progress, `- [X]` done.
- A trailing `!now`, `!next` or `!later` on the task line sets its priority. Tasks without one are
  Unsorted. Older `!p1` / `!p2` / `!p3` tags are still read as now / next / later.
- `## Heading` starts an area. Tasks above the first `##` have no area.
- Indented lines under a task belong to it, including blank lines followed by more indented text.
- `![](path)` images are resolved relative to the `TODO.md`. Uploaded images are saved in `todos/`.

## For AI agents

While the server runs, it serves a guide written for agents at **http://localhost:4747/llms.txt**. It covers what this
is, your current projects, the TODO.md format, how to work through the list (now → next → later, mark tasks
`doing` / `done`), and every endpoint with a ready-to-run curl command. Tell Claude something like:

> Use my todo-md task list for this project. Read http://localhost:4747/llms.txt to learn the API and the
> TODO.md format, then use it to read, add and update tasks as you work.

The **Endpoints** tab at the bottom of the sidebar shows the same endpoints, with copy buttons and examples
filled in for the selected project. `GET /api/endpoints` returns them as JSON.

## API

Everything the page does goes through a small JSON API, so a script or an agent can use it too. Task
endpoints take the project's TODO.md path as `project`, either in the query string or in the JSON body.
Use the `file` values from `GET /api/projects`. Only registered projects can be read or written.

| Method | Path | Body / query | Does |
| --- | --- | --- | --- |
| `GET` | `/api/projects` | | Lists projects with open/done counts |
| `POST` | `/api/projects` | `{ dir }` | Adds a folder as a project (creates `TODO.md` and `todos/`) |
| `DELETE` | `/api/projects` | `{ project }` | Removes a project from the list (files stay) |
| `GET` | `/api/dirs` | `?path=` | Lists subfolders, for picking a project folder |
| `POST` | `/api/dirs` | `{ parent, name }` | Creates a folder |
| `GET` | `/api/todos` | `?project=` | Parsed tasks: `{ items, areas }` |
| `POST` | `/api/todos` | `{ project, text, area?, priority?, images? }` | Adds a task. `images` are base64 data URLs (png, jpg, gif, webp) |
| `PATCH` | `/api/todos` | `{ project, line, raw, status?, priority? }` | Changes status (`todo`, `doing`, `done`) and/or priority |
| `DELETE` | `/api/todos` | `{ project, line, raw }` | Deletes a task and its indented lines |
| `GET` | `/api/events` | | Server-sent events: `{ file }` whenever a project's TODO.md changes |

`priority` is `"now"`, `"next"`, `"later"` or `"none"` (or `1`, `2`, `3`, `0`). Items from
`GET /api/todos` report it as a number.

`line` and `raw` come from the item returned by `GET /api/todos`. They're used to find the task again even
if the file changed in the meantime. If it can't be found, you get a `409`.

```sh
curl -s localhost:4747/api/projects             # find your project's "file"
P="$HOME/code/my-app/TODO.md"
curl -s -X POST localhost:4747/api/todos -H 'Content-Type: application/json' \
  -d "{\"project\": \"$P\", \"text\": \"write the release notes\", \"priority\": \"now\"}"
```

An agent can also just edit `TODO.md` directly using the format above, and the open page will pick up the change.
