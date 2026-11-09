#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

// ---------- args ----------
const args = process.argv.slice(2);
let port = Number(process.env.PORT) || 4747;
let target = null;
for (let i = 0; i < args.length; i++) {
  const a = args[i];
  if (a === '-p' || a === '--port') port = Number(args[++i]);
  else if (a === '-h' || a === '--help') {
    console.log('usage: todo-md [path/to/TODO.md | project-dir] [--port 4747]');
    console.log('Projects you add in the page are remembered in ~/.todo-md/projects.json');
    process.exit(0);
  } else target = a;
}

const home = os.homedir();
const tilde = (p) => (p === home || p.startsWith(home + path.sep) ? '~' + p.slice(home.length) : p);
const untilde = (p) => p.replace(/^~(?=$|[\\/])/, home);

// The TODO.md named on the command line (default: ./TODO.md) — the page opens it first.
let start = path.resolve(untilde(target || 'TODO.md'));
try { if (fs.statSync(start).isDirectory()) start = findTodo(start); } catch {}

// The TODO.md in a folder, matching an existing todo.md / Todo.md if there is one.
function findTodo(dir) {
  try {
    const hit = fs.readdirSync(dir).find((n) => n.toLowerCase() === 'todo.md' && fs.statSync(path.join(dir, n)).isFile());
    if (hit) return path.join(dir, hit);
  } catch {}
  return path.join(dir, 'TODO.md');
}
// One spelling per file, so the same TODO.md can't be added twice (case, symlinks, /tmp vs /private/tmp).
function canon(file) {
  try { return fs.realpathSync.native(file); } catch {}
  try { return path.join(fs.realpathSync.native(path.dirname(file)), path.basename(file)); } catch {}
  return file;
}

function httpError(status, message) {
  return Object.assign(new Error(message), { status });
}

// ---------- markdown ----------
// - [ ] to do   - [-] in progress   - [X] done
// Optional trailing priority tag: " !now" / " !next" / " !later" (old " !p1".. " !p3" still read).
// Items are grouped under "## Area" headings. Indented lines under an item belong to it
// (blank lines are allowed inside an item as long as an indented line follows).
const ITEM = /^[-*] \[([ xX-])\](?: (.*))?$/;
const AREA = /^##\s+(.*?)\s*#*\s*$/;
const H1 = /^#\s/;
const SECTION_BREAK = /^#{1,2}\s/;
const CONT = /^(?: {2,}|\t)\S/;
const IMG = /!\[[^\]]*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
const PRI = /(^|\s+)!(now|next|later|p[1-3])\s*$/i;
const PRI_TAG = ['', 'now', 'next', 'later']; // priority number -> tag; 0 = unsorted
const priOf = (tag) => (/^p\d$/i.test(tag) ? Number(tag[1]) : PRI_TAG.indexOf(tag.toLowerCase()));
// API accepts 0-3 or a name: "now", "next", "later", "none"/"" (unsorted).
const priIn = (v) => (typeof v === 'string' && !/^\d$/.test(v.trim()) ? (v.trim() === 'none' ? 0 : PRI_TAG.indexOf(v.trim().toLowerCase())) : Number(v));
const tagOf = (n) => (n ? ` !${PRI_TAG[n]}` : '');
const STATUS = { ' ': 'todo', '-': 'doing', x: 'done', X: 'done' };
const MARK = { todo: ' ', doing: '-', done: 'X' };

const readLines = (file) => fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n').split('\n');
const writeLines = (file, lines) => {
  if (lines[lines.length - 1] !== '') lines.push('');
  fs.writeFileSync(file, lines.join('\n'));
};

function blockEnd(lines, i) {
  let j = i + 1;
  let end = j;
  while (j < lines.length) {
    if (CONT.test(lines[j])) end = ++j;
    else if (lines[j].trim() === '') j++;
    else break;
  }
  return end;
}

