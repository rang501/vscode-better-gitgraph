(function () {
  const vscode = acquireVsCodeApi();

  const el = {
    hdrRepo: document.getElementById('hdr-repo'),
    hdrBranch: document.getElementById('hdr-branch'),
    author: document.getElementById('author'),
    preset: document.getElementById('preset'),
    since: document.getElementById('since'),
    until: document.getElementById('until'),
    tagFilter: document.getElementById('tag-filter'),
    tagsList: document.getElementById('tags-list'),
    subjectSearch: document.getElementById('subject-search'),
    limit: document.getElementById('limit'),
    refresh: document.getElementById('refresh'),
    ctxMenu: document.getElementById('ctx-menu'),
    status: document.getElementById('status'),
    rows: document.getElementById('rows'),
    empty: document.getElementById('empty'),
    listWrap: document.getElementById('list-wrap'),
    customRange: document.querySelectorAll('.custom-range'),
    main: document.querySelector('.main'),
    splitter: document.getElementById('splitter'),
    detailWrap: document.getElementById('detail-wrap'),
    detailClose: document.getElementById('detail-close'),
    meta: document.getElementById('meta'),
    metaSection: document.getElementById('meta-section'),
    filesSection: document.getElementById('files-section'),
    diffSection: document.getElementById('diff-section'),
    hSplitter1: document.getElementById('h-splitter-1'),
    hSplitter2: document.getElementById('h-splitter-2'),
    files: document.getElementById('files'),
    filesCount: document.getElementById('files-count'),
    diff: document.getElementById('diff'),
    diffPath: document.getElementById('diff-path'),
    openEditor: document.getElementById('open-editor'),
  };

  let selectedHash = null;
  let commitsList = [];
  let detailOpenHash = null;
  let selectedFile = null;
  let selectedFileRow = null;
  let availableTags = [];

  const LANE_WIDTH = 14;
  const ROW_HEIGHT = 24;
  const MID_Y = ROW_HEIGHT / 2;
  const DOT_R = 3.5;
  const LANE_COLORS = [
    '#5dade2',
    '#f5b041',
    '#58d68d',
    '#bb8fce',
    '#ec7063',
    '#48c9b0',
    '#f7dc6f',
    '#aab7b8',
  ];
  const SVG_NS = 'http://www.w3.org/2000/svg';

  const laneX = (i) => i * LANE_WIDTH + LANE_WIDTH / 2;
  const laneColor = (i) => LANE_COLORS[i % LANE_COLORS.length];

  function computeGraph(commits) {
    let lanes = [];
    let maxLanes = 0;
    const rows = [];
    for (const c of commits) {
      const parents = c.parents || [];
      const before = lanes.slice();

      let myLane = before.indexOf(c.hash);
      if (myLane === -1) {
        myLane = before.indexOf(null);
        if (myLane === -1) myLane = before.length;
      }

      const after = before.slice();
      for (let i = 0; i < after.length; i++) {
        if (after[i] === c.hash) after[i] = null;
      }
      while (after.length <= myLane) after.push(null);
      after[myLane] = parents[0] ?? null;

      const extraParents = [];
      for (let i = 1; i < parents.length; i++) {
        let slot = after.indexOf(null);
        if (slot === -1) {
          slot = after.length;
          after.push(null);
        }
        after[slot] = parents[i];
        extraParents.push(slot);
      }
      while (after.length && after[after.length - 1] === null) after.pop();

      const merges = [];
      const passThrough = [];
      for (let i = 0; i < before.length; i++) {
        if (before[i] === c.hash && i !== myLane) merges.push(i);
        else if (before[i] !== null && before[i] !== c.hash) passThrough.push(i);
      }

      rows.push({
        myLane,
        merges,
        passThrough,
        extraParents,
        continuesUp: before[myLane] === c.hash,
        hasFirstParent: parents.length > 0,
      });

      maxLanes = Math.max(maxLanes, before.length, after.length, myLane + 1);
      lanes = after;
    }
    return { rows, maxLanes };
  }

  function curvePath(x1, y1, x2, y2) {
    if (x1 === x2) return `M${x1},${y1} L${x2},${y2}`;
    const cy = (y1 + y2) / 2;
    return `M${x1},${y1} C${x1},${cy} ${x2},${cy} ${x2},${y2}`;
  }

  function buildGraphSvg(row, width) {
    const svg = document.createElementNS(SVG_NS, 'svg');
    svg.setAttribute('class', 'graph');
    svg.setAttribute('width', String(width));
    svg.setAttribute('height', String(ROW_HEIGHT));

    const addPath = (d, color) => {
      const p = document.createElementNS(SVG_NS, 'path');
      p.setAttribute('d', d);
      p.setAttribute('stroke', color);
      p.setAttribute('stroke-width', '1.5');
      p.setAttribute('fill', 'none');
      svg.appendChild(p);
    };

    for (const i of row.passThrough) {
      addPath(curvePath(laneX(i), 0, laneX(i), ROW_HEIGHT), laneColor(i));
    }
    if (row.continuesUp) {
      addPath(curvePath(laneX(row.myLane), 0, laneX(row.myLane), MID_Y), laneColor(row.myLane));
    }
    for (const i of row.merges) {
      addPath(curvePath(laneX(i), 0, laneX(row.myLane), MID_Y), laneColor(i));
    }
    if (row.hasFirstParent) {
      addPath(curvePath(laneX(row.myLane), MID_Y, laneX(row.myLane), ROW_HEIGHT), laneColor(row.myLane));
    }
    for (const slot of row.extraParents) {
      addPath(curvePath(laneX(row.myLane), MID_Y, laneX(slot), ROW_HEIGHT), laneColor(slot));
    }

    const dot = document.createElementNS(SVG_NS, 'circle');
    dot.setAttribute('cx', String(laneX(row.myLane)));
    dot.setAttribute('cy', String(MID_Y));
    dot.setAttribute('r', String(DOT_R));
    dot.setAttribute('fill', laneColor(row.myLane));
    dot.setAttribute('stroke', 'var(--vscode-editor-background)');
    dot.setAttribute('stroke-width', '1');
    svg.appendChild(dot);

    return svg;
  }

  function fmtDate(iso) {
    try {
      const d = new Date(iso);
      const pad = (n) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
    } catch {
      return iso;
    }
  }

  function setOptions(select, items, { withAll = false, allLabel = 'All', preserve = true } = {}) {
    const prev = preserve ? select.value : '';
    select.innerHTML = '';
    if (withAll) {
      const o = document.createElement('option');
      o.value = '';
      o.textContent = allLabel;
      select.appendChild(o);
    }
    for (const item of items) {
      const o = document.createElement('option');
      if (typeof item === 'string') {
        o.value = item;
        o.textContent = item;
      } else {
        o.value = item.value;
        o.textContent = item.label;
      }
      select.appendChild(o);
    }
    if (preserve && [...select.options].some((o) => o.value === prev)) {
      select.value = prev;
    }
  }

  function currentToolbarFilters() {
    const filters = {};
    if (el.author.value) filters.author = el.author.value;

    const preset = el.preset.value;
    if (preset === 'custom') {
      if (el.since.value) filters.since = el.since.value;
      if (el.until.value) filters.until = el.until.value;
    } else if (preset) {
      filters.since = `${preset}.days.ago`;
    }

    const tag = el.tagFilter.value.trim();
    if (tag && availableTags.includes(tag)) filters.tag = tag;

    const subject = el.subjectSearch.value.trim();
    if (subject) filters.subject = subject;

    const lim = parseInt(el.limit.value, 10);
    if (!Number.isNaN(lim) && lim > 0) filters.limit = lim;
    return filters;
  }

  function classifyRef(rawRef) {
    const ref = rawRef.replace(/^HEAD -> /, '');
    if (ref.startsWith('tag: ')) {
      return { kind: 'tag', name: ref.slice(5), isHead: false };
    }
    return { kind: 'branch', name: ref, isHead: rawRef.startsWith('HEAD') };
  }

  function tagsOnCommit(commit) {
    return (commit.refs || [])
      .map(classifyRef)
      .filter((r) => r.kind === 'tag')
      .map((r) => r.name);
  }

  function sendQuery() {
    el.status.textContent = 'Loading…';
    vscode.postMessage({ type: 'query', filters: currentToolbarFilters() });
  }

  function copy(text) {
    vscode.postMessage({ type: 'copy', text });
  }

  function selectRow(hash, opts = {}) {
    selectedHash = hash;
    let target = null;
    for (const tr of el.rows.querySelectorAll('tr.commit')) {
      const match = tr.dataset.hash === hash;
      tr.classList.toggle('selected', match);
      if (match) target = tr;
    }
    if (target && opts.scroll) target.scrollIntoView({ block: 'nearest' });
    if (opts.open) {
      detailOpenHash = hash;
      showDetail();
      el.meta.innerHTML = '<div class="loading">Loading…</div>';
      el.files.innerHTML = '';
      el.filesCount.textContent = '';
      el.diff.innerHTML = '';
      el.diffPath.textContent = 'Select a file to view diff';
      el.openEditor.hidden = true;
      vscode.postMessage({ type: 'openCommit', hash });
    }
  }

  function showDetail() {
    el.detailWrap.hidden = false;
    el.splitter.hidden = false;
  }

  function closeDetail() {
    el.detailWrap.hidden = true;
    el.splitter.hidden = true;
    detailOpenHash = null;
    vscode.postMessage({ type: 'closeDetail' });
  }

  function renderMeta(d) {
    el.meta.innerHTML = '';
    const subject = document.createElement('div');
    subject.className = 'subject';
    subject.textContent = d.subject;
    el.meta.appendChild(subject);

    const hashRow = metaRow('Hash', '');
    const hashSpan = document.createElement('span');
    hashSpan.className = 'hash';
    hashSpan.textContent = d.hash;
    const copyHash = document.createElement('button');
    copyHash.className = 'copy-btn';
    copyHash.textContent = 'copy';
    copyHash.addEventListener('click', () => copy(d.hash));
    hashRow.querySelector('.value').append(hashSpan, copyHash);
    el.meta.appendChild(hashRow);

    el.meta.appendChild(metaRow('Author', `${d.author} <${d.email}>`));
    el.meta.appendChild(metaRow('Date', fmtDate(d.date)));

    if (d.parents.length) {
      const parentsRow = metaRow('Parents', '');
      const value = parentsRow.querySelector('.value');
      d.parents.forEach((p, i) => {
        if (i > 0) value.append(' ');
        const span = document.createElement('span');
        span.className = 'hash';
        span.textContent = p.slice(0, 7);
        span.title = p;
        span.style.cursor = 'pointer';
        span.addEventListener('click', () => copy(p));
        value.appendChild(span);
      });
      el.meta.appendChild(parentsRow);
    }

    const classified = d.refs.map(classifyRef);
    const branches = classified.filter((r) => r.kind === 'branch');
    const tags = classified.filter((r) => r.kind === 'tag');
    if (branches.length) {
      const refsRow = metaRow('Branches', '');
      const value = refsRow.querySelector('.value');
      for (const b of branches) {
        const span = document.createElement('span');
        span.className = 'ref' + (b.isHead ? ' head' : '');
        span.textContent = b.name;
        value.appendChild(span);
      }
      el.meta.appendChild(refsRow);
    }
    if (tags.length) {
      const tagsRow = metaRow('Tags', '');
      const value = tagsRow.querySelector('.value');
      for (const t of tags) {
        const span = document.createElement('span');
        span.className = 'ref tag';
        span.textContent = t.name;
        value.appendChild(span);
      }
      el.meta.appendChild(tagsRow);
    }

    if (d.body && d.body.trim()) {
      const toggle = document.createElement('button');
      toggle.className = 'body-toggle';
      const body = document.createElement('div');
      body.className = 'body collapsed';
      body.textContent = d.body.trim();
      const setLabel = () => {
        toggle.textContent = body.classList.contains('collapsed') ? '▸ Show message' : '▾ Hide message';
      };
      setLabel();
      toggle.addEventListener('click', () => {
        body.classList.toggle('collapsed');
        setLabel();
      });
      el.meta.append(toggle, body);
    }
  }

  function metaRow(label, valueText) {
    const r = document.createElement('div');
    r.className = 'row';
    const l = document.createElement('span');
    l.className = 'label';
    l.textContent = label;
    const v = document.createElement('span');
    v.className = 'value';
    v.textContent = valueText;
    r.append(l, v);
    return r;
  }

  function buildTree(files) {
    const root = { dirs: new Map(), files: [] };
    for (const f of files) {
      const parts = f.path.split('/');
      let node = root;
      for (let i = 0; i < parts.length - 1; i++) {
        const p = parts[i];
        let next = node.dirs.get(p);
        if (!next) {
          next = { dirs: new Map(), files: [], name: p };
          node.dirs.set(p, next);
        }
        node = next;
      }
      node.files.push({ ...f, name: parts[parts.length - 1] });
    }
    return root;
  }

  function statusLabel(s) {
    if (s.startsWith('R')) return 'R';
    if (s.startsWith('C')) return 'C';
    return s[0];
  }

  function selectFile(f, rowEl) {
    if (selectedFileRow) selectedFileRow.classList.remove('selected');
    selectedFileRow = rowEl;
    rowEl.classList.add('selected');
    selectedFile = f;
    el.diffPath.textContent = f.oldPath && f.oldPath !== f.path
      ? `${f.oldPath} → ${f.path}`
      : f.path;
    el.openEditor.hidden = false;
    el.diff.innerHTML = '<div class="diff-empty">Loading diff…</div>';
    vscode.postMessage({ type: 'loadDiff', file: f });
  }

  function compactChain(node, startName) {
    let displayName = startName;
    let cur = node;
    while (cur.dirs.size === 1 && cur.files.length === 0) {
      const [childName, childNode] = [...cur.dirs.entries()][0];
      displayName += '/' + childName;
      cur = childNode;
    }
    return { displayName, deepest: cur };
  }

  function renderTree(node, depth) {
    const frag = document.createDocumentFragment();
    const dirNames = [...node.dirs.keys()].sort();
    for (const name of dirNames) {
      const child = node.dirs.get(name);
      const { displayName, deepest } = compactChain(child, name);
      const wrap = document.createElement('div');
      wrap.className = 'tree-node';
      const rowEl = document.createElement('div');
      rowEl.className = 'tree-row dir expanded';
      rowEl.style.paddingLeft = `${8 + depth * 8}px`;
      const tw = document.createElement('span');
      tw.className = 'twistie';
      tw.textContent = '›';
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = displayName;
      rowEl.append(tw, nm);
      const childrenWrap = document.createElement('div');
      childrenWrap.className = 'tree-children';
      childrenWrap.appendChild(renderTree(deepest, depth + 1));
      rowEl.addEventListener('click', () => {
        const isCollapsed = childrenWrap.classList.toggle('collapsed');
        rowEl.classList.toggle('expanded', !isCollapsed);
      });
      wrap.append(rowEl, childrenWrap);
      frag.appendChild(wrap);
    }
    const files = [...node.files].sort((a, b) => a.name.localeCompare(b.name));
    for (const f of files) {
      const rowEl = document.createElement('div');
      rowEl.className = 'tree-row file';
      rowEl.style.paddingLeft = `${8 + depth * 8}px`;
      const tw = document.createElement('span');
      tw.className = 'twistie';
      const nm = document.createElement('span');
      nm.className = 'name';
      nm.textContent = f.name;
      nm.title = f.oldPath ? `${f.oldPath} → ${f.path}` : f.path;
      const openBtn = document.createElement('button');
      openBtn.className = 'row-open';
      openBtn.textContent = '↗';
      openBtn.title = 'Open native diff editor';
      openBtn.addEventListener('click', (e) => {
        e.stopPropagation();
        vscode.postMessage({ type: 'openDiff', file: f });
      });
      const st = document.createElement('span');
      const label = statusLabel(f.status);
      st.className = `status status-${label}`;
      st.textContent = label;
      st.title = f.status;
      rowEl.append(tw, nm, openBtn, st);
      rowEl.addEventListener('click', () => selectFile(f, rowEl));
      frag.appendChild(rowEl);
    }
    return frag;
  }

  function renderFiles(files) {
    el.filesCount.textContent = String(files.length);
    el.files.innerHTML = '';
    selectedFile = null;
    selectedFileRow = null;
    el.diff.innerHTML = '';
    el.diffPath.textContent = 'Select a file to view diff';
    el.openEditor.hidden = true;
    if (!files.length) {
      const empty = document.createElement('div');
      empty.className = 'empty';
      empty.textContent = 'No file changes.';
      el.files.appendChild(empty);
      return;
    }
    const tree = buildTree(files);
    el.files.appendChild(renderTree(tree, 0));
    const firstFile = el.files.querySelector('.tree-row.file');
    if (firstFile) firstFile.click();
  }

  function parsePatch(patch) {
    const lines = patch.split('\n');
    const rows = [];
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    let isBinary = false;

    for (const line of lines) {
      if (line.startsWith('Binary files')) {
        isBinary = true;
        continue;
      }
      if (
        line.startsWith('diff --git') ||
        line.startsWith('index ') ||
        line.startsWith('--- ') ||
        line.startsWith('+++ ') ||
        line.startsWith('similarity ') ||
        line.startsWith('dissimilarity ') ||
        line.startsWith('rename ') ||
        line.startsWith('copy ') ||
        line.startsWith('new file mode') ||
        line.startsWith('deleted file mode') ||
        line.startsWith('old mode ') ||
        line.startsWith('new mode ')
      ) {
        continue;
      }
      if (line.startsWith('@@')) {
        const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
        if (m) {
          oldLine = parseInt(m[1], 10);
          newLine = parseInt(m[2], 10);
        }
        inHunk = true;
        rows.push({ type: 'hunk', text: line });
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith('+')) {
        rows.push({ type: 'add', oldNum: '', newNum: newLine++, text: line.slice(1) });
      } else if (line.startsWith('-')) {
        rows.push({ type: 'del', oldNum: oldLine++, newNum: '', text: line.slice(1) });
      } else if (line.startsWith(' ')) {
        rows.push({ type: 'ctx', oldNum: oldLine++, newNum: newLine++, text: line.slice(1) });
      } else if (line.startsWith('\\')) {
        rows.push({ type: 'meta', text: line });
      }
    }
    return { rows, isBinary };
  }

  function renderDiff(patch) {
    el.diff.innerHTML = '';
    if (!patch) {
      const empty = document.createElement('div');
      empty.className = 'diff-empty';
      empty.textContent = 'No textual diff available.';
      el.diff.appendChild(empty);
      return;
    }
    const { rows, isBinary } = parsePatch(patch);
    if (isBinary) {
      const note = document.createElement('div');
      note.className = 'diff-binary';
      note.textContent = 'Binary file — diff skipped.';
      el.diff.appendChild(note);
      return;
    }
    if (rows.length === 0) {
      const empty = document.createElement('div');
      empty.className = 'diff-empty';
      empty.textContent = 'No changes (mode or rename only).';
      el.diff.appendChild(empty);
      return;
    }
    const frag = document.createDocumentFragment();
    for (const r of rows) {
      const line = document.createElement('div');
      line.className = `diff-line ${r.type}`;

      if (r.type === 'hunk' || r.type === 'meta') {
        const num = document.createElement('span');
        num.className = 'num';
        const content = document.createElement('span');
        content.className = 'content';
        content.textContent = r.text;
        line.append(num, content);
      } else {
        const num = document.createElement('span');
        num.className = 'num';
        num.textContent = r.type === 'add' ? r.newNum : r.type === 'del' ? r.oldNum : r.newNum;
        const marker = document.createElement('span');
        marker.className = 'marker';
        marker.textContent = r.type === 'add' ? '+' : r.type === 'del' ? '-' : ' ';
        const content = document.createElement('span');
        content.className = 'content';
        content.textContent = r.text;
        line.append(num, marker, content);
      }
      frag.appendChild(line);
    }
    el.diff.appendChild(frag);
  }

  function showContextMenu(x, y, commit) {
    const tags = tagsOnCommit(commit);
    const items = [
      { label: 'Checkout commit…', action: () => vscode.postMessage({ type: 'checkoutCommit', hash: commit.hash }) },
      { label: 'Create branch here…', action: () => vscode.postMessage({ type: 'createBranch', hash: commit.hash }) },
      { label: 'Cherry-pick commit…', action: () => vscode.postMessage({ type: 'cherryPick', hash: commit.hash }) },
      { label: 'Revert commit…', action: () => vscode.postMessage({ type: 'revert', hash: commit.hash }) },
      { label: 'Reset current branch to here…', action: () => vscode.postMessage({ type: 'reset', hash: commit.hash }) },
      { sep: true },
      { label: 'Add tag here…', action: () => vscode.postMessage({ type: 'addTag', hash: commit.hash }) },
    ];
    if (availableTags.length) {
      items.push({ label: 'Move tag here…', action: () => vscode.postMessage({ type: 'moveTag', hash: commit.hash }) });
    }
    if (tags.length) {
      items.push({ sep: true });
      items.push({
        label: tags.length === 1 ? `Rename tag '${tags[0]}'…` : 'Rename tag…',
        action: () => vscode.postMessage({ type: 'renameTag', hash: commit.hash, tags }),
      });
      items.push({
        label: tags.length === 1 ? `Delete tag '${tags[0]}'` : 'Delete tag…',
        action: () => vscode.postMessage({ type: 'deleteTag', hash: commit.hash, tags }),
      });
    }
    items.push({ sep: true });
    items.push({ label: 'Copy commit hash', action: () => copy(commit.hash) });

    el.ctxMenu.innerHTML = '';
    for (const item of items) {
      if (item.sep) {
        const sep = document.createElement('div');
        sep.className = 'ctx-sep';
        el.ctxMenu.appendChild(sep);
        continue;
      }
      const it = document.createElement('div');
      it.className = 'ctx-item';
      it.textContent = item.label;
      it.addEventListener('click', () => {
        hideContextMenu();
        item.action();
      });
      el.ctxMenu.appendChild(it);
    }

    el.ctxMenu.hidden = false;
    el.ctxMenu.style.left = '0px';
    el.ctxMenu.style.top = '0px';
    const rect = el.ctxMenu.getBoundingClientRect();
    const maxX = window.innerWidth - rect.width - 4;
    const maxY = window.innerHeight - rect.height - 4;
    el.ctxMenu.style.left = Math.min(x, maxX) + 'px';
    el.ctxMenu.style.top = Math.min(y, maxY) + 'px';
  }

  function hideContextMenu() {
    el.ctxMenu.hidden = true;
  }

  function startSplitterDrag(e) {
    e.preventDefault();
    el.splitter.classList.add('dragging');
    const mainRect = el.main.getBoundingClientRect();
    const onMove = (ev) => {
      const x = ev.clientX;
      const newDetailWidth = Math.max(280, Math.min(mainRect.right - 200, mainRect.right - x));
      el.detailWrap.style.flex = `0 0 ${newDetailWidth}px`;
    };
    const onUp = () => {
      el.splitter.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function startVResize(e, section, edge) {
    e.preventDefault();
    const splitter = e.currentTarget;
    splitter.classList.add('dragging');
    const startY = e.clientY;
    const startHeight = section.getBoundingClientRect().height;
    const onMove = (ev) => {
      const dy = ev.clientY - startY;
      const minHeight = parseInt(getComputedStyle(section).minHeight, 10) || 60;
      const delta = edge === 'above' ? dy : -dy;
      const newHeight = Math.max(minHeight, startHeight + delta);
      section.style.flex = `0 0 ${newHeight}px`;
    };
    const onUp = () => {
      splitter.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);
    };
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  }

  function moveSelection(delta) {
    if (!commitsList.length) return;
    let idx = commitsList.findIndex((c) => c.hash === selectedHash);
    if (idx === -1) idx = delta > 0 ? -1 : commitsList.length;
    const next = Math.max(0, Math.min(commitsList.length - 1, idx + delta));
    selectRow(commitsList[next].hash, { open: true, scroll: true });
  }

  function renderCommits(commits) {
    commitsList = commits;
    el.rows.innerHTML = '';
    if (!commits.length) {
      el.empty.hidden = false;
      el.status.textContent = '0 commits';
      selectedHash = null;
      return;
    }
    el.empty.hidden = true;
    if (selectedHash && !commits.some((c) => c.hash === selectedHash)) {
      selectedHash = null;
    }

    const { rows: graphRows, maxLanes } = computeGraph(commits);
    const graphWidth = Math.max(maxLanes, 1) * LANE_WIDTH + 4;
    document.querySelectorAll('.col-graph').forEach((node) => {
      node.style.width = graphWidth + 'px';
    });

    const frag = document.createDocumentFragment();
    for (let idx = 0; idx < commits.length; idx++) {
      const c = commits[idx];
      const tr = document.createElement('tr');
      tr.className = 'commit';
      tr.dataset.hash = c.hash;
      if (c.hash === selectedHash) tr.classList.add('selected');
      tr.addEventListener('click', (e) => {
        if (e.target.closest('button, .ref')) return;
        selectRow(c.hash, { open: detailOpenHash !== null });
      });
      tr.addEventListener('dblclick', (e) => {
        if (e.target.closest('button, .ref')) return;
        selectRow(c.hash, { open: true });
      });
      tr.addEventListener('contextmenu', (e) => {
        e.preventDefault();
        selectRow(c.hash);
        showContextMenu(e.clientX, e.clientY, c);
      });

      const tdGraph = document.createElement('td');
      tdGraph.className = 'col-graph';
      tdGraph.appendChild(buildGraphSvg(graphRows[idx], graphWidth));

      const tdMsg = document.createElement('td');
      tdMsg.className = 'col-msg';
      tdMsg.textContent = c.subject;
      tdMsg.title = c.subject;

      const tdRefs = document.createElement('td');
      tdRefs.className = 'col-refs';
      for (const ref of c.refs) {
        const info = classifyRef(ref);
        const span = document.createElement('span');
        span.className = 'ref' + (info.isHead ? ' head' : '') + (info.kind === 'tag' ? ' tag' : '');
        span.textContent = info.name;
        span.title = `Click to copy: ${info.name}`;
        span.addEventListener('click', () => copy(info.name));
        tdRefs.appendChild(span);
      }

      const tdAuthor = document.createElement('td');
      tdAuthor.className = 'col-author';
      tdAuthor.textContent = c.author;
      tdAuthor.title = `${c.author} <${c.email}>`;

      const tdDate = document.createElement('td');
      tdDate.className = 'col-date';
      tdDate.textContent = fmtDate(c.date);
      tdDate.title = c.date;

      tr.append(tdGraph, tdMsg, tdRefs, tdAuthor, tdDate);
      frag.appendChild(tr);
    }
    el.rows.appendChild(frag);
    el.status.textContent = `${commits.length} commit${commits.length === 1 ? '' : 's'}`;
  }

  window.addEventListener('message', (event) => {
    const msg = event.data;
    switch (msg.type) {
      case 'state': {
        el.hdrRepo.textContent = msg.repo ? msg.repo.name : '— no repo —';
        el.hdrRepo.title = msg.repo ? msg.repo.path : '';
        el.hdrBranch.textContent = msg.branch === '__all__' ? 'all branches' : msg.branch;
        setOptions(el.author, msg.authors, { withAll: true, preserve: true });
        availableTags = msg.tags || [];
        el.tagsList.innerHTML = '';
        for (const t of availableTags) {
          const o = document.createElement('option');
          o.value = t;
          el.tagsList.appendChild(o);
        }
        if (el.tagFilter.value && !availableTags.includes(el.tagFilter.value.trim())) {
          el.tagFilter.value = '';
        }
        break;
      }
      case 'commits': {
        renderCommits(msg.commits);
        break;
      }
      case 'commit': {
        if (msg.error) {
          el.meta.innerHTML = `<div class="empty">Error: ${msg.error}</div>`;
          el.files.innerHTML = '';
          el.filesCount.textContent = '';
          break;
        }
        renderMeta(msg.details);
        renderFiles(msg.files);
        break;
      }
      case 'diff': {
        if (selectedFile && selectedFile.path !== msg.file.path) break;
        if (msg.error) {
          el.diff.innerHTML = `<div class="diff-empty">Error: ${msg.error}</div>`;
        } else {
          renderDiff(msg.patch);
        }
        break;
      }
      case 'error': {
        el.status.textContent = `Error: ${msg.message}`;
        break;
      }
    }
  });

  el.author.addEventListener('change', sendQuery);
  el.preset.addEventListener('change', () => {
    const custom = el.preset.value === 'custom';
    el.customRange.forEach((node) => (node.hidden = !custom));
    sendQuery();
  });
  el.since.addEventListener('change', sendQuery);
  el.until.addEventListener('change', sendQuery);
  el.limit.addEventListener('change', sendQuery);
  el.refresh.addEventListener('click', sendQuery);

  el.tagFilter.addEventListener('change', sendQuery);
  el.tagFilter.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      sendQuery();
    }
  });

  let searchTimer = null;
  el.subjectSearch.addEventListener('input', () => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(sendQuery, 250);
  });
  el.subjectSearch.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(searchTimer);
      sendQuery();
    }
  });

  document.addEventListener('mousedown', (e) => {
    if (!el.ctxMenu.hidden && !el.ctxMenu.contains(e.target)) hideContextMenu();
  });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && !el.ctxMenu.hidden) hideContextMenu();
  });
  window.addEventListener('blur', hideContextMenu);
  window.addEventListener('scroll', hideContextMenu, true);

  el.listWrap.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      moveSelection(1);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      moveSelection(-1);
    } else if (e.key === 'Home') {
      e.preventDefault();
      if (commitsList.length) selectRow(commitsList[0].hash, { open: true, scroll: true });
    } else if (e.key === 'End') {
      e.preventDefault();
      if (commitsList.length) selectRow(commitsList[commitsList.length - 1].hash, { open: true, scroll: true });
    } else if (e.key === 'Enter' && selectedHash) {
      e.preventDefault();
      vscode.postMessage({ type: 'openCommit', hash: selectedHash });
    }
  });
  el.listWrap.addEventListener('mousedown', () => el.listWrap.focus({ preventScroll: true }));

  el.splitter.addEventListener('mousedown', startSplitterDrag);
  el.hSplitter1.addEventListener('mousedown', (e) => startVResize(e, el.metaSection, 'above'));
  el.hSplitter2.addEventListener('mousedown', (e) => startVResize(e, el.diffSection, 'below'));
  el.detailClose.addEventListener('click', closeDetail);
  el.openEditor.addEventListener('click', () => {
    if (selectedFile) vscode.postMessage({ type: 'openDiff', file: selectedFile });
  });

  vscode.postMessage({ type: 'init' });
})();
