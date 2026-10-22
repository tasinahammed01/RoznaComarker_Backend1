const { validate, mode, VERSION, CLASSES, MODEL } = require('../src/services/hybridSource/contract');
const { reconcile: reconcileRaw, evidenceKey, cropBounds, align } = require('../src/services/hybridSource/reconcile');
const { read } = require('../src/services/hybridSource/reader');
const { observe, rawEvidence } = require('../src/services/hybridSource/shadow');
const identity = { submissionId: 'submission', fileId: 'file', pageNumber: 1, runId: 'run',
  sourceSha256: 'a'.repeat(64), inputSha256: 'b'.repeat(64), width: 1000, height: 1000, orientation: 1 };
const document = (text, classification = CLASSES[0], confidence = 1) => ({ version: VERSION,
  activeTranscript: classification === CLASSES[0] ? text : '', lines: [{ text, classification, confidence }] });
const words = texts => texts.map((text, i) => ({ text, confidence: 1, id: `word_file_1_${i + 1}`,
  polygon: [{ x: i * 100, y: 50 }, { x: i * 100 + 70, y: 50 },
    { x: i * 100 + 70, y: 80 }, { x: i * 100, y: 80 }] }));
// These synthetic test references are explicitly trusted review fixtures. Keep
// all original geometry assertions, now requiring a separate authority witness.
// Production provider agreement receives no such witness (covered in phase 2).
function reconcile(reader, native, current) {
  const diagnostic = reconcileRaw(reader, native, current);
  const trustedAttestations = diagnostic.bindings.filter(b => b.geometryUnique).map(b => ({
    kind: 'HUMAN_REVIEWED', reviewer: 'synthetic test reference', reviewId: 'unit-fixture',
    identity: current, evidenceKey: evidenceKey(current), wordIds: b.mappedWordIds,
    classification: b.classification, text: b.sourceText
  }));
  return reconcileRaw(reader, native, current, { trustedAttestations });
}

describe('source contract', () => {
  test('default and rollback bypass the reader; publishing fails closed', () => {
    expect(mode({})).toBe('legacy');
    expect(mode({ OCR_SOURCE_MODE: 'hybrid_shadow' })).toBe('hybrid_shadow');
    expect(() => mode({ OCR_SOURCE_MODE: 'hybrid' })).toThrow('NOT_VALIDATED');
    expect(() => mode({ OCR_SOURCE_MODE: 'typo' })).toThrow('INVALID');
  });
  test.each(['preception', 'hello', 'Hello', "don't", 'well-being', 'Hello, world!'])('preserves %s verbatim', text => {
    expect(validate(JSON.stringify(document(text))).activeTranscript).toBe(text);
  });
  test.each(CLASSES.slice(1))('explicit exclusion/uncertainty class %s', classification => {
    expect(validate(JSON.stringify(document('visible text', classification))).activeTranscript).toBe('');
  });
  test.each([
    v => ({ ...v, boundingBox: {} }), v => ({ ...v, activeTranscript: 'perception' }),
    v => ({ ...v, lines: [{ ...v.lines[0], confidence: 2 }] }),
    v => ({ ...v, lines: [{ ...v.lines[0], wordId: 'invented' }] }),
    v => ({ ...v, lines: [{ ...v.lines[0], classification: 'CORRECTED' }] })
  ])('rejects untrusted/malformed output %#', mutate => {
    expect(() => validate(JSON.stringify(mutate(document('preception'))))).toThrow();
  });
  test('rejects prose, code fences and oversized responses', () => {
    for (const text of ['```json\n{}\n```', 'hello', 'x'.repeat(160001)]) expect(() => validate(text)).toThrow();
  });
});