function parse(lines) {
  const items = [];
  const areas = [];
  let area = '';
  for (let i = 0; i < lines.length; i++) {
    const h = lines[i].match(AREA);
    if (h) {
      area = h[1];
      if (area && !areas.includes(area)) areas.push(area);
      continue;
    }
    if (H1.test(lines[i])) { area = ''; continue; }
    const m = lines[i].match(ITEM);
    if (!m) continue;

    const end = blockEnd(lines, i);
    const images = [];
    let first = (m[2] || '').replace(IMG, (_, p) => { images.push(p); return ''; }).trim();
    let priority = 0;
    const pm = first.match(PRI);
    if (pm) { priority = priOf(pm[2]); first = first.slice(0, pm.index).trim(); }

    const body = [];
    for (let j = i + 1; j < end; j++) {
      let had = false;
      const t = lines[j]
        .replace(/^(?: {2}|\t)/, '')
        .replace(IMG, (_, p) => { images.push(p); had = true; return ''; })
        .trimEnd();
      if (had && !t.trim()) continue; // a line that only held an image
      body.push(t);
    }
    while (body.length && !body[body.length - 1].trim()) body.pop();
    const text = (first ? [first, ...body] : body).join('\n').replace(/^\s*\n/, '');

    items.push({ line: i, raw: lines[i], status: STATUS[m[1]], priority, text, area, images });
    i = end - 1;
  }
  return { items, areas };
}

// Find an item again after the file may have changed underneath us.
function locate(lines, { line, raw }) {
  if (typeof raw !== 'string') return -1;
  if (lines[line] === raw) return line;
  return lines.indexOf(raw);
}

function insertItem(lines, area, block) {
  let start;
  if (area) {
    start = lines.findIndex((l) => {
      const h = l.match(AREA);
      return h && h[1].toLowerCase() === area.toLowerCase();
    });
    if (start === -1) {
      while (lines.length && lines[lines.length - 1].trim() === '') lines.pop();
      lines.push('', `## ${area}`, '', ...block, '');
      return;
    }
  } else {
    start = lines.findIndex((l) => H1.test(l)); // ungrouped items live under the title
  }

  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (SECTION_BREAK.test(lines[i])) { end = i; break; }
  }

  let last = -1;
  for (let i = start + 1; i < end; i++) {
    if (ITEM.test(lines[i])) { last = blockEnd(lines, i); i = last - 1; }
  }
  if (last !== -1) { lines.splice(last, 0, ...block); return; }

  let at = start + 1;
  while (at < end && lines[at].trim() === '') at++;
  const ins = [...block];
  if (at > 0 && lines[at - 1].trim() !== '') ins.unshift('');
  if (at < lines.length && lines[at].trim() !== '') ins.push('');
  lines.splice(at, 0, ...ins);
}

// Multi-line task text: first line goes on the "- [ ]" line, the rest is indented under it.
function cleanText(s) {
  return String(s || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((l) => l.replace(/\t/g, '  ').trimEnd())
    .join('\n')
    .replace(/^\n+|\n+$/g, '')
    .replace(/^[ ]+/, '');
}

function itemBlock(text, priority, images) {
  const [first, ...rest] = text.split('\n');
  return [
    `- [ ] ${first}${tagOf(priority)}`,
    ...rest.map((l) => (l ? '  ' + l : '')),
    ...images.map((p) => `  ![](${p})`),
  ];
}

// ---------- images ----------
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
const SERVE_EXT = new Set(['.png', '.jpg', '.jpeg', '.gif', '.webp']);

function slug(s) {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'image';
}

function saveImages(file, images, text) {
  if (!Array.isArray(images) || !images.length) return [];
  const decoded = images.map((d) => {
    const m = /^data:([\w/+.-]+);base64,(.+)$/s.exec(String(d || ''));
    if (!m || !EXT[m[1]]) throw httpError(400, 'Only png, jpg, gif and webp images are supported.');
    return { ext: EXT[m[1]], buf: Buffer.from(m[2], 'base64') };
  });
  const baseDir = path.dirname(file);
  const imgDir = path.join(baseDir, 'todos');
  fs.mkdirSync(imgDir, { recursive: true });
  const stamp = Date.now().toString(36);
  return decoded.map(({ ext, buf }, i) => {
    const name = `${slug(text)}-${stamp}${decoded.length > 1 ? '-' + (i + 1) : ''}.${ext}`;
    fs.writeFileSync(path.join(imgDir, name), buf);
    return path.relative(baseDir, path.join(imgDir, name)).split(path.sep).join('/');
  });
}

// ---------- projects ----------
// Each project is a folder with its own TODO.md (and a todos/ folder for images).
const CONFIG_DIR = path.join(home, '.todo-md');
const CONFIG = path.join(CONFIG_DIR, 'projects.json');

let projects = (() => {
  try {
    const j = JSON.parse(fs.readFileSync(CONFIG, 'utf8'));
    const list = Array.isArray(j.projects) ? j.projects.filter((p) => typeof p === 'string') : [];
    return [...new Set(list.map(canon))];
  } catch { return []; }
})();
const saveProjects = () => {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  fs.writeFileSync(CONFIG, JSON.stringify({ projects }, null, 2) + '\n');
};

function ensureProject(file) {
  fs.mkdirSync(path.join(path.dirname(file), 'todos'), { recursive: true });
  if (!fs.existsSync(file)) fs.writeFileSync(file, '# TODO\n');
}

function addProject(file) {
  ensureProject(file);
  file = canon(file);
  if (!projects.includes(file)) { projects.push(file); saveProjects(); }
  watch(file);
  return file;
}

// Resolve and validate the project a request is about. Only registered TODO.md files are touched.
function project(req) {
  const f = String(req.query.project || (req.body && req.body.project) || '');
  if (!projects.includes(f)) throw httpError(404, 'Unknown project.');
  if (!fs.existsSync(path.dirname(f))) throw httpError(404, `Project folder is gone: ${tilde(path.dirname(f))}`);
  ensureProject(f);
  return f;
}

function isDir(p) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}

