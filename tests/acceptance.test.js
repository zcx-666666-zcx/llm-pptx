import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import JSZip from 'jszip';
import { createAcceptancePack } from '../scripts/acceptance.js';
import { inspectPptx } from '../src/animation.js';

async function directory(t) {
  const root = await mkdtemp(join(tmpdir(), 'llm-pptx-acceptance-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('acceptance pack contains verified static/animated files and leaves real playback checks pending', async t => {
  const root = await directory(t);
  const result = await createAcceptancePack(root);
  assert.ok(result?.directory, 'a concrete output directory must be returned');
  const manifest = JSON.parse(await readFile(join(result.directory, 'manifest.json'), 'utf8'));
  assert.equal(manifest.generationMode, 'source');
  assert.equal(manifest.files.length, 4);
  assert.ok(manifest.manualChecks.length >= 5);
  assert.ok(manifest.manualChecks.every(check => check.status === 'pending'));
  assert.equal(manifest.aiProviderValidated, false);
  assert.equal(manifest.powerPointPlaybackValidated, false);
  const staticRecord = manifest.files.find(f => f.kind === 'static');
  const original = await JSZip.loadAsync(await readFile(join(result.directory, staticRecord.path)));
  for (const artifact of manifest.files) {
    const buffer = await readFile(join(result.directory, artifact.path));
    assert.equal(createHash('sha256').update(buffer).digest('hex'), artifact.sha256);
    assert.equal(buffer.length, artifact.bytes);
    const inventory = await inspectPptx(buffer);
    assert.equal(inventory.slides.length, artifact.slides);
    assert.equal(inventory.slides.reduce((n, slide) => n + slide.shapes.length, 0), artifact.objects);
    assert.ok(inventory.slides.every(s => s.hasAnimation === (artifact.kind === 'animated')));
    if (artifact.kind === 'animated') {
      const animated = await JSZip.loadAsync(buffer);
      for (const path of Object.keys(original.files).filter(path => !original.files[path].dir && !/^ppt\/slides\/slide\d+\.xml$/.test(path))) {
        assert.deepEqual(await animated.file(path).async('nodebuffer'), await original.file(path).async('nodebuffer'), path);
      }
    }
  }
  const instructions = await readFile(join(result.directory, 'CHECKLIST.md'), 'utf8');
  assert.match(instructions, /人工调整/);
  assert.match(instructions, /待验收/);
  assert.match(instructions, /PowerPoint/);
  assert.match(instructions, new RegExp(String(staticRecord.slides)));
});

test('another acceptance run preserves an earlier manual review record', async t => {
  const root = await directory(t);
  const first = await createAcceptancePack(root);
  assert.ok(first?.directory, 'a concrete output directory must be returned');
  const record = join(first.directory, 'manual-results.md');
  await writeFile(record, '人工验收记录，需要保留\n');
  const second = await createAcceptancePack(root);
  assert.notEqual(second.directory, first.directory);
  assert.equal(await readFile(record, 'utf8'), '人工验收记录，需要保留\n');
});