describe('conservative geometry binding', () => {
  test('retains repeated occurrence IDs without mutating source geometry', () => {
    const google = words(['the', 'the', 'word']), before = JSON.stringify(google);
    const result = reconcile(document('the the word'), google, identity);
    expect(result.bindings.map(b => b.wordIds)).toEqual([['word_file_1_1'], ['word_file_1_2'], ['word_file_1_3']]);
    expect(JSON.stringify(google)).toBe(before);
    expect(result.publishable).toBe(false);
  });
  test('ambiguous repeated occurrence cannot acquire geometry', () => {
    const result = reconcile(document('the'), words(['the', 'the']), identity);
    expect(result.alignment.ambiguous).toBe(true);
    expect(result.bindings.every(b => b.state === 'OCR_UNCERTAIN' && !b.wordIds.length)).toBe(true);
  });
  test.each([
    [['do', "n't"], "don't"], [["don't"], "do n't"],
    [['well', '-', 'being'], 'well-being'], [['hello', ','], 'hello,']
  ])('binds exact split/merged characters %j', (native, source) => {
    expect(reconcile(document(source), words(native), identity).bindings[0].state).toBe('VERIFIED_SOURCE');
  });
  test.each([['sshaped', 'shaped'], ['Hello', 'hello'], ['word,', 'word'], ['relize', 'realize']])(
    'withholds contradictory %s / %s without generating a student error', (google, source) => {
      const result = reconcile(document(source), words([google]), identity);
      expect(result.bindings[0].state).toBe('OCR_UNCERTAIN');
      expect(result.bindings[0].wordIds).toEqual([]);
    });
  test('preception remains source text for the existing correction layer', () => {
    const result = reconcile(document('preception'), words(['preception']), identity);
    expect(result.bindings[0]).toMatchObject({ state: 'VERIFIED_SOURCE', sourceText: 'preception' });
    expect(result.bindings[0]).not.toHaveProperty('suggestion');
  });
  test.each(CLASSES.slice(1, -1))('excludes %s from active geometry', classification => {
    expect(reconcile(document('@MAXI', classification), words(['@MAXI']), identity).bindings[0])
      .toMatchObject({ state: 'OCR_ARTIFACT', wordIds: [], transcriptStart: null });
  });
  test.each([0, 0.89])('low confidence %s cannot authorize geometry', confidence => {
    expect(reconcile(document('text', CLASSES[0], confidence), words(['text']), identity).bindings[0].state).toBe('OCR_UNCERTAIN');
  });
  test('foreign IDs and invalid polygons are withheld', () => {
    const native = words(['text']); native[0].id = 'word_other_1_1';
    expect(reconcile(document('text'), native, identity).bindings[0].wordIds).toEqual([]);
    native[0].id = 'word_file_1_1'; native[0].polygon[0].x = -20;
    expect(reconcile(document('text'), native, identity).bindings[0].wordIds).toEqual([]);
  });
  test.each(['fileId', 'runId', 'sourceSha256', 'inputSha256', 'orientation', 'width', 'pageNumber'])(
    'cache invalidates changed %s', key => {
      expect(evidenceKey({ ...identity, [key]: `${identity[key]}changed` })).not.toBe(evidenceKey(identity));
    });
  test('multi-line offsets refer to exact active transcript, excluding headers', () => {
    const reader = { version: VERSION, activeTranscript: 'one\ntwo', lines: [
      { text: 'HEADER', classification: 'HEADER_OR_TEMPLATE', confidence: 1 },
      ...['one', 'two'].map(text => ({ text, classification: CLASSES[0], confidence: 1 }))] };
    const result = reconcile(reader, words(['HEADER', 'one', 'two']), identity);
    expect(result.bindings.slice(1).map(b => [b.transcriptStart, b.transcriptEnd])).toEqual([[0, 3], [4, 7]]);
  });
  test('crop comes from current polygons and neighbors, never suggested English', () => {
    const native = words(['a', 'sshaped', 'b']);
    const result = reconcile(document('a shaped b'), native, identity);
    expect(cropBounds(result.bindings[1], native, identity)).toEqual({ left: 0, top: 38, width: 282, height: 54 });
  });
  test('bounded alignment rejects oversized inputs', () => {
    expect(() => align(Array(601).fill({ text: 'a' }), [])).toThrow('LIMIT');
  });
});