// ---------- server ----------
const app = express();
app.use(express.json({ limit: '50mb' }));

app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

function projectList() {
  return projects.map((file) => {
    const dir = path.dirname(file);
    const p = { file, dir, name: path.basename(dir), path: tilde(dir), missing: !isDir(dir), open: 0, done: 0 };
    if (!p.missing && fs.existsSync(file)) {
      for (const it of parse(readLines(file)).items) it.status === 'done' ? p.done++ : p.open++;
    }
    return p;
  });
}

app.get('/api/projects', (req, res) => {
  res.json({ start, projects: projectList() });
});

// Add a project: { dir } for a folder (TODO.md created if missing),
// or { files: [...] } to import existing TODO.md files (e.g. from /api/scan).
app.post('/api/projects', (req, res) => {
  if (Array.isArray(req.body.files)) {
    const added = [];
    for (const f of req.body.files) {
      const file = path.resolve(untilde(String(f || '')));
      if (path.basename(file).toLowerCase() !== 'todo.md') throw httpError(400, `Not a TODO.md: ${tilde(file)}`);
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw httpError(400, `File not found: ${tilde(file)}`);
      added.push(addProject(file));
    }
    return res.json({ ok: true, added, file: added[0] });
  }
  const dir = path.resolve(untilde(String(req.body.dir || '').trim()));
  if (!isDir(dir)) throw httpError(400, `Not a folder: ${tilde(dir)}`);
  const file = addProject(findTodo(dir));
  res.json({ ok: true, file });
});

// Find existing TODO.md files under a folder, for importing them as projects.
const SKIP_DIRS = new Set([
  'node_modules', 'vendor', 'dist', 'build', 'out', 'target', 'coverage', 'venv', 'env', '__pycache__',
  'Library', 'Applications', 'Pictures', 'Music', 'Movies', 'Photos', 'Public',
]);
app.get('/api/scan', (req, res) => {
  const q = String(req.query.path || '').trim();
  const root = q ? path.resolve(untilde(q)) : home;
  if (!isDir(root)) throw httpError(400, `Not a folder: ${tilde(root)}`);
  const maxDepth = Math.min(Math.max(Number(req.query.depth) || 5, 1), 8);
  const deadline = Date.now() + 4000;
  const found = [];
  let scanned = 0;
  let truncated = false;
  const queue = [[root, 0]]; // breadth-first, so shallow (likely) projects are found first
  while (queue.length) {
    if (Date.now() > deadline || scanned > 30000 || found.length >= 300) { truncated = true; break; }
    const [dir, depth] = queue.shift();
    let ents;
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    scanned++;
    for (const e of ents) {
      if (e.isFile() && e.name.toLowerCase() === 'todo.md') found.push(path.join(dir, e.name));
      else if (e.isDirectory() && depth < maxDepth && !e.name.startsWith('.') && !SKIP_DIRS.has(e.name)) {
        queue.push([path.join(dir, e.name), depth + 1]);
      }
    }
  }
  const results = found.map((f) => {
    const file = canon(f);
    const dir = path.dirname(file);
    let open = 0;
    let done = 0;
    try { for (const it of parse(readLines(file)).items) it.status === 'done' ? done++ : open++; } catch {}
    return { file, dir, name: path.basename(dir), path: tilde(dir), open, done, known: projects.includes(file) };
  }).sort((a, b) => a.path.localeCompare(b.path));
  res.json({ root, display: tilde(root), depth: maxDepth, scanned, truncated, results });
});

