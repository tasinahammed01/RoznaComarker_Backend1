'use strict';
/**
 * Loads the evaluation set: any <name>.jpg|.jpeg|.png with a matching <name>.txt (ground truth), plus an
 * optional <name>.mistakes.tsv, from a folder that lives OUTSIDE the repository.
 *
 * Read-only by design: nothing is written, copied or moved, and image bytes are not even read until
 * `readImageBytes` is called for a specific item.
 */
const fs = require('fs');
const path = require('path');
const { parseMistakes } = require('./metrics.cjs');

const IMAGE_EXTENSIONS = Object.freeze(['.jpg', '.jpeg', '.png']);
const MISTAKES_SUFFIX = '.mistakes.tsv';
const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // the production OCR path rejects larger images
const BACKEND_ROOT = path.resolve(__dirname, '..', '..', '..');

class DatasetError extends Error {
  constructor(message, problems = []) {
    super(message);
    this.name = 'DatasetError';
    this.problems = problems;
  }
}

// Numeric-aware ordering: image2 sorts before image10. Ties fall back to a plain comparison.
const collator = new Intl.Collator('en', { numeric: true, sensitivity: 'base' });
function naturalCompare(a, b) {
  return collator.compare(a, b) || (a < b ? -1 : a > b ? 1 : 0);
}

function isInsideDirectory(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function resolveEvalDir(env = process.env) {
  const raw = env.OCR_EVAL_DIR;
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new DatasetError('OCR_EVAL_DIR is not set. Point it at the folder holding the images and ground-truth .txt files (outside the repository).');
  }
  return path.resolve(raw.trim());
}

function addTo(map, key, value) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(value);
}

function readText(file, problems) {
  try {
    return fs.readFileSync(file, 'utf8').replace(/^﻿/, '');
  } catch (error) {
    problems.push(`${path.basename(file)}: cannot be read (${error.code || 'read error'})`);
    return null;
  }
}

function loadDataset(directory, { maxImageBytes = MAX_IMAGE_BYTES } = {}) {
  const dir = path.resolve(directory);
  let stat;
  try { stat = fs.statSync(dir); } catch { throw new DatasetError(`Folder not found: ${dir}`); }
  if (!stat.isDirectory()) throw new DatasetError(`Not a folder: ${dir}`);

  const warnings = [], problems = [];
  if (isInsideDirectory(dir, BACKEND_ROOT)) {
    warnings.push('The evaluation folder is inside the repository. Keep photos and ground truth outside it so they can never be committed.');
  }

  const images = new Map(), texts = new Map(), sidecars = new Map();
  for (const file of fs.readdirSync(dir).sort(naturalCompare)) {
    if (file.startsWith('.')) continue; // hidden and resource-fork files
    const full = path.join(dir, file);
    let info;
    try { info = fs.statSync(full); } catch { continue; }
    if (!info.isFile()) continue;
    if (file.toLowerCase().endsWith(MISTAKES_SUFFIX)) { addTo(sidecars, file.slice(0, -MISTAKES_SUFFIX.length), file); continue; }
    const { name, ext } = path.parse(file);
    const extension = ext.toLowerCase();
    if (extension === '.txt') addTo(texts, name, file);
    else if (IMAGE_EXTENSIONS.includes(extension)) addTo(images, name, { file, extension, bytes: info.size });
  }

  const items = [];
  for (const name of [...images.keys()].sort(naturalCompare)) {
    const candidates = images.get(name);
    if (candidates.length > 1) {
      problems.push(`${name}: more than one image (${candidates.map(c => c.file).join(', ')}); keep exactly one`);
      continue;
    }
    const [image] = candidates;
    const truthFiles = texts.get(name);
    if (!truthFiles) { warnings.push(`${image.file}: skipped, there is no matching ${name}.txt`); continue; }
    if (truthFiles.length > 1) { problems.push(`${name}: more than one ground-truth file (${truthFiles.join(', ')})`); continue; }

    const groundTruthPath = path.join(dir, truthFiles[0]);
    const groundTruth = readText(groundTruthPath, problems);
    if (groundTruth === null) continue;
    if (!groundTruth.trim()) { problems.push(`${truthFiles[0]}: ground truth is empty`); continue; }
    if (groundTruth.includes('�')) warnings.push(`${truthFiles[0]}: contains replacement characters, it may not be valid UTF-8`);

    let mistakes = null, mistakesPath = null;
    const sidecarFiles = sidecars.get(name);
    if (sidecarFiles?.length > 1) { problems.push(`${name}: more than one mistakes file (${sidecarFiles.join(', ')})`); continue; }
    if (sidecarFiles) {
      mistakesPath = path.join(dir, sidecarFiles[0]);
      const text = readText(mistakesPath, problems);
      if (text === null) continue;
      const parsed = parseMistakes(text);
      if (parsed.errors.length) {
        for (const error of parsed.errors) problems.push(`${sidecarFiles[0]} line ${error.line}: ${error.message}`);
        continue;
      }
      mistakes = { entries: parsed.entries };
    }
    if (image.bytes > maxImageBytes) {
      warnings.push(`${image.file}: ${(image.bytes / 1048576).toFixed(1)} MB exceeds the ${(maxImageBytes / 1048576).toFixed(0)} MB production limit`);
    }
    items.push({
      name, imagePath: path.join(dir, image.file), imageExtension: image.extension, imageBytes: image.bytes,
      groundTruthPath, groundTruth, mistakesPath, mistakes,
    });
  }

  for (const [name, files] of [...texts].sort(([a], [b]) => naturalCompare(a, b))) {
    if (!images.has(name)) warnings.push(`${files.join(', ')}: skipped, there is no matching image (.jpg, .jpeg or .png)`);
  }
  for (const [name, files] of [...sidecars].sort(([a], [b]) => naturalCompare(a, b))) {
    if (!images.has(name)) warnings.push(`${files.join(', ')}: ignored, there is no matching image`);
  }

  if (problems.length) {
    throw new DatasetError(`The evaluation folder has ${problems.length} problem(s):\n - ${problems.join('\n - ')}`, problems);
  }
  if (!items.length) {
    throw new DatasetError(`No usable image + .txt pairs found in ${dir}. Expected files such as image1.jpeg with image1.txt.`);
  }
  return { directory: dir, items, warnings };
}

function readImageBytes(item) {
  return fs.readFileSync(item.imagePath);
}

module.exports = { DatasetError, IMAGE_EXTENSIONS, MAX_IMAGE_BYTES, naturalCompare, isInsideDirectory, resolveEvalDir, loadDataset, readImageBytes };