describe('gateway and shadow isolation', () => {
  test('provider error echoes are removed before shared gateway logging', async () => {
    const generate = async args => {
      const response = await args.fetchImpl('https://example.invalid', { signal: new AbortController().signal });
      expect(await response.text()).not.toContain('private source');
      return { value: document('text'), attempts: [] };
    };
    await read({ bytes: Buffer.from('x'), mimeType: 'image/png', deadlineAt: Date.now() + 10000,
      inspect: async () => true, generate,
      fetchImpl: async () => ({ ok: false, status: 400, text: async () => 'private source image/email/token' }) });
  });
  test('burst admission holds at most two pages and never queues extra image buffers', async () => {
    let release;
    const held = new Promise(resolve => { release = resolve; });
    const reader = jest.fn(async () => { await held; return { reader: document('text') }; });
    const args = { bytes: Buffer.from('x'), mimeType: 'image/png', google: Promise.resolve({}),
      env: { OCR_SOURCE_MODE: 'hybrid_shadow' }, reader, save: jest.fn(), admit: async () => true };
    const first = observe({ ...args, identity: { ...identity, runId: 'burst1' } });
    const second = observe({ ...args, identity: { ...identity, runId: 'burst2' } });
    expect(observe({ ...args, identity: { ...identity, runId: 'burst3' } })).toBeNull();
    release(); await Promise.all([first, second]);
    expect(reader).toHaveBeenCalledTimes(2);
  });
  test('reader uses existing gateway with exact model, schema and full bytes', async () => {
    const generate = jest.fn(async options => ({ value: options.validate(JSON.stringify(document('preception'))), attempts: [] }));
    const bytes = Buffer.from('full resolution fixture bytes');
    await read({ bytes, mimeType: 'image/png', deadlineAt: Date.now() + 20000,
      inspect: async () => true, generate });
    const args = generate.mock.calls[0][0];
    expect(args.config.chain).toEqual([{ provider: 'openrouter', model: MODEL, fallbackIndex: 0 }]);
    expect(args.messages[1].content[1].image_url.url).toBe(`data:image/png;base64,${bytes.toString('base64')}`);
    expect(args.messages[1].content[1].image_url).not.toHaveProperty('detail');
  });
  test('unverified capabilities or expired deadline prevent paid attempts', async () => {
    const generate = jest.fn();
    const args = { bytes: Buffer.from('x'), mimeType: 'image/png', generate,
      deadlineAt: Date.now() + 10000, inspect: async () => { throw new Error('unverified'); } };
    await expect(read(args)).rejects.toThrow('unverified');
    await expect(read({ ...args, deadlineAt: 1 })).rejects.toThrow('CANCELLED');
    expect(generate).not.toHaveBeenCalled();
  });
  test('legacy makes no source calls or private writes', () => {
    const reader = jest.fn(), save = jest.fn(), admit = jest.fn();
    expect(observe({ env: {}, reader, save, admit, identity })).toBeNull();
    expect(reader).not.toHaveBeenCalled(); expect(save).not.toHaveBeenCalled(); expect(admit).not.toHaveBeenCalled();
  });
  test('shadow cannot mutate Google result; duplicate run shares a single attempt', async () => {
    const detected = { fullText: 'preception', pages: [{ text: 'preception' }] };
    Object.defineProperty(detected, rawEvidence, { value: [{ words: words(['preception']) }] });
    const before = JSON.stringify(detected), reader = jest.fn(async () => ({ reader: document('preception'), attempts: [] }));
    const save = jest.fn(), args = { bytes: Buffer.from('x'), mimeType: 'image/png',
      identity: { ...identity, runId: 'isolation' }, google: Promise.resolve(detected),
      env: { OCR_SOURCE_MODE: 'hybrid_shadow' }, reader, save, admit: async () => true };
    const first = observe(args); expect(observe(args)).toBe(first); await first;
    expect(reader).toHaveBeenCalledTimes(1); expect(save).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(detected)).toBe(before);
    expect(save.mock.calls[0][1].comparison.publishable).toBe(false);
  });
  test('failure diagnostics exclude provider bodies and source images', async () => {
    const save = jest.fn();
    await observe({ bytes: Buffer.from('secret image'), mimeType: 'image/png',
      identity: { ...identity, runId: 'failure' }, google: Promise.resolve({}),
      env: { OCR_SOURCE_MODE: 'hybrid_shadow' }, admit: async () => true, save,
      reader: async () => { throw new Error('secret token email and body'); } });
    expect(save.mock.calls[0][1].status).toBe('SOURCE_UNREADABLE');
    expect(JSON.stringify(save.mock.calls)).not.toContain('secret');
  });
  test('durable prior admission and superseded jobs prevent calls', async () => {
    const reader = jest.fn();
    const args = { identity: { ...identity, runId: 'claimed' }, env: { OCR_SOURCE_MODE: 'hybrid_shadow' },
      reader, admit: async () => false, save: jest.fn() };
    await observe(args); await observe({ ...args, identity: { ...identity, runId: 'old' }, isCurrentJob: async () => false });
    expect(reader).not.toHaveBeenCalled();
  });
  test('a losing database admission cannot overwrite the winning worker', async () => {
    const save = jest.fn(), reader = jest.fn();
    await observe({ identity: { ...identity, runId: 'claim-race' },
      env: { OCR_SOURCE_MODE: 'hybrid_shadow' }, reader, save,
      admit: async () => { throw Object.assign(new Error('duplicate'), { code: 11000 }); } });
    expect(save).not.toHaveBeenCalled(); expect(reader).not.toHaveBeenCalled();
  });
});