// Forget a project (files on disk are left alone).
app.delete('/api/projects', (req, res) => {
  const f = String(req.body.project || '');
  projects = projects.filter((p) => p !== f);
  saveProjects();
  unwatch(f);
  res.json({ ok: true });
});

// Folder browser for the "Select project location" dialog.
app.get('/api/dirs', (req, res) => {
  const q = String(req.query.path || '').trim();
  const dir = q ? path.resolve(untilde(q)) : home;
  let ents;
  try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { throw httpError(400, `Can't open ${tilde(dir)}`); }
  const dirs = ents
    .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
    .filter((e) => e.isDirectory() || (e.isSymbolicLink() && isDir(path.join(dir, e.name))))
    .map((e) => ({ name: e.name, path: path.join(dir, e.name), hasTodo: fs.existsSync(path.join(dir, e.name, 'TODO.md')) }))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base' }));
  const parent = path.dirname(dir);
  res.json({ path: dir, display: tilde(dir), parent: parent !== dir ? parent : null, hasTodo: fs.existsSync(path.join(dir, 'TODO.md')), dirs });
});

// Create a new folder inside `parent` (used by "New folder" in the picker).
app.post('/api/dirs', (req, res) => {
  const parent = path.resolve(untilde(String(req.body.parent || '').trim() || home));
  const name = String(req.body.name || '').trim();
  if (!name || name === '.' || name === '..' || /[\\/\0]/.test(name)) {
    throw httpError(400, 'Folder names can\'t be empty or contain slashes.');
  }
  if (!isDir(parent)) throw httpError(400, `Not a folder: ${tilde(parent)}`);
  const dir = path.join(parent, name);
  if (fs.existsSync(dir)) throw httpError(409, `${name} already exists here.`);
  try { fs.mkdirSync(dir); } catch (e) { throw httpError(400, `Couldn't create ${name}: ${e.code || e.message}`); }
  res.json({ ok: true, path: dir });
});

app.get('/api/todos', (req, res) => {
  const file = project(req);
  res.json({ file, path: tilde(file), ...parse(readLines(file)) });
});

