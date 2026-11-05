/*
 * Pixel Toolbox — user interface.
 *
 * Everything happens in this browser tab: files are read with the File API,
 * processed in memory and handed back as downloads. Nothing is uploaded.
 *
 * MIT License. Copyright (c) 2026 YunaWorks.
 */
(function () {
  'use strict';

  const PT = window.PixelToolbox;
  const png = PT.png;
  const raster = PT.raster;
  const split = PT.split;
  const merge = PT.merge;

  // ------------------------------------------------------------ DOM helpers

  const $ = (selector, root) => (root || document).querySelector(selector);
  const $$ = (selector, root) => Array.from((root || document).querySelectorAll(selector));

  function h(tag, props) {
    const node = document.createElement(tag);
    if (props) {
      for (const key of Object.keys(props)) {
        const value = props[key];
        if (value === null || value === undefined || value === false) continue;
        if (key === 'class') node.className = value;
        else if (key === 'text') node.textContent = value;
        else node.setAttribute(key, value === true ? '' : value);
      }
    }
    for (let i = 2; i < arguments.length; i++) {
      const child = arguments[i];
      if (child !== null && child !== undefined) node.append(child);
    }
    return node;
  }

  function plural(n, word, many) {
    return n + ' ' + (n === 1 ? word : many || word + 's');
  }

  function dims(w, h) {
    return w + ' × ' + h;
  }

  /** Runs `fn` once on the next animation frame, however often it is requested. */
  function coalesce(fn) {
    let pending = false;
    return function () {
      if (pending) return;
      pending = true;
      requestAnimationFrame(function () {
        pending = false;
        fn();
      });
    };
  }

  // ------------------------------------------------------------ feature check

  const supported =
    typeof CompressionStream !== 'undefined' &&
    typeof DecompressionStream !== 'undefined' &&
    typeof ResizeObserver !== 'undefined' &&
    typeof ImageData !== 'undefined';
  if (!supported) $('#browser-warning').hidden = false;

  // -------------------------------------------------------------------- toast

  const toast = $('#toast');
  let toastTimer = 0;

  function notify(message, kind) {
    toast.textContent = message;
    toast.className = 'toast is-visible' + (kind === 'error' ? ' is-error' : '');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(hideToast, kind === 'error' ? 9000 : 4000);
  }

  function hideToast() {
    toast.classList.remove('is-visible');
  }

  toast.addEventListener('click', hideToast);

  // ------------------------------------------------------------ files in/out

  function baseName(fileName) {
    const name = String(fileName || '').replace(/\.[^./\\]*$/, '');
    return name || 'image';
  }

  /** Decodes a PNG file into raw RGBA pixels. */
  async function readPng(file) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (!png.isPng(bytes)) throw new Error('This is not a PNG file.');
    try {
      return await png.decodePng(bytes);
    } catch (err) {
      // Unusual or slightly damaged files: let the browser's own decoder try.
      try {
        const image = await decodeWithBrowser(file);
        console.warn('Pixel Toolbox: used the browser decoder for ' + file.name + ':', err.message);
        return image;
      } catch (ignored) {
        throw err;
      }
    }
  }

  async function decodeWithBrowser(file) {
    const bitmap = await createImageBitmap(file, { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
    try {
      raster.checkSize(bitmap.width, bitmap.height);
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.imageSmoothingEnabled = false;
      ctx.drawImage(bitmap, 0, 0);
      const data = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
      return raster.createImage(bitmap.width, bitmap.height, data);
    } finally {
      if (bitmap.close) bitmap.close();
    }
  }

  function saveFile(data, fileName, type) {
    const blob = data instanceof Blob ? data : new Blob([data], { type: type });
    const url = URL.createObjectURL(blob);
    const link = h('a', { href: url, download: fileName });
    link.style.display = 'none';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(function () { URL.revokeObjectURL(url); }, 60000);
  }

  /** Paints an RGBA image onto a canvas at its native size. */
  function paint(canvas, image) {
    canvas.width = image.width;
    canvas.height = image.height;
    const ctx = canvas.getContext('2d');
    ctx.putImageData(new ImageData(image.data, image.width, image.height), 0, 0);
  }

  /**
   * Reads whole-number inputs. Marks invalid ones and returns
   * { values, error } where `error` is the first problem found.
   */
  function readNumbers(fields) {
    const values = {};
    let error = null;
    for (const f of fields) {
      const raw = f.input.value.trim();
      const value = Number(raw);
      const ok = raw !== '' && Number.isInteger(value) && value >= f.min && (f.max === undefined || value <= f.max);
      f.input.setAttribute('aria-invalid', ok ? 'false' : 'true');
      values[f.key] = value;
      if (!ok && !error) {
        error = f.label + ': enter a whole number ' +
          (f.max === undefined ? 'of at least ' + f.min : 'from ' + f.min + ' to ' + f.max) + '.';
      }
    }
    return { values: values, error: error };
  }

  function clearInvalid(inputs) {
    for (const input of inputs) input.setAttribute('aria-invalid', 'false');
  }

  function setSummary(node, lines, isError) {
    node.classList.toggle('is-error', !!isError);
    node.replaceChildren.apply(node, lines);
  }

  /** Builds a line like "8 × 4 cells" where the numbers are emphasised. */
  function line(parts, className) {
    const div = h('div', className ? { class: className } : null);
    for (const part of parts) {
      div.append(typeof part === 'string' ? part : h('strong', { text: String(part.b) }));
    }
    return div;
  }

  // -------------------------------------------------------------------- stage

  const ZOOM_STEPS = [0.125, 0.25, 0.5, 1, 2, 3, 4, 5, 6, 8, 10, 12, 16, 20, 24, 32, 48, 64];
  const MAX_DISPLAY_SIZE = 32768;

  /** Preview area: the image at a pixel-exact zoom with a grid overlay on top. */
  class Stage {
    constructor(root) {
      this.root = root;
      this.viewport = $('.stage-viewport', root);
      this.box = $('.stage-canvas', root);
      this.canvas = $('canvas', root);
      this.svg = $('svg', root);
      this.paths = {
        dim: $('.ov-dim', root),
        skip: $('.ov-skip', root),
        cross: $('.ov-cross', root),
        grid: $('.ov-grid', root),
      };
      this.hover = $('.ov-hover', root);
      this.zoomLabel = $('[data-zoom-label]', root);
      this.status = $('.stage-status', root);
      this.defaultStatus = this.status.textContent;
      this.image = null;
      this.zoom = 1;
      this.fit = true;
      this.hitTest = null;
      this.previewError = false;

      $('[data-zoom="in"]', root).addEventListener('click', () => this.step(1));
      $('[data-zoom="out"]', root).addEventListener('click', () => this.step(-1));
      $('[data-zoom="fit"]', root).addEventListener('click', () => {
        this.fit = true;
        this.applyZoom(this.fitZoom());
      });
      this.box.addEventListener('pointermove', (e) => this.onPointer(e));
      this.box.addEventListener('pointerleave', () => this.clearHover());
      new ResizeObserver(() => {
        if (this.image && this.fit) this.applyZoom(this.fitZoom());
      }).observe(this.viewport);
    }

    setImage(image) {
      const resized = !this.image || this.image.width !== image.width || this.image.height !== image.height;
      this.image = image;
      this.previewError = false;
      try {
        paint(this.canvas, image);
      } catch (err) {
        // Very large images can exceed the browser's canvas limits. Export still works.
        this.previewError = true;
        this.canvas.width = 1;
        this.canvas.height = 1;
      }
      this.svg.setAttribute('viewBox', '0 0 ' + image.width + ' ' + image.height);
      this.applyZoom(this.fit ? this.fitZoom() : Math.min(this.zoom, this.maxZoom()), resized ? { x: 0.5, y: 0.5 } : null);
      this.clearHover();
    }

    maxZoom() {
      return Math.max(ZOOM_STEPS[0], MAX_DISPLAY_SIZE / Math.max(this.image.width, this.image.height));
    }

    fitZoom() {
      const availW = Math.max(40, this.viewport.clientWidth - 32);
      const availH = Math.max(40, this.viewport.clientHeight - 32);
      const z = Math.min(availW / this.image.width, availH / this.image.height, this.maxZoom());
      if (z >= 1) return Math.min(64, Math.floor(z));
      let best = ZOOM_STEPS[0];
      for (const s of ZOOM_STEPS) if (s <= z) best = s;
      return best;
    }

    step(direction) {
      if (!this.image) return;
      const current = this.zoom;
      let next = current;
      if (direction > 0) {
        for (const s of ZOOM_STEPS) if (s > current + 1e-9) { next = s; break; }
      } else {
        for (let i = ZOOM_STEPS.length - 1; i >= 0; i--) if (ZOOM_STEPS[i] < current - 1e-9) { next = ZOOM_STEPS[i]; break; }
      }
      next = Math.min(next, this.maxZoom());
      this.fit = false;
      this.applyZoom(next);
    }

    /** Sets the zoom, keeping `anchor` (fractions of the image, default: the current centre) in view. */
    applyZoom(zoom, anchor) {
      const vp = this.viewport;
      const oldW = this.box.offsetWidth;
      const oldH = this.box.offsetHeight;
      const cx = anchor ? anchor.x : oldW ? (vp.scrollLeft + vp.clientWidth / 2) / oldW : 0.5;
      const cy = anchor ? anchor.y : oldH ? (vp.scrollTop + vp.clientHeight / 2) / oldH : 0.5;
      this.zoom = zoom;
      const w = Math.max(1, Math.round(this.image.width * zoom));
      const hgt = Math.max(1, Math.round(this.image.height * zoom));
      this.box.style.width = w + 'px';
      this.box.style.height = hgt + 'px';
      vp.scrollLeft = cx * w - vp.clientWidth / 2;
      vp.scrollTop = cy * hgt - vp.clientHeight / 2;
      this.zoomLabel.textContent = (zoom >= 1 ? zoom : zoom.toFixed(3).replace(/0+$/, '')) + '×';
    }

    /**
     * cells:   rectangles to outline
     * skipped: rectangles to cross out
     */
    setOverlay(cells, skipped) {
      const W = this.image.width;
      const H = this.image.height;
      let grid = '';
      let skip = '';
      let cross = '';
      for (const c of cells) grid += 'M' + c.x + ' ' + c.y + 'h' + c.width + 'v' + c.height + 'h' + -c.width + 'Z';
      for (const c of skipped || []) {
        skip += 'M' + c.x + ' ' + c.y + 'h' + c.width + 'v' + c.height + 'h' + -c.width + 'Z';
        cross += 'M' + c.x + ' ' + c.y + 'l' + c.width + ' ' + c.height + 'M' + (c.x + c.width) + ' ' + c.y + 'l' + -c.width + ' ' + c.height;
      }
      this.paths.dim.setAttribute('d', 'M0 0H' + W + 'V' + H + 'H0Z' + grid);
      this.paths.grid.setAttribute('d', grid);
      this.paths.skip.setAttribute('d', skip);
      this.paths.cross.setAttribute('d', cross);
    }

    onPointer(e) {
      if (!this.image) return;
      const r = this.box.getBoundingClientRect();
      const x = Math.floor(((e.clientX - r.left) / r.width) * this.image.width);
      const y = Math.floor(((e.clientY - r.top) / r.height) * this.image.height);
      if (x < 0 || y < 0 || x >= this.image.width || y >= this.image.height) return this.clearHover();
      const hit = this.hitTest ? this.hitTest(x, y) : null;
      if (hit && hit.rect) {
        this.hover.setAttribute('x', hit.rect.x);
        this.hover.setAttribute('y', hit.rect.y);
        this.hover.setAttribute('width', hit.rect.width);
        this.hover.setAttribute('height', hit.rect.height);
      } else {
        this.hover.setAttribute('width', 0);
        this.hover.setAttribute('height', 0);
      }
      this.status.textContent = hit ? hit.text : 'x ' + x + ', y ' + y;
    }

    clearHover() {
      this.hover.setAttribute('width', 0);
      this.hover.setAttribute('height', 0);
      this.status.textContent = this.previewError
        ? 'This image is too large to preview in this browser, but you can still export it.'
        : this.defaultStatus;
    }
  }

  /** Finds the grid cell under pixel (x, y), or -1. */
  function cellAt(x, y, margin, spacing, cellW, cellH, columns, rows) {
    const gx = x - margin;
    const gy = y - margin;
    if (gx < 0 || gy < 0) return -1;
    const col = Math.floor(gx / (cellW + spacing));
    const row = Math.floor(gy / (cellH + spacing));
    if (col >= columns || row >= rows) return -1;
    if (gx - col * (cellW + spacing) >= cellW || gy - row * (cellH + spacing) >= cellH) return -1;
    return row * columns + col;
  }

  // ------------------------------------------------------------------- split

  const S = {
    pick: $('#split-pick'),
    input: $('#split-input'),
    drop: $('#split-drop'),
    card: $('#split-file-card'),
    cardName: $('#split-file-name'),
    cardMeta: $('#split-file-meta'),
    empty: $('#split-file-empty'),
    modeInputs: $$('input[name="split-mode"]'),
    cellW: $('#split-cell-w'),
    cellH: $('#split-cell-h'),
    cols: $('#split-cols'),
    rows: $('#split-rows'),
    margin: $('#split-margin'),
    spacing: $('#split-spacing'),
    skipEmpty: $('#split-skip-empty'),
    prefix: $('#split-prefix'),
    start: $('#split-start'),
    digits: $('#split-digits'),
    summary: $('#split-summary'),
    names: $('#split-names'),
    exportBtn: $('#split-export'),
  };
  const splitStage = new Stage($('#split-stage'));
  const splitState = { image: null, fileName: '', plan: null, options: null, exporting: false };

  function splitMode() {
    return S.modeInputs.find((r) => r.checked).value;
  }

  function readSplitOptions() {
    const mode = splitMode();
    const fields = mode === 'size'
      ? [
          { key: 'cellWidth', input: S.cellW, label: 'Cell width', min: 1 },
          { key: 'cellHeight', input: S.cellH, label: 'Cell height', min: 1 },
        ]
      : [
          { key: 'columns', input: S.cols, label: 'Columns', min: 1 },
          { key: 'rows', input: S.rows, label: 'Rows', min: 1 },
        ];
    fields.push(
      { key: 'margin', input: S.margin, label: 'Margin', min: 0 },
      { key: 'spacing', input: S.spacing, label: 'Spacing', min: 0 },
      { key: 'startNumber', input: S.start, label: 'Start at', min: 0 },
      { key: 'digits', input: S.digits, label: 'Digits', min: 1, max: 6 }
    );
    clearInvalid(mode === 'size' ? [S.cols, S.rows] : [S.cellW, S.cellH]);
    const result = readNumbers(fields);
    result.values.mode = mode;
    result.values.skipEmpty = S.skipEmpty.checked;
    result.values.prefix = S.prefix.value;
    return result;
  }

  function namesPreview(plan) {
    const names = [];
    for (const f of plan.frames) if (f.fileName) names.push(f.fileName);
    if (names.length === 0) return '';
    if (names.length <= 3) return names.join(', ');
    return names[0] + ', ' + names[1] + ' … ' + names[names.length - 1];
  }

  function disableSplitExport(label) {
    S.exportBtn.disabled = true;
    S.exportBtn.textContent = label || 'Download ZIP';
  }

  function updateSplit() {
    if (splitState.exporting) return;
    const read = readSplitOptions();
    splitState.plan = null;
    splitState.options = null;

    if (!splitState.image) {
      setSummary(S.summary, read.error ? [line([read.error])] : [], !!read.error);
      S.names.textContent = read.error ? '' : 'Example: ' + split.frameFileName(read.values.prefix, read.values.startNumber, read.values.digits);
      disableSplitExport();
      return;
    }

    if (read.error) {
      setSummary(S.summary, [line([read.error])], true);
      S.names.textContent = '';
      splitStage.setOverlay([], []);
      disableSplitExport();
      return;
    }

    let plan;
    try {
      plan = split.planSplit(splitState.image, read.values);
    } catch (err) {
      setSummary(S.summary, [line([err.message])], true);
      disableSplitExport();
      return;
    }
    const grid = plan.grid;
    if (grid.problem) {
      setSummary(S.summary, [line([grid.problem])], true);
      S.names.textContent = '';
      splitStage.setOverlay([], []);
      disableSplitExport();
      return;
    }

    splitState.plan = plan;
    splitState.options = read.values;

    const lines = [
      line([{ b: dims(grid.columns, grid.rows) }, ' grid · cells of ', { b: dims(grid.cellWidth, grid.cellHeight) }, ' px']),
    ];
    if (plan.emptyCount === 0) {
      lines.push(line([plural(grid.cells.length, 'cell') + ', none empty']));
    } else if (read.values.skipEmpty) {
      lines.push(line([plural(grid.cells.length, 'cell') + ', ', { b: plan.emptyCount }, ' empty (skipped)']));
    } else {
      lines.push(line([plural(grid.cells.length, 'cell') + ', ', { b: plan.emptyCount }, ' empty (kept)']));
    }
    lines.push(line(['→ ', { b: plan.exportCount }, plan.exportCount === 1 ? ' PNG file' : ' PNG files']));
    const extraRight = grid.unusedRight - grid.margin;
    const extraBottom = grid.unusedBottom - grid.margin;
    const outside = [];
    if (extraRight > 0) outside.push(extraRight + ' px on the right');
    if (extraBottom > 0) outside.push(extraBottom + ' px at the bottom');
    if (outside.length) lines.push(line(['Not covered by the grid: ' + outside.join(', ') + '.'], 'note'));
    setSummary(S.summary, lines, false);

    S.names.textContent = plan.exportCount ? namesPreview(plan) : 'Every cell is empty, so there is nothing to export.';
    splitStage.setOverlay(
      grid.cells,
      plan.frames.filter((f) => f.skipped).map((f) => f.cell)
    );

    S.exportBtn.disabled = plan.exportCount === 0;
    S.exportBtn.textContent = plan.exportCount
      ? 'Download ZIP (' + plural(plan.exportCount, 'file') + ')'
      : 'Download ZIP';
  }

  const scheduleSplit = coalesce(updateSplit);

  splitStage.hitTest = function (x, y) {
    const plan = splitState.plan;
    if (!plan) return null;
    const g = plan.grid;
    const index = cellAt(x, y, g.margin, g.spacing, g.cellWidth, g.cellHeight, g.columns, g.rows);
    if (index < 0) return { rect: null, text: 'x ' + x + ', y ' + y + ' · not inside a cell' };
    const frame = plan.frames[index];
    const c = frame.cell;
    let text = 'Cell ' + (index + 1) + ' · row ' + (c.row + 1) + ', column ' + (c.column + 1) +
      ' · x ' + c.x + ', y ' + c.y + ' · ' + dims(c.width, c.height) + ' px';
    if (frame.skipped) text += ' · empty, skipped';
    else text += ' → ' + frame.fileName + (frame.empty ? ' (empty)' : '');
    return { rect: c, text: text };
  };

  async function loadSplitFile(file) {
    let image;
    try {
      image = await readPng(file);
    } catch (err) {
      notify('Could not open “' + file.name + '”: ' + err.message, 'error');
      return;
    }
    splitState.image = image;
    splitState.fileName = file.name;
    S.cardName.textContent = file.name;
    S.cardMeta.textContent = dims(image.width, image.height) + ' px';
    S.card.hidden = false;
    S.empty.hidden = true;
    S.pick.textContent = 'Choose another PNG…';
    S.prefix.value = split.sanitizeFileName(baseName(file.name)) + '_';
    S.drop.hidden = true;
    $('#split-stage').hidden = false;
    splitStage.fit = true;
    splitStage.setImage(image);
    updateSplit();
  }

  function handleSplitFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    if (list.length > 1) {
      notify('Only one sprite sheet can be split at a time; using “' + list[0].name + '”. To combine images, use Merge frames.');
    }
    loadSplitFile(list[0]);
  }

  // When switching modes, carry the current grid over so nothing jumps.
  for (const radio of S.modeInputs) {
    radio.addEventListener('change', function () {
      const plan = splitState.plan;
      if (plan) {
        if (splitMode() === 'count') {
          S.cols.value = plan.grid.columns;
          S.rows.value = plan.grid.rows;
        } else {
          S.cellW.value = plan.grid.cellWidth;
          S.cellH.value = plan.grid.cellHeight;
        }
      }
      for (const group of $$('[data-split-mode]')) group.hidden = group.dataset.splitMode !== splitMode();
      updateSplit();
    });
  }

  for (const input of [S.cellW, S.cellH, S.cols, S.rows, S.margin, S.spacing, S.skipEmpty, S.prefix, S.start, S.digits]) {
    input.addEventListener('input', scheduleSplit);
    input.addEventListener('change', scheduleSplit);
  }

  S.input.addEventListener('change', function () {
    handleSplitFiles(S.input.files);
    S.input.value = '';
  });

  S.exportBtn.addEventListener('click', async function () {
    const plan = splitState.plan;
    if (!plan || splitState.exporting) return;
    splitState.exporting = true;
    S.exportBtn.disabled = true;
    S.exportBtn.textContent = 'Preparing…';
    let last = 0;
    try {
      const result = await split.buildSplitZip(splitState.image, splitState.options, {
        onProgress: function (done, total) {
          const now = performance.now();
          if (now - last > 60 || done === total) {
            last = now;
            S.exportBtn.textContent = 'Packing ' + done + ' / ' + total + '…';
          }
        },
      });
      const zipName = split.sanitizeFileName(baseName(splitState.fileName)) + '_frames.zip';
      saveFile(result.zip, zipName, 'application/zip');
      notify('Saved ' + plural(result.names.length, 'frame') + ' to ' + zipName + '.');
    } catch (err) {
      notify('Export failed: ' + err.message, 'error');
    } finally {
      splitState.exporting = false;
      updateSplit();
    }
  });

  // ------------------------------------------------------------------- merge

  const M = {
    input: $('#merge-input'),
    drop: $('#merge-drop'),
    stageRoot: $('#merge-stage'),
    list: $('#merge-list'),
    count: $('#merge-count'),
    sort: $('#merge-sort'),
    clear: $('#merge-clear'),
    cols: $('#merge-cols'),
    spacing: $('#merge-spacing'),
    margin: $('#merge-margin'),
    alignInputs: $$('input[name="merge-align"]'),
    summary: $('#merge-summary'),
    name: $('#merge-name'),
    exportPng: $('#merge-export-png'),
    exportJson: $('#merge-export-json'),
  };
  const mergeStage = new Stage(M.stageRoot);
  const mergeState = { items: [], nextId: 1, result: null, pngBytes: null, encoding: false };

  function makeThumb(image) {
    const canvas = document.createElement('canvas');
    try {
      paint(canvas, image);
    } catch (err) {
      canvas.width = canvas.height = 1;
    }
    const box = 76;
    const fit = Math.min(box / image.width, box / image.height);
    const scale = fit >= 1 ? Math.floor(fit) : fit;
    canvas.style.width = Math.max(1, Math.round(image.width * scale)) + 'px';
    canvas.style.height = Math.max(1, Math.round(image.height * scale)) + 'px';
    return canvas;
  }

  function isSortedByName(items) {
    for (let i = 1; i < items.length; i++) {
      if (merge.naturalCompare(items[i - 1].name, items[i].name) > 0) return false;
    }
    return true;
  }

  async function addMergeFiles(files) {
    const list = Array.from(files || []);
    if (!list.length) return;
    const settled = await Promise.allSettled(list.map(readPng));
    const added = [];
    const failed = [];
    settled.forEach(function (r, i) {
      if (r.status === 'fulfilled') {
        added.push({ id: mergeState.nextId++, name: list[i].name, image: r.value, thumb: makeThumb(r.value) });
      } else {
        failed.push('“' + list[i].name + '”: ' + r.reason.message);
      }
    });
    if (added.length) {
      // Keep the list in name order unless the user has arranged it by hand.
      const keepSorted = isSortedByName(mergeState.items);
      let items = mergeState.items.concat(merge.sortByName(added));
      if (keepSorted) items = merge.sortByName(items);
      mergeState.items = items;
      renderFrames();
      updateMerge();
    }
    if (failed.length) {
      notify('Skipped ' + plural(failed.length, 'file') + '. ' + failed[0] + (failed.length > 1 ? ' …' : ''), 'error');
    } else if (added.length) {
      notify('Added ' + plural(added.length, 'frame') + '.');
    }
  }

  function renderFrames(focusId) {
    const items = mergeState.items;
    const tiles = items.map(function (item, i) {
      const sizeText = dims(item.image.width, item.image.height);
      return h('li', {
          class: 'tile',
          tabindex: '0',
          'data-id': item.id,
          title: item.name + ' — drag to move (or Alt + arrow keys)',
          'aria-label': 'Frame ' + (i + 1) + ': ' + item.name + ', ' + sizeText + ' pixels. Alt plus arrow keys move it, Delete removes it.',
        },
        h('span', { class: 'tile-handle', 'aria-hidden': 'true' }, h('span', { class: 'tile-index', text: String(i + 1) })),
        h('button', { class: 'tile-remove', type: 'button', 'aria-label': 'Remove ' + item.name, title: 'Remove', text: '×' }),
        h('div', { class: 'tile-thumb' }, item.thumb),
        h('div', { class: 'tile-name', text: item.name }),
        h('div', { class: 'tile-size', text: sizeText })
      );
    });
    M.list.replaceChildren.apply(M.list, tiles);
    M.count.textContent = String(items.length);
    M.sort.disabled = items.length < 2;
    M.clear.disabled = items.length === 0;
    if (focusId !== undefined) {
      const tile = M.list.querySelector('[data-id="' + focusId + '"]');
      if (tile) tile.focus();
    }
  }

  function renumberTiles() {
    $$('.tile-index', M.list).forEach(function (node, i) { node.textContent = String(i + 1); });
  }

  function readMergeOptions() {
    const result = readNumbers([
      { key: 'columns', input: M.cols, label: 'Frames per row', min: 1, max: 10000 },
      { key: 'spacing', input: M.spacing, label: 'Spacing', min: 0, max: 4096 },
      { key: 'margin', input: M.margin, label: 'Margin', min: 0, max: 4096 },
    ]);
    result.values.align = M.alignInputs.find((r) => r.checked).value;
    return result;
  }

  function outputName() {
    const name = split.sanitizeFileName(M.name.value.trim().replace(/\.(png|json)$/i, '')).trim();
    return name || 'spritesheet';
  }

  function setMergeExport(enabled) {
    M.exportPng.disabled = !enabled;
    M.exportJson.disabled = !enabled;
  }

  function updateMerge() {
    const items = mergeState.items;
    mergeState.pngBytes = null;
    M.drop.hidden = items.length > 0;
    M.stageRoot.hidden = items.length === 0;

    const read = readMergeOptions();
    if (!items.length) {
      mergeState.result = null;
      setSummary(M.summary, read.error ? [line([read.error])] : [], !!read.error);
      setMergeExport(false);
      return;
    }
    if (read.error) {
      mergeState.result = null;
      setSummary(M.summary, [line([read.error])], true);
      setMergeExport(false);
      return;
    }

    let packed;
    try {
      packed = merge.packSprites(items.map((i) => i.image), read.values);
    } catch (err) {
      mergeState.result = null;
      setSummary(M.summary, [line([err.message])], true);
      setMergeExport(false);
      return;
    }
    const layout = packed.layout;
    mergeState.result = { image: packed.image, layout: layout, names: items.map((i) => i.name) };

    mergeStage.setImage(packed.image);
    mergeStage.setOverlay(layout.placements.map((p) => p.cell), []);

    const mixed = items.some((i) => i.image.width !== layout.cellWidth || i.image.height !== layout.cellHeight);
    const lines = [
      line([{ b: items.length }, items.length === 1 ? ' frame' : ' frames', ' in a ', { b: dims(layout.columns, layout.rows) }, ' grid']),
      line(['Cells: ', { b: dims(layout.cellWidth, layout.cellHeight) }, ' px' + (mixed ? ' (largest frame)' : '')]),
      line(['Sheet: ', { b: dims(layout.width, layout.height) }, ' px']),
    ];
    if (mixed) {
      lines.push(line([
        'Frames have different sizes; smaller ones are ' +
        (layout.align === 'bottom' ? 'placed on the bottom edge of their cell.' : 'centered in their cell.'),
      ], 'note'));
    }
    setSummary(M.summary, lines, false);
    setMergeExport(true);
  }

  const scheduleMerge = coalesce(updateMerge);

  mergeStage.hitTest = function (x, y) {
    const result = mergeState.result;
    if (!result) return null;
    const L = result.layout;
    const index = cellAt(x, y, L.margin, L.spacing, L.cellWidth, L.cellHeight, L.columns, L.rows);
    const p = index >= 0 ? L.placements[index] : null;
    if (!p) return { rect: null, text: 'x ' + x + ', y ' + y + ' · empty space' };
    return {
      rect: { x: p.x, y: p.y, width: p.width, height: p.height },
      text: 'Frame ' + (index + 1) + ' · ' + result.names[index] + ' · x ' + p.x + ', y ' + p.y + ' · ' +
        dims(p.width, p.height) + ' px',
    };
  };

  function moveItem(from, to) {
    const items = mergeState.items;
    if (to < 0 || to >= items.length || from === to) return;
    const moved = items.splice(from, 1)[0];
    items.splice(to, 0, moved);
    renderFrames(moved.id);
    updateMerge();
  }

  function removeItem(id) {
    const items = mergeState.items;
    const index = items.findIndex((i) => i.id === id);
    if (index < 0) return;
    items.splice(index, 1);
    const next = items[Math.min(index, items.length - 1)];
    renderFrames(next ? next.id : undefined);
    updateMerge();
  }

  M.list.addEventListener('click', function (e) {
    const button = e.target.closest('.tile-remove');
    if (button) removeItem(Number(button.closest('.tile').dataset.id));
  });

  M.list.addEventListener('keydown', function (e) {
    const tile = e.target;
    if (!tile.classList || !tile.classList.contains('tile')) return;
    const id = Number(tile.dataset.id);
    const index = mergeState.items.findIndex((i) => i.id === id);
    const back = e.key === 'ArrowLeft' || e.key === 'ArrowUp';
    const forward = e.key === 'ArrowRight' || e.key === 'ArrowDown';
    if (e.altKey && (back || forward)) {
      e.preventDefault();
      moveItem(index, index + (back ? -1 : 1));
    } else if (back || forward) {
      e.preventDefault();
      const sibling = back ? tile.previousElementSibling : tile.nextElementSibling;
      if (sibling) sibling.focus();
    } else if (e.key === 'Delete' || e.key === 'Backspace') {
      e.preventDefault();
      removeItem(id);
    }
  });

  // Drag to reorder (mouse anywhere on a tile; touch and pen on the number badge).
  let drag = null;

  M.list.addEventListener('pointerdown', function (e) {
    const tile = e.target.closest('.tile');
    if (!tile || e.button !== 0 || e.target.closest('button')) return;
    if (e.pointerType !== 'mouse' && !e.target.closest('.tile-handle')) return;
    drag = { tile: tile, pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, x: e.clientX, y: e.clientY, started: false, raf: 0 };
    // Capture on the list: the tile itself moves around the DOM while dragging.
    M.list.setPointerCapture(e.pointerId);
  });

  M.list.addEventListener('pointermove', function (e) {
    if (!drag || e.pointerId !== drag.pointerId) return;
    drag.x = e.clientX;
    drag.y = e.clientY;
    if (!drag.started) {
      if (Math.abs(e.clientX - drag.startX) + Math.abs(e.clientY - drag.startY) < 5) return;
      drag.started = true;
      drag.tile.classList.add('is-dragging');
      M.list.classList.add('is-sorting');
      drag.raf = requestAnimationFrame(autoScroll);
    }
    e.preventDefault();
    reorderAt(e.clientX, e.clientY);
  });

  function reorderAt(x, y) {
    const target = document.elementFromPoint(x, y);
    const over = target && target.closest('.tile');
    if (!over || over === drag.tile || over.parentNode !== M.list) return;
    const tiles = Array.from(M.list.children);
    const from = tiles.indexOf(drag.tile);
    const to = tiles.indexOf(over);
    M.list.insertBefore(drag.tile, from < to ? over.nextSibling : over);
    renumberTiles();
  }

  function autoScroll() {
    if (!drag || !drag.started) return;
    const r = M.list.getBoundingClientRect();
    const edge = 36;
    let dy = 0;
    if (drag.y < r.top + edge) dy = -Math.min(18, Math.ceil((r.top + edge - drag.y) / 3));
    else if (drag.y > r.bottom - edge) dy = Math.min(18, Math.ceil((drag.y - (r.bottom - edge)) / 3));
    if (dy) {
      M.list.scrollTop += dy;
      reorderAt(drag.x, drag.y);
    }
    drag.raf = requestAnimationFrame(autoScroll);
  }

  function endDrag() {
    if (!drag) return;
    const d = drag;
    drag = null;
    cancelAnimationFrame(d.raf);
    d.tile.classList.remove('is-dragging');
    M.list.classList.remove('is-sorting');
    if (!d.started) return;
    const byId = new Map(mergeState.items.map((i) => [i.id, i]));
    const order = Array.from(M.list.children).map((li) => byId.get(Number(li.dataset.id)));
    const changed = order.some((item, i) => item !== mergeState.items[i]);
    mergeState.items = order;
    if (changed) {
      renderFrames(Number(d.tile.dataset.id));
      updateMerge();
    }
  }

  M.list.addEventListener('pointerup', endDrag);
  M.list.addEventListener('pointercancel', endDrag);
  M.list.addEventListener('lostpointercapture', endDrag);

  M.sort.addEventListener('click', function () {
    mergeState.items = merge.sortByName(mergeState.items);
    renderFrames();
    updateMerge();
    notify('Sorted by file name.');
  });

  M.clear.addEventListener('click', function () {
    mergeState.items = [];
    renderFrames();
    updateMerge();
  });

  for (const input of [M.cols, M.spacing, M.margin].concat(M.alignInputs)) {
    input.addEventListener('input', scheduleMerge);
    input.addEventListener('change', scheduleMerge);
  }

  M.input.addEventListener('change', function () {
    addMergeFiles(M.input.files);
    M.input.value = '';
  });

  M.exportPng.addEventListener('click', async function () {
    const result = mergeState.result;
    if (!result || mergeState.encoding) return;
    mergeState.encoding = true;
    M.exportPng.disabled = true;
    M.exportPng.textContent = 'Encoding…';
    try {
      const bytes = mergeState.pngBytes || (await png.encodePng(result.image));
      if (mergeState.result === result) mergeState.pngBytes = bytes;
      saveFile(bytes, outputName() + '.png', 'image/png');
    } catch (err) {
      notify('Export failed: ' + err.message, 'error');
    } finally {
      mergeState.encoding = false;
      M.exportPng.textContent = 'Download PNG';
      M.exportPng.disabled = !mergeState.result;
    }
  });

  M.exportJson.addEventListener('click', function () {
    const result = mergeState.result;
    if (!result) return;
    const name = outputName();
    const atlas = merge.buildAtlas(result.names, result.layout, name + '.png');
    saveFile(merge.stringifyAtlas(atlas), name + '.json', 'application/json');
  });

  // -------------------------------------------------------------------- tabs

  const tabs = $$('[role="tab"]');
  let currentTab = 'split';

  function selectTab(name, moveFocus) {
    currentTab = name;
    for (const tab of tabs) {
      const selected = tab.dataset.tab === name;
      tab.setAttribute('aria-selected', String(selected));
      tab.tabIndex = selected ? 0 : -1;
      $('#' + tab.getAttribute('aria-controls')).hidden = !selected;
      if (selected && moveFocus) tab.focus();
    }
    try {
      history.replaceState(null, '', name === 'merge' ? '#merge' : location.pathname + location.search);
    } catch (err) {
      // Some browsers restrict history changes on file:// pages; the tab still works.
    }
  }

  for (const tab of tabs) {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', function (e) {
      if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
      e.preventDefault();
      const i = tabs.indexOf(tab);
      const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length];
      selectTab(next.dataset.tab, true);
    });
  }

  // ------------------------------------------------------- choose & drop files

  document.addEventListener('click', function (e) {
    const picker = e.target.closest('[data-pick]');
    if (picker) (picker.dataset.pick === 'merge' ? M.input : S.input).click();
  });

  const overlay = $('#drop-overlay');
  const overlayText = $('#drop-overlay-text');
  let dragDepth = 0;

  function hasFiles(e) {
    return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).indexOf('Files') >= 0;
  }

  window.addEventListener('dragenter', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth++;
    overlayText.textContent = currentTab === 'merge' ? 'Drop PNG frames to add them' : 'Drop a PNG sprite sheet to split it';
    overlay.hidden = false;
  });

  window.addEventListener('dragover', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  window.addEventListener('dragleave', function (e) {
    if (!hasFiles(e)) return;
    dragDepth = Math.max(0, dragDepth - 1);
    if (dragDepth === 0) overlay.hidden = true;
  });

  window.addEventListener('drop', function (e) {
    if (!hasFiles(e)) return;
    e.preventDefault();
    dragDepth = 0;
    overlay.hidden = true;
    const files = e.dataTransfer.files;
    if (currentTab === 'merge') addMergeFiles(files);
    else handleSplitFiles(files);
  });

  // ------------------------------------------------------------------- start

  // Browsers may restore form values on reload; make the visible inputs match.
  for (const group of $$('[data-split-mode]')) group.hidden = group.dataset.splitMode !== splitMode();
  selectTab(location.hash === '#merge' ? 'merge' : 'split');
  updateSplit();
  updateMerge();
})();