app.post('/api/todos', (req, res) => {
  const file = project(req);
  const images = req.body.images || [];
  const area = String(req.body.area || '').replace(/\s+/g, ' ').trim().replace(/^#+\s*/, '');
  const priority = [1, 2, 3].includes(priIn(req.body.priority)) ? priIn(req.body.priority) : 0;
  let text = cleanText(req.body.text);
  if (!text && !images.length) throw httpError(400, 'Nothing to add.');
  if (!text) text = 'Screenshot';

  const paths = saveImages(file, images, text.split('\n')[0]);
  const lines = readLines(file);
  insertItem(lines, area, itemBlock(text, priority, paths));
  writeLines(file, lines);
  res.json({ ok: true });
});

// Change status and/or priority of one item.
app.patch('/api/todos', (req, res) => {
  const file = project(req);
  const lines = readLines(file);
  const i = locate(lines, req.body);
  if (i < 0 || !ITEM.test(lines[i])) throw httpError(409, 'That item changed. Reloaded.');
  let l = lines[i];
  if (req.body.status !== undefined) {
    const mark = MARK[req.body.status];
    if (mark === undefined) throw httpError(400, 'Unknown status.');
    l = l.replace(/^([-*] \[)[ xX-]\]/, `$1${mark}]`);
  }
  if (req.body.priority !== undefined) {
    const p = priIn(req.body.priority);
    if (![0, 1, 2, 3].includes(p)) throw httpError(400, 'Unknown priority.');
    l = l.replace(PRI, '').trimEnd();
    l += tagOf(p);
  }
  lines[i] = l;
  writeLines(file, lines);
  res.json({ ok: true });
});

app.delete('/api/todos', (req, res) => {
  const file = project(req);
  const lines = readLines(file);
  const i = locate(lines, req.body);
  if (i < 0 || !ITEM.test(lines[i])) throw httpError(409, 'That item changed. Reloaded.');
  lines.splice(i, blockEnd(lines, i) - i);
  writeLines(file, lines);
  res.json({ ok: true });
});

// ---------- docs for agents ----------
// One list drives both the Endpoints tab in the page and /llms.txt, so they can't drift apart.
// "<file>" is replaced with a real project's TODO.md path.
const ENDPOINTS = [
  { group: 'Projects', method: 'GET', path: '/api/projects',
    desc: 'List projects with open/done counts. Use a project\'s `file` as `project` in the calls below.' },
  { group: 'Projects', method: 'POST', path: '/api/projects', body: { dir: '~/code/my-app' },
    desc: 'Add a folder as a project. Creates TODO.md and todos/ in it if missing. To import existing files instead, send `{ "files": ["/path/to/TODO.md", ...] }`.' },
  { group: 'Projects', method: 'GET', path: '/api/scan?path=~/code',
    desc: 'Find existing TODO.md files under a folder (5 levels deep by default, `&depth=` up to 8). Each result has `file`, `open`, `done` and `known` (already a project).' },
  { group: 'Projects', method: 'DELETE', path: '/api/projects', body: { project: '<file>' },
    desc: 'Remove a project from the list. Its files stay on disk.' },
  { group: 'Tasks', method: 'GET', path: '/api/todos?project=<file>',
    desc: 'All tasks in a project: `{ items, areas }`. Each item has `line`, `raw`, `status`, `priority` (1 now, 2 next, 3 later, 0 unsorted), `text`, `area`, `images`.' },
  { group: 'Tasks', method: 'POST', path: '/api/todos',
    body: { project: '<file>', text: 'Fix the login redirect\nIt loops back to /login after OAuth.', priority: 'next', area: 'Auth' },
    desc: 'Add a task. `priority`: now | next | later | none. `area` (optional) is a ## heading. `images` (optional): base64 data URLs. `\\n` in `text` becomes extra lines.' },
  { group: 'Tasks', method: 'PATCH', path: '/api/todos',
    body: { project: '<file>', line: 4, raw: '- [ ] Fix the login redirect !next', status: 'doing' },
    desc: 'Change `status` (todo | doing | done) and/or `priority`. Copy `line` and `raw` from the item in GET /api/todos. A 409 means the task changed: re-read and retry.' },
  { group: 'Tasks', method: 'DELETE', path: '/api/todos',
    body: { project: '<file>', line: 4, raw: '- [ ] Fix the login redirect !next' },
    desc: 'Delete a task and its indented lines.' },
  { group: 'Folders', method: 'GET', path: '/api/dirs?path=~/code', desc: 'List the subfolders of a folder.' },
  { group: 'Folders', method: 'POST', path: '/api/dirs', body: { parent: '~/code', name: 'new-app' }, desc: 'Create a folder.' },
  { group: 'Live updates', method: 'GET', path: '/api/events',
    desc: 'Server-sent events. Sends `{"file": "..."}` whenever a project\'s TODO.md changes.' },
];

const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;
function endpointDocs(base, file) {
  const fill = (v) => (typeof v === 'string' ? v.replace('<file>', file) : v);
  return ENDPOINTS.map((e) => {
    const p = e.path.replace('<file>', encodeURIComponent(file));
    const body = e.body && Object.fromEntries(Object.entries(e.body).map(([k, v]) => [k, fill(v)]));
    const curl = body
      ? `curl -s -X ${e.method} ${base}${p} \\\n  -H 'Content-Type: application/json' \\\n  -d ${shq(JSON.stringify(body))}`
      : `curl -s${e.path === '/api/events' ? 'N' : ''} ${shq(base + p)}`;
    return { ...e, path: p, body, curl };
  });
}
const baseUrl = (req) => `http://${req.headers.host || `localhost:${port}`}`;
const docProject = (req) => (projects.includes(String(req.query.project)) ? String(req.query.project) : projects.includes(start) ? start : projects[0] || start);

app.get('/api/endpoints', (req, res) => {
  const base = baseUrl(req);
  res.json({ base, guide: `${base}/llms.txt`, project: docProject(req), endpoints: endpointDocs(base, docProject(req)) });
});

// A guide written for AI agents (Claude etc.): what this is, the file format, and how to use the API.
function guide(req) {
  const base = baseUrl(req);
  const list = projectList();
  const eps = endpointDocs(base, docProject(req));
  const L = [];
  L.push('# todo-md', '');
  L.push(`> A local task list. Each project is a folder with a plain TODO.md file. This server (${base}) reads and writes those files and shows them as a board in the browser. The page updates live when a file changes.`, '');
  L.push('You can work with tasks in two ways. Use whichever is easier:', '');
  L.push('1. **HTTP API** (below). Safest while the server is running: it keeps the format right and tells you if a task changed under you.');
  L.push('2. **Edit the TODO.md directly** in the project folder, following the format below. The open page picks up the change.', '');
  L.push('## Projects', '');
  if (!list.length) L.push('No projects yet. Add one with `POST /api/projects`.');
  for (const p of list) {
    L.push(`- **${p.name}**: \`${p.file}\`${p.missing ? ' (folder missing)' : ` (${p.open} open, ${p.done} done)`}`);
  }
  L.push('', 'Pick the project whose folder matches the repo you are working in. Pass its path as `project`.', '');
  L.push('## How to work with the list', '');
  L.push('- Read the tasks before starting: `GET /api/todos?project=...`.');
  L.push('- Work left to right: **now**, then **next**, then **later**. Unsorted tasks (no priority) have not been triaged yet.');
  L.push('- When you start a task, set its status to `doing`. When it is finished, set it to `done`. Don\'t delete finished tasks unless asked.');
  L.push('- Add tasks you discover along the way. Use `later` or no priority if you are unsure, and leave `now` for things the user said are urgent.');
  L.push('- Keep task text short: the first line is the title, and extra lines are details.');
  L.push('- When editing the file directly, only touch the lines you mean to change.', '');
  L.push('## TODO.md format', '');
  L.push('```markdown', '# TODO', '', '- [ ] a task with no area', '- [-] something in progress !now', '', '## Checkout page', '',
    '- [ ] fix the coupon field !next', '  It rejects codes with lowercase letters.', '  ![](todos/coupon-bug.png)', '- [X] a finished task', '```', '');
  L.push('- `- [ ]` to do, `- [-]` doing, `- [X]` done.');
  L.push('- Priority is an optional tag at the end of the task line: `!now`, `!next` or `!later`. No tag means unsorted. Old `!p1`/`!p2`/`!p3` tags mean now/next/later.');
  L.push('- `## Heading` is an area (a group of tasks). Tasks above the first `##` have no area.');
  L.push('- Indented lines (2 spaces) under a task are its details. Images are `![](todos/name.png)`, relative to the TODO.md.', '');
  L.push('## API', '');
  L.push(`Base URL: ${base}. JSON in and out. Errors look like \`{"error": "..."}\`.`, '');
  for (const e of eps) {
    L.push(`### ${e.method} ${e.path.split('?')[0]}`, '', e.desc, '', '```sh', e.curl, '```', '');
  }
  return L.join('\n');
}
app.get(['/llms.txt', '/api/guide'], (req, res) => {
  res.type('text/markdown; charset=utf-8').send(guide(req));
});

// Images referenced from a project's markdown, resolved relative to its TODO.md.
app.use('/f', (req, res) => {
  const f = String(req.query.project || '');
  if (!projects.includes(f)) return res.sendStatus(404);
  const baseDir = path.dirname(f);
  let p;
  try { p = path.resolve(baseDir, '.' + decodeURIComponent(req.path)); } catch { return res.sendStatus(400); }
  if (!p.startsWith(baseDir + path.sep) || !SERVE_EXT.has(path.extname(p).toLowerCase())) {
    return res.sendStatus(404);
  }
  res.sendFile(p, (err) => { if (err && !res.headersSent) res.sendStatus(404); });
});

// Push a ping to open pages whenever a project file changes (including edits by Claude).
const clients = new Set();
app.get('/api/events', (req, res) => {
  res.set({ 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 2000\n\n');
  clients.add(res);
  req.on('close', () => clients.delete(res));
});
const broadcast = (msg) => { for (const c of clients) c.write(`data: ${JSON.stringify(msg)}\n\n`); };

const watched = new Map();
function watch(file) {
  if (watched.has(file)) return;
  const fn = (cur, prev) => { if (cur.mtimeMs !== prev.mtimeMs) broadcast({ file }); };
  watched.set(file, fn);
  fs.watchFile(file, { interval: 400 }, fn);
}
function unwatch(file) {
  const fn = watched.get(file);
  if (fn) { fs.unwatchFile(file, fn); watched.delete(file); }
  broadcast({ projects: true });
}
setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 30000).unref();

app.use((err, req, res, next) => {
  res.status(err.status || 500).json({ error: err.message || 'Something went wrong.' });
});

// ---------- start ----------
start = addProject(start);
for (const f of projects) if (isDir(path.dirname(f))) watch(f);

const server = app.listen(port, '127.0.0.1', () => {
  console.log(`todo-md  http://localhost:${port}`);
  console.log(`editing  ${tilde(start)}  (+${projects.length - 1} other project${projects.length === 2 ? '' : 's'})`);
  console.log(`agents   http://localhost:${port}/llms.txt`);
});
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') console.error(`Port ${port} is in use. Try --port ${port + 1}`);
  else console.error(e.message);
  process.exit(1);
});
